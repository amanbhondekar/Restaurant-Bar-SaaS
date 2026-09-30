import { restaurantCache } from './restaurantCache.js';
import { resolveEffectivePrice } from './dayParts.js';

/**
 * Server-side order pricing.
 *
 * Handsets are untrusted: anything on the LAN can POST /orders with arbitrary
 * `price` values. The hub therefore ignores client-supplied prices entirely and
 * re-prices every line against its own menu cache, which is the same menu the
 * handsets are served from GET /menu.
 *
 * Returns either { ok: true, items, total_amount } with authoritative prices, or
 * { ok: false, error, details } describing exactly which lines were rejected.
 */

const MAX_QTY_PER_LINE = 99;
const MAX_LINES_PER_ORDER = 60;

export function priceOrder(rawItems, restaurantId) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: 'Order must contain at least 1 item.' };
  }

  if (rawItems.length > MAX_LINES_PER_ORDER) {
    return {
      ok: false,
      error: `Order exceeds the maximum of ${MAX_LINES_PER_ORDER} line items.`
    };
  }

  const menu = restaurantCache.getMenuCache(restaurantId);

  // A hub with no menu cannot price an order. Handsets already show the
  // "no menu data" banner in this state, so this should be unreachable in
  // normal use -- but billing must fail closed, never fall back to client prices.
  if (menu.uninitialized || !Array.isArray(menu.items) || menu.items.length === 0) {
    return {
      ok: false,
      error: 'Hub has no menu loaded, so orders cannot be priced. Connect this hub to the internet once to complete setup.',
      code: 'NO_MENU_CACHE'
    };
  }

  const byId = new Map(menu.items.map(item => [String(item.id), item]));

  const priced = [];
  const rejected = [];

  for (const raw of rawItems) {
    const id = String(raw?.id ?? '');
    const menuItem = byId.get(id);

    if (!menuItem) {
      rejected.push({ id, reason: 'UNKNOWN_ITEM' });
      continue;
    }

    if (menuItem.available === false) {
      rejected.push({ id, name: menuItem.name, reason: 'ITEM_UNAVAILABLE' });
      continue;
    }

    const qty = Math.floor(Number(raw?.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      rejected.push({ id, name: menuItem.name, reason: 'INVALID_QTY' });
      continue;
    }

    const price = Number(menuItem.price);
    if (!Number.isFinite(price) || price < 0) {
      rejected.push({ id, name: menuItem.name, reason: 'ITEM_NOT_PRICED' });
      continue;
    }

    // Variant handling. When the menu item ships a `variants` array, the
    // handset MUST pick one (the item's own `price` is a fallback for
    // legacy items that never grew variants). If the handset supplies a
    // variant_id that doesn't match one of them, reject the line — a
    // silent fallback would price the whole cart at a stale amount.
    //
    // Day-part pricing (M2 · PR 13) layers on top of variant / base
    // resolution via lib/dayParts.js: when a window is currently active,
    // its per-variant override wins over the variant's own price, its
    // flat `price` wins over the item's base price, and both fall back
    // to the underlying value when no window is active. Modifier deltas
    // still stack on top at the per-unit price step below.
    let variantId = null;
    let variantLabel = null;
    let unitPrice = price;
    let dayPartId = null;
    let dayPartLabel = null;
    const hasVariants = Array.isArray(menuItem.variants) && menuItem.variants.length > 0;
    if (hasVariants) {
      const raw_variant_id = raw?.variant_id;
      if (!raw_variant_id) {
        rejected.push({ id, name: menuItem.name, reason: 'VARIANT_REQUIRED' });
        continue;
      }
      const variant = menuItem.variants.find(v => String(v.id) === String(raw_variant_id));
      if (!variant) {
        rejected.push({ id, name: menuItem.name, reason: 'UNKNOWN_VARIANT', variant_id: raw_variant_id });
        continue;
      }
      const vp = Number(variant.price);
      if (!Number.isFinite(vp) || vp < 0) {
        rejected.push({ id, name: menuItem.name, reason: 'VARIANT_NOT_PRICED', variant_id: variant.id });
        continue;
      }
      // Per-variant availability (M2 · PR 14). `available: false` on a
      // variant means it's 86'd — the handset should already have hidden
      // or disabled it, but we still fail loud on the server so a stale
      // menu on the phone can't sneak an 86'd portion onto the KOT.
      // Legacy variants without an `available` field default to true.
      if (variant.available === false) {
        rejected.push({ id, name: menuItem.name, reason: 'VARIANT_UNAVAILABLE', variant_id: variant.id, variant_label: variant.label });
        continue;
      }
      variantId = variant.id;
      variantLabel = variant.label;
      const eff = resolveEffectivePrice(menuItem, variant);
      unitPrice = eff.price;
      dayPartId = eff.day_part_id;
      dayPartLabel = eff.day_part_label;
    } else {
      const eff = resolveEffectivePrice(menuItem, null);
      unitPrice = eff.price;
      dayPartId = eff.day_part_id;
      dayPartLabel = eff.day_part_label;
    }
    if (raw?.variant_id && !hasVariants) {
      // Item has no variants but the handset supplied one — reject rather
      // than silently ignore, so a stale menu on the phone gets caught.
      rejected.push({ id, name: menuItem.name, reason: 'UNKNOWN_VARIANT', variant_id: raw.variant_id });
      continue;
    }

    // Modifier handling. Same fail-loud discipline as variants: when the item
    // ships `modifier_groups`, the handset MUST honour min/max on every group
    // and every referenced group_id / option_id must resolve, or the whole
    // line is rejected. When the item has no modifier_groups, a modifiers[]
    // array from the handset is still rejected — same reason as spurious
    // variants: silently dropping it would let a stale phone menu bill wrong.
    const hasModifierGroups = Array.isArray(menuItem.modifier_groups) && menuItem.modifier_groups.length > 0;
    const rawModifiers = Array.isArray(raw?.modifiers) ? raw.modifiers : [];
    let resolvedModifiers = [];
    let modifierDelta = 0;
    let modifierReject = null;

    if (hasModifierGroups) {
      const groupsById = new Map(menuItem.modifier_groups.map(g => [String(g.id), g]));
      // Bucket handset picks by group so min/max checks can run per group.
      const picksByGroup = new Map();
      for (const pick of rawModifiers) {
        const gid = String(pick?.group_id ?? '');
        const oid = String(pick?.option_id ?? '');
        if (!gid || !oid) { modifierReject = { reason: 'UNKNOWN_MODIFIER_GROUP', group_id: gid }; break; }
        const group = groupsById.get(gid);
        if (!group) { modifierReject = { reason: 'UNKNOWN_MODIFIER_GROUP', group_id: gid }; break; }
        const option = (group.options || []).find(o => String(o.id) === oid);
        if (!option) { modifierReject = { reason: 'UNKNOWN_MODIFIER_OPTION', group_id: gid, option_id: oid }; break; }
        // Per-option availability (M2 · PR 14). Fail loud so a stale phone
        // menu can't sneak "+Extra cream" onto a ticket when the kitchen
        // ran out. Legacy options without `available` default to true.
        if (option.available === false) {
          modifierReject = { reason: 'MODIFIER_OPTION_UNAVAILABLE', group_id: gid, option_id: oid, option_label: option.label };
          break;
        }
        const bucket = picksByGroup.get(gid) || [];
        // Same option twice in the same group is treated as a max violation,
        // not a silent dedupe — the handset should not be sending duplicates.
        bucket.push(option);
        picksByGroup.set(gid, bucket);
      }
      if (!modifierReject) {
        for (const group of menuItem.modifier_groups) {
          const gid = String(group.id);
          const picks = picksByGroup.get(gid) || [];
          const min = Number.isFinite(Number(group.min)) ? Number(group.min) : 0;
          const max = Number.isFinite(Number(group.max)) ? Number(group.max) : (min > 0 ? 1 : 99);
          if (picks.length < min) {
            modifierReject = min > 0 && picks.length === 0
              ? { reason: 'MODIFIER_GROUP_REQUIRED', group_id: gid, group_label: group.label }
              : { reason: 'MODIFIER_GROUP_MIN_UNMET', group_id: gid, group_label: group.label, min, chosen: picks.length };
            break;
          }
          if (picks.length > max) {
            modifierReject = { reason: 'MODIFIER_GROUP_MAX_EXCEEDED', group_id: gid, group_label: group.label, max, chosen: picks.length };
            break;
          }
          for (const opt of picks) {
            const delta = Number(opt.price_delta);
            if (!Number.isFinite(delta)) {
              modifierReject = { reason: 'MODIFIER_NOT_PRICED', group_id: gid, option_id: String(opt.id) };
              break;
            }
            modifierDelta += delta;
            resolvedModifiers.push({
              group_id: gid,
              group_label: group.label,
              option_id: String(opt.id),
              option_label: opt.label,
              price_delta: delta
            });
          }
          if (modifierReject) break;
        }
      }
    } else if (rawModifiers.length > 0) {
      modifierReject = { reason: 'SPURIOUS_MODIFIERS' };
    }

    if (modifierReject) {
      rejected.push({ id, name: menuItem.name, ...modifierReject });
      continue;
    }

    // Per-unit price = variant (or base) price + sum of modifier deltas. The
    // delta is applied once per unit, not once per line — one Chicken Tikka
    // (Full, +Extra Cheese) ×2 costs `(340 + 40) × 2`.
    const finalUnitPrice = Math.round((unitPrice + modifierDelta) * 100) / 100;
    if (finalUnitPrice < 0) {
      rejected.push({ id, name: menuItem.name, reason: 'MODIFIER_MAKES_NEGATIVE_PRICE' });
      continue;
    }

    priced.push({
      id: menuItem.id,
      // Name and price both come from the hub, never from the request body.
      name: menuItem.name,
      qty,
      price: finalUnitPrice,
      variant_id: variantId,
      variant_label: variantLabel,
      // Empty array (not null) so downstream renderers can always .map without
      // a nullish guard. Legacy items with no modifiers keep the array empty.
      modifiers: resolvedModifiers,
      // Day-part attribution (M2 · PR 13). Both null when no window was
      // active at pricing time — the KOT/receipt/KDS then render the item
      // unchanged, just as they did before PR 13.
      day_part_id: dayPartId,
      day_part_label: dayPartLabel
    });
  }

  if (rejected.length > 0) {
    return {
      ok: false,
      error: 'Order rejected: one or more items are not on the current menu.',
      code: 'INVALID_ITEMS',
      details: rejected
    };
  }

  const total_amount = Math.round(
    priced.reduce((sum, i) => sum + i.price * i.qty, 0) * 100
  ) / 100;

  return { ok: true, items: priced, total_amount };
}
