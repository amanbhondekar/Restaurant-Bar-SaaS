import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, checkSupabaseConnection, authenticateHubStaff } from './supabaseClient.js';
import { ticketStore } from './ticketStore.js';
import { hubConfig } from './hubConfig.js';
import { pushMenu, pushTables, isUuid } from './catalogSync.js';
import { pushInventory, pullInventory } from './inventorySync.js';
import { pushReservations, pullReservations } from './reservationSync.js';
import { reservationStore } from './reservationStore.js';
import { inventoryStore } from './inventoryStore.js';
import { pushInvoice, pullInvoices, countInvoices } from './invoiceSync.js';
import { invoiceStore } from './invoiceStore.js';
import { pushReconciliation, pullReconciliations, countReconciliations } from './reconciliationSync.js';
import { mergeById, byIssuedDesc, bySeqAsc, describeRepair, ledgerGap } from './ledgerRepair.js';
import { reconciliationStore } from './reconciliationStore.js';
import { pushFeedback, pullFeedback } from './feedbackSync.js';
import { feedbackStore } from './feedbackStore.js';
import { pushInvoiceEvents, pullInvoiceEvents } from './invoiceEventsSync.js';
import { invoiceEventStore } from './invoiceEventStore.js';
import { orderCourseColumns, itemCourseColumns, isMissingCourseColumn, withoutCourseColumns } from './courseSync.js';
import { appendRecord, encodeRecord, fsyncEnabled, lastCompleteRecord, SLOW_SYNC_MS } from './queueJournal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'sync_queue.json');
// Appended before every snapshot, emptied after. See lib/queueJournal.js for why.
const QUEUE_JOURNAL = path.join(DATA_DIR, 'sync_queue.wal');
const QUARANTINE_FILE = path.join(DATA_DIR, 'quarantine_sync_queue.json');
// Newest catalog revision the cloud is known to hold, per catalog. Survives restarts so the admin page
// can say "synced" without pushing again.
const CATALOG_STATE_FILE = path.join(DATA_DIR, 'catalog_sync.json');
// The hub's replicated catalogs. Each keeps one pending push (always the newest snapshot) and a
// record of the newest revision the cloud is known to hold. Stock is the third: it is not edited like
// the other two, but it is pushed the same way (a full snapshot), so it shares the machinery.
const CATALOG_OPS = { menu: 'SYNC_MENU', tables: 'SYNC_TABLES', inventory: 'SYNC_INVENTORY', reservations: 'SYNC_RESERVATIONS' };
const CATALOG_KINDS = Object.fromEntries(Object.entries(CATALOG_OPS).map(([kind, type]) => [type, kind]));
const isCatalogOp = item => Boolean(item) && item.type in CATALOG_KINDS;

const INVOICE_OP = 'SYNC_INVOICE';
const isInvoiceOp = item => item?.type === INVOICE_OP;

const RECONCILIATION_OP = 'SYNC_RECONCILIATION';
const isReconciliationOp = item => item?.type === RECONCILIATION_OP;

const FEEDBACK_OP = 'SYNC_FEEDBACK';
const isFeedbackOp = item => item?.type === FEEDBACK_OP;
const INVOICE_EVENTS_OP = 'SYNC_INVOICE_EVENTS';
const isInvoiceEventsOp = item => item?.type === INVOICE_EVENTS_OP;
export const MAX_SYNC_ATTEMPTS = 5;

/**
 * Distinguishes a hub-wide problem from a genuinely bad queue item.
 *
 * Quarantine exists to stop one malformed order blocking the queue. But an
 * unauthorised hub (RLS refusal, expired JWT, missing tenant binding) fails
 * *every* item identically -- counting those toward the retry limit would
 * quarantine the whole day's takings for what is really a config error.
 * Systemic failures pause the drain instead, and retry forever.
 */
/**
 * The complete leading entries of a truncated queue file, or null if none survive.
 *
 * The file is written with JSON.stringify(queue, null, 2), so every top-level entry ends on a
 * line that is exactly two spaces and a brace. Walking those boundaries from the end and closing
 * the array at the last one that parses recovers everything except the partial tail -- which is
 * the shape a crash mid-write leaves behind.
 */
export function salvageQueue(raw) {
  if (typeof raw !== 'string') return null;
  const MARKER = '\n  }';
  for (let end = raw.lastIndexOf(MARKER); end !== -1; end = raw.lastIndexOf(MARKER, end - 1)) {
    try {
      const candidate = JSON.parse(`${raw.slice(0, end + MARKER.length)}\n]`);
      // An entry that was itself cut short parses as something other than a list of objects.
      if (Array.isArray(candidate) && candidate.every(item => item && typeof item === 'object')) {
        return candidate;
      }
    } catch {
      // Truncated inside this entry; try the boundary before it.
    }
  }
  return null;
}

export function isSystemicFailure(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const message = String(err.message || '').toLowerCase();
  return (
    code === '42501' ||            // row-level security violation
    code === 'PGRST301' ||         // JWT expired / invalid
    code === '28000' ||            // invalid authorization
    err.status === 401 ||
    err.status === 403 ||
    message.includes('row-level security') ||
    message.includes('jwt') ||
    message.includes('not authorized') ||
    message.includes('permission denied')
  );
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class SyncQueue {
  constructor() {
    this.queue = this.loadQueue();
    this.isOnline = true;
    this.isSyncing = false;
    this.lastSyncedAt = null;
    this.onStatusChangeCallbacks = [];
    this.onReconnectCallbacks = [];
    // Set by the sync methods when a failure looks hub-wide rather than item-specific.
    this.lastFailureSystemic = false;
    // Seams for tests: the connectivity probe and the cloud client.
    this.checkConnection = checkSupabaseConnection;
    this.cloud = supabase;
    this.catalogState = this.loadCatalogState();
    // Queue writes are serialised through this, the same way restaurantCache serialises catalog
    // writes. See saveQueue.
    this._writeChain = Promise.resolve();
  }

  loadCatalogState() {
    try {
      if (fs.existsSync(CATALOG_STATE_FILE)) return JSON.parse(fs.readFileSync(CATALOG_STATE_FILE, 'utf-8'));
    } catch (err) {
      console.warn('⚠️ Could not load catalog_sync.json:', err.message);
    }
    return {};
  }

  saveCatalogState(kind, synced_revision) {
    this.catalogState = { ...this.catalogState, [kind]: { synced_revision } };
    // Tiny and rare, so written synchronously and via rename: a crash never leaves half a file.
    try {
      const tmp = `${CATALOG_STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.catalogState, null, 2), 'utf-8');
      fs.renameSync(tmp, CATALOG_STATE_FILE);
    } catch (err) {
      console.error('❌ Could not save catalog_sync.json:', err);
    }
  }

  /**
   * The queue as the hub last committed it.
   *
   * The journal wins whenever it holds a complete state: it is written BEFORE the snapshot, so it
   * is never older, and it is the only one of the two that cannot have been damaged by a crash
   * part-way through a write. It is empty in the ordinary case (truncated after each snapshot),
   * which is why the snapshot is still the usual answer.
   */
  loadQueue() {
    const journalled = this.loadJournal();
    if (journalled) return journalled;

    let raw = null;
    try {
      if (!fs.existsSync(QUEUE_FILE)) return [];
      raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('sync_queue.json does not hold a list');
      return parsed;
    } catch (err) {
      return this.recoverQueue(raw, err);
    }
  }

  /**
   * The newest complete state in the journal, or null when there is nothing usable in it.
   *
   * A journal that survived a restart means the hub stopped between committing a state and
   * finishing the snapshot, so it is worth saying so: it is the one moment this machinery exists
   * for, and silence would make a real crash indistinguishable from a clean shutdown.
   */
  loadJournal() {
    let raw;
    try {
      if (!fs.existsSync(QUEUE_JOURNAL)) return null;
      raw = fs.readFileSync(QUEUE_JOURNAL, 'utf-8');
    } catch (err) {
      console.warn(`⚠️ Could not read ${path.basename(QUEUE_JOURNAL)}: ${err.message}`);
      return null;
    }
    const record = lastCompleteRecord(raw);
    if (!record) return null;
    console.warn(
      `🛟 The hub stopped before it finished saving its sync queue. Recovered ${record.queue.length} ` +
      `item(s) from ${path.basename(QUEUE_JOURNAL)}${record.at ? `, committed ${record.at}` : ''}.`
    );
    return record.queue;
  }

  /**
   * What to do with a queue file that will not parse.
   *
   * This used to warn and return an empty queue, which is the worst available answer: the file
   * holds orders and bills that never reached the cloud, and the next save overwrites it, so a
   * single torn write silently destroyed a restaurant's unsent takings. Instead: keep a copy of
   * exactly what was on disk, salvage whatever complete entries survive, and say so loudly.
   */
  recoverQueue(raw, err) {
    const salvaged = salvageQueue(raw);
    let kept = null;
    if (raw !== null) {
      try {
        kept = path.join(DATA_DIR, `sync_queue.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(kept, raw, 'utf-8');
      } catch (copyErr) {
        kept = null;
        console.error('❌ Could not preserve the unreadable queue file:', copyErr.message);
      }
    }
    console.error(
      `🚨 sync_queue.json could not be read (${err.message}). ` +
      `${salvaged ? `Recovered ${salvaged.length} complete item(s); anything after them is lost.` : 'Nothing could be recovered.'}` +
      `${kept ? ` The file as found is kept at ${path.basename(kept)}.` : ''}`
    );
    return salvaged || [];
  }

  /**
   * Append to the journal and sync it to disk (lib/queueJournal.js). A disk that refuses to sync, or one that is
   * slow at it, is said once a minute rather than on every save, so the log shows the cause without drowning in it.
   */
  async appendToJournal(record) {
    const say = message => {
      const now = Date.now();
      if (this._lastJournalWarning && now - this._lastJournalWarning < 60000) return;
      this._lastJournalWarning = now;
      console.warn(message);
    };
    const { syncMs } = await appendRecord(QUEUE_JOURNAL, record, {
      fsync: fsyncEnabled(),
      onSyncError: err => say(`⚠️ Could not sync ${path.basename(QUEUE_JOURNAL)} to disk (${err.code || err.message}); a power cut could lose the newest unsent takings.`)
    });
    if (syncMs !== null && syncMs > SLOW_SYNC_MS) {
      say(`⚠️ Syncing ${path.basename(QUEUE_JOURNAL)} took ${Math.round(syncMs)} ms. Set HUB_QUEUE_FSYNC=0 to turn it off if this disk is too slow.`);
    }
  }

  saveQueue(queueList) {
    this.queue = queueList;
    this.notifyStatusChange();
    // Non-blocking, but serialised. Clearing a table saves the queue several times in quick
    // succession (the ticket updates, then the bill), and unchained writes finish in whatever
    // order the OS returns them -- so the file could end up holding an older snapshot than
    // memory and silently lose the newest ops if the hub then stopped. Chaining keeps the last
    // call the last write. Both payloads are built now, not inside the chain, so each link
    // writes the queue as it was when that save was asked for.
    //
    // The journal is appended FIRST and emptied LAST, which is what makes a crash survivable:
    // an append cannot damage what is already on disk, so the state is durable before the
    // snapshot -- the part that CAN be torn -- is touched at all. See lib/queueJournal.js.
    const record = encodeRecord(queueList);
    const snapshot = JSON.stringify(queueList, null, 2);
    this._writeChain = this._writeChain
      .then(() => this.appendToJournal(record))
      .then(() => fs.promises.writeFile(QUEUE_FILE, snapshot, 'utf-8'))
      // Only now is the snapshot known to hold this state, so the journal has nothing left to
      // protect. Truncating rather than deleting keeps one file for the life of the hub.
      .then(() => fs.promises.truncate(QUEUE_JOURNAL, 0))
      .catch(err => console.error('❌ Async save queue error:', err));
    return true;
  }

  async quarantineItem(item, reason) {
    let currentQuarantine = [];
    try {
      if (fs.existsSync(QUARANTINE_FILE)) {
        currentQuarantine = JSON.parse(fs.readFileSync(QUARANTINE_FILE, 'utf-8'));
      }
    } catch (e) {}

    const quarantinedRecord = {
      ...item,
      quarantined_at: new Date().toISOString(),
      quarantine_reason: reason || 'Max retry attempts exceeded'
    };

    currentQuarantine.push(quarantinedRecord);
    try {
      await fs.promises.writeFile(QUARANTINE_FILE, JSON.stringify(currentQuarantine, null, 2), 'utf-8');
      console.warn(`[sync] 📦 Item ${item.queue_id} quarantined to quarantine_sync_queue.json.`);
    } catch (err) {
      console.error('[sync] ❌ Failed to write quarantine_sync_queue.json:', err);
    }
  }

  readQuarantine() {
    try {
      if (fs.existsSync(QUARANTINE_FILE)) {
        return JSON.parse(fs.readFileSync(QUARANTINE_FILE, 'utf-8'));
      }
    } catch (err) {
      console.warn('[sync] Could not read quarantine file:', err.message);
    }
    return [];
  }

  /**
   * Returns quarantined items to the live queue with their retry budget reset.
   * Used after fixing a hub-wide problem (provisioning secret, missing migration)
   * that caused otherwise-valid orders to be shelved.
   */
  async requeueQuarantined() {
    const shelved = this.readQuarantine();
    if (!shelved.length) return { requeued: 0 };

    const restored = shelved.map(({ quarantined_at, quarantine_reason, ...item }) => ({
      ...item,
      attempts: 0
    }));

    // A quarantined snapshot may be older than one queued since; only the newest per catalog goes back.
    let merged = [...this.queue];
    for (const item of restored) merged = isCatalogOp(item) ? this.mergeCatalogOp(merged, item) : [...merged, item];
    this.saveQueue(merged);

    try {
      await fs.promises.writeFile(QUARANTINE_FILE, '[]', 'utf-8');
    } catch (err) {
      console.error('[sync] ❌ Failed to clear quarantine file:', err);
    }

    console.log(`[sync] ♻️ Requeued ${restored.length} quarantined item(s) for another attempt.`);
    this.processQueue();
    return { requeued: restored.length };
  }

  onReconnected(callback) {
    this.onReconnectCallbacks.push(callback);
    return () => {
      this.onReconnectCallbacks = this.onReconnectCallbacks.filter(cb => cb !== callback);
    };
  }

  notifyReconnected() {
    this.onReconnectCallbacks.forEach(cb => {
      try {
        cb();
      } catch (err) {
        console.error('Error in onReconnect callback:', err);
      }
    });
  }

  onStatusChange(callback) {
    this.onStatusChangeCallbacks.push(callback);
    return () => {
      this.onStatusChangeCallbacks = this.onStatusChangeCallbacks.filter(cb => cb !== callback);
    };
  }

  notifyStatusChange() {
    const status = this.getStatus();
    this.onStatusChangeCallbacks.forEach(cb => {
      try {
        cb(status);
      } catch (err) {
        console.error('Error in sync status change callback:', err);
      }
    });
  }

  /** Per catalog: is a push waiting, did one get shelved, and which revision does the cloud hold. */
  getCatalogStatus() {
    const shelved = this.readQuarantine();
    const status = {};
    for (const [kind, type] of Object.entries(CATALOG_OPS)) {
      const waiting = this.queue.find(q => q.type === type);
      status[kind] = {
        synced_revision: this.catalogState[kind]?.synced_revision ?? 0,
        pending_revision: waiting ? waiting.payload.revision : null,
        failed: shelved.some(q => q.type === type)
      };
    }
    return status;
  }

  getStatus() {
    return {
      queued: this.queue.length,
      // Shelved orders are revenue that never reached the cloud. Surfacing the
      // count keeps that from being a console-only event.
      // Orders only: a shelved menu push is reported under `catalog`, not as lost takings.
      quarantined: this.readQuarantine().filter(q => !isCatalogOp(q)).length,
      online: this.isOnline,
      isSyncing: this.isSyncing,
      last_synced_at: this.lastSyncedAt,
      catalog: this.getCatalogStatus()
    };
  }

  enqueueTicket(ticket) {
    const queueItem = {
      queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: 'CREATE_ORDER',
      ticket,
      queued_at: new Date().toISOString(),
      attempts: 0
    };
    const updated = [...this.queue, queueItem];
    this.saveQueue(updated);
    // Trigger immediate async attempt without awaiting or blocking caller
    this.processQueue();
  }

  /**
   * Queues a status change. Pass the ticket (as it stands after the change) and its course state
   * travels with the status: a station marking its part ready or a course being fired changes the
   * state without always changing the status, so the status alone would lose it.
   */
  enqueueStatusUpdate(ticketId, newStatus, restaurantId, ticket, { requestId } = {}) {
    // The id the order was inserted under (see syncOrderToSupabase). The ticket NUMBER is not an identity:
    // it restarts at 101 on a hub whose data directory was lost, so a change aimed at the number alone
    // rewrites every older order that ever had it.
    const orderRequestId = requestId ?? (ticket ? (ticket.order_request_id || ticket.id) : undefined);
    const queueItem = {
      queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: 'UPDATE_STATUS',
      payload: {
        ticketId, status: newStatus, restaurantId,
        ...(orderRequestId ? { requestId: orderRequestId } : {}),
        ...(ticket ? { course: orderCourseColumns(ticket) } : {})
      },
      queued_at: new Date().toISOString(),
      attempts: 0
    };
    const updated = [...this.queue, queueItem];
    this.saveQueue(updated);
    this.processQueue();
  }

  // Keeps one pending push per catalog, always the newest snapshot: a day of offline edits is one push.
  mergeCatalogOp(queue, op) {
    const kept = [];
    let newest = op;
    for (const q of queue) {
      if (q.type !== op.type) kept.push(q);
      else if (q.payload.revision > newest.payload.revision) newest = q;
    }
    return [...kept, newest];
  }

  /**
   * Queues one bill for the cloud. Each push is a full snapshot upserted on the hub's invoice id,
   * so a bill that is issued, paid and then refunded while the hub is offline leaves one queued
   * push carrying its final state rather than three carrying a history the cloud never needed.
   */
  enqueueInvoice(invoice) {
    const pairing = hubConfig.getPairingInfo();
    const restaurantId = invoice?.restaurant_id || pairing.restaurant_id || null;
    if (!invoice?.id) return;

    // The cloud's copy is stale from the moment the bill changes, not from when the push fails.
    invoiceStore.markPending(invoice.id, restaurantId);
    this.saveQueue(this.mergeInvoiceOp(this.queue, this.invoiceOp(invoice, restaurantId)));
    // The history behind this change goes with it. It is a separate push because it is a separate table, and it never holds up the bill.
    this.enqueueInvoiceEvents(invoice.id, restaurantId);
    this.processQueue();
  }

  invoiceOp(invoice, restaurantId) {
    return {
      queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: INVOICE_OP,
      payload: {
        // The restaurant the bill was raised for. A hub re-paired before the push must not
        // write it to the new one.
        restaurant_id: restaurantId,
        invoice
      },
      queued_at: new Date().toISOString(),
      attempts: 0
    };
  }

  /**
   * Queues every bill the cloud has not confirmed, in one pass.
   *
   * Replication is driven by state changes, so a bill issued before migration 005 -- or while
   * the cloud was rejecting pushes -- has nothing coming to carry it up and would stay on this
   * laptop forever. Runs at boot; a no-op once the ledger is fully replicated.
   */
  enqueueUnsyncedInvoices(restaurantId) {
    const pending = invoiceStore.listUnsynced(restaurantId);
    if (!pending.length) return { queued: 0 };

    let queue = this.queue;
    for (const invoice of pending) {
      queue = this.mergeInvoiceOp(queue, this.invoiceOp(invoice, restaurantId));
    }
    // One save and one drain for the whole ledger rather than per bill.
    this.saveQueue(queue);
    console.log(`[sync] 📒 Queued ${pending.length} unreplicated bill(s) for the cloud.`);
    this.processQueue();
    return { queued: pending.length };
  }

  /** Collapses queued pushes for the same bill, keeping the newest snapshot. */
  mergeInvoiceOp(queue, op) {
    const id = op.payload.invoice.id;
    return [...queue.filter(q => !(isInvoiceOp(q) && q.payload?.invoice?.id === id)), op];
  }

  /**
   * Queues one closed shift. Cash-ups are immutable, so there is nothing to collapse: a record
   * already queued is simply left alone rather than replaced with an identical copy.
   */
  enqueueReconciliation(record) {
    const pairing = hubConfig.getPairingInfo();
    const restaurantId = record?.restaurant_id || pairing.restaurant_id || null;
    if (!record?.id) return;
    if (this.queue.some(q => isReconciliationOp(q) && q.payload?.record?.id === record.id)) return;

    this.saveQueue([...this.queue, {
      queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: RECONCILIATION_OP,
      payload: { restaurant_id: restaurantId, record },
      queued_at: new Date().toISOString(),
      attempts: 0
    }]);
    this.processQueue();
  }

  /**
   * Fills an empty ledger from the cloud. For a reinstalled or replaced reception laptop: the
   * hub pushes bills and cash-ups but has never read them back, so a fresh hub started with no
   * financial history at all and -- worse -- reissued INV-000001, which migration 005's unique
   * index rejects, leaving those bills unable to sync for as long as the hub ran.
   *
   * Deliberately only ever fills, never merges. A hub that already holds bills is the authority
   * on them; pulling the cloud's copy over the top could resurrect a locally voided bill or
   * overwrite a settlement that has not been pushed yet. If either store has anything, that
   * store is left alone.
   */
  async restoreLedgerFromCloud(restaurantId) {
    const pairing = hubConfig.getPairingInfo();
    if (!pairing.paired || !isUuid(restaurantId) || String(restaurantId) !== String(pairing.restaurant_id)) {
      return { restored: false, reason: 'NOT_PAIRED' };
    }
    const wantInvoices = invoiceStore.listInvoices(restaurantId).length === 0;
    const wantCashups = reconciliationStore.list(restaurantId).length === 0;
    if (!wantInvoices && !wantCashups) return { restored: false, reason: 'LEDGER_PRESENT' };

    const { online } = await this.checkConnection();
    if (!online) return { restored: false, reason: 'OFFLINE' };

    let invoices = 0;
    let cashups = 0;
    try {
      if (wantInvoices) {
        const rows = await pullInvoices(this.cloud, restaurantId);
        if (rows.length) {
          invoiceStore.invoices = rows;
          invoiceStore.save();
          invoices = rows.length;
        }
      }
      if (wantCashups) {
        const rows = await pullReconciliations(this.cloud, restaurantId);
        if (rows.length) {
          reconciliationStore.records = rows;
          reconciliationStore.persist();
          cashups = rows.length;
        }
      }
    } catch (err) {
      // Fail soft, exactly like the plan sync: an empty ledger is bad, but refusing to boot
      // because the cloud is unreachable would be worse. The next boot tries again.
      console.warn(`⚠️ Could not restore the ledger from the cloud: ${err.message}`);
      return { restored: false, reason: 'CLOUD_ERROR', detail: err.message };
    }

    if (invoices || cashups) {
      console.log(`📥 Restored ${invoices} bill(s) and ${cashups} cash-up(s) from the cloud.`);
    }
    return { restored: Boolean(invoices || cashups), invoices, cashups };
  }

  /**
   * Whether the cloud holds bills or cash-ups this hub does not, from counts alone.
   *
   * Runs at boot when the ledger is NOT empty -- the case `restoreLedgerFromCloud` refuses and
   * where a shortfall would otherwise never be noticed by anyone. Two counting queries, and every
   * failure is soft: not knowing is not a reason to hold up a hub that is about to open.
   */
  async checkLedgerGap(restaurantId) {
    const pairing = hubConfig.getPairingInfo();
    if (!pairing.paired || !isUuid(restaurantId) || String(restaurantId) !== String(pairing.restaurant_id)) {
      return { checked: false, reason: 'NOT_PAIRED' };
    }
    const { online } = await this.checkConnection();
    if (!online) return { checked: false, reason: 'OFFLINE' };

    try {
      const gap = ledgerGap({
        localInvoices: invoiceStore.listInvoices(restaurantId).length,
        cloudInvoices: await countInvoices(this.cloud, restaurantId),
        localCashups: reconciliationStore.list(restaurantId).length,
        cloudCashups: await countReconciliations(this.cloud, restaurantId)
      });
      this.lastLedgerGap = { ...gap, at: new Date().toISOString() };
      if (gap.short) {
        console.warn(
          `⚠️ The cloud holds ${gap.invoices} bill(s) and ${gap.cashups} cash-up(s) this hub does not. ` +
          'Reception can fill the gap from Cash & payments -> Repair ledger; nothing already here is changed.'
        );
      }
      return { checked: true, ...gap };
    } catch (err) {
      console.warn(`⚠️ Could not compare the ledger with the cloud: ${err.message}`);
      return { checked: false, reason: 'CLOUD_ERROR', detail: err.message };
    }
  }

  /**
   * Fills the gaps in a partial ledger from the cloud. With `apply: false` (the default) it only
   * reports what it WOULD add, so reception can look before it leaps.
   *
   * The merge rule is in lib/ledgerRepair.js: a union keyed on the hub's own id, where anything
   * already here wins. Nothing is overwritten and nothing is removed.
   */
  async repairLedgerFromCloud(restaurantId, { apply = false } = {}) {
    const pairing = hubConfig.getPairingInfo();
    if (!pairing.paired || !isUuid(restaurantId) || String(restaurantId) !== String(pairing.restaurant_id)) {
      return { ok: false, reason: 'NOT_PAIRED' };
    }
    const { online } = await this.checkConnection();
    if (!online) return { ok: false, reason: 'OFFLINE' };

    let cloudInvoices;
    let cloudCashups;
    try {
      cloudInvoices = await pullInvoices(this.cloud, restaurantId);
      cloudCashups = await pullReconciliations(this.cloud, restaurantId);
    } catch (err) {
      console.warn(`⚠️ Could not read the cloud ledger: ${err.message}`);
      return { ok: false, reason: 'CLOUD_ERROR', detail: err.message };
    }

    const bills = mergeById(invoiceStore.listInvoices(restaurantId), cloudInvoices, byIssuedDesc);
    const cashups = mergeById(reconciliationStore.list(restaurantId), cloudCashups, bySeqAsc);
    const described = describeRepair({ invoices: bills.added, cashups: cashups.added });
    const result = {
      ok: true,
      applied: false,
      added: { invoices: bills.added.length, cashups: cashups.added.length },
      invoice_numbers: bills.added.map(i => i.invoice_number).filter(Boolean),
      ...described
    };
    if (!apply || !described.changed) return result;

    // Everything pulled is already in the cloud, so it is stored as replicated: the backfill that
    // follows must not push it all straight back up.
    invoiceStore.invoices = bills.merged;
    invoiceStore.save();
    reconciliationStore.records = cashups.merged;
    reconciliationStore.persist();
    console.log(`🩹 Ledger repaired: added ${bills.added.length} bill(s) and ${cashups.added.length} cash-up(s) from the cloud.`);
    return { ...result, applied: true };
  }

  /**
   * Queues one piece of guest feedback. Immutable once given, so nothing to collapse: an entry already
   * queued is left alone. Called when the guest submits, and by the boot backfill.
   */
  enqueueFeedback(entry) {
    const pairing = hubConfig.getPairingInfo();
    const restaurantId = entry?.restaurant_id || pairing.restaurant_id || null;
    if (!entry?.id) return;
    if (this.queue.some(q => isFeedbackOp(q) && q.payload?.entry?.id === entry.id)) return;

    this.saveQueue([...this.queue, {
      queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: FEEDBACK_OP,
      payload: { restaurant_id: restaurantId, entry },
      queued_at: new Date().toISOString(),
      attempts: 0
    }]);
    this.processQueue();
  }

  /** Queues every entry the cloud has not confirmed. Runs at boot, after the restore. */
  enqueueUnsyncedFeedback(restaurantId) {
    const pending = feedbackStore.listUnsynced(restaurantId);
    if (!pending.length) return { queued: 0 };
    for (const entry of pending) this.enqueueFeedback(entry);
    console.log(`[sync] ⭐ Queued ${pending.length} unreplicated piece(s) of guest feedback for the cloud.`);
    return { queued: pending.length };
  }

  async syncFeedbackToSupabase(item) {
    const { restaurant_id, entry } = item.payload;
    const pairing = hubConfig.getPairingInfo();

    if (!pairing.paired || !isUuid(restaurant_id) || String(restaurant_id) !== String(pairing.restaurant_id)) {
      console.warn(`[sync] ⚠️ Dropping ${FEEDBACK_OP} (${entry?.id}): it was left for a different restaurant than this hub is paired with.`);
      return true;
    }

    try {
      const pushed = await pushFeedback(this.cloud, restaurant_id, entry);
      console.log(`[sync] ✅ Guest feedback ${pushed.id} (${pushed.rating}/5) pushed to Supabase`);
      return true;
    } catch (err) {
      this.lastFailureSystemic = isSystemicFailure(err);
      console.error(`[sync] ❌ ${FEEDBACK_OP} failed:`, { message: err.message, code: err.code || 'unknown', details: err.details || err.hint || null });
      return false;
    }
  }

  /**
   * Fills an EMPTY feedback store from the cloud, for a replacement laptop. Never merges: a hub that holds
   * any feedback is the authority on it.
   */
  async restoreFeedbackFromCloud(restaurantId) {
    const pairing = hubConfig.getPairingInfo();
    if (!pairing.paired || !isUuid(restaurantId) || String(restaurantId) !== String(pairing.restaurant_id)) {
      return { restored: false, reason: 'NOT_PAIRED' };
    }
    if (!feedbackStore.isEmpty(restaurantId)) return { restored: false, reason: 'FEEDBACK_PRESENT' };

    const { online } = await this.checkConnection();
    if (!online) return { restored: false, reason: 'OFFLINE' };

    let pulled;
    try {
      pulled = await pullFeedback(this.cloud, restaurantId);
    } catch (err) {
      console.warn(`⚠️ Could not restore guest feedback from the cloud: ${err.message}`);
      return { restored: false, reason: 'CLOUD_ERROR', detail: err.message };
    }
    if (!pulled.length) return { restored: false, reason: 'NOTHING_IN_CLOUD' };

    const restored = feedbackStore.restoreAll(restaurantId, pulled);   // re-checks emptiness: a guest may have answered meanwhile
    if (restored) console.log(`📥 Restored ${restored} piece(s) of guest feedback from the cloud.`);
    return { restored: restored > 0, count: restored };
  }

  /**
   * Queues the unsent events of one bill. One push per bill, however often this is asked: the push reads what is unsent when it RUNS,
   * so events recorded after it was queued ride along with it, and they always go up in order, in one call.
   */
  enqueueInvoiceEvents(invoiceRef, restaurantId) {
    if (!invoiceRef || !restaurantId) return false;
    if (!invoiceEventStore.listUnsyncedFor(restaurantId, invoiceRef).length) return false;
    if (this.queue.some(q => isInvoiceEventsOp(q) && q.payload?.invoice_ref === invoiceRef && q.payload?.restaurant_id === restaurantId)) return false;

    this.saveQueue([...this.queue, {
      queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: INVOICE_EVENTS_OP,
      payload: { restaurant_id: restaurantId, invoice_ref: invoiceRef },
      queued_at: new Date().toISOString(),
      attempts: 0
    }]);
    this.processQueue();
    return true;
  }

  /**
   * Gives bills that have no history a baseline, then queues every bill that has events the cloud has not confirmed. Runs at boot, after
   * the restore. A bill restored from the cloud later than this runs gets its baseline the first time it changes.
   */
  enqueueUnsyncedInvoiceEvents(restaurantId) {
    const { recorded: baselines } = invoiceStore.recordBaselines(restaurantId);
    const refs = invoiceEventStore.unsyncedRefs(restaurantId);
    let queued = 0;
    for (const ref of refs) if (this.enqueueInvoiceEvents(ref, restaurantId)) queued++;
    if (queued) console.log(`[sync] 📜 Queued the unsent history of ${queued} bill(s) for the cloud.`);
    return { queued, baselines };
  }

  async syncInvoiceEventsToSupabase(item) {
    const { restaurant_id, invoice_ref } = item.payload;
    const pairing = hubConfig.getPairingInfo();

    if (!pairing.paired || !isUuid(restaurant_id) || String(restaurant_id) !== String(pairing.restaurant_id)) {
      console.warn(`[sync] ⚠️ Dropping ${INVOICE_EVENTS_OP} (${invoice_ref}): it was left for a different restaurant than this hub is paired with.`);
      return true;
    }

    const events = invoiceEventStore.listUnsyncedFor(restaurant_id, invoice_ref);
    if (!events.length) return true;

    try {
      const pushed = await pushInvoiceEvents(this.cloud, restaurant_id, events);
      invoiceEventStore.markSynced(pushed.ids);
      console.log(`[sync] ✅ ${pushed.ids.length} event(s) of bill ${invoice_ref} pushed to Supabase`);
      return true;
    } catch (err) {
      this.lastFailureSystemic = isSystemicFailure(err);
      console.error(`[sync] ❌ ${INVOICE_EVENTS_OP} failed:`, { message: err.message, code: err.code || 'unknown', details: err.details || err.hint || null });
      return false;
    }
  }

  /**
   * Fills an EMPTY history from the cloud, for a replacement laptop. Never merges: a hub that holds any history is the authority on it.
   * A restored history that does not verify is kept and reported, not thrown away.
   */
  async restoreInvoiceEventsFromCloud(restaurantId) {
    const pairing = hubConfig.getPairingInfo();
    if (!pairing.paired || !isUuid(restaurantId) || String(restaurantId) !== String(pairing.restaurant_id)) {
      return { restored: false, reason: 'NOT_PAIRED' };
    }
    if (!invoiceEventStore.isEmpty(restaurantId)) return { restored: false, reason: 'EVENTS_PRESENT' };

    const { online } = await this.checkConnection();
    if (!online) return { restored: false, reason: 'OFFLINE' };

    let pulled;
    try {
      pulled = await pullInvoiceEvents(this.cloud, restaurantId);
    } catch (err) {
      console.warn(`⚠️ Could not restore the history of bills from the cloud: ${err.message}`);
      return { restored: false, reason: 'CLOUD_ERROR', detail: err.message };
    }
    if (!pulled.length) return { restored: false, reason: 'NOTHING_IN_CLOUD' };

    const result = invoiceEventStore.restoreAll(restaurantId, pulled);   // re-checks emptiness: a bill may have changed meanwhile
    if (result.restored) console.log(`📥 Restored ${result.restored} event(s) of bill history from the cloud.`);
    if (result.broken.length) console.error(`🚨 The restored history of ${result.broken.length} bill(s) does not verify: ${result.broken.slice(0, 5).join(', ')}${result.broken.length > 5 ? ', ...' : ''}. It was kept as evidence.`);
    return { restored: result.restored > 0, count: result.restored, broken: result.broken };
  }

  /** Queues every cash-up the cloud has not confirmed. Runs at boot, alongside the bills. */
  enqueueUnsyncedReconciliations(restaurantId) {
    const pending = reconciliationStore.listUnsynced(restaurantId);
    if (!pending.length) return { queued: 0 };
    for (const record of pending) this.enqueueReconciliation(record);
    console.log(`[sync] 🧾 Queued ${pending.length} unreplicated cash-up(s) for the cloud.`);
    return { queued: pending.length };
  }

  async syncReconciliationToSupabase(item) {
    const { restaurant_id, record } = item.payload;
    const pairing = hubConfig.getPairingInfo();

    if (!pairing.paired || !isUuid(restaurant_id) || String(restaurant_id) !== String(pairing.restaurant_id)) {
      console.warn(`[sync] ⚠️ Dropping ${RECONCILIATION_OP} (${record?.number}): it was closed for a different restaurant than this hub is paired with.`);
      return true;
    }

    try {
      const pushed = await pushReconciliation(this.cloud, restaurant_id, record);
      console.log(`[sync] ✅ Cash-up ${pushed.number} (${pushed.status}) pushed to Supabase`);
      return true;
    } catch (err) {
      this.lastFailureSystemic = isSystemicFailure(err);
      console.error(`[sync] ❌ ${RECONCILIATION_OP} failed:`, { message: err.message, code: err.code || 'unknown', details: err.details || err.hint || null });
      return false;
    }
  }

  async syncInvoiceToSupabase(item) {
    const { restaurant_id, invoice } = item.payload;
    const pairing = hubConfig.getPairingInfo();

    if (!pairing.paired || !isUuid(restaurant_id) || String(restaurant_id) !== String(pairing.restaurant_id)) {
      // Nothing can make this bill correct later, so drop it rather than retry or write it to
      // the wrong tenant's revenue.
      console.warn(`[sync] ⚠️ Dropping ${INVOICE_OP} (${invoice?.invoice_number}): it was raised for a different restaurant than this hub is paired with.`);
      return true;
    }

    try {
      const pushed = await pushInvoice(this.cloud, restaurant_id, invoice);
      console.log(`[sync] ✅ Invoice ${pushed.invoice_number} (${pushed.payment_status}) pushed to Supabase`);
      return true;
    } catch (err) {
      this.lastFailureSystemic = isSystemicFailure(err);
      console.error(`[sync] ❌ ${INVOICE_OP} failed:`, { message: err.message, code: err.code || 'unknown', details: err.details || err.hint || null });
      return false;
    }
  }

  /** Queues the diary if the cloud has not confirmed the hub's current revision. See stock. */
  enqueueReservationsIfBehind(restaurantId) {
    const state = reservationStore.stateFor(restaurantId);
    if (!state.restaurant_id || state.revision === 0) return { queued: false, reason: 'NOTHING_TO_PUSH' };
    if (state.revision <= (this.catalogState.reservations?.synced_revision ?? 0)) return { queued: false, reason: 'UP_TO_DATE' };
    this.enqueueCatalog('reservations', { restaurant_id: state.restaurant_id, revision: state.revision, ...reservationStore.all(restaurantId) });
    return { queued: true, revision: state.revision };
  }

  /**
   * Fills an EMPTY diary from the cloud, for a replacement laptop. Same rule as stock: only ever a
   * store that has never held anything (revision 0), so a restaurant that deliberately cleared the
   * book does not have last month's no-shows handed back to it.
   */
  async restoreReservationsFromCloud(restaurantId) {
    const pairing = hubConfig.getPairingInfo();
    if (!pairing.paired || !isUuid(restaurantId) || String(restaurantId) !== String(pairing.restaurant_id)) {
      return { restored: false, reason: 'NOT_PAIRED' };
    }
    if (reservationStore.state.revision > 0 || !reservationStore.isEmpty()) return { restored: false, reason: 'DIARY_PRESENT' };

    const { online } = await this.checkConnection();
    if (!online) return { restored: false, reason: 'OFFLINE' };

    let pulled;
    try {
      pulled = await pullReservations(this.cloud, restaurantId);
    } catch (err) {
      console.warn(`⚠️ Could not restore the booking diary from the cloud: ${err.message}`);
      return { restored: false, reason: 'CLOUD_ERROR', detail: err.message };
    }
    if (!pulled.reservations.length && !pulled.waitlist.length) return { restored: false, reason: 'NOTHING_IN_CLOUD' };
    if (reservationStore.state.revision > 0 || !reservationStore.isEmpty()) return { restored: false, reason: 'DIARY_PRESENT' };

    const state = reservationStore.replaceAll(restaurantId, { ...pulled, revision: 1 });
    this.saveCatalogState('reservations', state.revision);
    console.log(`📥 Restored ${state.reservations.length} booking(s) and ${state.waitlist.length} queued party/parties from the cloud.`);
    return { restored: true, reservations: state.reservations.length, waitlist: state.waitlist.length };
  }

  /**
   * Queues the stock snapshot if the cloud has not confirmed the hub's current revision. Pushes are
   * driven by a change, so stock changed while the cloud was rejecting pushes (or before migration
   * 009 existed) has nothing coming to carry it up. Runs at boot; a no-op once the cloud is level.
   */
  enqueueInventoryIfBehind(restaurantId) {
    const state = inventoryStore.stateFor(restaurantId);
    if (!state.restaurant_id || state.revision === 0) return { queued: false, reason: 'NOTHING_TO_PUSH' };
    if (state.revision <= (this.catalogState.inventory?.synced_revision ?? 0)) return { queued: false, reason: 'UP_TO_DATE' };
    this.enqueueCatalog('inventory', state);
    return { queued: true, revision: state.revision };
  }

  /**
   * Fills an EMPTY inventory from the cloud, for a reinstalled or replaced reception laptop. It will
   * only ever act on a store that has never held anything (revision 0). A store whose owner deleted
   * every ingredient is also empty, but has a revision, and restoring would resurrect what they
   * deleted -- worse than starting empty. What comes back is the cloud's last snapshot, so on_hand is
   * as of that push: a recount is the honest next step, and the console is where it happens.
   */
  async restoreInventoryFromCloud(restaurantId) {
    const pairing = hubConfig.getPairingInfo();
    if (!pairing.paired || !isUuid(restaurantId) || String(restaurantId) !== String(pairing.restaurant_id)) {
      return { restored: false, reason: 'NOT_PAIRED' };
    }
    if (inventoryStore.state.revision > 0 || !inventoryStore.isEmpty()) return { restored: false, reason: 'INVENTORY_PRESENT' };

    const { online } = await this.checkConnection();
    if (!online) return { restored: false, reason: 'OFFLINE' };

    let pulled;
    try {
      pulled = await pullInventory(this.cloud, restaurantId);
    } catch (err) {
      // Fail soft, like the ledger restore: refusing to boot over an unreachable cloud would be worse.
      console.warn(`⚠️ Could not restore stock from the cloud: ${err.message}`);
      return { restored: false, reason: 'CLOUD_ERROR', detail: err.message };
    }
    if (!pulled.items.length && !pulled.recipes.length) return { restored: false, reason: 'NOTHING_IN_CLOUD' };

    // Re-check: the connection test above awaited, and an ingredient could have been added meanwhile.
    if (inventoryStore.state.revision > 0 || !inventoryStore.isEmpty()) return { restored: false, reason: 'INVENTORY_PRESENT' };
    const state = inventoryStore.replaceAll(restaurantId, { ...pulled, revision: 1, movements: [] });
    // It came FROM the cloud, so the cloud already holds it: do not push it straight back.
    this.saveCatalogState('inventory', state.revision);
    console.log(`📥 Restored ${state.items.length} ingredient(s) and ${state.recipes.length} recipe(s) from the cloud.`);
    return { restored: true, items: state.items.length, recipes: state.recipes.length };
  }

  /** Queues the whole catalog for the cloud. `data` is the committed cache, revision included. */
  enqueueCatalog(kind, data) {
    const pairing = hubConfig.getPairingInfo();
    const body = kind === 'menu'
      ? { categories: data.categories, items: data.items }
      : kind === 'inventory'
        ? { items: data.items, recipes: data.recipes }
        : kind === 'reservations'
          ? { reservations: data.reservations, waitlist: data.waitlist }
          : { tables: data.tables };
    const op = {
      queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: CATALOG_OPS[kind],
      payload: {
        revision: data.revision,
        // The restaurant the edit was made for. A hub re-paired before the push must not write it to the new one.
        restaurant_id: data.restaurant_id || pairing.restaurant_id || null,
        ...body
      },
      queued_at: new Date().toISOString(),
      attempts: 0
    };
    this.saveQueue(this.mergeCatalogOp(this.queue, op));
    this.processQueue();
  }

  async syncCatalogToSupabase(item) {
    const { revision, restaurant_id, ...body } = item.payload;
    const kind = CATALOG_KINDS[item.type];
    const pairing = hubConfig.getPairingInfo();

    if (!pairing.paired || !isUuid(restaurant_id) || String(restaurant_id) !== String(pairing.restaurant_id)) {
      // Nothing can make this snapshot correct later, so drop it rather than retry or write to the wrong tenant.
      console.warn(`[sync] ⚠️ Dropping ${item.type} (revision ${revision}): it was made for a different restaurant than this hub is paired with.`);
      return true;
    }

    try {
      const pushed = kind === 'menu'
        ? await pushMenu(this.cloud, restaurant_id, body)
        : kind === 'inventory'
          ? await pushInventory(this.cloud, restaurant_id, body)
          : kind === 'reservations'
            ? await pushReservations(this.cloud, restaurant_id, body)
            : await pushTables(this.cloud, restaurant_id, body);
      this.saveCatalogState(kind, Math.max(revision, this.catalogState[kind]?.synced_revision ?? 0));
      console.log(`[sync] ✅ ${kind} revision ${revision} pushed to Supabase`, pushed);
      return true;
    } catch (err) {
      this.lastFailureSystemic = isSystemicFailure(err);
      console.error(`[sync] ❌ ${item.type} failed:`, { message: err.message, code: err.code || 'unknown', details: err.details || err.hint || null });
      return false;
    }
  }

  async processQueue() {
    if (this.isSyncing) {
      return;
    }
    this.isSyncing = true;
    this.notifyStatusChange();

    try {
      const prevOnline = this.isOnline;
      const queuedCount = this.queue.length;

      // 1. Check connection state
      const connResult = await this.checkConnection();
      const online = connResult.online;
      this.isOnline = online;

      if (!online) {
        if (prevOnline !== false) {
          console.warn(`[sync] ⚡ Hub Offline (Network Error): ${connResult.error?.message || 'Failed to fetch'}. ${queuedCount} item(s) queued locally.`);
        } else {
          console.warn(`[sync] ⚡ Retry attempt: Network connection unavailable (${queuedCount} order(s) pending). Retrying in 12s...`);
        }
        return;
      }

      // Reconnection detection: if previously offline and now online
      if (!prevOnline && online) {
        console.log(`[sync] 🌐 Hub Online: Internet connection verified! Draining sync queue (${queuedCount} items queued)...`);
        this.notifyReconnected();
      }

      if (!queuedCount) {
        return;
      }

      // 2. Pre-sync Auth Session & Tenant ID Audit Log
      const pairing = hubConfig.getPairingInfo();
      let sessionUser = null;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        sessionUser = session?.user || null;
      } catch (err) {}

      console.log(`[sync] 🔐 Pre-sync Auth Check: Auth UID=${sessionUser?.id || 'NONE'}, Restaurant ID=${pairing.restaurant_id || 'NONE'}, Paired=${pairing.paired}`);

      // Auto re-authenticate as kitchen staff if session is missing but hub is paired
      if (pairing.paired && pairing.restaurant_id && !sessionUser) {
        console.log(`[sync] 🔑 Auth session missing. Attempting re-authentication for kitchen staff (Tenant: ${pairing.restaurant_id})...`);
        const authRes = await authenticateHubStaff(pairing.restaurant_id);
        console.log(`[sync] 🔑 Auth re-authentication result:`, authRes);
      }

      // 3. Process queued items
      console.log(`[sync] 🔄 Processing ${queuedCount} queued cloud sync item(s)...`);

      // Orders and status updates go first: a catalog push is bulky and, while the cloud schema
      // is not migrated yet, fails; it must never delay a bill.
      const itemsToProcess = [...this.queue.filter(q => !isCatalogOp(q)), ...this.queue.filter(isCatalogOp)];
      // Edits that arrive while this drain awaits the network must survive it, so the queue is rebuilt
      // from the live list at the end by removing only what this drain finished with.
      const finished = new Set();
      let syncedCount = 0;

      for (const item of itemsToProcess) {
        let success = false;
        this.lastFailureSystemic = false;

        if (item.type === 'CREATE_ORDER') {
          success = await this.syncOrderToSupabase(item.ticket).catch((err) => {
            console.error('[sync] ❌ Sync order exception:', {
              message: err.message,
              code: err.code || 'unknown',
              stack: err.stack
            });
            return false;
          });

          if (success) {
            ticketStore.markTicketSynced(item.ticket.id);
          }
        } else if (isCatalogOp(item)) {
          success = await this.syncCatalogToSupabase(item).catch((err) => {
            console.error('[sync] ❌ Sync catalog exception:', { message: err.message, code: err.code || 'unknown' });
            return false;
          });
        } else if (isInvoiceOp(item)) {
          success = await this.syncInvoiceToSupabase(item).catch((err) => {
            console.error('[sync] ❌ Sync invoice exception:', { message: err.message, code: err.code || 'unknown' });
            return false;
          });
          if (success) invoiceStore.markSynced(item.payload?.invoice?.id, item.payload?.restaurant_id);
        } else if (isReconciliationOp(item)) {
          success = await this.syncReconciliationToSupabase(item).catch((err) => {
            console.error('[sync] ❌ Sync cash-up exception:', { message: err.message, code: err.code || 'unknown' });
            return false;
          });
          if (success) reconciliationStore.markSynced(item.payload?.record?.id, item.payload?.restaurant_id);
        } else if (isFeedbackOp(item)) {
          success = await this.syncFeedbackToSupabase(item).catch((err) => {
            console.error('[sync] ❌ Sync feedback exception:', { message: err.message, code: err.code || 'unknown' });
            return false;
          });
          if (success) feedbackStore.markSynced(item.payload?.entry?.id, item.payload?.restaurant_id);
        } else if (isInvoiceEventsOp(item)) {
          success = await this.syncInvoiceEventsToSupabase(item).catch((err) => {
            console.error('[sync] ❌ Sync invoice events exception:', { message: err.message, code: err.code || 'unknown' });
            return false;
          });
        } else if (item.type === 'UPDATE_STATUS') {
          success = await this.syncStatusToSupabase(item.payload).catch((err) => {
            console.error('[sync] ❌ Sync status exception:', {
              message: err.message,
              code: err.code || 'unknown'
            });
            return false;
          });
        }

        if (success) {
          syncedCount++;
          finished.add(item.queue_id);
          this.lastSyncedAt = new Date().toISOString();
        } else {
          const targetId = item.ticket?.ticket_number || item.payload?.ticketId || item.queue_id;

          if (this.lastFailureSystemic) {
            // Hub-wide problem: do not burn this item's retry budget, and stop
            // the drain so the rest of the queue is preserved intact.
            console.error(
              `[sync] 🔒 Cloud rejected the hub itself (not Ticket #${targetId}). ` +
              'Queue held intact; check HUB_PROVISIONING_SECRET and that migrations 001/002 are applied.'
            );
            break;
          }

          item.attempts = (item.attempts || 0) + 1;
          if (item.attempts >= MAX_SYNC_ATTEMPTS) {
            console.error(`[sync] 🚨 Item ${item.queue_id} (Ticket #${targetId}) reached max retries (${MAX_SYNC_ATTEMPTS}). Quarantining to prevent head-of-line blocking.`);
            await this.quarantineItem(item, 'Max retry attempts exceeded during cloud sync');
            finished.add(item.queue_id);
            // Do not break; allow subsequent healthy items to proceed
          } else {
            console.warn(`[sync] ⚠️ Item ${item.queue_id} (${isCatalogOp(item) ? item.type : `Ticket #${targetId}`}) failed sync (attempt ${item.attempts}/${MAX_SYNC_ATTEMPTS}). Retrying on next cycle.`);
            if (isCatalogOp(item)) continue; // it never holds up a later catalog push
            break; // Stop loop on transient failure and retry on next interval
          }
        }
      }

      const remainingQueue = this.queue.filter(q => !finished.has(q.queue_id));
      this.saveQueue(remainingQueue);

      if (syncedCount > 0) {
        console.log(`[sync] 🎉 Successfully synced ${syncedCount} item(s) to cloud. ${remainingQueue.length} remaining.`);
      }
    } catch (err) {
      console.error('[sync] ❌ Error during sync queue processing:', {
        message: err.message,
        code: err.code || err.name || 'unknown',
        stack: err.stack
      });
    } finally {
      this.isSyncing = false;
      this.notifyStatusChange();
    }
  }

  async syncOrderToSupabase(ticket) {
    try {
      // Pre-insert session sanity check requested
      const { data: { user } = {} } = (await this.cloud.auth?.getUser?.().catch(() => ({ data: {} }))) ?? { data: {} };
      console.log('[sync] 🔑 About to insert into orders as auth.uid():', user?.id ?? 'NONE');

      const isUUID = (str) => typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
      const restId = isUUID(ticket.restaurant_id) ? ticket.restaurant_id : '11111111-1111-1111-1111-111111111111';
      const reqId = ticket.order_request_id || ticket.id || null;

      // Check idempotency if order_request_id is present
      if (reqId) {
        try {
          const { data: existingOrder } = await this.cloud
            .from('orders')
            .select('id')
            .eq('restaurant_id', restId)
            .eq('order_request_id', reqId)
            .maybeSingle();

          if (existingOrder) {
            console.log(`[sync] ℹ️ Order Ticket #${ticket.ticket_number} (req: ${reqId}) already exists in Supabase. Marking synced.`);
            return true;
          }
        } catch (e) {}
      }

      const orderRecord = {
        restaurant_id: restId,
        table_name: ticket.table_name || 'T1',
        ticket_number: Number(ticket.ticket_number) || 101,
        status: ticket.status || 'in_progress',
        total_amount: Number(ticket.total_amount) || 0,
        note: ticket.note || '',
        created_by_waiter: ticket.created_by_waiter || 'Waiter',
        order_request_id: reqId,
        synced_to_cloud: true,
        ...orderCourseColumns(ticket),
        created_at: ticket.created_at || new Date().toISOString()
      };

      if (isUUID(ticket.table_id)) {
        orderRecord.table_id = ticket.table_id;
      }

      // 1. Insert order record
      let sentRecord = orderRecord;
      let { data: insertedOrder, error: orderErr } = await this.cloud
        .from('orders')
        .insert(sentRecord)
        .select('id')
        .single();

      // Graceful fallback if migration 008 (course state) has not been applied yet: the order itself
      // is what matters, and it must not wait for a schema change.
      let courseColumnsMissing = false;
      if (orderErr && isMissingCourseColumn(orderErr)) {
        console.warn('[sync] ⚠️ Course-state columns not present in cloud database (migration 008). Retrying order without them...');
        courseColumnsMissing = true;
        sentRecord = withoutCourseColumns(sentRecord);
        const retryRes = await this.cloud.from('orders').insert(sentRecord).select('id').single();
        insertedOrder = retryRes.data;
        orderErr = retryRes.error;
      }

      // Graceful fallback if migration 002 has not been applied to Supabase yet
      if (orderErr && (orderErr.message?.includes('order_request_id') || orderErr.code === 'PGRST204')) {
        console.warn(`[sync] ⚠️ 'order_request_id' column not present in cloud database. Retrying insert without it...`);
        const fallbackRecord = { ...sentRecord };
        delete fallbackRecord.order_request_id;
        const retryRes = await this.cloud
          .from('orders')
          .insert(fallbackRecord)
          .select('id')
          .single();
        insertedOrder = retryRes.data;
        orderErr = retryRes.error;
      }

      if (orderErr) {
        this.lastFailureSystemic = isSystemicFailure(orderErr);
        console.error('[sync] ❌ Supabase Order Insert Failed:', {
          message: orderErr.message,
          code: orderErr.code || 'unknown',
          status: orderErr.status || 'unknown',
          details: orderErr.details || orderErr.hint || null,
          ticket_number: ticket.ticket_number,
          restaurant_id: restId
        });
        return false;
      }

      const dbOrderId = insertedOrder.id;

      // 2. Insert order items
      if (ticket.items && ticket.items.length > 0) {
        const itemRecords = ticket.items.map(item => ({
          order_id: dbOrderId,
          name: item.name,
          qty: Number(item.qty) || 1,
          price: Number(item.price) || 0,
          ...(courseColumnsMissing ? {} : itemCourseColumns(item))
        }));

        let { error: itemsErr } = await this.cloud.from('order_items').insert(itemRecords);
        // The order row accepted the course columns but the line table has not been migrated (or the
        // reverse): the order is already in, so send the lines without them rather than failing.
        if (itemsErr && isMissingCourseColumn(itemsErr)) {
          console.warn('[sync] ⚠️ Course columns not present on order_items (migration 008). Retrying lines without them...');
          ({ error: itemsErr } = await this.cloud.from('order_items').insert(itemRecords.map(withoutCourseColumns)));
        }
        if (itemsErr) {
          this.lastFailureSystemic = isSystemicFailure(itemsErr);
          console.error('[sync] ❌ Supabase Order Items Insert Failed:', {
            message: itemsErr.message,
            code: itemsErr.code || 'unknown',
            details: itemsErr.details || itemsErr.hint || null,
            ticket_number: ticket.ticket_number
          });
          return false;
        }
      }

      console.log(`[sync] ✅ Order Ticket #${ticket.ticket_number} synced to Supabase successfully.`);
      return true;
    } catch (err) {
      console.error('[sync] ❌ Sync order exception:', {
        message: err.message,
        code: err.code || err.name || 'unknown'
      });
      return false;
    }
  }

  async syncStatusToSupabase({ ticketId, status, restaurantId, course, requestId }) {
    try {
      // Aimed at one order of one restaurant. An item queued before request ids were recorded carries only
      // the number, and still drains: it is the best that was known when it was queued, and it stays
      // inside the restaurant.
      const aim = query => {
        let q = query;
        if (restaurantId) q = q.eq('restaurant_id', restaurantId);
        return requestId ? q.eq('order_request_id', requestId) : q.eq('ticket_number', Number(ticketId));
      };
      const update = (extra = {}) => aim(this.cloud
        .from('orders')
        .update({ status, updated_at: new Date().toISOString(), ...extra }));

      let { error } = await update(course || {});
      // Cloud not migrated yet (008): the status is the part that must get through.
      if (error && course && isMissingCourseColumn(error)) {
        console.warn('[sync] ⚠️ Course-state columns not present in cloud database (migration 008). Sending the status alone...');
        ({ error } = await update());
      }

      if (error) {
        this.lastFailureSystemic = isSystemicFailure(error);
        console.error('[sync] ❌ Supabase Status Update Failed:', {
          message: error.message,
          code: error.code || 'unknown',
          details: error.details || error.hint || null,
          ticketId,
          status
        });
        return false;
      } else {
        console.log(`[sync] ✅ Ticket #${ticketId} status updated to '${status}' on Supabase.`);
        return true;
      }
    } catch (err) {
      console.error('[sync] ❌ Sync status exception:', {
        message: err.message,
        code: err.code || err.name || 'unknown'
      });
      return false;
    }
  }

  startSyncLoop(intervalMs = 12000) {
    console.log(`⏰ Hub Cloud Sync background retry loop active (every ${intervalMs / 1000}s)`);

    const runLoop = async () => {
      try {
        await this.processQueue();
      } catch (err) {
        console.error('[sync] ❌ Retry loop execution error:', err.message || err);
      } finally {
        // ALWAYS schedule next retry loop execution regardless of success or failure
        setTimeout(runLoop, intervalMs);
      }
    };

    // Run initial check immediately
    runLoop();
  }
}

export const syncQueue = new SyncQueue();
