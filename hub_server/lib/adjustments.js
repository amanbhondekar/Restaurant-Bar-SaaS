/**
 * Pre-tax invoice adjustments — discounts and service charge.
 *
 * Order of operations (matches Indian restaurant convention, and lines up
 * with what a printed thermal receipt reads top-to-bottom):
 *
 *   1. Line totals summed to subtotal.
 *   2. Bill-level discounts subtracted.                    [this module]
 *   3. Service charge added on the discounted subtotal.    [this module]
 *   4. Tax computed on (discounted subtotal + service charge).
 *   5. Grand total = taxable + tax, rupee-rounded.
 *
 * Line-level discounts and per-seat splits are deliberately out of scope
 * for this PR — the shape here is what lets those slot in later without
 * breaking the invoice contract.
 *
 * All adjustments are validated here and fail closed: a negative amount,
 * a discount larger than the subtotal, or an unknown discount type all
 * return `{ ok: false, error }` before the invoice is built. Callers must
 * check `ok`.
 */

const DISCOUNT_TYPES = new Set(['percent', 'flat']);
const MAX_SERVICE_CHARGE_PERCENT = 25;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function validateDiscount(raw, subtotal, rowIndex) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `discounts[${rowIndex}] is not an object.` };
  }
  const type = raw.type;
  if (!DISCOUNT_TYPES.has(type)) {
    return { ok: false, error: `discounts[${rowIndex}].type must be 'percent' or 'flat'.` };
  }
  const value = Number(raw.value);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: `discounts[${rowIndex}].value must be a non-negative number.` };
  }
  if (type === 'percent' && value > 100) {
    return { ok: false, error: `discounts[${rowIndex}].value cannot exceed 100 (percent).` };
  }
  const amount = type === 'percent'
    ? round2(subtotal * (value / 100))
    : round2(value);
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 120) : '';
  return {
    ok: true,
    row: {
      scope: 'bill',
      type,
      value,
      reason,
      amount
    }
  };
}

/**
 * Resolve adjustments against the given subtotal, returning validated rows
 * and their totals. When the caller supplies nothing, returns zeroes so the
 * invoice math stays a straight pass-through.
 */
export function resolveAdjustments({ subtotal = 0, discounts = [], service_charge_percent = 0 } = {}) {
  const rows = [];
  const errors = [];

  if (discounts && !Array.isArray(discounts)) {
    return { ok: false, error: 'discounts must be an array.' };
  }

  for (let i = 0; i < (discounts || []).length; i++) {
    const result = validateDiscount(discounts[i], subtotal, i);
    if (!result.ok) errors.push(result.error);
    else rows.push(result.row);
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join(' ') };
  }

  const discount_total = round2(rows.reduce((s, r) => s + r.amount, 0));
  if (discount_total > subtotal) {
    return { ok: false, error: `Total discount (${discount_total}) cannot exceed subtotal (${subtotal}).` };
  }

  const subtotal_after_discount = round2(subtotal - discount_total);

  const scPercent = Number(service_charge_percent) || 0;
  if (scPercent < 0 || scPercent > MAX_SERVICE_CHARGE_PERCENT) {
    return {
      ok: false,
      error: `service_charge_percent must be between 0 and ${MAX_SERVICE_CHARGE_PERCENT}.`
    };
  }
  const service_charge_amount = round2(subtotal_after_discount * (scPercent / 100));

  const taxable_base = round2(subtotal_after_discount + service_charge_amount);

  return {
    ok: true,
    discount_rows: rows,
    discount_total,
    subtotal_after_discount,
    service_charge_percent: scPercent,
    service_charge_amount,
    taxable_base
  };
}
