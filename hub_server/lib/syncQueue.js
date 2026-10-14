import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, checkSupabaseConnection, authenticateHubStaff } from './supabaseClient.js';
import { ticketStore } from './ticketStore.js';
import { hubConfig } from './hubConfig.js';
import { pushMenu, pushTables, isUuid } from './catalogSync.js';
import { pushInvoice } from './invoiceSync.js';
import { invoiceStore } from './invoiceStore.js';
import { pushReconciliation } from './reconciliationSync.js';
import { reconciliationStore } from './reconciliationStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'sync_queue.json');
const QUARANTINE_FILE = path.join(DATA_DIR, 'quarantine_sync_queue.json');
// Newest catalog revision the cloud is known to hold, per catalog. Survives restarts so the admin page
// can say "synced" without pushing again.
const CATALOG_STATE_FILE = path.join(DATA_DIR, 'catalog_sync.json');
const CATALOG_OPS = { menu: 'SYNC_MENU', tables: 'SYNC_TABLES' };
const isCatalogOp = item => item?.type === CATALOG_OPS.menu || item?.type === CATALOG_OPS.tables;

const INVOICE_OP = 'SYNC_INVOICE';
const isInvoiceOp = item => item?.type === INVOICE_OP;

const RECONCILIATION_OP = 'SYNC_RECONCILIATION';
const isReconciliationOp = item => item?.type === RECONCILIATION_OP;
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

  loadQueue() {
    try {
      if (fs.existsSync(QUEUE_FILE)) {
        const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('⚠️ Could not load sync_queue.json:', err.message);
    }
    return [];
  }

  saveQueue(queueList) {
    this.queue = queueList;
    this.notifyStatusChange();
    // Non-blocking, but serialised. Clearing a table saves the queue several times in quick
    // succession (the ticket updates, then the bill), and unchained writes finish in whatever
    // order the OS returns them -- so the file could end up holding an older snapshot than
    // memory and silently lose the newest ops if the hub then stopped. Chaining keeps the last
    // call the last write. The JSON is captured now, not inside the chain, so each link writes
    // the queue as it was when that save was asked for.
    //
    // NOTE: still not atomic. A crash inside the write leaves a truncated file, and loadQueue
    // answers a parse failure with an empty queue, discarding everything unsent. Writing to a
    // temp file and renaming was tried and reverted: on Windows the rename contends with
    // readers, and this is a far hotter path than a catalog write. That needs its own slice.
    const snapshot = JSON.stringify(queueList, null, 2);
    this._writeChain = this._writeChain
      .then(() => fs.promises.writeFile(QUEUE_FILE, snapshot, 'utf-8'))
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

  enqueueStatusUpdate(ticketId, newStatus, restaurantId) {
    const queueItem = {
      queue_id: 'q_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      type: 'UPDATE_STATUS',
      payload: { ticketId, status: newStatus, restaurantId },
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

  /** Queues the whole catalog for the cloud. `data` is the committed cache, revision included. */
  enqueueCatalog(kind, data) {
    const pairing = hubConfig.getPairingInfo();
    const body = kind === 'menu'
      ? { categories: data.categories, items: data.items }
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
    const kind = item.type === CATALOG_OPS.menu ? 'menu' : 'tables';
    const pairing = hubConfig.getPairingInfo();

    if (!pairing.paired || !isUuid(restaurant_id) || String(restaurant_id) !== String(pairing.restaurant_id)) {
      // Nothing can make this snapshot correct later, so drop it rather than retry or write to the wrong tenant.
      console.warn(`[sync] ⚠️ Dropping ${item.type} (revision ${revision}): it was made for a different restaurant than this hub is paired with.`);
      return true;
    }

    try {
      const pushed = kind === 'menu'
        ? await pushMenu(this.cloud, restaurant_id, body)
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
      const { data: { user } } = await supabase.auth.getUser().catch(() => ({ data: {} }));
      console.log('[sync] 🔑 About to insert into orders as auth.uid():', user?.id ?? 'NONE');

      const isUUID = (str) => typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
      const restId = isUUID(ticket.restaurant_id) ? ticket.restaurant_id : '11111111-1111-1111-1111-111111111111';
      const reqId = ticket.order_request_id || ticket.id || null;

      // Check idempotency if order_request_id is present
      if (reqId) {
        try {
          const { data: existingOrder } = await supabase
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
        created_at: ticket.created_at || new Date().toISOString()
      };

      if (isUUID(ticket.table_id)) {
        orderRecord.table_id = ticket.table_id;
      }

      // 1. Insert order record
      let { data: insertedOrder, error: orderErr } = await supabase
        .from('orders')
        .insert(orderRecord)
        .select('id')
        .single();

      // Graceful fallback if migration 002 has not been applied to Supabase yet
      if (orderErr && (orderErr.message?.includes('order_request_id') || orderErr.code === 'PGRST204')) {
        console.warn(`[sync] ⚠️ 'order_request_id' column not present in cloud database. Retrying insert without it...`);
        const fallbackRecord = { ...orderRecord };
        delete fallbackRecord.order_request_id;
        const retryRes = await supabase
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
          price: Number(item.price) || 0
        }));

        const { error: itemsErr } = await supabase.from('order_items').insert(itemRecords);
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

  async syncStatusToSupabase({ ticketId, status, restaurantId }) {
    try {
      const { error } = await supabase
        .from('orders')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('ticket_number', Number(ticketId));

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
