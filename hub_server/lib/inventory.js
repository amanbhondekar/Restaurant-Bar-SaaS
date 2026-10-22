import crypto from 'crypto';

// Stock and recipes (M2 · inventory). Pure rules: every operation takes the current inventory state
// and returns { ok:true, data, meta? } or { ok:false, status, code, error, errors? }, the same shape
// menuAdmin.js uses. Nothing here touches the disk or the clock; lib/inventoryStore.js does.
//
// The model
// ---------
//   items    ingredients the kitchen counts: a name, one unit, how much is on hand, and a "low at"
//            level. One unit per ingredient, and recipes are written in that unit, so there is no
//            conversion to get wrong (a "kg" ingredient is cooked from in kg).
//   recipes  what ONE portion of a menu item (or of one size of it) uses: [{ ingredient, qty }].
//   movements the audit trail: every change to on_hand, with why.
//
// An item with no recipe is not tracked at all, so a restaurant that never sets this up sees no
// change anywhere. Stock-out is a flag layered over the menu, never a write to it: `available` stays
// what reception set by hand, so restocking brings a dish back without undoing a hand 86.

export const UNITS = ['g', 'kg', 'ml', 'l', 'pcs'];
export const LIMITS = { name: 80, ingredients: 500, recipeLines: 30, note: 200, quantity: 1e9, movements: 2000 };

const r3 = n => Math.round(n * 1000) / 1000;
/** A quantity of at least one thousandth, at most three decimals: what a kitchen can weigh. */
const isQty = n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= LIMITS.quantity && r3(n) === n;
/** The same, but zero is allowed (a stock count of nothing; a "low at" that never warns). */
const isLevel = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= LIMITS.quantity && r3(n) === n;

const norm = s => String(s ?? '').trim().toLowerCase();
// A recipe line is an ingredient and a quantity. A line may also name a modifier choice on the dish
// (`group_id` + `option_id`): it is then what ONE portion with that choice adds on top of the dish --
// extra cheese uses 20 g of cheese -- and is counted only when the order line picked that choice.
//
// Kept inside the dish's own recipe rather than as a recipe of its own. The cloud table has no column
// for an option, so a separate row would lose what it was for on a restore and come back as a second
// dish-wide recipe, which would be worse than not tracking extras at all.
export const isOptionLine = l => l.option_id != null;
const optionKey = (groupId, optionId) => `${groupId}|${optionId}`;
const lineKey = l => `${l.inventory_item_id}|${isOptionLine(l) ? optionKey(l.group_id, l.option_id) : ''}`;

/**
 * One recipe line as it is stored, synced and read back. Null for a line that cannot be trusted: a
 * half-named option is DROPPED rather than read as a base line, because the alternative is quietly
 * charging every portion of the dish for an extra that only some of them have.
 */
export function cleanLine(l) {
  if (!l || l.inventory_item_id == null || !isQty(Number(l.qty))) return null;
  const hasGroup = l.group_id != null && l.group_id !== '';
  const hasOption = l.option_id != null && l.option_id !== '';
  if (hasGroup !== hasOption) return null;
  return {
    inventory_item_id: String(l.inventory_item_id),
    qty: Number(l.qty),
    ...(hasOption ? { group_id: String(l.group_id), option_id: String(l.option_id) } : {})
  };
}

export const newIngredientId = () => 'ing_' + crypto.randomBytes(4).toString('hex');
export const newRecipeId = () => 'rec_' + crypto.randomBytes(4).toString('hex');
const newMovementId = () => 'mv_' + crypto.randomBytes(5).toString('hex');

const fail = (status, code, error, errors) => ({ ok: false, status, code, error, ...(errors ? { errors } : {}) });
const invalid = (errors, code = 'INVALID_INGREDIENT') => fail(400, code, errors[0].message, errors);
const bump = (state, patch) => ({ ...state, ...patch, revision: (state.revision || 0) + 1 });

export function emptyState(restaurantId = null) {
  return { restaurant_id: restaurantId, revision: 0, items: [], recipes: [], movements: [] };
}

/** A state read from disk, made safe to use: every list present, nothing else trusted. */
export function normalizeState(raw, restaurantId = null) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const items = (Array.isArray(s.items) ? s.items : [])
    .filter(i => i && typeof i === 'object' && i.id && String(i.name || '').trim() && UNITS.includes(i.unit))
    .map(i => ({
      id: String(i.id), name: String(i.name).trim(), unit: i.unit,
      on_hand: isLevel(Number(i.on_hand)) ? Number(i.on_hand) : Math.max(0, r3(Number(i.on_hand) || 0)),
      low_at: isLevel(Number(i.low_at)) ? Number(i.low_at) : 0
    }));
  const known = new Set(items.map(i => i.id));
  const recipes = (Array.isArray(s.recipes) ? s.recipes : [])
    .filter(r => r && r.id && r.item_id)
    .map(r => ({
      id: String(r.id), item_id: String(r.item_id), variant_id: r.variant_id == null || r.variant_id === '' ? null : String(r.variant_id),
      lines: (Array.isArray(r.lines) ? r.lines : [])
        .filter(l => l && known.has(String(l.inventory_item_id)))
        .map(cleanLine)
        .filter(Boolean)
    }))
    .filter(r => r.lines.length > 0);
  return {
    restaurant_id: s.restaurant_id ?? restaurantId,
    revision: Number.isInteger(s.revision) && s.revision >= 0 ? s.revision : 0,
    items,
    recipes,
    movements: (Array.isArray(s.movements) ? s.movements : []).filter(m => m && m.id && m.inventory_item_id).slice(-LIMITS.movements)
  };
}

// --- ingredients --------------------------------------------------------------------------------

export function validateIngredientInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid([{ field: 'ingredient', message: 'ingredient must be an object' }]);
  }
  const errors = [];
  const out = {};
  const has = k => input[k] !== undefined;

  if (has('name') || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > LIMITS.name) errors.push({ field: 'name', message: `name is required (1–${LIMITS.name} characters)` });
    else out.name = name;
  }
  if (has('unit') || !partial) {
    if (!UNITS.includes(input.unit)) errors.push({ field: 'unit', message: `unit must be one of ${UNITS.join(', ')}` });
    else out.unit = input.unit;
  }
  if (has('low_at')) {
    if (!isLevel(input.low_at)) errors.push({ field: 'low_at', message: 'low-stock level must be zero or more, with at most 3 decimals' });
    else out.low_at = input.low_at;
  }
  // Opening stock is accepted when an ingredient is created, never on an edit: changing what is on
  // hand has to go through an adjustment so the movement log says why.
  if (!partial && has('on_hand')) {
    if (!isLevel(input.on_hand)) errors.push({ field: 'on_hand', message: 'opening stock must be zero or more, with at most 3 decimals' });
    else out.on_hand = input.on_hand;
  }
  return errors.length ? invalid(errors) : { ok: true, item: out };
}

const usedBy = (state, ingredientId) => state.recipes.filter(r => r.lines.some(l => l.inventory_item_id === ingredientId));

function movement(ing, delta, reason, ctx, extra = {}) {
  return {
    id: newMovementId(),
    at: (ctx.now ?? new Date()).toISOString(),
    inventory_item_id: ing.id,
    delta: r3(delta),
    on_hand_after: ing.on_hand,
    reason,
    ...(extra.note ? { note: String(extra.note).slice(0, LIMITS.note) } : {}),
    ...(extra.ref ? { ref: String(extra.ref) } : {}),
    ...(ctx.by ? { by: String(ctx.by).slice(0, 60) } : {})
  };
}

const appendMovements = (state, moves) => [...state.movements, ...moves].slice(-LIMITS.movements);

export function addIngredient(state, input, ctx = {}) {
  const v = validateIngredientInput(input);
  if (!v.ok) return v;
  if (state.items.length >= LIMITS.ingredients) return fail(409, 'TOO_MANY_INGREDIENTS', `At most ${LIMITS.ingredients} ingredients.`);
  if (state.items.some(i => norm(i.name) === norm(v.item.name))) {
    return fail(409, 'DUPLICATE_INGREDIENT', `"${v.item.name}" already exists.`);
  }
  const item = { id: newIngredientId(), name: v.item.name, unit: v.item.unit, on_hand: v.item.on_hand ?? 0, low_at: v.item.low_at ?? 0 };
  const moves = item.on_hand > 0 ? [movement(item, item.on_hand, 'opening', ctx)] : [];
  return { ok: true, data: bump(state, { items: [...state.items, item], movements: appendMovements(state, moves) }), meta: { item } };
}

export function updateIngredient(state, id, input) {
  const idx = state.items.findIndex(i => i.id === id);
  if (idx === -1) return fail(404, 'INGREDIENT_NOT_FOUND', `No ingredient with id ${id}.`);
  const v = validateIngredientInput(input, { partial: true });
  if (!v.ok) return v;
  if ('on_hand' in (input || {})) {
    return fail(400, 'USE_ADJUSTMENT', 'Stock on hand is changed with a delivery, waste or count, so the log says why.');
  }
  const current = state.items[idx];
  if (v.item.unit && v.item.unit !== current.unit && usedBy(state, id).length > 0) {
    return fail(409, 'UNIT_IN_USE', `"${current.name}" is used in ${usedBy(state, id).length} recipe(s), written in ${current.unit}. Change those first.`);
  }
  if (v.item.name && norm(v.item.name) !== norm(current.name) && state.items.some((i, n) => n !== idx && norm(i.name) === norm(v.item.name))) {
    return fail(409, 'DUPLICATE_INGREDIENT', `"${v.item.name}" already exists.`);
  }
  const item = { ...current, ...v.item };
  return { ok: true, data: bump(state, { items: state.items.map((i, n) => (n === idx ? item : i)) }), meta: { item } };
}

export function deleteIngredient(state, id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return fail(404, 'INGREDIENT_NOT_FOUND', `No ingredient with id ${id}.`);
  const using = usedBy(state, id);
  if (using.length > 0) {
    return fail(409, 'INGREDIENT_IN_USE', `"${item.name}" is used in ${using.length} recipe(s). Remove it from them first.`);
  }
  return {
    ok: true,
    data: bump(state, { items: state.items.filter(i => i.id !== id), movements: state.movements.filter(m => m.inventory_item_id !== id) }),
    meta: { deleted: id }
  };
}

/**
 * Change what is on hand. `receive` adds a delivery, `waste` takes off what was thrown away or
 * spoiled, `count` sets the figure to what was physically counted. Waste cannot take stock below
 * zero: a count is how a discrepancy is put right.
 */
export function adjustStock(state, id, input, ctx = {}) {
  const idx = state.items.findIndex(i => i.id === id);
  if (idx === -1) return fail(404, 'INGREDIENT_NOT_FOUND', `No ingredient with id ${id}.`);
  const kind = input?.kind;
  const ing = state.items[idx];
  let after;
  if (kind === 'receive' || kind === 'waste') {
    if (!isQty(input.qty)) return invalid([{ field: 'qty', message: 'quantity must be more than zero, with at most 3 decimals' }], 'INVALID_ADJUSTMENT');
    if (kind === 'waste' && input.qty > ing.on_hand) {
      return fail(409, 'EXCEEDS_STOCK', `Only ${ing.on_hand} ${ing.unit} of ${ing.name} is on hand. Use a count to correct it.`);
    }
    after = r3(ing.on_hand + (kind === 'receive' ? input.qty : -input.qty));
  } else if (kind === 'count') {
    if (!isLevel(input.qty)) return invalid([{ field: 'qty', message: 'counted quantity must be zero or more, with at most 3 decimals' }], 'INVALID_ADJUSTMENT');
    after = input.qty;
  } else {
    return invalid([{ field: 'kind', message: 'kind must be receive, waste or count' }], 'INVALID_ADJUSTMENT');
  }
  if (typeof input.note === 'string' && input.note.length > LIMITS.note) {
    return invalid([{ field: 'note', message: `note can be at most ${LIMITS.note} characters` }], 'INVALID_ADJUSTMENT');
  }
  const next = { ...ing, on_hand: after };
  const delta = r3(after - ing.on_hand);
  const moves = delta === 0 ? [] : [movement(next, delta, kind, ctx, { note: input.note })];
  return {
    ok: true,
    data: bump(state, { items: state.items.map((i, n) => (n === idx ? next : i)), movements: appendMovements(state, moves) }),
    meta: { item: next, delta }
  };
}

// --- recipes ------------------------------------------------------------------------------------

const recipeKey = (itemId, variantId) => `${itemId}|${variantId ?? ''}`;

/**
 * Set what one portion uses. `lines: []` removes the recipe, which un-tracks that dish.
 * `menu` is the hub's menu, used only to check the dish (and size) exists.
 */
export function setRecipe(state, input, menu) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid([{ field: 'recipe', message: 'recipe must be an object' }], 'INVALID_RECIPE');
  const itemId = typeof input.item_id === 'string' ? input.item_id : '';
  const variantId = input.variant_id == null || input.variant_id === '' ? null : String(input.variant_id);
  const menuItem = (menu?.items || []).find(i => String(i.id) === itemId);
  if (!menuItem) return fail(404, 'ITEM_NOT_FOUND', `No menu item with id ${itemId || '(none)'}.`);
  if (variantId !== null && !(menuItem.variants || []).some(v => String(v.id) === variantId)) {
    return fail(404, 'VARIANT_NOT_FOUND', `"${menuItem.name}" has no size with id ${variantId}.`);
  }
  if (!Array.isArray(input.lines)) return invalid([{ field: 'lines', message: 'lines must be a list' }], 'INVALID_RECIPE');
  if (input.lines.length > LIMITS.recipeLines) return invalid([{ field: 'lines', message: `a recipe can have at most ${LIMITS.recipeLines} ingredients` }], 'INVALID_RECIPE');

  const known = new Set(state.items.map(i => i.id));
  // The choices this dish offers, so a line cannot name an extra it does not have.
  const offered = new Set((menuItem.modifier_groups || []).flatMap(g => (g.options || []).map(o => optionKey(g.id, o.id))));
  const seen = new Set();
  const errors = [];
  const lines = [];
  input.lines.forEach((l, n) => {
    const id = typeof l?.inventory_item_id === 'string' ? l.inventory_item_id : '';
    const hasGroup = l?.group_id != null && l.group_id !== '';
    const hasOption = l?.option_id != null && l.option_id !== '';
    const key = `${id}|${hasOption ? optionKey(l.group_id, l.option_id) : ''}`;
    if (!known.has(id)) errors.push({ field: `lines.${n}.inventory_item_id`, message: `line ${n + 1}: unknown ingredient` });
    else if (hasGroup !== hasOption) errors.push({ field: `lines.${n}.option_id`, message: `line ${n + 1}: an extra needs both its group and its choice` });
    else if (hasOption && !offered.has(optionKey(l.group_id, l.option_id))) errors.push({ field: `lines.${n}.option_id`, message: `line ${n + 1}: "${menuItem.name}" does not offer that choice` });
    else if (seen.has(key)) errors.push({ field: `lines.${n}.inventory_item_id`, message: `line ${n + 1}: ${hasOption ? 'that ingredient is already listed for this extra' : 'each ingredient can appear once'}` });
    else if (!isQty(l.qty)) errors.push({ field: `lines.${n}.qty`, message: `line ${n + 1}: quantity must be more than zero, with at most 3 decimals` });
    else { seen.add(key); lines.push(cleanLine({ ...l, inventory_item_id: id })); }
  });
  if (errors.length) return invalid(errors, 'INVALID_RECIPE');

  const key = recipeKey(itemId, variantId);
  const others = state.recipes.filter(r => recipeKey(r.item_id, r.variant_id) !== key);
  if (lines.length === 0) return { ok: true, data: bump(state, { recipes: others }), meta: { removed: key } };

  const existing = state.recipes.find(r => recipeKey(r.item_id, r.variant_id) === key);
  const recipe = { id: existing?.id ?? newRecipeId(), item_id: itemId, variant_id: variantId, lines };
  return { ok: true, data: bump(state, { recipes: [...others, recipe] }), meta: { recipe } };
}

/** The recipe for a dish at a size: that size's own, else the dish-wide one, else none. */
export function recipeFor(state, itemId, variantId = null) {
  const id = String(itemId);
  const exact = variantId == null ? null : state.recipes.find(r => r.item_id === id && r.variant_id === String(variantId));
  return exact ?? state.recipes.find(r => r.item_id === id && r.variant_id === null) ?? null;
}

// --- what an order needs ------------------------------------------------------------------------

/**
 * Total each ingredient an order needs, with the lines that need it. `lines` are priced order lines
 * ({ id, variant_id, qty }). A line with no recipe needs nothing, so it is never a problem.
 */
export function needsFor(state, lines) {
  const needs = new Map();
  (lines || []).forEach((line, index) => {
    const recipe = recipeFor(state, line.id, line.variant_id);
    if (!recipe) return;
    const qty = Number(line.qty) || 0;
    const picked = new Set((Array.isArray(line.modifiers) ? line.modifiers : []).map(m => optionKey(m?.group_id, m?.option_id)));
    for (const l of recipe.lines) {
      // An extra counts only for the portions that chose it.
      if (isOptionLine(l) && !picked.has(optionKey(l.group_id, l.option_id))) continue;
      const cur = needs.get(l.inventory_item_id) || { needed: 0, lines: [] };
      cur.needed = r3(cur.needed + l.qty * qty);
      if (!cur.lines.includes(index)) cur.lines.push(index);
      needs.set(l.inventory_item_id, cur);
    }
  });
  return needs;
}

/**
 * Ingredients an order cannot be made from. Needs are summed across lines first -- two dishes that
 * both use the chicken must be checked against the chicken together, not one at a time.
 */
export function shortagesFor(state, lines) {
  const byId = new Map(state.items.map(i => [i.id, i]));
  const out = [];
  for (const [id, { needed, lines: idx }] of needsFor(state, lines)) {
    const ing = byId.get(id);
    if (!ing) continue;
    if (needed > ing.on_hand) out.push({ inventory_item_id: id, name: ing.name, unit: ing.unit, needed, on_hand: ing.on_hand, lines: idx });
  }
  return out;
}

/** Take an order's ingredients out of stock. Never goes below zero; the check is `shortagesFor`. */
export function consume(state, lines, ctx = {}) {
  const needs = needsFor(state, lines);
  if (needs.size === 0) return { ok: true, data: state, meta: { movements: [] } };
  const moves = [];
  const items = state.items.map(ing => {
    const n = needs.get(ing.id);
    if (!n) return ing;
    const next = { ...ing, on_hand: Math.max(0, r3(ing.on_hand - n.needed)) };
    const delta = r3(next.on_hand - ing.on_hand);
    if (delta !== 0) moves.push(movement(next, delta, 'sale', ctx, { ref: ctx.ref }));
    return next;
  });
  return { ok: true, data: bump(state, { items, movements: appendMovements(state, moves) }), meta: { movements: moves } };
}

// --- levels and the menu overlay ----------------------------------------------------------------

/** 'out' at nothing, 'low' at or below the level reception set (when they set one), else 'ok'. */
export function levelOf(ing) {
  if (ing.on_hand <= 0) return 'out';
  if (ing.low_at > 0 && ing.on_hand <= ing.low_at) return 'low';
  return 'ok';
}

// Only the dish's own ingredients decide whether the DISH is out. An extra that has run out holds up an
// order that asks for it (shortagesFor), not the whole dish: nobody should lose the biryani because the
// extra cheese is gone.
const recipeShort = (state, byId, recipe) =>
  recipe.lines.filter(l => !isOptionLine(l)).some(l => {
    const ing = byId.get(l.inventory_item_id);
    return !ing || ing.on_hand < l.qty;
  });

/**
 * Which dishes and sizes cannot be made from what is on hand, as a Set of 'itemId' and
 * 'itemId|variantId' keys. One portion is the test: stock for two but an order of three is the order
 * check's business (`shortagesFor`), not a reason to hide the dish.
 */
export function stockOutKeys(state, menuItems) {
  const keys = new Set();
  if (!state.recipes.length) return keys;
  const byId = new Map(state.items.map(i => [i.id, i]));
  for (const item of menuItems || []) {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    if (variants.length === 0) {
      const r = recipeFor(state, item.id, null);
      if (r && recipeShort(state, byId, r)) keys.add(String(item.id));
      continue;
    }
    const outVariants = variants.filter(v => {
      const r = recipeFor(state, item.id, v.id);
      return r && recipeShort(state, byId, r);
    });
    outVariants.forEach(v => keys.add(`${item.id}|${v.id}`));
    // The dish as a whole is out when stock is the reason nothing can be ordered: at least one size
    // is out of stock and every other size is either out of stock or already 86'd by hand.
    if (outVariants.length > 0 && variants.every(v => v.available === false || outVariants.includes(v))) keys.add(String(item.id));
  }
  return keys;
}

/**
 * The menu with `stock_out: true` on what cannot be made. Items that need no change are returned as
 * they are (same reference), and `available` is never touched: that is reception's own switch.
 */
export function overlayMenuItems(state, items) {
  if (!Array.isArray(items) || !state.recipes.length) return items;
  const keys = stockOutKeys(state, items);
  if (keys.size === 0) return items;
  return items.map(item => {
    const itemOut = keys.has(String(item.id));
    const variants = Array.isArray(item.variants) ? item.variants : [];
    const anyVariantOut = variants.some(v => keys.has(`${item.id}|${v.id}`));
    if (!itemOut && !anyVariantOut) return item;
    return {
      ...item,
      ...(itemOut ? { stock_out: true } : {}),
      ...(anyVariantOut ? { variants: variants.map(v => (keys.has(`${item.id}|${v.id}`) ? { ...v, stock_out: true } : v)) } : {})
    };
  });
}

/**
 * The refusal for an order that cannot be made from what is on hand: a sentence for the waiter's
 * screen, and per-line details for anything that wants them. `lines` are the priced lines the
 * shortages were computed from.
 */
export function refusalFor(shortages, lines) {
  const byLine = new Map();
  for (const s of shortages) {
    for (const index of s.lines) {
      const list = byLine.get(index) || [];
      list.push({ ingredient: s.name, unit: s.unit, needed: s.needed, on_hand: s.on_hand });
      byLine.set(index, list);
    }
  }
  const details = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([index, short]) => {
    const line = lines[index] || {};
    return { id: line.id, name: line.name, variant_id: line.variant_id ?? null, variant_label: line.variant_label ?? null, reason: 'OUT_OF_STOCK', short };
  });
  const sentence = d => {
    const label = d.variant_label ? `${d.name} (${d.variant_label})` : d.name;
    const why = d.short.map(x => (x.on_hand <= 0 ? `no ${x.ingredient} left` : `needs ${x.needed} ${x.unit} of ${x.ingredient}, ${x.on_hand} ${x.unit} left`)).join(', ');
    return `${label}: ${why}`;
  };
  const shown = details.slice(0, 3).map(sentence).join('; ');
  const more = details.length > 3 ? ` and ${details.length - 3} more` : '';
  return { error: `Not enough stock for this order. ${shown}${more}.`, code: 'OUT_OF_STOCK', details };
}

/** Counts for the console's header. */
export function summarize(state) {
  const levels = state.items.map(levelOf);
  return {
    ingredients: state.items.length,
    out: levels.filter(l => l === 'out').length,
    low: levels.filter(l => l === 'low').length,
    recipes: state.recipes.length
  };
}
