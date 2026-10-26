import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildEvent, verifyChain, GENESIS_HASH } from './invoiceEvents.js';

// The hub's own copy of every bill's event history (G0-4).
//
// One JSON line per event, only ever appended to. Nothing already written is rewritten: that is what lets a crash tear the last line
// and nothing else, and it is why "which events has the cloud confirmed" is itself a line (`{"mark":"synced","ids":[...]}`) rather
// than a flag edited into an event. A line that does not parse is skipped and counted, not fatal.
//
// The file is written synchronously, before the bill's own file is saved, so a bill never changes without its event being on disk
// first. It is flushed to the operating system, not forced to the platter: a process crash loses nothing, a power cut may lose the newest line.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_FILE = path.join(DATA_DIR, 'invoice_events.jsonl');

const keyOf = (restaurantId, invoiceRef) => `${restaurantId}|${invoiceRef}`;
const isEventLine = o => o && typeof o === 'object'
  && typeof o.id === 'string' && typeof o.restaurant_id === 'string' && typeof o.invoice_ref === 'string'
  && Number.isInteger(o.seq) && typeof o.hash === 'string' && typeof o.type === 'string';

export class InvoiceEventStore {
  constructor({ file = DEFAULT_FILE } = {}) {
    this.file = file;
    this.reload();
  }

  /** Reads the file again, from scratch. */
  reload() {
    this.chains = new Map();        // restaurantId|invoiceRef -> events in order; insertion order is oldest bill first
    this.byId = new Map();
    this.synced = new Set();
    this.damagedLines = 0;
    this.needsNewline = false;

    let text = '';
    try {
      if (fs.existsSync(this.file)) text = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      console.warn(`⚠️ Could not read ${path.basename(this.file)}:`, err.message);
    }
    this.needsNewline = text.length > 0 && !text.endsWith('\n');

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { this.damagedLines++; continue; }
      if (parsed?.mark === 'synced' && Array.isArray(parsed.ids)) {
        for (const id of parsed.ids) this.synced.add(id);
      } else if (isEventLine(parsed)) {
        this.place(parsed);
      } else {
        this.damagedLines++;
      }
    }
    if (this.damagedLines) console.warn(`⚠️ ${this.damagedLines} unreadable line(s) in ${path.basename(this.file)} were skipped.`);
  }

  place(event) {
    const key = keyOf(event.restaurant_id, event.invoice_ref);
    if (!this.chains.has(key)) this.chains.set(key, []);
    this.chains.get(key).push(event);
    this.byId.set(event.id, event);
  }

  writeLines(lines) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const text = (this.needsNewline ? '\n' : '') + lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    fs.appendFileSync(this.file, text, 'utf-8');
    this.needsNewline = false;
  }

  /** Adds the next event of a bill: the next number, chained to the last. */
  append({ restaurantId, invoiceRef, type, actor, payload, occurredAt }) {
    const chain = this.chains.get(keyOf(restaurantId, invoiceRef)) || [];
    const last = chain[chain.length - 1];
    const event = buildEvent({
      restaurantId, invoiceRef, type, actor, payload, occurredAt,
      seq: last ? last.seq + 1 : 1,
      prevHash: last ? last.hash : GENESIS_HASH
    });
    this.writeLines([event]);
    this.place(event);
    return event;
  }

  list(restaurantId, invoiceRef) {
    return [...(this.chains.get(keyOf(restaurantId, invoiceRef)) || [])];
  }

  hasHistory(restaurantId, invoiceRef) {
    return this.chains.has(keyOf(restaurantId, invoiceRef));
  }

  head(restaurantId, invoiceRef) {
    const chain = this.chains.get(keyOf(restaurantId, invoiceRef));
    return chain?.length ? chain[chain.length - 1].hash : GENESIS_HASH;
  }

  verify(restaurantId, invoiceRef) {
    return verifyChain(this.list(restaurantId, invoiceRef));
  }

  /** Events the cloud has not confirmed: the oldest bill first, and in order within a bill. */
  listUnsynced(restaurantId) {
    const out = [];
    for (const chain of this.chains.values()) {
      if (chain[0].restaurant_id !== restaurantId) continue;
      for (const e of chain) if (!this.synced.has(e.id)) out.push(e);
    }
    return out;
  }

  listUnsyncedFor(restaurantId, invoiceRef) {
    return this.list(restaurantId, invoiceRef).filter(e => !this.synced.has(e.id));
  }

  /** The bills that have events to send. */
  unsyncedRefs(restaurantId) {
    const refs = [];
    for (const chain of this.chains.values()) {
      if (chain[0].restaurant_id === restaurantId && chain.some(e => !this.synced.has(e.id))) refs.push(chain[0].invoice_ref);
    }
    return refs;
  }

  /** Records that the cloud holds these events. Returns how many were newly marked. */
  markSynced(ids) {
    const fresh = [...new Set(ids)].filter(id => this.byId.has(id) && !this.synced.has(id));
    if (!fresh.length) return 0;
    this.writeLines([{ mark: 'synced', ids: fresh }]);
    for (const id of fresh) this.synced.add(id);
    return fresh.length;
  }

  /** Which of these bills have no history at all. */
  withoutHistory(restaurantId, bills) {
    return bills.filter(b => b.restaurant_id === restaurantId && !this.hasHistory(restaurantId, b.id));
  }

  isEmpty(restaurantId) {
    for (const chain of this.chains.values()) if (chain[0].restaurant_id === restaurantId) return false;
    return true;
  }

  /**
   * Fills an EMPTY store from the cloud, for a replacement laptop. Never merges: a hub that holds any history is the authority on it.
   * A history that does not verify is kept (it is evidence) and the bills it belongs to are named in `broken`.
   */
  restoreAll(restaurantId, events) {
    if (!this.isEmpty(restaurantId)) return { restored: 0, broken: [], reason: 'EVENTS_PRESENT' };
    const mine = (events || []).filter(e => e?.restaurant_id === restaurantId && isEventLine(e));
    if (!mine.length) return { restored: 0, broken: [] };

    const byBill = new Map();
    for (const e of mine) {
      if (!byBill.has(e.invoice_ref)) byBill.set(e.invoice_ref, []);
      byBill.get(e.invoice_ref).push(e);
    }
    const broken = [];
    const ordered = [];
    for (const [ref, list] of byBill) {
      list.sort((a, b) => a.seq - b.seq);
      if (!verifyChain(list).ok) broken.push(ref);
      ordered.push(...list);
    }
    this.writeLines([...ordered, { mark: 'synced', ids: ordered.map(e => e.id) }]);
    for (const e of ordered) { this.place(e); this.synced.add(e.id); }
    return { restored: ordered.length, broken };
  }
}

export const invoiceEventStore = new InvoiceEventStore();
