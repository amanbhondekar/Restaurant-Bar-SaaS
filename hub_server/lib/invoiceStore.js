import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildInvoicePreview } from './invoice.js';

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
   * Mark an invoice as paid — the seam future payment-capture code will
   * hook into. For now callers supply the method (`cash`, `upi`, `card`,
   * `other`) directly; a follow-up will replace direct calls with the
   * outcome of an actual payment integration.
   *
   * Refuses: unknown id, already paid, voided, refunded, unknown method.
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
