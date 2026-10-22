// Wording and arithmetic for the Inventory tab. Pure functions, no React, so the rules are tested on
// their own. The hub (hub_server/lib/inventory.js) re-checks everything; these exist so reception
// hears about a mistake before the round trip, in words, next to the field.

export const LEVELS = {
  ok: { label: 'In stock', tone: 'green' },
  low: { label: 'Low', tone: 'amber' },
  out: { label: 'Out', tone: 'rust' }
};

export const UNIT_NAMES = { g: 'grams (g)', kg: 'kilograms (kg)', ml: 'millilitres (ml)', l: 'litres (l)', pcs: 'pieces (pcs)' };

const MAX_QTY = 1e9;

/** "1,000 g", "0.25 kg". Indian digit grouping, no trailing zeros, never more than 3 decimals. */
export function formatQty(qty, unit) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return '';
  const text = n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  return unit ? `${text} ${unit}` : text;
}

/**
 * A quantity typed into a box. Whole numbers or decimals only (no "1e3", no "1,5"), at most three
 * decimals, and more than zero unless `allowZero` (a stock count of nothing, a level that never warns).
 */
export function parseQuantity(text, { allowZero = false } = {}) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { ok: false, error: 'Enter a quantity.' };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { ok: false, error: 'Use digits only, with a point for a fraction (for example 0.25).' };
  if ((raw.split('.')[1] || '').length > 3) return { ok: false, error: 'At most 3 decimal places.' };
  const value = Number(raw);
  if (value > MAX_QTY) return { ok: false, error: 'That is more than the hub accepts.' };
  if (value === 0 && !allowZero) return { ok: false, error: 'Must be more than zero.' };
  return { ok: true, value };
}

// --- ingredients --------------------------------------------------------------------------------

export const blankIngredient = () => ({ name: '', unit: 'g', on_hand: '', low_at: '' });

export const ingredientToForm = ing => ({ name: ing.name, unit: ing.unit, on_hand: '', low_at: ing.low_at ? String(ing.low_at) : '' });

/**
 * Check the add/edit form. `editing` ingredients cannot change what is on hand here (that is a delivery,
 * waste or a count, so the log says why), so on_hand is only read when adding.
 * Returns { errors, payload } where payload is the body to send when there are no errors.
 */
export function validateIngredientForm(form, { editing = false, others = [] } = {}) {
  const errors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Give it a name.';
  else if (name.length > 80) errors.name = 'At most 80 characters.';
  else if (others.some(o => o.trim().toLowerCase() === name.toLowerCase())) errors.name = `"${name}" is already on the list.`;

  const payload = { name, unit: form.unit };
  const low = form.low_at.trim() === '' ? { ok: true, value: 0 } : parseQuantity(form.low_at, { allowZero: true });
  if (!low.ok) errors.low_at = low.error; else payload.low_at = low.value;

  if (!editing) {
    const have = form.on_hand.trim() === '' ? { ok: true, value: 0 } : parseQuantity(form.on_hand, { allowZero: true });
    if (!have.ok) errors.on_hand = have.error; else payload.on_hand = have.value;
  }
  return { errors, payload };
}

// --- adjustments --------------------------------------------------------------------------------

export const ADJUSTMENTS = {
  receive: { title: 'Record a delivery', verb: 'Add', hint: 'How much arrived.', placeholder: 'Quantity received' },
  waste: { title: 'Record waste', verb: 'Remove', hint: 'How much was thrown away or spoiled.', placeholder: 'Quantity wasted' },
  count: { title: 'Correct the count', verb: 'Set', hint: 'What you actually counted on the shelf. This replaces the figure.', placeholder: 'Quantity counted' }
};

/** Validate an adjustment against what is on hand. Waste cannot take more than there is. */
export function validateAdjustment(kind, text, ingredient) {
  const parsed = parseQuantity(text, { allowZero: kind === 'count' });
  if (!parsed.ok) return parsed;
  if (kind === 'waste' && parsed.value > ingredient.on_hand) {
    return { ok: false, error: `Only ${formatQty(ingredient.on_hand, ingredient.unit)} is on hand. Use "Correct the count" if the figure is wrong.` };
  }
  return parsed;
}

/** What the figure will be after the adjustment, for the line under the box. */
export function afterAdjustment(kind, qty, ingredient) {
  if (kind === 'receive') return Math.round((ingredient.on_hand + qty) * 1000) / 1000;
  if (kind === 'waste') return Math.round((ingredient.on_hand - qty) * 1000) / 1000;
  return qty;
}

const REASON = { opening: 'Opening stock', receive: 'Delivery', waste: 'Waste', count: 'Count correction', sale: 'Used in orders' };

/** One line of an ingredient's history. */
export function describeMovement(m, unit) {
  const sign = m.delta > 0 ? '+' : m.delta < 0 ? '−' : '';
  return {
    id: m.id,
    reason: REASON[m.reason] || m.reason,
    change: `${sign}${formatQty(Math.abs(m.delta), unit)}`,
    after: formatQty(m.on_hand_after, unit),
    detail: [m.ref ? `Ticket ${m.ref}` : null, m.note || null, m.by || null].filter(Boolean).join(' · '),
    at: m.at
  };
}

// --- recipes ------------------------------------------------------------------------------------

export const subjectKey = (itemId, variantId) => `${itemId}|${variantId ?? ''}`;

/** A choice on a dish (extra cheese), as a map key. Group AND option: option ids repeat across groups. */
export const extraKey = (groupId, optionId) => `${groupId}|${optionId}`;

/** The choices a dish offers, each of which can use stock: [{ key, group_id, option_id, label, group_label }]. */
export function dishExtras(item) {
  return (Array.isArray(item?.modifier_groups) ? item.modifier_groups : []).flatMap(g =>
    (Array.isArray(g.options) ? g.options : []).map(o => ({
      key: extraKey(g.id, o.id), group_id: String(g.id), option_id: String(o.id), label: o.label, group_label: g.label
    })));
}

/**
 * Everything a recipe can be written for: each dish with no sizes, and for a dish with sizes each size
 * plus "every size" (a recipe that covers any size without its own). Each carries the extras the dish
 * offers, because an extra's ingredients are part of that same recipe.
 */
export function recipeSubjects(menuItems) {
  const out = [];
  for (const item of menuItems || []) {
    const sizes = Array.isArray(item.variants) ? item.variants : [];
    const extras = dishExtras(item);
    if (sizes.length === 0) {
      out.push({ key: subjectKey(item.id, null), item_id: String(item.id), variant_id: null, label: item.name, extras });
      continue;
    }
    out.push({ key: subjectKey(item.id, null), item_id: String(item.id), variant_id: null, label: `${item.name} · every size`, extras });
    for (const v of sizes) out.push({ key: subjectKey(item.id, v.id), item_id: String(item.id), variant_id: String(v.id), label: `${item.name} · ${v.label}`, extras });
  }
  return out;
}

/**
 * "Paneer 150 g · Onion 0.1 kg", then "With Extra cheese: Cheese 20 g" for each extra. An ingredient that
 * has since been removed is said so, not hidden. `extras` (a subject's) turns an extra's ids into the
 * name reception gave it; without it the option id is shown, which is ugly but not wrong.
 */
export function recipeSummary(recipe, ingredients, extras = []) {
  const byId = new Map((ingredients || []).map(i => [i.id, i]));
  const named = new Map(extras.map(x => [x.key, x.label]));
  const say = l => {
    const ing = byId.get(l.inventory_item_id);
    return ing ? `${ing.name} ${formatQty(l.qty, ing.unit)}` : '(removed ingredient)';
  };
  const base = recipe.lines.filter(l => l.option_id == null).map(say);
  const byExtra = new Map();
  for (const l of recipe.lines.filter(x => x.option_id != null)) {
    const key = extraKey(l.group_id, l.option_id);
    byExtra.set(key, [...(byExtra.get(key) ?? []), say(l)]);
  }
  const extrasText = [...byExtra.entries()].map(([key, said]) => `With ${named.get(key) ?? key.split('|')[1]}: ${said.join(', ')}`);
  return [...base, ...extrasText].join(' · ');
}

export const blankLine = () => ({ inventory_item_id: '', qty: '' });

/** The dish's own ingredients, as the editor's rows. */
export const recipeToLines = recipe => recipe.lines
  .filter(l => l.option_id == null)
  .map(l => ({ inventory_item_id: l.inventory_item_id, qty: String(l.qty) }));

/** The extras' ingredients, as editor rows keyed by extra: { 'g_extras|o_cheese': [row, ...] }. */
export function recipeToExtras(recipe) {
  const out = {};
  for (const l of recipe.lines.filter(x => x.option_id != null)) {
    const key = extraKey(l.group_id, l.option_id);
    out[key] = [...(out[key] ?? []), { inventory_item_id: l.inventory_item_id, qty: String(l.qty) }];
  }
  return out;
}

/**
 * Check a recipe editor's lines. An empty list is allowed: it removes the recipe. Returns
 * { errors: { [index]: { ingredient?, qty? } , form? }, payload } with payload = the lines to send.
 */
export function validateRecipeLines(lines, ingredients) {
  const errors = {};
  const payload = [];
  const known = new Set((ingredients || []).map(i => i.id));
  const seen = new Set();
  lines.forEach((l, i) => {
    const e = {};
    const id = l.inventory_item_id;
    if (!id) e.ingredient = 'Choose an ingredient.';
    else if (!known.has(id)) e.ingredient = 'That ingredient no longer exists.';
    else if (seen.has(id)) e.ingredient = 'Each ingredient can be listed once.';
    else seen.add(id);
    const q = parseQuantity(l.qty);
    if (!q.ok) e.qty = q.error;
    if (e.ingredient || e.qty) errors[i] = e;
    else payload.push({ inventory_item_id: id, qty: q.value });
  });
  if (lines.length > 30) errors.form = 'A recipe can list at most 30 ingredients.';
  return { errors, payload };
}

/**
 * Check the whole editor: the dish's own lines and each extra's. `extras` is { key: [rows] } and
 * `offered` the dish's own extras (from its subject), so a row for an extra the dish no longer offers is
 * left out rather than sent and refused. Returns { errors, extraErrors: { [key]: errors }, payload }, with
 * payload = every line to send, the extras' carrying their group and option.
 */
export function validateRecipe(lines, extras, offered, ingredients) {
  const base = validateRecipeLines(lines, ingredients);
  const extraErrors = {};
  const payload = [...base.payload];
  for (const x of offered || []) {
    const rows = (extras || {})[x.key] ?? [];
    if (rows.length === 0) continue;
    const checked = validateRecipeLines(rows, ingredients);
    if (Object.keys(checked.errors).length) extraErrors[x.key] = checked.errors;
    payload.push(...checked.payload.map(l => ({ ...l, group_id: x.group_id, option_id: x.option_id })));
  }
  const total = payload.length;
  const errors = { ...base.errors };
  if (total > 30 && !errors.form) errors.form = 'A recipe can list at most 30 ingredients.';
  return { errors, extraErrors, payload };
}

// --- reading the menu for stock-outs ------------------------------------------------------------

/** Dishes (and sizes) the hub says cannot be made right now, from the shown menu's `stock_out` flags. */
export function dishesOutOfStock(menuItems) {
  const out = [];
  for (const item of menuItems || []) {
    if (item.stock_out) { out.push({ id: item.id, label: item.name }); continue; }
    for (const v of item.variants || []) if (v.stock_out) out.push({ id: `${item.id}|${v.id}`, label: `${item.name} · ${v.label}` });
  }
  return out;
}

/** The sentence for the banner: "Paneer Tikka and Biryani · Full cannot be ordered until restocked." */
export function outOfStockLine(dishes) {
  if (!dishes.length) return '';
  const names = dishes.map(d => d.label);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} cannot be ordered until restocked.`;
}

/** The header line: "12 ingredients · 2 low · 1 out of stock · 5 dishes tracked". */
export function summaryLine(summary) {
  if (!summary || summary.ingredients === 0) return 'No ingredients yet.';
  const parts = [`${summary.ingredients} ${summary.ingredients === 1 ? 'ingredient' : 'ingredients'}`];
  if (summary.low) parts.push(`${summary.low} low`);
  if (summary.out) parts.push(`${summary.out} out of stock`);
  parts.push(`${summary.recipes} ${summary.recipes === 1 ? 'recipe' : 'recipes'}`);
  return parts.join(' · ');
}
