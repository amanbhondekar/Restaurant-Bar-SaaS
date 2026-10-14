import test from 'node:test';
import assert from 'node:assert/strict';
import { previewImport, applyImport } from '../lib/menuImport.js';

const menu = () => ({
  restaurant_id: 'r', revision: 2,
  categories: ['Starters', 'Mains', 'Desserts'],
  items: [
    { id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true },
    {
      id: 'm2', name: 'Dal Tadka', price: 190, category: 'Mains', isVeg: true, available: true,
      variants: [{ id: 'v_half', label: 'Half', price: 120 }, { id: 'v_full', label: 'Full', price: 190, available: false }],
      modifier_groups: [{ id: 'g1', label: 'Spice', min: 1, max: 1, options: [{ id: 'o1', label: 'Mild', price_delta: 0, available: true }] }]
    },
    { id: 'm3', name: 'Gulab Jamun', price: 90, category: 'Desserts', isVeg: true, available: true, station: 'cold' }
  ]
});

test('merge updates a matched item (name + category, case-insensitive) and shows the field diff', () => {
  const p = previewImport(menu(), [{ name: 'paneer tikka', category: 'STARTERS', price: '250' }]);
  assert.equal(p.ok, true);
  assert.equal(p.rows[0].status, 'updated');
  assert.equal(p.rows[0].matched_id, 'm1');
  assert.deepEqual(p.rows[0].changes, [{ field: 'price', from: 230, to: 250 }]);
  assert.deepEqual(p.counts, { new: 0, updated: 1, unchanged: 0, error: 0, removed: 0 });

  const a = applyImport(menu(), [{ name: 'paneer tikka', category: 'STARTERS', price: '250' }]);
  assert.equal(a.data.items.find(i => i.id === 'm1').price, 250);
  assert.equal(a.data.items.length, 3);
});

test('blank cells and absent columns never overwrite; modifiers and variants survive', () => {
  const rows = [{ name: 'Dal Tadka', category: 'Mains', price: '200', veg: '', available: '', station: '' }];
  const p = previewImport(menu(), rows);
  assert.deepEqual(p.rows[0].changes.map(c => c.field), ['price']);
  const item = applyImport(menu(), rows).data.items.find(i => i.id === 'm2');
  assert.equal(item.price, 200);
  assert.equal(item.modifier_groups.length, 1);
  assert.equal(item.variants.length, 2);
});

test('an id that matches takes precedence; an unknown id falls back to name + category', () => {
  const byId = previewImport(menu(), [{ id: 'm3', name: 'Gulab Jamun (2 pcs)', category: 'Desserts' }]);
  assert.equal(byId.rows[0].matched_id, 'm3');
  assert.equal(byId.rows[0].status, 'updated');

  const unknown = previewImport(menu(), [{ id: 'zzz', name: 'Paneer Tikka', category: 'Starters' }]);
  assert.equal(unknown.rows[0].matched_id, 'm1');
});

test('a new item needs veg; the reported row number follows the spreadsheet (header = row 1)', () => {
  const p = previewImport(menu(), [{ name: 'Chaas', category: 'Beverages', price: '50' }]);
  assert.equal(p.rows[0].status, 'error');
  assert.equal(p.rows[0].row, 2);
  assert.ok(p.rows[0].errors.some(e => e.startsWith('veg is required')));

  const hinted = previewImport(menu(), [{ __row: 7, name: 'Chaas', category: 'Beverages', price: '50' }]);
  assert.equal(hinted.rows[0].row, 7);
});

test('a new item gets a generated id (never the supplied unknown one) and a new category', () => {
  const rows = [{ id: 'zzz', name: 'Masala Chaas', category: 'Beverages', price: '50', veg: 'yes', station: 'bar' }];
  const p = previewImport(menu(), rows);
  assert.equal(p.rows[0].status, 'new');
  const a = applyImport(menu(), rows);
  const added = a.data.items.at(-1);
  assert.match(added.id, /^m_[0-9a-f]{8}$/);
  assert.equal(added.station, 'bar');
  assert.equal(added.isVeg, true);
  assert.equal(added.available, true);
  assert.deepEqual(a.data.categories, ['Starters', 'Mains', 'Desserts', 'Beverages']);
});

test('veg accepts yes/no/true/false/1/0/veg/non-veg and rejects anything else', () => {
  const ok = ['yes', 'No', 'TRUE', 'false', '1', '0', 'veg', 'Non-Veg'].map(v => ({ name: `D${v}`, category: 'Starters', price: '10', veg: v }));
  assert.equal(previewImport(menu(), ok).counts.error, 0);
  const bad = previewImport(menu(), [{ name: 'X', category: 'Starters', price: '10', veg: 'maybe' }]);
  assert.ok(bad.rows[0].errors.includes('veg must be yes or no'));
});

test('prices are strict: above 0, at most 2 decimals, digits only', () => {
  const run = price => previewImport(menu(), [{ name: 'X', category: 'Starters', price, veg: 'yes' }]).rows[0].status;
  assert.equal(run('50'), 'new');
  assert.equal(run('50.5'), 'new');
  assert.equal(run('12.345'), 'error');
  assert.equal(run('-5'), 'error');
  assert.equal(run('0'), 'error');
  assert.equal(run('₹50'), 'error');
});

test('variants: matched labels keep id and 86\'d state, new labels get slug ids, omitted labels are removed', () => {
  const rows = [{ name: 'Dal Tadka', category: 'Mains', variants: 'Half:130|Large:260' }];
  const item = applyImport(menu(), rows).data.items.find(i => i.id === 'm2');
  assert.deepEqual(item.variants, [
    { id: 'v_half', label: 'Half', price: 130, available: true },
    { id: 'v_large', label: 'Large', price: 260, available: true }
  ]);

  const same = previewImport(menu(), [{ name: 'Dal Tadka', category: 'Mains', variants: 'Half:120|Full:190' }]);
  assert.equal(same.rows[0].status, 'unchanged', 'identical variants (86\'d Full included) are not a change');
  const kept = applyImport(menu(), [{ name: 'Dal Tadka', category: 'Mains', variants: 'Half:120|Full:190' }]);
  assert.equal(kept.data.items.find(i => i.id === 'm2').variants[1].available, false);
});

test('variants: bad syntax, repeated labels and non-positive prices are errors; slug collisions are suffixed', () => {
  const run = variants => previewImport(menu(), [{ name: 'X', category: 'Starters', veg: 'yes', variants }]).rows[0];
  assert.equal(run('Half-180').status, 'error');
  assert.equal(run('Half:180|half:200').status, 'error');
  assert.equal(run('Half:0').status, 'error');

  const a = applyImport(menu(), [{ name: 'X', category: 'Starters', veg: 'yes', variants: 'Half Plate:100|Half-Plate!:120' }]);
  assert.deepEqual(a.data.items.at(-1).variants.map(v => v.id), ['v_half_plate', 'v_half_plate_2']);
});

test('a new item with variants and no price takes the first variant price', () => {
  const a = applyImport(menu(), [{ name: 'Chai', category: 'Beverages', veg: 'yes', variants: 'Cutting:20|Full:40' }]);
  assert.equal(a.data.items.at(-1).price, 20);
});

test('duplicate rows in one file are flagged on the second occurrence', () => {
  const p = previewImport(menu(), [
    { name: 'Paneer Tikka', category: 'Starters', price: '240' },
    { name: 'paneer tikka', category: 'starters', price: '250' }
  ]);
  assert.equal(p.rows[0].status, 'updated');
  assert.equal(p.rows[1].status, 'error');
  assert.equal(p.rows[1].errors[0], 'duplicate of row 2');
});

test('replace removes unmatched items but keeps non-importable fields on matched ones', () => {
  const rows = [{ name: 'Dal Tadka', category: 'Mains', price: '200' }];
  const p = previewImport(menu(), rows, { mode: 'replace' });
  assert.equal(p.counts.removed, 2);

  const a = applyImport(menu(), rows, { mode: 'replace' });
  assert.deepEqual(a.data.items.map(i => i.id), ['m2']);
  assert.equal(a.data.items[0].modifier_groups.length, 1);
  assert.deepEqual(a.data.categories, ['Mains'], 'categories no longer used are dropped');
});

test('replace never deletes an item whose row had an error', () => {
  const rows = [
    { name: 'Paneer Tikka', category: 'Starters', price: '230' },
    { name: 'Dal Tadka', category: 'Mains', price: 'abc' }
  ];
  const p = previewImport(menu(), rows, { mode: 'replace' });
  assert.equal(p.counts.removed, 1, 'only Gulab Jamun is unmatched');
  const a = applyImport(menu(), rows, { mode: 'replace', skipInvalid: true });
  assert.deepEqual(a.data.items.map(i => i.id).sort(), ['m1', 'm2']);
  assert.equal(a.data.items.find(i => i.id === 'm2').price, 190, 'the bad row left the item untouched');
});

test('applyImport blocks on row errors unless skipInvalid is set', () => {
  const rows = [
    { name: 'Paneer Tikka', category: 'Starters', price: '240' },
    { name: 'Bad', category: 'Starters', price: 'abc', veg: 'yes' }
  ];
  const blocked = applyImport(menu(), rows);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.code, 'INVALID_ROWS');
  assert.equal(blocked.details.length, 1);
  assert.equal(blocked.details[0].row, 3);

  const skipped = applyImport(menu(), rows, { skipInvalid: true });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.meta.skipped, 1);
  assert.equal(skipped.data.items.find(i => i.id === 'm1').price, 240);
  assert.equal(skipped.data.items.length, 3);
});

test('row limits: empty and over-2000 files are refused', () => {
  assert.equal(previewImport(menu(), []).code, 'NO_ROWS');
  const many = Array.from({ length: 2001 }, (_, i) => ({ name: `D${i}`, category: 'Bulk', price: '1', veg: 'yes' }));
  assert.equal(previewImport(menu(), many).code, 'TOO_MANY_ROWS');
  assert.equal(previewImport(menu(), many.slice(0, 2000)).ok, true);
});

// ADDITIONAL TESTS FOR ID UNIQUENESS AND KEY-COLLISION GUARD

test('ID uniqueness: idGen option generates unique ids, skipping duplicates', () => {
  const ids = ['m1', 'm1', 'mNew1', 'mNew2'];
  let callCount = 0;
  const idGen = () => ids[callCount++];

  const rows = [
    { name: 'Item1', category: 'Starters', price: '100', veg: 'yes' },
    { name: 'Item2', category: 'Starters', price: '100', veg: 'yes' }
  ];

  const a = applyImport(menu(), rows, { idGen });
  const newItems = a.data.items.slice(-2);

  // First item should get 'mNew1' (skipped 'm1' twice)
  // Second item should get 'mNew2'
  assert.equal(newItems[0].id, 'mNew1');
  assert.equal(newItems[1].id, 'mNew2');
  assert.ok(newItems.every(i => !a.data.items.slice(0, 3).some(existing => existing.id === i.id)));
});

test('key-collision guard: would duplicate error when id-match rename creates collision', () => {
  const rows = [{ id: 'm1', name: 'Dal Tadka', category: 'Mains' }];
  const p = previewImport(menu(), rows);

  assert.equal(p.rows[0].status, 'error');
  assert.ok(p.rows[0].errors.some(e => e.includes('would duplicate')));
  assert.ok(p.rows[0].errors.some(e => e.includes('Dal Tadka')));
  assert.ok(p.rows[0].errors.some(e => e.includes('Mains')));
});

test('key-collision guard: duplicate of row N when new row collides with earlier new row', () => {
  const rows = [
    { name: 'NewItem', category: 'Starters', price: '100', veg: 'yes' },
    { name: 'NewItem', category: 'Starters', price: '150', veg: 'yes' }
  ];
  const p = previewImport(menu(), rows);

  assert.equal(p.rows[0].status, 'new');
  assert.equal(p.rows[1].status, 'error');
  assert.equal(p.rows[1].errors[0], 'duplicate of row 2');
});

test('key-collision guard: unchanged key is never blocked by collision guard', () => {
  // Create a menu with a legacy duplicate pair
  const menuWithDuplicate = () => ({
    restaurant_id: 'r', revision: 2,
    categories: ['Starters', 'Mains'],
    items: [
      { id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true },
      { id: 'm2', name: 'Paneer Tikka', price: 250, category: 'Starters', isVeg: true, available: true }
    ]
  });

  // Re-importing unchanged row for m1 should not error
  const rows = [{ id: 'm1', name: 'Paneer Tikka', category: 'Starters', price: '230' }];
  const p = previewImport(menuWithDuplicate(), rows);

  assert.equal(p.rows[0].status, 'unchanged');
  assert.equal(p.rows[0].errors.length, 0);
});

// FIX ROUND 1: NEW TESTS FOR DEFECTS

test('key guard: an id-rename cannot take a key an earlier row just claimed, in either order', () => {
  const a = previewImport(menu(), [
    { name: 'Chaas', category: 'Beverages', price: '50', veg: 'yes' },
    { id: 'm3', name: 'Chaas', category: 'Beverages' }]);
  assert.equal(a.rows[1].errors[0], 'duplicate of row 2');

  const b = previewImport(menu(), [
    { id: 'm3', name: 'Chaas', category: 'Beverages' },
    { name: 'Chaas', category: 'Beverages', price: '50', veg: 'yes' }]);
  assert.equal(b.rows[1].errors[0], 'duplicate of row 2');
});

test('ID uniqueness: a repeat from idGen within one import is skipped', () => {
  const seq = ['dup', 'dup', 'ok'];
  const a = applyImport(menu(), [
    { name: 'A', category: 'Starters', price: '1', veg: 'yes' },
    { name: 'B', category: 'Starters', price: '1', veg: 'yes' }], { idGen: () => seq.shift() });
  assert.deepEqual(a.data.items.slice(3).map(i => i.id), ['dup', 'ok']);
});

test('key-collision guard: exact error message for would_duplicate', () => {
  const rows = [{ id: 'm1', name: 'Dal Tadka', category: 'Mains' }];
  const p = previewImport(menu(), rows);
  assert.equal(p.rows[0].status, 'error');
  assert.equal(p.rows[0].errors[0], 'would duplicate "Dal Tadka" in Mains');
  assert.equal(p.rows[0].matched_id, 'm1');
});

test('blank price on new item is error, on existing item is unchanged', () => {
  const newItemBlankPrice = previewImport(menu(), [{ name: 'NewItem', category: 'Starters', price: '', veg: 'yes' }]);
  assert.equal(newItemBlankPrice.rows[0].status, 'error');
  assert.ok(newItemBlankPrice.rows[0].errors.some(e => e.includes('price is required')));

  const existingItemBlankPrice = previewImport(menu(), [{ name: 'Paneer Tikka', category: 'Starters', price: '' }]);
  assert.equal(existingItemBlankPrice.rows[0].status, 'unchanged');
  const item = applyImport(menu(), [{ name: 'Paneer Tikka', category: 'Starters', price: '' }]).data.items.find(i => i.id === 'm1');
  assert.equal(item.price, 230);
});

test('variants with blank prices are errors', () => {
  const run = variants => previewImport(menu(), [{ name: 'X', category: 'Starters', veg: 'yes', variants }]).rows[0];
  assert.equal(run('Half:').status, 'error');
  assert.equal(run('Half: ').status, 'error');
  assert.equal(run('Half:|Full:190').status, 'error');
});

test('station defaults to "hot" for round-trip consistency', () => {
  const rows = [{ name: 'Paneer Tikka', category: 'Starters', station: 'hot' }];
  const p = previewImport(menu(), rows);
  assert.equal(p.rows[0].status, 'unchanged', 'explicitly setting station to hot should not be a change');
});

test('NO_VALID_ROWS: replace with no valid rows returns error and menu is unchanged', () => {
  const original = menu();
  const snapshot = structuredClone(original);

  const result = applyImport(original, [{ name: 'X' }], { mode: 'replace', skipInvalid: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'NO_VALID_ROWS');
  assert.equal(result.error, 'Replace needs at least one valid row. Nothing was changed.');
  assert.deepEqual(original, snapshot);
});

test('NO_VALID_ROWS: wrong-case headers file with replace + skipInvalid returns error', () => {
  const original = menu();
  const snapshot = structuredClone(original);

  const result = applyImport(original, [{ Name: 'Dal', Category: 'Mains', Price: '1' }], { mode: 'replace', skipInvalid: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_VALID_ROWS');
  assert.deepEqual(original, snapshot);
});

test('replace with one valid row plus one invalid row (missing price/veg) keeps claimed existing items', () => {
  const result = applyImport(menu(), [
    { name: 'Dal Tadka', category: 'Mains', price: '200' },
    { name: 'Paneer Tikka', category: 'Specials', price: '', veg: '' }
  ], { mode: 'replace', skipInvalid: true });

  assert.equal(result.ok, true);
  assert.ok(result.data.items.some(i => i.id === 'm1'), 'Paneer Tikka should be kept (name-claimed)');
  assert.ok(result.data.items.some(i => i.id === 'm2'), 'Dal Tadka should be kept (matched)');
});

// A merge import where nothing is valid must be refused, not applied as a no-op write: a no-op write
// would still bump the revision, write a backup, broadcast, and make the hub authoritative over cloud pulls.

test('NO_VALID_ROWS: merge + skipInvalid with only invalid rows is refused and the menu is unchanged', () => {
  const original = menu();
  const snapshot = structuredClone(original);
  const bad = [{ name: 'Bad', category: 'Starters', price: 'x', veg: 'yes' }];

  const result = applyImport(original, bad, { mode: 'merge', skipInvalid: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'NO_VALID_ROWS');
  assert.equal(result.error, 'No valid rows to import. Nothing was changed.');
  assert.equal(result.data, undefined, 'a refusal carries no data to write');
  assert.deepEqual(original, snapshot);

  // The default mode is merge.
  assert.equal(applyImport(menu(), bad, { skipInvalid: true }).code, 'NO_VALID_ROWS');

  // Without skipInvalid the row errors are still reported first, with their details.
  const blocked = applyImport(menu(), bad);
  assert.equal(blocked.code, 'INVALID_ROWS');
  assert.equal(blocked.details.length, 1);

  // Replace keeps its own exact wording.
  const replace = applyImport(menu(), bad, { mode: 'replace', skipInvalid: true });
  assert.equal(replace.code, 'NO_VALID_ROWS');
  assert.equal(replace.error, 'Replace needs at least one valid row. Nothing was changed.');
});

test('NO_VALID_ROWS: an unchanged row still counts as valid, and one valid row among invalid ones still applies', () => {
  const unchanged = applyImport(menu(), [{ name: 'Paneer Tikka', category: 'Starters', price: '230' }], { mode: 'merge', skipInvalid: true });
  assert.equal(unchanged.ok, true, 'a row with no changes is valid, so the guard must not treat it as "nothing to import"');
  assert.equal(unchanged.meta.counts.unchanged, 1);

  const mixed = applyImport(menu(), [
    { name: 'Paneer Tikka', category: 'Starters', price: '240' },
    { name: 'Bad', category: 'Starters', price: 'x', veg: 'yes' }
  ], { mode: 'merge', skipInvalid: true });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.meta.skipped, 1);
  assert.equal(mixed.data.items.find(i => i.id === 'm1').price, 240);
});

// --- the course column (M2 leftover) -----------------------------------------------------------

test('course: a valid course is applied to a new dish', () => {
  const rows = [{ name: 'Gajar Halwa', category: 'Desserts', price: '120', veg: 'yes', course: '3' }];
  const result = applyImport(menu(), rows, { mode: 'merge' });
  assert.equal(result.ok, true);
  const added = result.data.items.find(i => i.name === 'Gajar Halwa');
  assert.equal(added.course, 3);
});

test('course: an existing dish can be moved to another course', () => {
  const rows = [{ id: 'm1', name: 'Paneer Tikka', category: 'Starters', price: '230', course: '2' }];
  const p = previewImport(menu(), rows);
  assert.equal(p.rows[0].status, 'updated');
  const result = applyImport(menu(), rows, { mode: 'merge' });
  assert.equal(result.data.items.find(i => i.id === 'm1').course, 2);
});

test('course: a blank cell leaves an existing dish alone, like every other column', () => {
  const base = menu();
  base.items[0].course = 2;
  const rows = [{ id: 'm1', name: 'Paneer Tikka', category: 'Starters', price: '230', course: '' }];
  const result = applyImport(base, rows, { mode: 'merge' });
  assert.equal(result.data.items.find(i => i.id === 'm1').course, 2, 'blank is "leave it", not "reset it"');
});

test('course: out of range, zero and non-numeric are errors rather than silent defaults', () => {
  // Silently coercing a typo to course 1 would reorder a restaurant's service without telling
  // anyone, which is exactly the kind of quiet wrong this importer reports instead.
  for (const bad of ['0', '10', '-1', '2.5', 'main', ' ']) {
    const p = previewImport(menu(), [{ name: 'X', category: 'Mains', price: '10', course: bad }]);
    assert.equal(p.rows[0].status, 'error', `course '${bad}' should be refused`);
  }
});

test('course: the column is optional, so a file written before it still imports', () => {
  const rows = [{ name: 'Jeera Rice', category: 'Mains', price: '140', veg: 'yes' }];
  const result = applyImport(menu(), rows, { mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.data.items.find(i => i.name === 'Jeera Rice').course, undefined);
});
