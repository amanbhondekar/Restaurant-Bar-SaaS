import crypto from 'crypto';
import { normalizeVariants, normalizeModifierGroups, normalizeDayParts } from './menuNormalize.js';

// Pure menu editing. Nothing here touches disk: every operation takes the current
// menu object and returns { ok:true, data, meta? } or { ok:false, status, code,
// error, errors? }, the shape restaurantCache.updateCatalog expects from a mutator.

export const STATIONS = ['hot', 'cold', 'bar'];
export const LIMITS = { name: 120, category: 60, variantLabel: 40, importRows: 2000 };

export const norm = s => String(s ?? '').trim().toLowerCase();
export const newItemId = () => 'm_' + crypto.randomBytes(4).toString('hex');
export const isMoney = n => typeof n === 'number' && Number.isFinite(n) && n > 0 && Math.round(n * 100) / 100 === n;

export const sameKey = (a, b) => norm(a.name) === norm(b.name) && norm(a.category) === norm(b.category);

/** Find a category by exact match first, then case-insensitive. */
export function findCategory(categories, name) {
  return categories.find(c => c === name) ?? categories.find(c => norm(c) === norm(name)) ?? null;
}

/** The spelling a category already has in the menu, else the trimmed input. */
export function canonicalCategory(categories, name) {
  return categories.find(c => norm(c) === norm(name)) ?? String(name).trim();
}

const withCategory = (categories, name) =>
  categories.some(c => norm(c) === norm(name)) ? categories : [...categories, name];

const invalid = (errors, code = 'INVALID_ITEM') => ({ ok: false, status: 400, code, error: errors[0].message, errors });
const notFound = (code, error) => ({ ok: false, status: 404, code, error });
const conflict = (code, error) => ({ ok: false, status: 409, code, error });

/**
 * Strict validation of editor input. Every malformed value is rejected so the user
 * hears about it: no silent truncation, coercion or dropping of nested rows.
 * With `partial`, only the keys present are checked.
 */
export function validateItemInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid([{ field: 'item', message: 'item must be an object' }]);
  }
  const errors = [];
  const out = {};
  const has = k => input[k] !== undefined;

  if (has('name') || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > LIMITS.name) errors.push({ field: 'name', message: `name is required (1–${LIMITS.name} characters)` });
    else out.name = name;
  }
  if (has('category') || !partial) {
    const category = typeof input.category === 'string' ? input.category.trim() : '';
    if (!category || category.length > LIMITS.category) errors.push({ field: 'category', message: `category is required (1–${LIMITS.category} characters)` });
    else out.category = category;
  }
  if (has('isVeg') || !partial) {
    if (typeof input.isVeg !== 'boolean') errors.push({ field: 'isVeg', message: 'isVeg must be true or false' });
    else out.isVeg = input.isVeg;
  }
  if (has('available')) {
    if (typeof input.available !== 'boolean') errors.push({ field: 'available', message: 'available must be true or false' });
    else out.available = input.available;
  }
  if (has('station')) {
    const s = String(input.station).toLowerCase();
    if (!STATIONS.includes(s)) errors.push({ field: 'station', message: `station must be one of ${STATIONS.join(', ')}` });
    else out.station = s;
  }
  if (has('course')) {
    const c = typeof input.course === 'string' ? Number(input.course) : input.course;
    if (!Number.isInteger(c) || c < 1 || c > 9) errors.push({ field: 'course', message: 'course must be a whole number from 1 to 9' });
    else out.course = c;
  }
  if (has('price')) {
    const price = typeof input.price === 'string' ? Number(input.price) : input.price;
    if (!isMoney(price)) errors.push({ field: 'price', message: 'price must be a number above 0 with at most 2 decimals' });
    else out.price = price;
  }
  if (has('variants')) {
    const raw = input.variants;
    const clean = Array.isArray(raw) ? normalizeVariants(raw) : null;
    const ok = clean
      && clean.length === raw.length
      && new Set(clean.map(v => v.id)).size === clean.length
      && clean.every((v, i) => isMoney(v.price) && String(raw[i].label ?? '').length <= LIMITS.variantLabel);
    if (!ok) errors.push({ field: 'variants', message: 'every variant needs a unique id, a label (≤40 chars) and a price above 0 with at most 2 decimals' });
    else out.variants = clean;
  }
  if (has('modifier_groups')) {
    const raw = input.modifier_groups;
    const clean = Array.isArray(raw) ? normalizeModifierGroups(raw) : null;
    const ok = clean
      && clean.length === raw.length
      && new Set(clean.map(g => g.id)).size === clean.length
      && clean.every((g, i) => {
        const rawG = raw[i];
        const minOk = (rawG.min ?? 0) >= 0 && Number.isInteger(rawG.min ?? 0);
        const maxOk = rawG.max >= 1 && Number.isInteger(rawG.max) && rawG.max >= g.min;
        const labelOk = String(rawG.label ?? '').length <= LIMITS.variantLabel;
        const optionsOk = g.options.length === rawG.options.length
          && new Set(g.options.map(o => o.id)).size === g.options.length
          && g.options.every((o, oi) => {
            const rawO = rawG.options[oi];
            return typeof rawO.price_delta === 'number' && Number.isFinite(rawO.price_delta)
              && String(rawO.label ?? '').length <= LIMITS.variantLabel;
          });
        return minOk && maxOk && labelOk && optionsOk && g.min <= g.options.length;
      });
    if (!ok) {
      errors.push({
        field: 'modifier_groups',
        message: 'every group needs a unique id, a label (≤40 chars), min≥0 and max≥1 with max≥min; every option needs a unique id, a label (≤40 chars) and a numeric price_delta'
      });
    } else out.modifier_groups = clean;
  }
  if (has('day_parts')) {
    const raw = input.day_parts;
    const clean = Array.isArray(raw) ? normalizeDayParts(raw) : null;
    const ok = clean
      && clean.length === raw.length
      && new Set(clean.map(d => d.id)).size === clean.length
      && clean.every((d, i) => {
        const rawD = raw[i];
        const labelOk = String(rawD.label ?? '').length <= LIMITS.variantLabel;
        const priceOk = !Object.prototype.hasOwnProperty.call(rawD, 'price') || isMoney(rawD.price);
        const variantsOk = !rawD.variant_prices || (typeof rawD.variant_prices === 'object' && !Array.isArray(rawD.variant_prices)
          && Object.values(rawD.variant_prices).every(vp => isMoney(vp)));
        const daysOk = !Object.prototype.hasOwnProperty.call(rawD, 'days') || (Array.isArray(rawD.days)
          && rawD.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6));
        return labelOk && priceOk && variantsOk && daysOk;
      });
    if (!ok) {
      errors.push({ field: 'day_parts', message: 'every day-part needs a unique id, a label (≤40 chars), HH:MM start/end times; price (if present) must be >0 with ≤2 decimals, variant_prices values must be valid prices, days (if present) must all be integers 0–6' });
    } else out.day_parts = clean;
  }

  return errors.length ? invalid(errors) : { ok: true, item: out };
}

export function addItem(menu, input) {
  const v = validateItemInput(input);
  if (!v.ok) return v;

  const item = { id: newItemId(), available: true, ...v.item };
  item.category = canonicalCategory(menu.categories, item.category);
  if (item.price === undefined) {
    if (!item.variants?.length) return invalid([{ field: 'price', message: 'price is required when the item has no variants' }]);
    item.price = item.variants[0].price;
  }
  if (menu.items.some(i => sameKey(i, item))) {
    return conflict('DUPLICATE_ITEM', `"${item.name}" already exists in ${item.category}.`);
  }
  return {
    ok: true,
    data: { ...menu, categories: withCategory(menu.categories, item.category), items: [...menu.items, item] },
    meta: { item }
  };
}

const EMPTYABLE = ['variants', 'modifier_groups', 'day_parts'];

/** Merge semantics: keys you omit are preserved; send `[]` to clear variants/groups/day-parts. */
export function updateItem(menu, id, input) {
  const idx = menu.items.findIndex(i => i.id === id);
  if (idx === -1) return notFound('ITEM_NOT_FOUND', `No menu item with id ${id}.`);

  const v = validateItemInput(input, { partial: true });
  if (!v.ok) return v;

  const item = { ...menu.items[idx], ...v.item };
  if (v.item.category) item.category = canonicalCategory(menu.categories, v.item.category);
  for (const k of EMPTYABLE) {
    if (Array.isArray(item[k]) && item[k].length === 0) delete item[k];
  }
  if (!sameKey(menu.items[idx], item) && menu.items.some((i, n) => n !== idx && sameKey(i, item))) {
    return conflict('DUPLICATE_ITEM', `"${item.name}" already exists in ${item.category}.`);
  }
  return {
    ok: true,
    data: {
      ...menu,
      categories: withCategory(menu.categories, item.category),
      items: menu.items.map((i, n) => (n === idx ? item : i))
    },
    meta: { item }
  };
}

export function deleteItem(menu, id) {
  if (!menu.items.some(i => i.id === id)) return notFound('ITEM_NOT_FOUND', `No menu item with id ${id}.`);
  return { ok: true, data: { ...menu, items: menu.items.filter(i => i.id !== id) }, meta: { deleted: id } };
}

const cleanCategoryName = name => {
  const clean = typeof name === 'string' ? name.trim() : '';
  return clean && clean.length <= LIMITS.category ? clean : null;
};
const badCategoryName = () =>
  invalid([{ field: 'name', message: `category name is required (1–${LIMITS.category} characters)` }], 'INVALID_CATEGORY');

export function addCategory(menu, name) {
  const clean = cleanCategoryName(name);
  if (!clean) return badCategoryName();
  if (menu.categories.some(c => norm(c) === norm(clean))) return conflict('CATEGORY_EXISTS', `Category "${clean}" already exists.`);
  return { ok: true, data: { ...menu, categories: [...menu.categories, clean] }, meta: { name: clean } };
}

export function renameCategory(menu, from, to) {
  const current = findCategory(menu.categories, from);
  if (!current) return notFound('CATEGORY_NOT_FOUND', `No category named "${from}".`);
  const clean = cleanCategoryName(to);
  if (!clean) return badCategoryName();
  if (menu.categories.some(c => c !== current && norm(c) === norm(clean))) {
    return conflict('CATEGORY_EXISTS', `Category "${clean}" already exists.`);
  }
  return {
    ok: true,
    data: {
      ...menu,
      categories: menu.categories.map(c => (c === current ? clean : c)),
      items: menu.items.map(i => (norm(i.category) === norm(current) ? { ...i, category: clean } : i))
    },
    meta: { name: clean }
  };
}

export function reorderCategories(menu, names) {
  if (!Array.isArray(names) || names.length !== menu.categories.length || new Set(names).size !== names.length) {
    return invalid([{ field: 'names', message: 'names must list every existing category exactly once' }], 'INVALID_ORDER');
  }
  const canonical = names.map(n => findCategory(menu.categories, n));
  if (canonical.some(c => !c) || new Set(canonical).size !== canonical.length) {
    return invalid([{ field: 'names', message: 'names must list every existing category exactly once' }], 'INVALID_ORDER');
  }
  return { ok: true, data: { ...menu, categories: canonical } };
}

export function deleteCategory(menu, name) {
  const category = findCategory(menu.categories, name);
  if (!category) return notFound('CATEGORY_NOT_FOUND', `No category named "${name}".`);
  const count = menu.items.filter(i => norm(i.category) === norm(category)).length;
  if (count > 0) return conflict('CATEGORY_NOT_EMPTY', `"${category}" still has ${count} item(s). Move or delete them first.`);
  return { ok: true, data: { ...menu, categories: menu.categories.filter(c => c !== category) } };
}
