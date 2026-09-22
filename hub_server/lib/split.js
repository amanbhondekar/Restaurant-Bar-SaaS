/**
 * Split-bill math.
 *
 * A split is a per-seat share of the invoice's grand total. The invoice
 * itself is unchanged — the split records ride along on the same document
 * so downstream (thermal printer, cloud replica) has one source of truth
 * for "what did this table order?" and a second, thinner one for "how did
 * they pay for it?".
 *
 * Rupee-fair rounding: every share is an integer number of rupees, and the
 * shares must sum EXACTLY to the invoice's grand_total (which is itself
 * rupee-rounded upstream). We hand out `floor(grand / n)` to each seat and
 * distribute the leftover paise-count as +1 rupee to the first R seats.
 */

const MIN_SEATS = 2;
const MAX_SEATS = 40;
// Amount splits share the same [2, 40] fan-out cap: enforced separately so
// its rejection text reads correctly ("splits" vs "seats").
const MIN_AMOUNT_SPLITS = 2;
const MAX_AMOUNT_SPLITS = 40;

export function validateSeatCount(rawCount, { min = MIN_SEATS, max = MAX_SEATS } = {}) {
  const n = Number(rawCount);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    return { ok: false, error: 'Seat count must be a whole number.' };
  }
  if (n < min) return { ok: false, error: `Seat count must be at least ${min}.` };
  if (n > max) return { ok: false, error: `Seat count cannot exceed ${max}.` };
  return { ok: true, count: n };
}

/**
 * Build N seat splits over the given grand_total. Returns:
 *   [{ index, label, share_amount, payment_status: 'pending' }]
 *
 * The invariant `sum(share_amount) === grand_total` is asserted; if the
 * caller ever hands a non-integer grand_total, we round it and log — but
 * upstream PR 1 already rupee-rounds every invoice, so this never fires
 * in practice.
 */
export function computeSeatSplits(grandTotal, count) {
  const total = Math.round(Number(grandTotal) || 0);
  if (total <= 0) throw new Error('grand_total must be positive to split');

  const base = Math.floor(total / count);
  const remainder = total - base * count;

  const splits = [];
  for (let i = 0; i < count; i++) {
    const share = i < remainder ? base + 1 : base;
    splits.push({
      index: i,
      label: `Seat ${i + 1}`,
      share_amount: share,
      payment_status: 'pending',
      payment_method: null,
      paid_at: null
    });
  }

  const sum = splits.reduce((s, x) => s + x.share_amount, 0);
  if (sum !== total) {
    throw new Error(`internal: split shares (${sum}) do not sum to grand_total (${total})`);
  }

  return splits;
}

/**
 * Validate a list of reception-supplied `{ label?, share_amount }` splits
 * against the invoice's grand_total. Every amount must be a positive
 * integer number of rupees, and the sum must equal grand_total EXACTLY —
 * we deliberately refuse a "close enough" tolerance so a shorted total is
 * caught at the register, not on the day-end reconcile.
 *
 * Returns { ok: true, splits: [...] } on success or { ok: false, error }.
 */
export function validateAmountSplits(rawSplits, grandTotal) {
  if (!Array.isArray(rawSplits)) {
    return { ok: false, error: 'splits must be an array.' };
  }
  if (rawSplits.length < MIN_AMOUNT_SPLITS) {
    return { ok: false, error: `Need at least ${MIN_AMOUNT_SPLITS} splits.` };
  }
  if (rawSplits.length > MAX_AMOUNT_SPLITS) {
    return { ok: false, error: `Cannot exceed ${MAX_AMOUNT_SPLITS} splits.` };
  }

  const total = Math.round(Number(grandTotal) || 0);
  const cleaned = [];

  for (let i = 0; i < rawSplits.length; i++) {
    const row = rawSplits[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `splits[${i}] is not an object.` };
    }
    const amount = Number(row.share_amount);
    if (!Number.isFinite(amount) || Math.floor(amount) !== amount) {
      return { ok: false, error: `splits[${i}].share_amount must be a whole number of rupees.` };
    }
    if (amount <= 0) {
      return { ok: false, error: `splits[${i}].share_amount must be positive.` };
    }
    if (amount > total) {
      return { ok: false, error: `splits[${i}].share_amount (${amount}) cannot exceed grand_total (${total}).` };
    }
    const rawLabel = typeof row.label === 'string' ? row.label.trim() : '';
    cleaned.push({
      index: i,
      label: rawLabel ? rawLabel.slice(0, 40) : `Split ${i + 1}`,
      share_amount: amount,
      payment_status: 'pending',
      payment_method: null,
      paid_at: null
    });
  }

  const sum = cleaned.reduce((s, x) => s + x.share_amount, 0);
  if (sum !== total) {
    const delta = total - sum;
    const direction = delta > 0 ? `short by ₹${delta}` : `over by ₹${-delta}`;
    return { ok: false, error: `Split amounts sum to ${sum}, but grand_total is ${total} (${direction}).` };
  }

  return { ok: true, splits: cleaned };
}
