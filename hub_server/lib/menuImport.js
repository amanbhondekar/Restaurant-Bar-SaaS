import { STATIONS, LIMITS, norm, newItemId } from './menuAdmin.js';

// Menu import: rows arrive already parsed (the browser reads the CSV/xlsx; the hub
// never sees the file) as plain objects of strings keyed by lower-case column name.
// Rules (spec §2): a column that is absent, or a cell that is blank, never
// overwrites an existing value; modifiers and day-parts are not importable and
// survive re-imports; `veg` is required for new items.

const YES = new Set(['yes', 'y', 'true', '1', 'veg', 'available']);
const NO = new Set(['no', 'n', 'false', '0', 'non-veg', 'nonveg', 'non veg', 'unavailable']);
const MONEY = /^\d+(\.\d{1,2})?$/;

const parseBool = v => {
  const s = String(v).trim().toLowerCase();
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  return null;
};
const parseMoney = v => {
  const s = String(v).trim();
  if (!MONEY.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
};
const slug = label => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

// What counts as "changed" for the review table. Legacy variants have no
// `available` key, so compare it as `!== false`. Station defaults to 'hot' for
// round-trip consistency (export writes 'hot', re-import should not mark as changed).
const VIEW = {
  name: i => i.name,
  category: i => i.category,
  price: i => i.price,
  isVeg: i => i.isVeg,
  available: i => i.available !== false,
  station: i => i.station || 'hot',
  // Course defaults to 1 the same way station defaults to 'hot': the export writes a blank for
  // course 1, so re-importing that file must not read as a change.
  course: i => i.course || 1,
  variants: i => (i.variants || []).map(v => [v.id, v.label, v.price, v.available !== false])
};

function parseVariants(cell, existing) {
  const parts = cell.split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { error: 'variants must look like Half:180|Full:280' };

  const taken = new Set(existing.map(v => v.id));
  const seen = new Set();
  const variants = [];
  for (const part of parts) {
    const at = part.lastIndexOf(':');
    const label = at > 0 ? part.slice(0, at).trim() : '';
    if (!label || label.length > LIMITS.variantLabel) {
      return { error: `variant "${part}" must look like Label:price (label up to ${LIMITS.variantLabel} characters)` };
    }
    const price = parseMoney(part.slice(at + 1));
    if (price === null) return { error: `variant "${label}" needs a price above 0 with at most 2 decimals` };
    if (seen.has(norm(label))) return { error: `variant "${label}" is listed twice` };
    seen.add(norm(label));

    const prior = existing.find(v => norm(v.label) === norm(label));
    if (prior) {
      variants.push({ id: prior.id, label, price, available: prior.available !== false });
      continue;
    }
    const base = 'v_' + slug(label);
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}_${n++}`;
    taken.add(id);
    variants.push({ id, label, price, available: true });
  }
  return { variants };
}

function claimedIds(menu, results) {
  const claimed = new Set();
  for (const r of results) {
    // All rows claim their matched_id if they have one
    if (r.matched_id) claimed.add(r.matched_id);
    // Errored rows with no match also claim existing items by name
    if (r.status === 'error' && !r.matched_id && r.name) {
      const existing = menu.items.filter(i => norm(i.name) === norm(r.name));
      for (const e of existing) claimed.add(e.id);
    }
  }
  return claimed;
}

function processRow(raw, idx, menu, catMap, seen, usedIds, idGen, finalKeys) {
  const row = Number.isInteger(raw?.__row) ? raw.__row : idx + 2;
  const cell = k => (raw?.[k] === undefined || raw?.[k] === null ? '' : String(raw[k]).trim());
  const errors = [];
  const id = cell('id');
  const name = cell('name');
  const category = cell('category');

  let existing = id ? menu.items.find(i => i.id === id) : undefined;
  const matchedById = Boolean(existing);
  if (!existing && name) {
    const byName = menu.items.filter(i => norm(i.name) === norm(name));
    existing = category
      ? byName.find(i => norm(i.category) === norm(category))
      : (byName.length === 1 ? byName[0] : undefined);
  }
  const isNew = !existing;
  const before = existing ? structuredClone(existing) : null;
  const item = existing ? structuredClone(existing) : { available: true };

  // Generate ID for new items
  if (isNew) {
    let newId = idGen();
    while (usedIds.has(newId)) {
      newId = idGen();
    }
    item.id = newId;
    usedIds.add(newId);
  } else {
    item.id = existing.id;
  }

  if (name) {
    if (name.length > LIMITS.name) errors.push(`name must be at most ${LIMITS.name} characters`);
    // A match by name keeps the stored spelling ("paneer tikka" must not rename
    // "Paneer Tikka"); only a match by id may rename the item.
    else if (!existing || matchedById) item.name = name;
  } else if (isNew) {
    errors.push('name is required');
  }

  if (category) {
    if (category.length > LIMITS.category) {
      errors.push(`category must be at most ${LIMITS.category} characters`);
    } else {
      const key = norm(category);
      if (!catMap.has(key)) catMap.set(key, category);
      item.category = catMap.get(key);
    }
  } else if (isNew) {
    errors.push('category is required');
  }

  const priceCell = cell('price');
  if (priceCell) {
    const p = parseMoney(priceCell);
    if (p === null) errors.push('price must be a number above 0 with at most 2 decimals');
    else item.price = p;
  }

  const variantsCell = cell('variants');
  if (variantsCell) {
    const r = parseVariants(variantsCell, existing?.variants || []);
    if (r.error) {
      errors.push(r.error);
    } else {
      item.variants = r.variants;
      if (isNew && item.price === undefined) item.price = r.variants[0].price;
    }
  }
  if (isNew && item.price === undefined && !priceCell && !variantsCell) {
    errors.push('price is required (or provide variants)');
  }

  const vegCell = cell('veg');
  if (vegCell) {
    const b = parseBool(vegCell);
    if (b === null) errors.push('veg must be yes or no');
    else item.isVeg = b;
  } else if (isNew) {
    errors.push('veg is required for new items (yes or no)');
  }

  const availCell = cell('available');
  if (availCell) {
    const b = parseBool(availCell);
    if (b === null) errors.push('available must be yes or no');
    else item.available = b;
  }

  const stationCell = cell('station').toLowerCase();
  if (stationCell) {
    if (!STATIONS.includes(stationCell)) errors.push(`station must be one of ${STATIONS.join(', ')}`);
    else item.station = stationCell;
  }

  // Serving course, 1-9 (1 starters, 2 mains, 3 desserts). A blank cell leaves an existing
  // dish's course alone and gives a new dish the default, exactly like every other column here.
  const courseCell = cell('course');
  if (courseCell) {
    const course = Number(courseCell);
    if (!Number.isInteger(course) || course < 1 || course > 9) {
      errors.push('course must be a whole number from 1 to 9');
    } else {
      item.course = course;
    }
  }

  if (name || existing) {
    const key = existing ? `id:${existing.id}` : `new:${norm(item.name ?? name)}|${norm(item.category ?? category)}`;
    if (seen.has(key)) errors.push(`duplicate of row ${seen.get(key)}`);
    else seen.set(key, row);
  }

  const matched_id = existing?.id ?? null;
  if (errors.length) return { row, status: 'error', name, category, errors, changes: [], matched_id };

  // KEY-COLLISION GUARD: Check for duplicate keys when item is new or key has changed
  const finalKey = `${norm(item.name ?? '')}|${norm(item.category ?? '')}`;
  const originalKey = existing ? `${norm(existing.name)}|${norm(existing.category)}` : null;
  const keyChanged = originalKey !== null && finalKey !== originalKey;

  if (isNew || keyChanged) {
    // Check if another existing item already has this key
    const collision = menu.items.find(i => i.id !== item.id &&
      norm(i.name) === norm(item.name) &&
      norm(i.category) === norm(item.category));

    if (collision) {
      errors.push(`would duplicate "${item.name}" in ${item.category}`);
      return { row, status: 'error', name: item.name, category: item.category, errors, changes: [], matched_id };
    }

    // Check if finalKeys already has this key
    if (finalKeys.has(finalKey)) {
      errors.push(`duplicate of row ${finalKeys.get(finalKey)}`);
      return { row, status: 'error', name: item.name, category: item.category, errors, changes: [], matched_id };
    }
  }

  const changes = before
    ? Object.keys(VIEW)
        .filter(f => JSON.stringify(VIEW[f](before)) !== JSON.stringify(VIEW[f](item)))
        .map(f => ({ field: f, from: VIEW[f](before), to: VIEW[f](item) }))
    : [];
  const status = isNew ? 'new' : changes.length ? 'updated' : 'unchanged';

  // Record the key for new items or items that changed keys
  if (isNew || keyChanged) {
    finalKeys.set(finalKey, row);
  }

  return { row, status, name: item.name, category: item.category, errors: [], changes, item, matched_id };
}

export function previewImport(menu, rows, { mode = 'merge', idGen = newItemId } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, status: 400, code: 'NO_ROWS', error: 'The file has no rows to import.' };
  }
  if (rows.length > LIMITS.importRows) {
    return { ok: false, status: 400, code: 'TOO_MANY_ROWS', error: `Imports are limited to ${LIMITS.importRows} rows.` };
  }

  const catMap = new Map(menu.categories.map(c => [norm(c), c]));
  const seen = new Map();
  const usedIds = new Set(menu.items.map(i => i.id));
  const finalKeys = new Map();
  const results = rows.map((raw, idx) => processRow(raw, idx, menu, catMap, seen, usedIds, idGen, finalKeys));

  const counts = { new: 0, updated: 0, unchanged: 0, error: 0, removed: 0 };
  for (const r of results) counts[r.status]++;
  if (mode === 'replace') {
    // A row with an error still "claims" the item it matched or shares a name with,
    // so a bad row never deletes data.
    const claimed = claimedIds(menu, results);
    counts.removed = menu.items.filter(i => !claimed.has(i.id)).length;
  }
  return { ok: true, rows: results, counts };
}

export function applyImport(menu, rows, { mode = 'merge', skipInvalid = false, idGen = newItemId } = {}) {
  const preview = previewImport(menu, rows, { mode, idGen });
  if (!preview.ok) return preview;

  if (preview.counts.error > 0 && !skipInvalid) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_ROWS',
      error: `${preview.counts.error} row(s) have errors. Fix them or import the valid rows only.`,
      details: preview.rows.filter(r => r.status === 'error')
    };
  }

  const good = preview.rows.filter(r => r.status !== 'error');

  // Need at least one valid (non-error) row to apply. A row with no changes is still valid.
  // Refusing here, in either mode, keeps a no-op import from becoming a write: that would
  // bump the revision (which makes the hub authoritative over cloud pulls), take a backup
  // and broadcast, all for nothing.
  if (good.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'NO_VALID_ROWS',
      error: mode === 'replace'
        ? 'Replace needs at least one valid row. Nothing was changed.'
        : 'No valid rows to import. Nothing was changed.'
    };
  }

  const updatedById = new Map(good.filter(r => r.matched_id).map(r => [r.matched_id, r.item]));
  const fresh = good.filter(r => !r.matched_id).map(r => r.item);

  let items;
  if (mode === 'replace') {
    const claimed = claimedIds(menu, preview.rows);
    items = [...menu.items.filter(i => claimed.has(i.id)).map(i => updatedById.get(i.id) || i), ...fresh];
  } else {
    items = [...menu.items.map(i => updatedById.get(i.id) || i), ...fresh];
  }

  const used = new Set(items.map(i => i.category));
  const categories = mode === 'replace' ? menu.categories.filter(c => used.has(c)) : [...menu.categories];
  for (const it of items) {
    if (!categories.includes(it.category)) categories.push(it.category);
  }

  return {
    ok: true,
    data: { ...menu, categories, items },
    meta: { counts: preview.counts, skipped: preview.counts.error }
  };
}
