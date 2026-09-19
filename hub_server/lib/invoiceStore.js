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
   */
  issueInvoice({ tickets, tableId, tableName, restaurantId, currency, taxConfig }) {
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
      taxConfig
    });

    const invoice = {
      ...preview,
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
}

export const invoiceStore = new InvoiceStore();
