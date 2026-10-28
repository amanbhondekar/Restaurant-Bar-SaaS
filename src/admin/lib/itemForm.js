// The item editor's form model. Plain ESM with no DOM and no React, so the hub's `node --test` suite
// can check it against the hub's own item rules (hub_server/lib/menuAdmin.js).
//
//   itemToForm(item)            hub item  -> form fields (everything the user types is a string)
//   formToPayload(form)         form      -> the item shape the hub stores
//   createPayload(form)         form      -> POST body for a new item (empty lists left out)
//   changedPayload(item, form)  form      -> PUT body: ONLY the keys the user changed
//   validateForm(form, {original})        -> { ok, errors } keyed by field path ("variants.0.price")
//
// "Saving a basic edit never drops variants, modifier groups or day-parts" holds because a PUT carries
// only the changed keys and the hub merges them into the stored item.

export const STATIONS = ['hot', 'cold', 'bar'];
export const LIMITS = { name: 120, category: 60, label: 40 };

const MONEY = /^\d+(\.\d{1,2})?$/;
const DELTA = /^-?\d+(\.\d{1,2})?$/;
const WHOLE = /^\d+$/;
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const text = v => (v === undefined || v === null ? '' : String(v));
const num = s => Number(String(s).trim());
const blank = s => String(s ?? '').trim() === '';

const randomHex = () => {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes); // randomUUID needs a secure context; this does not
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

/** `prefix_` + 8 hex digits, not one of `taken`. Prefixes in use: v (variant), g (group), o (option), d (day-part). */
export function makeId(prefix, taken = []) {
  const used = new Set(taken);
  let id;
  do { id = `${prefix}_${randomHex()}`; } while (used.has(id));
  return id;
}

/** A new item. `isVeg` starts unanswered: like the importer, the editor makes the user say so. */
export function blankForm(category = '') {
  return { id: null, name: '', category, price: '', isVeg: null, available: true, station: '', course: '', variants: [], modifier_groups: [], day_parts: [] };
}

/** Hub item (as GET /menu returns it) to form fields. Extra keys such as effective_price are ignored. */
export function itemToForm(item) {
  const station = text(item.station).toLowerCase();
  return {
    id: item.id ?? null,
    name: text(item.name),
    category: text(item.category),
    price: Number(item.price) > 0 ? String(item.price) : '',
    isVeg: item.isVeg !== false,
    available: item.available !== false,
    station: STATIONS.includes(station) ? station : '',
    // The serving course (1 starters, 2 mains, 3 desserts); blank means the default, course 1.
    course: Number.isInteger(item.course) && item.course >= 1 && item.course <= 9 ? String(item.course) : '',
    variants: (item.variants ?? []).map(v => ({
      id: String(v.id), label: text(v.label), price: text(v.price), available: v.available !== false
    })),
    modifier_groups: (item.modifier_groups ?? []).map(g => ({
      id: String(g.id), label: text(g.label), min: text(g.min ?? 0), max: text(g.max ?? 1),
      options: (g.options ?? []).map(o => ({
        id: String(o.id), label: text(o.label), price_delta: text(o.price_delta ?? 0), available: o.available !== false
      }))
    })),
    day_parts: (item.day_parts ?? []).map(d => ({
      id: String(d.id), label: text(d.label), starts_at: text(d.starts_at), ends_at: text(d.ends_at),
      days: Array.isArray(d.days) ? d.days.filter(Number.isInteger) : [],
      price: text(d.price),
      variant_prices: Object.fromEntries(Object.entries(d.variant_prices ?? {}).map(([id, price]) => [id, text(price)]))
    }))
  };
}

/**
 * Form fields to the item shape the hub stores (ids kept, numbers parsed, text trimmed). A blank
 * price or station is left out (the hub keeps what it has), and a day-part's per-variant prices are
 * limited to variants that still exist.
 */
export function formToPayload(form) {
  const payload = {
    name: form.name.trim(),
    category: form.category.trim(),
    isVeg: form.isVeg,
    available: form.available
  };
  if (!blank(form.price)) payload.price = num(form.price);
  if (form.station) payload.station = form.station;
  if (form.course) payload.course = num(form.course);

  payload.variants = form.variants.map(v => ({ id: v.id, label: v.label.trim(), price: num(v.price), available: v.available }));
  payload.modifier_groups = form.modifier_groups.map(g => ({
    id: g.id, label: g.label.trim(), min: num(g.min), max: num(g.max),
    options: g.options.map(o => ({ id: o.id, label: o.label.trim(), price_delta: num(o.price_delta), available: o.available }))
  }));
  const variantIds = new Set(form.variants.map(v => v.id));
  payload.day_parts = form.day_parts.map(d => {
    const part = { id: d.id, label: d.label.trim(), starts_at: d.starts_at, ends_at: d.ends_at };
    if (d.days.length > 0) part.days = [...d.days].sort((a, b) => a - b);
    if (!blank(d.price)) part.price = num(d.price);
    const perVariant = Object.entries(d.variant_prices).filter(([id, price]) => variantIds.has(id) && !blank(price));
    if (perVariant.length > 0) part.variant_prices = Object.fromEntries(perVariant.map(([id, price]) => [id, num(price)]));
    return part;
  });
  return payload;
}

/** POST body for a new item: the same, without empty variant / modifier / day-part lists. */
export function createPayload(form) {
  const payload = formToPayload(form);
  for (const key of ['variants', 'modifier_groups', 'day_parts']) {
    if (payload[key].length === 0) delete payload[key];
  }
  return payload;
}

/**
 * PUT body for an edited item: only the keys whose value differs from what the item looked like when
 * it was opened. A list the user changed is sent whole (an empty list clears it on the hub); a list
 * they did not touch is not sent at all, so the hub keeps it.
 */
export function changedPayload(item, form) {
  const before = formToPayload(itemToForm(item));
  const after = formToPayload(form);
  const out = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) out[key] = after[key];
  }
  return out;
}

const PRICE_MESSAGE = 'Price must be above 0, with up to 2 decimals.';
const priceBad = s => !MONEY.test(String(s).trim()) || !(num(s) > 0);

/**
 * What the editor checks before it bothers the hub. It follows the hub's rules, and may be stricter,
 * never looser. With `original` (an edit), only what the user changed is checked: an old row with
 * data the hub would no longer accept must not block an unrelated edit such as 86'ing the dish.
 * Errors are keyed by field path: name, category, isVeg, price, station, variants.0.label,
 * modifier_groups.1.options.0.price_delta, day_parts.0.variant_prices.<variantId>, ...
 */
export function validateForm(form, { original = null } = {}) {
  const errors = {};
  const after = formToPayload(form);
  const before = original ? formToPayload(itemToForm(original)) : null;
  const touched = key => !before || JSON.stringify(after[key]) !== JSON.stringify(before[key]);

  if (touched('name') && (!after.name || after.name.length > LIMITS.name)) {
    errors.name = `Name is required (up to ${LIMITS.name} characters).`;
  }
  if (touched('category') && (!after.category || after.category.length > LIMITS.category)) {
    errors.category = `Category is required (up to ${LIMITS.category} characters).`;
  }
  if (touched('isVeg') && typeof form.isVeg !== 'boolean') errors.isVeg = 'Choose Veg or Non-veg.';
  if (touched('station') && form.station && !STATIONS.includes(form.station)) errors.station = 'Choose hot, cold or bar.';
  if (touched('course') && form.course && !(Number.isInteger(Number(form.course)) && Number(form.course) >= 1 && Number(form.course) <= 9)) {
    errors.course = 'Choose a course from 1 to 9.';
  }
  if (touched('price')) {
    // An item with variants is priced by its variants; the top-level price is only a display fallback.
    if (blank(form.price) ? form.variants.length === 0 : priceBad(form.price)) errors.price = PRICE_MESSAGE;
  }

  if (touched('variants')) {
    const seen = new Set();
    form.variants.forEach((v, i) => {
      const label = v.label.trim();
      if (!label || label.length > LIMITS.label) errors[`variants.${i}.label`] = `Give each variant a name (up to ${LIMITS.label} characters).`;
      else if (seen.has(label.toLowerCase())) errors[`variants.${i}.label`] = 'Each variant needs a different name.';
      seen.add(label.toLowerCase());
      if (priceBad(v.price)) errors[`variants.${i}.price`] = PRICE_MESSAGE;
    });
  }

  if (touched('modifier_groups')) {
    form.modifier_groups.forEach((g, i) => {
      const at = k => `modifier_groups.${i}.${k}`;
      const label = g.label.trim();
      if (!label || label.length > LIMITS.label) errors[at('label')] = `Give the group a name (up to ${LIMITS.label} characters).`;
      const minOk = WHOLE.test(g.min.trim());
      const maxOk = WHOLE.test(g.max.trim()) && num(g.max) >= 1;
      if (!minOk) errors[at('min')] = 'Minimum must be a whole number, 0 or more.';
      if (!maxOk) errors[at('max')] = 'Maximum must be a whole number, at least 1.';
      else if (minOk && num(g.max) < num(g.min)) errors[at('max')] = `Maximum must be at least the minimum (${num(g.min)}).`;
      if (g.options.length === 0) errors[at('options')] = 'Add at least one option.';
      else if (minOk && num(g.min) > g.options.length) errors[at('min')] = `Minimum can't be more than the number of options (${g.options.length}).`;
      g.options.forEach((o, j) => {
        const optionLabel = o.label.trim();
        if (!optionLabel || optionLabel.length > LIMITS.label) errors[at(`options.${j}.label`)] = `Give each option a name (up to ${LIMITS.label} characters).`;
        if (!DELTA.test(o.price_delta.trim())) errors[at(`options.${j}.price_delta`)] = 'Enter a number: 0 for free, a minus sign for a discount.';
      });
    });
  }

  if (touched('day_parts')) {
    form.day_parts.forEach((d, i) => {
      const at = k => `day_parts.${i}.${k}`;
      const label = d.label.trim();
      if (!label || label.length > LIMITS.label) errors[at('label')] = `Give this window a name (up to ${LIMITS.label} characters).`;
      if (blank(d.starts_at)) errors[at('starts_at')] = 'Set a start time.';
      else if (!HHMM.test(d.starts_at)) errors[at('starts_at')] = 'Use a time like 18:30.';
      if (blank(d.ends_at)) errors[at('ends_at')] = 'Set an end time.';
      else if (!HHMM.test(d.ends_at)) errors[at('ends_at')] = 'Use a time like 18:30.';
      else if (d.starts_at === d.ends_at) errors[at('ends_at')] = 'Start and end must be different times.';
      if (!d.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) errors[at('days')] = 'Pick days between Sunday and Saturday.';

      const perVariant = Object.entries(d.variant_prices).filter(([id, price]) => form.variants.some(v => v.id === id) && !blank(price));
      for (const [id, price] of perVariant) {
        if (priceBad(price)) errors[at(`variant_prices.${id}`)] = PRICE_MESSAGE;
      }
      if (!blank(d.price)) {
        if (priceBad(d.price)) errors[at('price')] = PRICE_MESSAGE;
      } else if (perVariant.length === 0) {
        errors[at('price')] = 'Set a price for this window, flat or per variant.';
      }
    });
  }

  return { ok: Object.keys(errors).length === 0, errors };
}
