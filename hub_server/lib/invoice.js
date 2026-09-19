import { computeTax, resolveTaxRules } from './tax.js';
import { restaurantCache } from './restaurantCache.js';

/**
 * A bill is a per-table construct, not a per-ticket one: guests add tickets
 * over the course of a meal and settle a single invoice at the end. This
 * module folds a table's open tickets into that invoice, then applies the
 * tenant's tax rules through lib/tax.js.
 *
 * Item metadata (isVeg, category) is looked up from the live menu cache when
 * available, so scoped tax rules (veg-only, category-only) work even though
 * tickets only carry `{id, name, qty, price}`.
 */

function enrichLine(ticket, line, menuById) {
  const menuItem = menuById.get(String(line?.id));
  return {
    ticket_number: ticket.ticket_number,
    ticket_id: ticket.id,
    id: line?.id,
    name: line?.name,
    qty: Number(line?.qty) || 0,
    price: Number(line?.price) || 0,
    line_total: (Number(line?.qty) || 0) * (Number(line?.price) || 0),
    isVeg: menuItem?.isVeg,
    category: menuItem?.category
  };
}

/**
 * Build an invoice preview for the tickets belonging to one table's current
 * open session. Does NOT persist. Callers who want a stable invoice number
 * must issue via invoiceStore.issueInvoice() instead.
 *
 *   {
 *     table_id, table_name,
 *     restaurant_id, currency,
 *     tickets: [{ ticket_number, id }],
 *     items: [{ ticket_number, id, name, qty, price, line_total, ... }],
 *     subtotal, tax_rows, tax_total, grand_total,
 *     generated_at
 *   }
 */
export function buildInvoicePreview({ tickets, tableId, tableName, restaurantId, currency, taxConfig }) {
  const rules = resolveTaxRules(taxConfig);
  const menuCache = restaurantCache.getMenuCache(restaurantId);
  const menuById = new Map(
    Array.isArray(menuCache?.items)
      ? menuCache.items.map(i => [String(i.id), i])
      : []
  );

  const orderedTickets = [...tickets].sort((a, b) => {
    const at = new Date(a.created_at || 0).getTime();
    const bt = new Date(b.created_at || 0).getTime();
    return at - bt;
  });

  const items = [];
  for (const ticket of orderedTickets) {
    if (!Array.isArray(ticket.items)) continue;
    for (const line of ticket.items) {
      items.push(enrichLine(ticket, line, menuById));
    }
  }

  const { subtotal, tax_rows, tax_total, grand_total } = computeTax(items, rules);

  return {
    restaurant_id: restaurantId,
    table_id: tableId ?? null,
    table_name: tableName || null,
    currency: currency || '₹',
    tickets: orderedTickets.map(t => ({
      ticket_number: t.ticket_number,
      id: t.id,
      created_at: t.created_at
    })),
    items,
    subtotal,
    tax_rows,
    tax_total,
    grand_total,
    generated_at: new Date().toISOString()
  };
}
