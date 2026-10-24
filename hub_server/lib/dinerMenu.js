// The menu as a diner may see it (M4 · diner QR menu).
//
// This is a security boundary, not a formatting helper. The hub's menu cache carries things that
// belong to the restaurant and not to its guests -- which station cooks a dish, the day-part
// schedule that sets its price, internal availability flags -- and the route that serves this is
// the only unauthenticated read in the hub. So this builds a diner's menu from an allow-list of
// fields rather than deleting the sensitive ones from a copy: a field added to the cache later
// stays invisible here until someone deliberately lets it through.
//
// Prices are the *effective* ones, resolved through the same day-part logic the order is priced
// with, so a diner is never shown a number the kitchen would not charge.

import { resolveEffectivePrice } from './dayParts.js';

/** What an option adds. Zero is meaningful here -- a free choice such as spice level. */
const delta = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/**
 * What a dish costs. Zero is NOT meaningful here: the hub's own rules require a price above zero,
 * so a 0 in the cache is bad data, and quoting a guest "₹0" is worse than not listing the dish.
 */
const price = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

// Not on offer either way: reception 86'd it by hand (`available: false`), or the kitchen has run out of
// something it needs (`stock_out`, set by the stock overlay). A guest cannot tell the two apart and
// has no use for the difference.
const isAvailable = thing => thing?.available !== false && thing?.stock_out !== true;

/** Options a diner can choose, with what each adds. Prep instructions carry no price. */
function publicModifierGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map(g => {
      const options = (Array.isArray(g.options) ? g.options : [])
        .filter(isAvailable)
        .map(o => ({
          id: String(o.id),
          label: String(o.label ?? ''),
          // 0 is meaningful (a free choice such as spice level), so it is kept rather than dropped.
          price_delta: delta(o.price_delta) ?? 0
        }));
      return {
        id: String(g.id),
        label: String(g.label ?? ''),
        min: Number.isFinite(Number(g.min)) ? Number(g.min) : 0,
        max: Number.isFinite(Number(g.max)) ? Number(g.max) : options.length,
        options
      };
    })
    // A group whose every option is 86'd would render as an empty choice.
    .filter(g => g.options.length > 0);
}

/**
 * One cached item as a diner's menu entry, or null if it should not be shown at all.
 *
 * An 86'd dish is hidden rather than greyed out: a guest cannot order from this screen, so
 * showing something unavailable only invites them to ask for it. The same goes for a dish whose
 * every size is 86'd, and for one with no sensible price.
 */
export function publicItem(item, now = new Date()) {
  if (!item || !isAvailable(item)) return null;

  const variants = Array.isArray(item.variants)
    ? item.variants.filter(isAvailable).map(v => ({
        id: String(v.id),
        label: String(v.label ?? ''),
        price: price(resolveEffectivePrice(item, v, now).price)
      })).filter(v => v.price !== null)
    : [];

  // A dish that has variants is priced by them; one with none is priced by itself.
  const hadVariants = Array.isArray(item.variants) && item.variants.length > 0;
  if (hadVariants && variants.length === 0) return null;

  const basePrice = price(resolveEffectivePrice(item, null, now).price);
  if (!hadVariants && basePrice === null) return null;

  return {
    id: String(item.id),
    name: String(item.name ?? ''),
    category: String(item.category ?? ''),
    is_veg: item.isVeg === true,
    ...(hadVariants ? { variants } : { price: basePrice }),
    ...(publicModifierGroups(item.modifier_groups).length
      ? { options: publicModifierGroups(item.modifier_groups) }
      : {})
  };
}

/**
 * The whole menu for a diner, grouped the way it is read: by category, in the restaurant's own
 * order, with empty categories dropped.
 */
export function publicMenu(menuCache, now = new Date()) {
  const items = Array.isArray(menuCache?.items) ? menuCache.items : [];
  const shown = items.map(i => publicItem(i, now)).filter(Boolean);

  // The restaurant's category order, with anything referenced only by an item appended after it.
  const declared = Array.isArray(menuCache?.categories) ? menuCache.categories.map(String) : [];
  const seen = [...declared];
  for (const i of shown) if (i.category && !seen.includes(i.category)) seen.push(i.category);

  const categories = seen
    .map(name => ({ name, items: shown.filter(i => i.category === name) }))
    .filter(c => c.items.length > 0);

  return { categories, item_count: shown.length };
}
