import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  paymentEvents, summarize, invoiceSideNotes, validateCloseInput, buildRecord, NOTES_MIN_LENGTH, round2
} from './reconciliation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'reconciliations.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Reconciliation records are append-only: once a shift is closed the record is the
 * audit trail and is never edited or deleted. The file is replaced atomically
 * (write a temp file, then rename), so a crash mid-write cannot leave half a record.
 */
export class ReconciliationStore {
  constructor() {
    this.records = this.load();
  }

  load() {
    try {
      if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    } catch (err) {
      console.warn('⚠️ Could not load reconciliations.json:', err.message);
    }
    return [];
  }

  persist() {
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf-8');
    fs.renameSync(tmp, FILE);
  }

  forTenant(restaurantId) {
    return this.records.filter(r => r.restaurant_id === restaurantId);
  }

  /** Newest first. */
  list(restaurantId) {
    return [...this.forTenant(restaurantId)].sort((a, b) => b.seq - a.seq);
  }

  get(id, restaurantId) {
    return this.forTenant(restaurantId).find(r => r.id === id || r.number === id) || null;
  }

  last(restaurantId) {
    return this.list(restaurantId)[0] || null;
  }

  /** Start of the current period: the moment of the last close (null before the first). */
  periodStartMs(restaurantId) {
    const last = this.last(restaurantId);
    return last ? new Date(last.period_end).getTime() : null;
  }

  /**
   * What the period since the last close looks like right now. Nothing is stored.
   * `suggested_opening_float` is what was left in the drawer at the last close.
   */
  preview(invoices, restaurantId, now = new Date()) {
    const fromMs = this.periodStartMs(restaurantId);
    const toMs = now.getTime();
    const events = paymentEvents(invoices, restaurantId);
    const summary = summarize(events, { fromMs, toMs });
    const last = this.last(restaurantId);
    // Before the first close the period starts at the first recorded payment (there is nothing earlier to count).
    const periodStart = fromMs !== null ? new Date(fromMs).toISOString() : (events[0] ? events[0].at : null);
    return {
      period_start: periodStart,
      period_end: now.toISOString(),
      since_last_close: Boolean(last),
      last_record: last ? { id: last.id, number: last.number, closed_at: last.period_end, status: last.status } : null,
      suggested_opening_float: last ? last.closing_float : 0,
      ...summary,
      ...invoiceSideNotes(invoices, restaurantId, { fromMs, toMs })
    };
  }

  /**
   * Close the shift: compute everything server-side for the period since the last
   * close, compare against what reception counted, and store the record.
   */
  close(invoices, restaurantId, input, now = new Date()) {
    const checked = validateCloseInput(input);
    if (!checked.ok) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', error: checked.errors[0].error, errors: checked.errors };
    }
    const values = checked.values;

    const fromMs = this.periodStartMs(restaurantId);
    const toMs = now.getTime();
    if (fromMs !== null && toMs < fromMs) {
      return {
        ok: false, status: 409, code: 'CLOCK_BEHIND_LAST_CLOSE',
        error: 'This computer\'s clock is earlier than the last close. Fix the date and time, then try again.'
      };
    }

    const events = paymentEvents(invoices, restaurantId);
    const summary = summarize(events, { fromMs, toMs });
    const notes = invoiceSideNotes(invoices, restaurantId, { fromMs, toMs });
    const firstEvent = events.find(e => e.ms >= (fromMs ?? -Infinity) && e.ms < toMs);
    const periodStartMs = fromMs !== null ? fromMs : (firstEvent ? firstEvent.ms : null);

    const record = buildRecord({ summary, values, periodStartMs, periodEndMs: toMs, notesFromInvoices: notes });

    if (record.has_variance && values.notes.length < NOTES_MIN_LENGTH) {
      return {
        ok: false, status: 400, code: 'NOTES_REQUIRED_FOR_VARIANCE',
        error: 'The counts do not match the system. Add a note explaining the difference before closing.',
        preview: record
      };
    }

    const seq = this.forTenant(restaurantId).reduce((m, r) => Math.max(m, r.seq), 0) + 1;
    const stored = {
      id: `rec_${now.getTime().toString(36)}_${seq}`,
      seq,
      number: `REC-${String(seq).padStart(6, '0')}`,
      restaurant_id: restaurantId,
      ...record
    };
    this.records = [...this.records, stored];
    try {
      this.persist();
    } catch (err) {
      this.records = this.records.filter(r => r.id !== stored.id);
      return { ok: false, status: 500, code: 'SAVE_FAILED', error: `Could not save the record: ${err.message}` };
    }
    return { ok: true, record: stored };
  }
}

export const reconciliationStore = new ReconciliationStore();
export { round2 };
