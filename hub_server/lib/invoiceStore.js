import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildInvoicePreview } from './invoice.js';
import { computeSeatSplits, validateSeatCount, validateAmountSplits } from './split.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const INVOICES_FILE = path.join(DATA_DIR, 'invoices.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Issued-invoice ledger.
 *
 * Invoices are per-tenant sequential (INV-000001, INV-000002, ...) and are
 * append-only from this hub's perspective: once an invoice is issued it never
 * changes shape. Refunds and voids will land as new adjustment records in a
 * follow-up PR.
 *
 * Persistence is a JSON file so an unpaired second hub can be dropped in
 * without database plumbing. Cloud replication is a follow-up.
 */
class InvoiceStore {
  constructor() {
    this.invoices = this.load();
  }

  load() {
    try {
      if (fs.existsSync(INVOICES_FILE)) {
        const raw = fs.readFileSync(INVOICES_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('⚠️ Could not load invoices.json:', err.message);
    }
    return [];
  }

  save() {
    fs.promises
      .writeFile(INVOICES_FILE, JSON.stringify(this.invoices, null, 2), 'utf-8')
      .catch(err => console.error('❌ Async save invoices error:', err));
  }

  nextInvoiceNumber(restaurantId) {
    const tenantInvoices = this.invoices.filter(i => i.restaurant_id === restaurantId);
    const nextSeq = tenantInvoices.length + 1;
    return `INV-${String(nextSeq).padStart(6, '0')}`;
  }

  /**
   * Build the invoice from live ticket state, assign a stable number, persist,
   * and return it. Idempotent per (restaurant_id, table_id, ticket ids):
   * calling twice with the same tickets returns the first invoice unchanged
   * so a network retry on POST /tables/:id/clear can never double-charge.
   *
   * `adjustments` (optional) is forwarded to buildInvoicePreview; a validation
   * failure there is returned to the caller and no invoice is persisted.
   */
  issueInvoice({ tickets, tableId, tableName, restaurantId, currency, taxConfig, adjustments }) {
    if (!Array.isArray(tickets) || tickets.length === 0) {
      return { ok: false, error: 'No open tickets to invoice for this table.' };
    }

    const ticketIds = tickets.map(t => t.id).sort();
    const existing = this.invoices.find(inv =>
      inv.restaurant_id === restaurantId &&
      String(inv.table_id) === String(tableId) &&
      inv.ticket_ids &&
      inv.ticket_ids.length === ticketIds.length &&
      inv.ticket_ids.slice().sort().every((id, idx) => id === ticketIds[idx])
    );
    if (existing) {
      return { ok: true, invoice: existing, duplicate: true };
    }

    const preview = buildInvoicePreview({
      tickets,
      tableId,
      tableName,
      restaurantId,
      currency,
      taxConfig,
      adjustments
    });

    if (!preview.ok) {
      return { ok: false, error: preview.error };
    }

    // Strip the wrapper flag before persisting; the on-disk shape matches
    // what the modal / cloud replica consumes.
    const { ok: _ok, ...invoiceBody } = preview;

    const invoice = {
      ...invoiceBody,
      id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      invoice_number: this.nextInvoiceNumber(restaurantId),
      ticket_ids: tickets.map(t => t.id),
      issued_at: new Date().toISOString(),
      payment_status: 'pending', // 'pending' | 'paid' — payment capture lands in a follow-up PR
      synced_to_cloud: false
    };

    this.invoices = [invoice, ...this.invoices];
    this.save();
    return { ok: true, invoice, duplicate: false };
  }

  getInvoice(invoiceId, restaurantId) {
    return this.invoices.find(inv =>
      (inv.id === invoiceId || inv.invoice_number === invoiceId) &&
      (!restaurantId || inv.restaurant_id === restaurantId)
    ) || null;
  }

  listInvoices(restaurantId) {
    return this.invoices.filter(inv => !restaurantId || inv.restaurant_id === restaurantId);
  }

  /**
   * Void an issued invoice (accidental close, mis-billing, etc.).
   *
   * Refuses: unknown id, wrong tenant, already voided, already refunded,
   * already paid (a paid invoice must be refunded, not voided), missing
   * reason. Returns the mutated invoice on success.
   */
  voidInvoice(invoiceId, restaurantId, { reason, actor } = {}) {
    const invoice = this.getInvoice(invoiceId, restaurantId);
    if (!invoice) return { ok: false, error: 'Invoice not found.', code: 'NOT_FOUND' };
    if (invoice.payment_status === 'voided') {
      return { ok: false, error: 'Invoice already voided.', code: 'ALREADY_VOIDED' };
    }
    if (invoice.payment_status === 'paid') {
      return { ok: false, error: 'A paid invoice cannot be voided; refund it instead.', code: 'ALREADY_PAID' };
    }
    if (invoice.payment_status === 'refunded') {
      return { ok: false, error: 'Invoice already refunded.', code: 'ALREADY_REFUNDED' };
    }
    if (Array.isArray(invoice.splits) && invoice.splits.some(s => s.payment_status === 'paid')) {
      return { ok: false, error: 'One or more splits are already paid; cannot void.', code: 'SPLIT_PAID' };
    }
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (!cleanReason) {
      return { ok: false, error: 'A reason is required to void an invoice.', code: 'REASON_REQUIRED' };
    }

    this.invoices = this.invoices.map(inv => {
      if (inv.id !== invoice.id) return inv;
      return {
        ...inv,
        payment_status: 'voided',
        voided_at: new Date().toISOString(),
        voided_reason: cleanReason.slice(0, 240),
        voided_by: typeof actor === 'string' ? actor.slice(0, 60) : null
      };
    });
    this.save();
    return { ok: true, invoice: this.getInvoice(invoice.id, restaurantId) };
  }

  /**
   * Split an issued invoice into N equal seat shares. Refuses when the
   * invoice is voided / refunded / already paid, or already split.
   */
  splitBySeats(invoiceId, restaurantId, { count, actor } = {}) {
    const invoice = this.getInvoice(invoiceId, restaurantId);
    if (!invoice) return { ok: false, error: 'Invoice not found.', code: 'NOT_FOUND' };
    if (invoice.payment_status === 'paid') {
      return { ok: false, error: 'Cannot split a paid invoice.', code: 'ALREADY_PAID' };
    }
    if (invoice.payment_status === 'voided') {
      return { ok: false, error: 'Cannot split a voided invoice.', code: 'ALREADY_VOIDED' };
    }
    if (invoice.payment_status === 'refunded') {
      return { ok: false, error: 'Cannot split a refunded invoice.', code: 'ALREADY_REFUNDED' };
    }
    if (Array.isArray(invoice.splits) && invoice.splits.length > 0) {
      return { ok: false, error: 'Invoice is already split; unsplit before re-splitting.', code: 'ALREADY_SPLIT' };
    }

    const validation = validateSeatCount(count);
    if (!validation.ok) {
      return { ok: false, error: validation.error, code: 'INVALID_SEAT_COUNT' };
    }

    let splits;
    try {
      splits = computeSeatSplits(invoice.grand_total, validation.count);
    } catch (err) {
      return { ok: false, error: err.message, code: 'INTERNAL_SPLIT_MATH' };
    }

    this.invoices = this.invoices.map(inv => {
      if (inv.id !== invoice.id) return inv;
      return {
        ...inv,
        splits,
        split_mode: 'seats',
        split_at: new Date().toISOString(),
        split_by: typeof actor === 'string' ? actor.slice(0, 60) : null
      };
    });
    this.save();
    return { ok: true, invoice: this.getInvoice(invoice.id, restaurantId) };
  }

  /**
   * Split by reception-supplied amounts. Same idempotency and state
   * guardrails as splitBySeats; the only extra work is running the
   * caller's amounts through validateAmountSplits so the sum must
   * equal grand_total exactly.
   */
  splitByAmounts(invoiceId, restaurantId, { splits: rawSplits, actor } = {}) {
    const invoice = this.getInvoice(invoiceId, restaurantId);
    if (!invoice) return { ok: false, error: 'Invoice not found.', code: 'NOT_FOUND' };
    if (invoice.payment_status === 'paid') {
      return { ok: false, error: 'Cannot split a paid invoice.', code: 'ALREADY_PAID' };
    }
    if (invoice.payment_status === 'voided') {
      return { ok: false, error: 'Cannot split a voided invoice.', code: 'ALREADY_VOIDED' };
    }
    if (invoice.payment_status === 'refunded') {
      return { ok: false, error: 'Cannot split a refunded invoice.', code: 'ALREADY_REFUNDED' };
    }
    if (Array.isArray(invoice.splits) && invoice.splits.length > 0) {
      return { ok: false, error: 'Invoice is already split; unsplit before re-splitting.', code: 'ALREADY_SPLIT' };
    }

    const validation = validateAmountSplits(rawSplits, invoice.grand_total);
    if (!validation.ok) {
      return { ok: false, error: validation.error, code: 'INVALID_AMOUNTS' };
    }

    this.invoices = this.invoices.map(inv => {
      if (inv.id !== invoice.id) return inv;
      return {
        ...inv,
        splits: validation.splits,
        split_mode: 'amounts',
        split_at: new Date().toISOString(),
        split_by: typeof actor === 'string' ? actor.slice(0, 60) : null
      };
    });
    this.save();
    return { ok: true, invoice: this.getInvoice(invoice.id, restaurantId) };
  }

  /**
   * Undo a split before any share is paid. Once a share is marked paid,
   * unsplit is refused (that money belongs to a settled record).
   */
  unsplit(invoiceId, restaurantId) {
    const invoice = this.getInvoice(invoiceId, restaurantId);
    if (!invoice) return { ok: false, error: 'Invoice not found.', code: 'NOT_FOUND' };
    if (!Array.isArray(invoice.splits) || invoice.splits.length === 0) {
      return { ok: false, error: 'Invoice is not split.', code: 'NOT_SPLIT' };
    }
    if (invoice.splits.some(s => s.payment_status === 'paid')) {
      return { ok: false, error: 'One or more splits are already paid; cannot unsplit.', code: 'SPLIT_PAID' };
    }

    this.invoices = this.invoices.map(inv => {
      if (inv.id !== invoice.id) return inv;
      const { splits: _s, split_mode: _m, split_at: _sa, split_by: _sb, ...rest } = inv;
      return rest;
    });
    this.save();
    return { ok: true, invoice: this.getInvoice(invoice.id, restaurantId) };
  }

  /**
   * Mark a single seat share as paid. When all shares are paid, the parent
   * invoice.payment_status flips to 'paid' with payment_method = 'split'.
   */
  markSplitPaid(invoiceId, restaurantId, { splitIndex, method, actor } = {}) {
    const invoice = this.getInvoice(invoiceId, restaurantId);
    if (!invoice) return { ok: false, error: 'Invoice not found.', code: 'NOT_FOUND' };
    if (!Array.isArray(invoice.splits) || invoice.splits.length === 0) {
      return { ok: false, error: 'Invoice is not split.', code: 'NOT_SPLIT' };
    }
    if (invoice.payment_status === 'voided' || invoice.payment_status === 'refunded') {
      return { ok: false, error: `Cannot pay a split on a ${invoice.payment_status} invoice.`, code: 'INVALID_PARENT_STATE' };
    }

    const idx = Number(splitIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= invoice.splits.length) {
      return { ok: false, error: `Unknown split index ${splitIndex}.`, code: 'UNKNOWN_SPLIT' };
    }

    const target = invoice.splits[idx];
    if (target.payment_status === 'paid') {
      return { ok: false, error: 'Split already marked paid.', code: 'ALREADY_PAID' };
    }

    const allowed = new Set(['cash', 'upi', 'card', 'other']);
    if (!allowed.has(method)) {
      return { ok: false, error: `payment_method must be one of ${[...allowed].join(', ')}.`, code: 'INVALID_METHOD' };
    }

    const now = new Date().toISOString();
    const newSplits = invoice.splits.map((s, i) => {
      if (i !== idx) return s;
      return {
        ...s,
        payment_status: 'paid',
        payment_method: method,
        paid_at: now,
        paid_by: typeof actor === 'string' ? actor.slice(0, 60) : null
      };
    });

    const allPaid = newSplits.every(s => s.payment_status === 'paid');

    this.invoices = this.invoices.map(inv => {
      if (inv.id !== invoice.id) return inv;
      const patch = { ...inv, splits: newSplits };
      if (allPaid) {
        patch.payment_status = 'paid';
        patch.payment_method = 'split';
        patch.paid_at = now;
        patch.paid_by = typeof actor === 'string' ? actor.slice(0, 60) : null;
      }
      return patch;
    });
    this.save();
    return {
      ok: true,
      invoice: this.getInvoice(invoice.id, restaurantId),
      parent_settled: allPaid
    };
  }

  /**
   * Mark an invoice as paid — the seam future payment-capture code will
   * hook into. For now callers supply the method (`cash`, `upi`, `card`,
   * `other`) directly; a follow-up will replace direct calls with the
   * outcome of an actual payment integration.
   *
   * Refuses: unknown id, already paid, voided, refunded, unknown method,
   * or when the invoice is split (settle each split individually).
   */
  markPaid(invoiceId, restaurantId, { method, actor } = {}) {
    const invoice = this.getInvoice(invoiceId, restaurantId);
    if (!invoice) return { ok: false, error: 'Invoice not found.', code: 'NOT_FOUND' };
    if (invoice.payment_status === 'paid') {
      return { ok: false, error: 'Invoice already marked paid.', code: 'ALREADY_PAID' };
    }
    if (invoice.payment_status === 'voided') {
      return { ok: false, error: 'A voided invoice cannot be marked paid.', code: 'ALREADY_VOIDED' };
    }
    if (invoice.payment_status === 'refunded') {
      return { ok: false, error: 'A refunded invoice cannot be marked paid.', code: 'ALREADY_REFUNDED' };
    }
    if (Array.isArray(invoice.splits) && invoice.splits.length > 0) {
      return { ok: false, error: 'Invoice is split; settle each split individually.', code: 'INVOICE_SPLIT' };
    }
    const allowed = new Set(['cash', 'upi', 'card', 'other']);
    if (!allowed.has(method)) {
      return { ok: false, error: `payment_method must be one of ${[...allowed].join(', ')}.`, code: 'INVALID_METHOD' };
    }

    this.invoices = this.invoices.map(inv => {
      if (inv.id !== invoice.id) return inv;
      return {
        ...inv,
        payment_status: 'paid',
        payment_method: method,
        paid_at: new Date().toISOString(),
        paid_by: typeof actor === 'string' ? actor.slice(0, 60) : null
      };
    });
    this.save();
    return { ok: true, invoice: this.getInvoice(invoice.id, restaurantId) };
  }
}

export const invoiceStore = new InvoiceStore();
