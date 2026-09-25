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
// Item splits: same cap on the number of splits; upper bound on how many
// distinct items a bill can contain lives with the invoice itself.
const MIN_ITEM_SPLITS = 2;
const MAX_ITEM_SPLITS = 40;

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

/**
 * Validate reception-supplied per-split item assignments against the
 * invoice's items list, then compute per-split share amounts by
 * distributing grand_total proportionally to each split's raw subtotal.
 *
 * Rules:
 *   - Each split has `item_indices: [0, 3, ...]` referring to positions in
 *     invoice.items (0-based).
 *   - Every item index in 0..items.length-1 must appear in EXACTLY one
 *     split (no orphans, no double-assignment).
 *   - Each split must have at least one item (an empty split makes no
 *     sense — nothing to charge for).
 *   - 2..40 splits (matches seat / amount caps).
 *
 * Rounding: raw share = split_subtotal / invoice_subtotal * grand_total.
 * Largest-remainder allocation floors each raw share then hands out the
 * remaining rupees to the splits with the largest fractional parts, so
 * shares are always integer rupees AND sum EXACTLY to grand_total.
 *
 * Returns { ok: true, splits: [{ item_indices, share_amount, label, ...}] }
 * or { ok: false, error }.
 */
export function validateItemSplits(rawSplits, invoice) {
  if (!Array.isArray(rawSplits)) {
    return { ok: false, error: 'splits must be an array.' };
  }
  if (rawSplits.length < MIN_ITEM_SPLITS) {
    return { ok: false, error: `Need at least ${MIN_ITEM_SPLITS} splits.` };
  }
  if (rawSplits.length > MAX_ITEM_SPLITS) {
    return { ok: false, error: `Cannot exceed ${MAX_ITEM_SPLITS} splits.` };
  }
  const items = Array.isArray(invoice?.items) ? invoice.items : [];
  if (items.length === 0) {
    return { ok: false, error: 'Invoice has no items to split.' };
  }

  const grand = Math.round(Number(invoice?.grand_total) || 0);
  const subtotal = Number(invoice?.subtotal) || 0;
  if (subtotal <= 0) {
    return { ok: false, error: 'Invoice subtotal is zero; cannot split by items.' };
  }

  const assignedTo = new Array(items.length).fill(-1);
  const perSplit = [];

  for (let i = 0; i < rawSplits.length; i++) {
    const row = rawSplits[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `splits[${i}] is not an object.` };
    }
    const raw = row.item_indices;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { ok: false, error: `splits[${i}].item_indices must be a non-empty array.` };
    }

    const seen = new Set();
    for (const rawIdx of raw) {
      const idx = Number(rawIdx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
        return { ok: false, error: `splits[${i}] references item index ${rawIdx}, which is out of range.` };
      }
      if (seen.has(idx)) {
        return { ok: false, error: `splits[${i}] repeats item index ${idx}.` };
      }
      if (assignedTo[idx] !== -1) {
        return { ok: false, error: `Item ${idx} is assigned to both split ${assignedTo[idx]} and split ${i}.` };
      }
      seen.add(idx);
      assignedTo[idx] = i;
    }

    const item_indices = [...seen].sort((a, b) => a - b);
    let split_subtotal = 0;
    for (const idx of item_indices) {
      split_subtotal += Number(items[idx]?.line_total) || 0;
    }
    split_subtotal = Math.round(split_subtotal * 100) / 100;

    const rawLabel = typeof row.label === 'string' ? row.label.trim() : '';
    perSplit.push({
      index: i,
      label: rawLabel ? rawLabel.slice(0, 40) : `Split ${i + 1}`,
      item_indices,
      split_subtotal,
      payment_status: 'pending',
      payment_method: null,
      paid_at: null
    });
  }

  const unassigned = [];
  for (let idx = 0; idx < items.length; idx++) {
    if (assignedTo[idx] === -1) unassigned.push(idx);
  }
  if (unassigned.length > 0) {
    return {
      ok: false,
      error: `Item${unassigned.length === 1 ? '' : 's'} ${unassigned.join(', ')} not assigned to any split.`
    };
  }

  // Largest-remainder allocation: floor of the proportional share, then hand
  // out leftover rupees to the splits with the largest fractional part.
  const rawShares = perSplit.map(s => (s.split_subtotal / subtotal) * grand);
  const floors = rawShares.map(r => Math.floor(r));
  let remainder = grand - floors.reduce((s, x) => s + x, 0);

  // Order split indices by fractional-part descending; original order breaks ties.
  const order = perSplit
    .map((s, i) => ({ i, frac: rawShares[i] - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .map(x => x.i);

  const shares = floors.slice();
  for (const idx of order) {
    if (remainder <= 0) break;
    shares[idx] += 1;
    remainder -= 1;
  }

  const finalised = perSplit.map((s, i) => ({
    ...s,
    share_amount: shares[i]
  }));

  const sum = finalised.reduce((s, x) => s + x.share_amount, 0);
  if (sum !== grand) {
    throw new Error(`internal: item-split shares (${sum}) do not sum to grand_total (${grand})`);
  }

  return { ok: true, splits: finalised };
}
