/**
 * Day-part price resolution (M2 · PR 13).
 *
 * A menu item can carry `day_parts: [{ id, label, starts_at, ends_at, days?,
 * price?, variant_prices? }]`. When "now" falls inside an active window on
 * an allowed weekday, the window's price wins over the variant/base price;
 * modifier deltas (PR 12) still stack on top at pricing time.
 *
 * `starts_at` / `ends_at` are `'HH:MM'` strings in the hub's local time zone.
 * Overnight windows (bar late-night 22:00 → 02:00) are supported — when
 * `ends_at <= starts_at` the window straddles midnight. The active window
 * is picked by first-match order in the array, so authors can list a
 * narrower promotion first and a broader default second.
 *
 * `days` is an optional array of `Date.getDay()` values (Sun=0..Sat=6). Omit
 * or empty array = every day. Bar happy hour on weekdays: `days: [1,2,3,4,5]`.
 *
 * `variant_prices: { v_half: 60, v_full: 100 }` overrides per-variant prices
 * during the window. When only `price` is given on a variant-carrying item,
 * that flat number wins over EVERY variant during the window — useful for
 * "all sizes ₹80 at breakfast" promotions.
 *
 * This module is deliberately pure so `pricing.js` (server-authoritative
 * order re-pricing) and the `/menu` endpoint (handset display prices) can
 * share exactly the same resolution rules.
 */

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(str) {
  const m = HHMM_RE.exec(String(str || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Does `now` fall inside `[startMin, endMin)` on the local clock, handling
 * overnight wrap? A zero-length window (starts === ends) is treated as never
 * active — authors who want "one instant" should use two windows instead.
 */
function isWithin(nowMin, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  // Overnight: 22:00 → 02:00 means [22:00, 24:00) ∪ [00:00, 02:00).
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * Return the first `day_part` in `dayParts` that is currently active, or
 * null. `now` defaults to `new Date()` so callers can inject a clock in
 * tests.
 */
export function resolveActiveDayPart(dayParts, now = new Date()) {
  if (!Array.isArray(dayParts) || dayParts.length === 0) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dow = now.getDay();
  for (const dp of dayParts) {
    if (!dp || !dp.id) continue;
    const start = parseHHMM(dp.starts_at);
    const end = parseHHMM(dp.ends_at);
    if (start == null || end == null) continue;
    const days = Array.isArray(dp.days) && dp.days.length > 0 ? dp.days.map(Number) : null;
    if (days && !days.includes(dow)) continue;
    if (!isWithin(nowMin, start, end)) continue;
    return dp;
  }
  return null;
}

/**
 * Resolve the effective per-unit price for a menu item, honouring an active
 * day_part when present. `variant` is optional — when supplied, per-variant
 * pricing rules apply (variant_prices > variant.price); when omitted, the
 * item's base rules apply (day_part.price > item.price).
 *
 * Returns `{ price, day_part_id, day_part_label }`; `day_part_*` are null
 * when no window is active.
 */
export function resolveEffectivePrice(item, variant = null, now = new Date()) {
  const basePrice = variant
    ? Number(variant.price)
    : Number(item?.price);
  const active = resolveActiveDayPart(item?.day_parts, now);
  if (!active) {
    return { price: basePrice, day_part_id: null, day_part_label: null };
  }
  // Per-variant override wins when both are supplied.
  if (variant && active.variant_prices && Object.prototype.hasOwnProperty.call(active.variant_prices, variant.id)) {
    const vp = Number(active.variant_prices[variant.id]);
    if (Number.isFinite(vp) && vp >= 0) {
      return { price: vp, day_part_id: active.id, day_part_label: active.label };
    }
  }
  // Flat window price applies to both flat items and (as a fallback) variants.
  if (Number.isFinite(Number(active.price)) && Number(active.price) >= 0) {
    return { price: Number(active.price), day_part_id: active.id, day_part_label: active.label };
  }
  // Window is active but had no usable price for this item/variant combo —
  // fall back to the base so a partially-authored day_part doesn't zero
  // the bill. The active label is not returned in that case (there's no
  // effective override to attribute).
  return { price: basePrice, day_part_id: null, day_part_label: null };
}
