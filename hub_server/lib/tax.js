/**
 * Server-side tax computation for invoices.
 *
 * A tenant's tax config lives on the paired restaurant record as an array of
 * rules. Each rule has a label (shown as its own row on the printed bill), a
 * rate expressed as a percentage of the taxable amount, and an `applies_to`
 * scope. For M1 the only scope shipped is `'all'`; category- and vegness-based
 * scopes are handled by matchesScope() and will be exercised by later PRs.
 *
 * When a hub has no tax config we default to Indian GST for restaurants:
 * CGST 2.5% + SGST 2.5% = 5%. Downstream code treats the default as any other
 * config, so it prints on the bill with those labels.
 */

export const DEFAULT_TAX_RULES = [
  { label: 'CGST', rate_percent: 2.5, applies_to: 'all' },
  { label: 'SGST', rate_percent: 2.5, applies_to: 'all' }
];

function normaliseRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  const rate = Number(raw.rate_percent);
  if (!label || !Number.isFinite(rate) || rate < 0) return null;
  return {
    label,
    rate_percent: rate,
    applies_to: raw.applies_to || 'all'
  };
}

export function resolveTaxRules(config) {
  const raw = config?.tax_rules ?? config?.settings?.tax ?? config?.tax;
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TAX_RULES;
  const cleaned = raw.map(normaliseRule).filter(Boolean);
  return cleaned.length > 0 ? cleaned : DEFAULT_TAX_RULES;
}

function matchesScope(rule, item) {
  const scope = rule.applies_to;
  if (!scope || scope === 'all') return true;
  if (scope === 'veg') return item.isVeg === true;
  if (scope === 'non_veg') return item.isVeg === false;
  if (typeof scope === 'string' && scope.startsWith('category:')) {
    const cat = scope.slice('category:'.length);
    return item.category === cat || item.category_id === cat;
  }
  return true;
}

// Round to 2 decimal places using half-up. Rupees ship with 2dp on the wire
// even though the final printed grand total is rupee-rounded downstream.
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Compute per-rule tax rows across the given line items.
 * Items are shaped `{ id, name, qty, price, isVeg?, category? }`.
 *
 * Returns:
 *   {
 *     subtotal,          // pre-tax total across all lines
 *     tax_rows: [        // one row per rule in the order given
 *       { label, rate_percent, taxable_amount, amount }
 *     ],
 *     tax_total,         // sum of tax_rows[].amount
 *     grand_total        // subtotal + tax_total, rupee-rounded
 *   }
 */
export function computeTax(items, rules = DEFAULT_TAX_RULES, opts = {}) {
  if (!Array.isArray(items)) items = [];
  const activeRules = Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_TAX_RULES;

  let subtotal = 0;
  for (const line of items) {
    const qty = Number(line?.qty) || 0;
    const price = Number(line?.price) || 0;
    subtotal += qty * price;
  }
  subtotal = round2(subtotal);

  // When pre-tax adjustments have been applied, callers pass their override
  // for what each rule taxes. In the plain (no-adjustment) path we tax the
  // per-line contribution as before, so scoped rules still work.
  const overrideBase = Number.isFinite(opts.taxableBase) ? Number(opts.taxableBase) : null;
  const baseScale = overrideBase !== null && subtotal > 0 ? overrideBase / subtotal : null;

  const tax_rows = activeRules.map(rule => {
    let taxable = 0;
    for (const line of items) {
      if (!matchesScope(rule, line)) continue;
      const qty = Number(line?.qty) || 0;
      const price = Number(line?.price) || 0;
      taxable += qty * price;
    }
    if (baseScale !== null) {
      // Scale the rule's taxable share so bill-level discounts and service
      // charge redistribute proportionally across scoped rules.
      taxable = round2(taxable * baseScale);
    } else {
      taxable = round2(taxable);
    }
    const amount = round2(taxable * (rule.rate_percent / 100));
    return {
      label: rule.label,
      rate_percent: rule.rate_percent,
      taxable_amount: taxable,
      amount
    };
  });

  const tax_total = round2(tax_rows.reduce((s, r) => s + r.amount, 0));
  const grand_base = overrideBase !== null ? overrideBase : subtotal;
  const grand_total = Math.round(grand_base + tax_total);

  return { subtotal, tax_rows, tax_total, grand_total };
}
