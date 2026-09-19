import { computeTax, resolveTaxRules } from './tax.js';
import { resolveAdjustments } from './adjustments.js';
import { restaurantCache } from './restaurantCache.js';

/**
 * A bill is a per-table construct, not a per-ticket one: guests add tickets
 * over the course of a meal and settle a single invoice at the end. This
 * module folds a table's open tickets into that invoice, applies bill-level
 * discounts and service charge, then applies the tenant's tax rules through
 * lib/tax.js.
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

function resolveTenantServiceCharge(taxConfig) {
  const raw = taxConfig?.service_charge_percent
           ?? taxConfig?.settings?.service_charge_percent
           ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Build an invoice preview for the tickets belonging to one table's current
 * open session. Does NOT persist. Callers who want a stable invoice number
 * must issue via invoiceStore.issueInvoice() instead.
 *
 * `adjustments` (optional) shape:
 *   {
 *     discounts: [{ type: 'percent'|'flat', value: number, reason?: string }],
 *     service_charge_percent?: number  // overrides tenant default when set
 *   }
 *
 * Returns either the invoice shape below or `{ ok: false, error }` when any
 * adjustment fails validation (never partially applied).
 *
 * Invoice shape:
 *   {
 *     restaurant_id, table_id, table_name, currency,
 *     tickets, items,
 *     subtotal,                   // sum of line_totals, unchanged by discounts
 *     discount_rows, discount_total,
 *     subtotal_after_discount,
 *     service_charge_percent, service_charge_amount,
 *     taxable_base,
 *     tax_rows, tax_total,
 *     grand_total,
 *     generated_at
 *   }
 */
export function buildInvoicePreview({ tickets, tableId, tableName, restaurantId, currency, taxConfig, adjustments }) {
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

  const subtotal = Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100;

  const tenantServiceCharge = resolveTenantServiceCharge(taxConfig);
  const requested = adjustments || {};
  const scPercent = requested.service_charge_percent !== undefined
    ? Number(requested.service_charge_percent)
    : tenantServiceCharge;

  const adj = resolveAdjustments({
    subtotal,
    discounts: requested.discounts || [],
    service_charge_percent: scPercent
  });

  if (!adj.ok) {
    return { ok: false, error: adj.error };
  }

  const { subtotal: _, tax_rows, tax_total, grand_total } = computeTax(items, rules, { taxableBase: adj.taxable_base });

  return {
    ok: true,
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
    discount_rows: adj.discount_rows,
    discount_total: adj.discount_total,
    subtotal_after_discount: adj.subtotal_after_discount,
    service_charge_percent: adj.service_charge_percent,
    service_charge_amount: adj.service_charge_amount,
    taxable_base: adj.taxable_base,
    tax_rows,
    tax_total,
    grand_total,
    generated_at: new Date().toISOString()
  };
}
