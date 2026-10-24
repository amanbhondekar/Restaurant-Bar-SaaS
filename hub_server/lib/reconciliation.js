/**
 * Payment reconciliation (M1 completion). Pure functions: no I/O, no clock.
 *
 * The hub already records every payment on the invoice (method, reference,
 * timestamp, split shares, refunds). Reconciliation turns those into a ledger
 * of payment events and answers the end-of-shift question: "does the money in
 * the drawer and on the card/UPI statements match what the system says we took?"
 *
 * Events, derived from invoices:
 *   - payment: an invoice (or a split share) was marked paid, at paid_at, by method.
 *   - refund:  a paid invoice (or split share) was refunded, at refund_at, back
 *              out through the SAME method it was paid with.
 *
 * A refund is dated when it happened, not when the sale did, so a cash refund
 * today for yesterday's sale reduces today's cash, which is what is physically
 * in the drawer.
 *
 * Windows are half-open [from, to): an event exactly at the close time belongs
 * to the NEXT period, so no payment can be counted in two closes.
 */

export const METHODS = ['cash', 'upi', 'card', 'other'];

export const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const normMethod = m => (METHODS.includes(m) ? m : 'other');
const toMs = v => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Every payment and refund recorded on the tenant's invoices, oldest first. */
export function paymentEvents(invoices, restaurantId) {
  const events = [];
  const push = (kind, at, method, amount, inv, split) => {
    const ms = toMs(at);
    if (ms === null) return;
    events.push({
      kind,
      at: new Date(ms).toISOString(),
      ms,
      method: normMethod(method),
      amount: round2(amount),
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      table_name: inv.table_name || null,
      split_label: split ? (split.label || `Share ${Number(split.index) + 1}`) : null,
      reference: (split ? split.payment_ref : inv.payment_ref) || null
    });
  };

  for (const inv of Array.isArray(invoices) ? invoices : []) {
    if (!inv || (restaurantId && inv.restaurant_id !== restaurantId)) continue;

    if (Array.isArray(inv.splits) && inv.splits.length > 0) {
      for (const s of inv.splits) {
        if (!['paid', 'refunded'].includes(s.payment_status) || !s.paid_at) continue;
        push('payment', s.paid_at, s.payment_method, s.share_amount, inv, s);
        if (s.payment_status === 'refunded' && s.refund_at) push('refund', s.refund_at, s.payment_method, s.share_amount, inv, s);
      }
    } else if (['paid', 'refunded'].includes(inv.payment_status) && inv.paid_at && inv.payment_method) {
      push('payment', inv.paid_at, inv.payment_method, inv.grand_total, inv, null);
      if (inv.payment_status === 'refunded' && inv.refund_at) push('refund', inv.refund_at, inv.payment_method, inv.grand_total, inv, null);
    }
  }
  return events.sort((a, b) => a.ms - b.ms || (a.kind === 'payment' ? -1 : 1));
}

export function inWindow(ms, fromMs, toMs_) {
  return (fromMs === null || fromMs === undefined || ms >= fromMs) && (toMs_ === null || toMs_ === undefined || ms < toMs_);
}

const blank = () => ({ payments_count: 0, payments_total: 0, refunds_count: 0, refunds_total: 0, net: 0 });

/** Per-method and overall totals for the events inside [fromMs, toMs). */
export function summarize(events, { fromMs = null, toMs: toMsArg = null } = {}) {
  const by_method = Object.fromEntries(METHODS.map(m => [m, blank()]));
  const totals = blank();
  let count = 0;
  for (const e of events) {
    if (!inWindow(e.ms, fromMs, toMsArg)) continue;
    count++;
    const bucket = by_method[e.method];
    const field = e.kind === 'payment' ? 'payments' : 'refunds';
    for (const b of [bucket, totals]) {
      b[`${field}_count`] += 1;
      b[`${field}_total`] = round2(b[`${field}_total`] + e.amount);
    }
  }
  for (const b of [...Object.values(by_method), totals]) b.net = round2(b.payments_total - b.refunds_total);
  return { by_method, totals, event_count: count };
}

/** Voids in the window, and bills issued but not yet paid right now (a close-time warning). */
export function invoiceSideNotes(invoices, restaurantId, { fromMs = null, toMs: toMsArg = null } = {}) {
  let voidCount = 0;
  let voidTotal = 0;
  let unpaidCount = 0;
  let unpaidTotal = 0;
  for (const inv of Array.isArray(invoices) ? invoices : []) {
    if (!inv || (restaurantId && inv.restaurant_id !== restaurantId)) continue;
    if (inv.payment_status === 'voided') {
      const v = toMs(inv.voided_at);
      if (v !== null && inWindow(v, fromMs, toMsArg)) { voidCount++; voidTotal = round2(voidTotal + (Number(inv.grand_total) || 0)); }
    } else if (inv.payment_status === 'pending') {
      unpaidCount++;
      unpaidTotal = round2(unpaidTotal + (Number(inv.grand_total) || 0));
    }
  }
  return { voided: { count: voidCount, total: voidTotal }, unpaid: { count: unpaidCount, total: unpaidTotal } };
}

// ---------------------------------------------------------------------------
// Closing a shift
// ---------------------------------------------------------------------------

const isMoney = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9;
const asNumber = v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);

/**
 * Validate what reception types in. Returns `{ ok: true, values }` or
 * `{ ok: false, errors: [{ field, code, error }] }`; every problem is reported at once.
 */
export function validateCloseInput(input) {
  const body = input && typeof input === 'object' ? input : {};
  const errors = [];
  const err = (field, code, error) => errors.push({ field, code, error });

  const counted = asNumber(body.counted_cash);
  if (counted === undefined || counted === null || counted === '') err('counted_cash', 'COUNTED_CASH_REQUIRED', 'Enter the cash you counted in the drawer.');
  else if (!isMoney(counted)) err('counted_cash', 'INVALID_AMOUNT', 'Counted cash must be a number, zero or more.');

  const opening = body.opening_float === undefined || body.opening_float === null || body.opening_float === '' ? 0 : asNumber(body.opening_float);
  if (!isMoney(opening)) err('opening_float', 'INVALID_AMOUNT', 'Opening float must be a number, zero or more.');

  const removed = body.cash_removed === undefined || body.cash_removed === null || body.cash_removed === '' ? 0 : asNumber(body.cash_removed);
  if (!isMoney(removed)) err('cash_removed', 'INVALID_AMOUNT', 'Cash removed must be a number, zero or more.');
  else if (isMoney(counted) && removed > counted) err('cash_removed', 'REMOVED_EXCEEDS_COUNTED', 'You cannot remove more cash than you counted.');

  const reported = {};
  if (body.reported !== undefined && body.reported !== null) {
    if (typeof body.reported !== 'object' || Array.isArray(body.reported)) err('reported', 'INVALID_REPORTED', 'Reported totals must be an object keyed by method.');
    else {
      for (const [k, raw] of Object.entries(body.reported)) {
        if (raw === '' || raw === null || raw === undefined) continue;
        if (!['upi', 'card', 'other'].includes(k)) { err(`reported.${k}`, 'INVALID_METHOD', 'Reported totals can be given for upi, card and other (cash is counted).'); continue; }
        const v = asNumber(raw);
        if (!isMoney(v)) err(`reported.${k}`, 'INVALID_AMOUNT', `Reported ${k} total must be a number, zero or more.`);
        else reported[k] = round2(v);
      }
    }
  }

  const clean = s => (typeof s === 'string' ? s.trim().slice(0, 500) : '');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    values: {
      counted_cash: round2(counted),
      opening_float: round2(opening),
      cash_removed: round2(removed),
      reported,
      notes: clean(body.notes),
      closed_by: clean(body.closed_by).slice(0, 60) || null
    }
  };
}

/**
 * Build the reconciliation record from a summary and the validated input.
 * The record is the audit artefact: what the system expected, what was counted,
 * and the difference, per method.
 */
export function buildRecord({ summary, values, periodStartMs, periodEndMs, notesFromInvoices }) {
  const cash = summary.by_method.cash;
  const expected_cash = round2(values.opening_float + cash.net);
  const cash_variance = round2(values.counted_cash - expected_cash);

  const methods = {};
  for (const m of METHODS) {
    const sys = summary.by_method[m];
    const entry = { ...sys };
    if (m === 'cash') {
      entry.expected = expected_cash;
      entry.counted = values.counted_cash;
      entry.variance = cash_variance;
    } else if (values.reported[m] !== undefined) {
      entry.reported = values.reported[m];
      entry.variance = round2(values.reported[m] - sys.net);
    }
    methods[m] = entry;
  }

  const variances = Object.values(methods).map(e => e.variance).filter(v => v !== undefined);
  const has_variance = variances.some(v => v !== 0);

  return {
    period_start: periodStartMs === null || periodStartMs === undefined ? null : new Date(periodStartMs).toISOString(),
    period_end: new Date(periodEndMs).toISOString(),
    opening_float: values.opening_float,
    counted_cash: values.counted_cash,
    cash_removed: values.cash_removed,
    closing_float: round2(values.counted_cash - values.cash_removed),
    expected_cash,
    cash_variance,
    methods,
    totals: summary.totals,
    status: has_variance ? 'variance' : 'balanced',
    has_variance,
    voided: notesFromInvoices.voided,
    unpaid_at_close: notesFromInvoices.unpaid,
    notes: values.notes,
    closed_by: values.closed_by
  };
}

export const NOTES_MIN_LENGTH = 3;

// ---------------------------------------------------------------------------
// Ledger export
// ---------------------------------------------------------------------------

/** Neutralise spreadsheet formulas in user-supplied text (payment references can be typed by anyone). */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function ledgerCsv(events) {
  const lines = [['Time', 'Type', 'Method', 'Amount', 'Invoice', 'Table', 'Share', 'Reference'].join(',')];
  for (const e of events) {
    // Only text a person can type (invoice, table, share label, reference) goes through the formula
    // guard. The amount is computed here, and a refund's leading minus sign must stay a number.
    const amount = (e.kind === 'refund' ? -e.amount : e.amount).toFixed(2);
    lines.push([
      e.at, e.kind, e.method, amount,
      csvCell(e.invoice_number), csvCell(e.table_name), csvCell(e.split_label), csvCell(e.reference)
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
