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
