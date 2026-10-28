// The basket on a guest's phone (§4.5). Pure: no React, no fetch.
//
// Everything here is about what the guest SEES. The hub prices the order again from its own menu when
// it arrives, so nothing worked out here can change what anyone is charged -- it only has to agree
// with the menu in front of them, or they will think they were overcharged.

export const MAX_PER_LINE = 20;

/** A line's key: a dish, or one size of it. Two sizes of the same dish are two lines. */
export const lineKey = (itemId, variantId) => `${itemId}|${variantId ?? ''}`;

/** What one unit of this costs, as the menu shows it. A sized dish is priced by its size. */
export function unitPrice(item, variant) {
  if (variant) return Number(variant.price) || 0;
  return Number(item?.price) || 0;
}

/** Add one. Already in the basket means one more, up to the cap. */
export function addToBasket(basket, item, variant) {
  const key = lineKey(item.id, variant?.id);
  const existing = basket[key];
  if (existing) {
    return existing.qty >= MAX_PER_LINE
      ? basket
      : { ...basket, [key]: { ...existing, qty: existing.qty + 1 } };
  }
  return {
    ...basket,
    [key]: {
      item_id: String(item.id),
      ...(variant ? { variant_id: String(variant.id), variant_label: variant.label } : {}),
      name: item.name,
      price: unitPrice(item, variant),
      qty: 1
    }
  };
}

/** Take one away. The last one takes the line out, rather than leaving a row saying zero. */
export function removeFromBasket(basket, key) {
  const existing = basket[key];
  if (!existing) return basket;
  if (existing.qty <= 1) {
    const { [key]: _gone, ...rest } = basket;
    return rest;
  }
  return { ...basket, [key]: { ...existing, qty: existing.qty - 1 } };
}

export const basketLines = basket => Object.entries(basket).map(([key, line]) => ({ key, ...line }));
export const basketCount = basket => basketLines(basket).reduce((n, l) => n + l.qty, 0);

/**
 * What the basket comes to, as the menu would add it up.
 *
 * Shown as "about", and the screen says so: tax and any service charge are worked out by the hub when
 * the bill is raised, so a total presented as final here would be a number the guest is then charged
 * more than.
 */
export const basketTotal = basket => basketLines(basket).reduce((n, l) => n + l.price * l.qty, 0);

/** What is sent to the hub: the ids and quantities, and nothing else. */
export const basketToOrder = basket => basketLines(basket).map(l => ({
  id: l.item_id,
  qty: l.qty,
  ...(l.variant_id ? { variant_id: l.variant_id } : {})
}));

/** "₹1,480" in Indian digit grouping, matching the menu above it. */
export const money = (currency, n) => `${currency}${Number(n).toLocaleString('en-IN')}`;
