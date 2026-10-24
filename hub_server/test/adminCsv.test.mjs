import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, rowsFromTable, csvToRows, menuToCsv, MENU_COLUMNS } from '../../src/admin/lib/csv.js';
import { previewImport } from '../lib/menuImport.js';

// Browser-side CSV helpers for the /admin page: parse an uploaded file into the plain string rows the hub's
// importer takes, and export the current menu in the same format (the export doubles as the template).

// ---------------------------------------------------------------- parseCsv

test('parseCsv reads records separated by LF, CRLF or a mix, with or without a final newline', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]);
});

test('parseCsv keeps commas, escaped quotes and line breaks inside quoted fields', () => {
  assert.deepEqual(parseCsv('"a,b","say ""hi""","x\ny"\n'), [['a,b', 'say "hi"', 'x\ny']]);
  assert.deepEqual(parseCsv('"line1\r\nline2",z\r\n'), [['line1\r\nline2', 'z']]);
  assert.deepEqual(parseCsv('"""",x\n'), [['"', 'x']]);
});

test('parseCsv: empty fields, blank lines (they keep their place) and the empty text', () => {
  assert.deepEqual(parseCsv('a,,c\n'), [['a', '', 'c']]);
  assert.deepEqual(parseCsv(',\n'), [['', '']]);
  assert.deepEqual(parseCsv('a,'), [['a', '']]);
  assert.deepEqual(parseCsv('a\n\nb'), [['a'], [''], ['b']]);
  assert.deepEqual(parseCsv('""\n'), [['']]);
  assert.deepEqual(parseCsv(''), []);
});

test('parseCsv strips a UTF-8 byte order mark', () => {
  assert.deepEqual(parseCsv('\uFEFFname,price\r\nDal,190\r\n'), [['name', 'price'], ['Dal', '190']]);
});

test('parseCsv is lenient about stray quotes instead of dropping data', () => {
  assert.deepEqual(parseCsv('12" pizza,5\n'), [['12" pizza', '5']]);
  assert.deepEqual(parseCsv('"ab"c,d\n'), [['abc', 'd']]);
  assert.deepEqual(parseCsv('a,"b'), [['a', 'b']]);
});

// ---------------------------------------------------------------- rowsFromTable

test('rowsFromTable: the first row is the header, keys are lower-cased and trimmed, cells are trimmed strings', () => {
  const { rows, columns } = rowsFromTable([
    [' Name ', 'CATEGORY', 'Price'],
    [' Paneer Tikka ', 'Starters ', 230],
    ['Dal', 'Main', 12.5]
  ]);
  assert.deepEqual(columns, ['name', 'category', 'price']);
  assert.deepEqual(rows, [
    { name: 'Paneer Tikka', category: 'Starters', price: '230', __row: 2 },
    { name: 'Dal', category: 'Main', price: '12.5', __row: 3 }
  ]);
});

test('rowsFromTable turns every kind of cell into a string (Excel hands back numbers and booleans)', () => {
  const { rows } = rowsFromTable([['a', 'b', 'c', 'd', 'e', 'f'], [1, true, null, undefined, '  x  ', false]]);
  assert.deepEqual(rows, [{ a: '1', b: 'true', c: '', d: '', e: 'x', f: 'false', __row: 2 }]);
});

test('rowsFromTable drops fully empty rows but keeps each row\'s spreadsheet row number', () => {
  const { rows } = rowsFromTable([
    ['name', 'price'],
    ['A', '1'],
    ['', ''],
    [null, '  '],
    ['B', '2']
  ]);
  assert.deepEqual(rows.map(r => [r.name, r.__row]), [['A', 2], ['B', 5]]);
});

test('rowsFromTable skips blank rows above the header and still counts from the top of the sheet', () => {
  const { rows, columns } = rowsFromTable([[''], [], ['Name', 'Price'], ['A', '1']]);
  assert.deepEqual(columns, ['name', 'price']);
  assert.deepEqual(rows, [{ name: 'A', price: '1', __row: 4 }]);
});

test('rowsFromTable pads short rows, ignores extra cells and unnamed columns, and keeps the first of a repeated header', () => {
  const { rows, columns } = rowsFromTable([
    ['name', '', 'price', 'NAME'],
    ['A', 'ignored', '5', 'dup', 'extra'],
    ['B']
  ]);
  assert.deepEqual(columns, ['name', 'price']);
  assert.deepEqual(rows, [
    { name: 'A', price: '5', __row: 2 },
    { name: 'B', price: '', __row: 3 }
  ]);
});

test('rowsFromTable on an empty, blank or header-only table', () => {
  assert.deepEqual(rowsFromTable([]), { rows: [], columns: [] });
  assert.deepEqual(rowsFromTable([[''], ['', null]]), { rows: [], columns: [] });
  assert.deepEqual(rowsFromTable([['name', 'price']]), { rows: [], columns: ['name', 'price'] });
  assert.deepEqual(rowsFromTable(undefined), { rows: [], columns: [] });
});

// ---------------------------------------------------------------- csvToRows

test('csvToRows reads a CSV file the way the importer expects it', () => {
  const text = '\uFEFFName,Category,Price\r\n"Paneer, Tikka",Starters,230\r\n\r\nDal,Main,"12.50"\r\n';
  assert.deepEqual(csvToRows(text), {
    columns: ['name', 'category', 'price'],
    rows: [
      { name: 'Paneer, Tikka', category: 'Starters', price: '230', __row: 2 },
      { name: 'Dal', category: 'Main', price: '12.50', __row: 4 }
    ]
  });
});

// ---------------------------------------------------------------- menuToCsv

test('MENU_COLUMNS is the importer\'s column order', () => {
  assert.deepEqual(MENU_COLUMNS, ['id', 'name', 'category', 'price', 'veg', 'available', 'station', 'course', 'variants']);
});

test('menuToCsv writes a BOM, a header and one CRLF-terminated row per item', () => {
  const csv = menuToCsv({ categories: ['Main'], items: [{ id: 'm1', name: 'Dal Tadka', category: 'Main', price: 190, isVeg: true, available: true }] });
  assert.equal(csv, '\uFEFFid,name,category,price,veg,available,station,course,variants\r\nm1,Dal Tadka,Main,190,yes,yes,,,\r\n');
});

test('menuToCsv of an empty menu is the header alone', () => {
  assert.equal(menuToCsv({ categories: [], items: [] }), '\uFEFFid,name,category,price,veg,available,station,course,variants\r\n');
  assert.equal(menuToCsv(undefined), '\uFEFFid,name,category,price,veg,available,station,course,variants\r\n');
});

test('menuToCsv: veg and available as yes/no, station only when it is a known one, variants as Label:price|Label:price', () => {
  const csv = menuToCsv({
    categories: ['A'],
    items: [
      { id: 'a', name: 'Veg on', category: 'A', price: 10, isVeg: true, available: true, station: 'bar', course: 2 },
      { id: 'b', name: 'Non-veg off', category: 'A', price: 20.5, isVeg: false, available: false, station: 'grill', course: 99 },
      { id: 'c', name: 'Half and full', category: 'A', price: 280, isVeg: true, available: true,
        variants: [{ id: 'h', label: 'Half', price: 180 }, { id: 'f', label: 'Full', price: 280, available: false }] },
      { id: 'd', name: 'No price yet', category: 'A', price: 0, isVeg: true }
    ]
  });
  assert.deepEqual(parseCsv(csv).slice(1), [
    ['a', 'Veg on', 'A', '10', 'yes', 'yes', 'bar', '2', ''],
    ['b', 'Non-veg off', 'A', '20.5', 'no', 'no', '', '', ''],
    ['c', 'Half and full', 'A', '280', 'yes', 'yes', '', '', 'Half:180|Full:280'],
    ['d', 'No price yet', 'A', '', 'yes', 'yes', '', '', '']
  ]);
});

test('menuToCsv quotes what needs quoting and the file parses back to the same text', () => {
  const items = [
    { id: 'q1', name: 'Masala "Chaas", chilled', category: 'Breads, Rice', price: 49.5, isVeg: true, available: true },
    { id: 'q2', name: 'Two\nLine Thali', category: 'Main', price: 150, isVeg: true, available: true },
    { id: 'q3', name: 'Gulab Jamun ₹ (2 pcs)', category: 'Main', price: 90, isVeg: true, available: true }
  ];
  const csv = menuToCsv({ categories: ['Breads, Rice', 'Main'], items });
  assert.ok(csv.includes('"Masala ""Chaas"", chilled","Breads, Rice"'), csv);
  assert.ok(csv.includes('"Two\nLine Thali"'), csv);
  assert.deepEqual(parseCsv(csv).slice(1).map(r => [r[1], r[2]]), items.map(i => [i.name, i.category]));
});

// ---------------------------------------------------------------- round trip with the hub's own importer

const fullMenu = () => ({
  restaurant_id: 'r1',
  revision: 3,
  categories: ['Starters', 'Main Course', 'Breads, Rice', 'Beverages', 'Desserts'],
  items: [
    // legacy variants: no `available` key at all
    { id: 'm1', name: 'Paneer Butter Masala', category: 'Main Course', price: 280, isVeg: true, available: true,
      variants: [{ id: 'v_half', label: 'Half', price: 180 }, { id: 'v_full', label: 'Full', price: 280 }] },
    // variants (the full one is 86'd), a modifier group, a day-part and a station
    { id: 'm3', name: 'Chicken Tikka Masala', category: 'Main Course', price: 340, isVeg: false, available: true, station: 'hot',
      variants: [
        { id: 'v_half', label: 'Half', price: 220, available: true },
        { id: 'v_full', label: 'Full', price: 340, available: false }
      ],
      modifier_groups: [
        { id: 'mg_spice', label: 'Spice level', min: 1, max: 1, options: [
          { id: 'mild', label: 'Mild', price_delta: 0, available: true },
          { id: 'hot', label: 'Hot', price_delta: 0, available: false }
        ] },
        { id: 'mg_extras', label: 'Extras', min: 0, max: 3, options: [{ id: 'cheese', label: 'Extra cheese', price_delta: 40, available: true }] }
      ],
      day_parts: [
        { id: 'dp_lunch', label: 'Lunch', starts_at: '12:00', ends_at: '15:00', days: [1, 2, 3, 4, 5], variant_prices: { v_half: 199, v_full: 299 } }
      ] },
    { id: 'm_ab12cd34', name: 'Masala "Chaas", chilled', category: 'Beverages', price: 49.5, isVeg: true, available: false, station: 'bar' },
    { id: 'm4', name: 'Gulab Jamun ₹ (2 pcs)', category: 'Desserts', price: 90, isVeg: true, available: true, station: 'cold',
      day_parts: [{ id: 'dp_eve', label: 'Evening', starts_at: '18:00', ends_at: '22:00', price: 80 }] },
    { id: 'm5', name: 'Two\nLine Thali', category: 'Breads, Rice', price: 150.25, isVeg: true, available: true },
    { id: 'm6', name: 'Veg Crispy', category: 'Starters', price: 220, isVeg: true }
  ]
});

test('round trip: menuToCsv -> csvToRows -> previewImport reports every row unchanged and none in error', () => {
  const menu = fullMenu();
  const { rows } = csvToRows(menuToCsv(menu));
  assert.equal(rows.length, menu.items.length);

  const preview = previewImport(menu, rows);
  assert.equal(preview.ok, true);
  assert.equal(preview.counts.error, 0, JSON.stringify(preview.rows.filter(r => r.status === 'error')));
  for (const r of preview.rows) assert.equal(r.status, 'unchanged', `row ${r.row} (${r.name}) came back as ${r.status}: ${JSON.stringify(r.changes)}`);
  assert.equal(preview.counts.unchanged, menu.items.length);
  assert.deepEqual(preview.rows.map(r => r.row), menu.items.map((_, i) => i + 2), 'spreadsheet row numbers');
});

test('round trip through a spreadsheet: numbers come back as numbers and it is still all unchanged', () => {
  const menu = fullMenu();
  const table = parseCsv(menuToCsv(menu));
  const priceAt = table[0].indexOf('price');
  const asExcel = table.map((r, i) => (i === 0 ? r : r.map((c, j) => (j === priceAt && c !== '' ? Number(c) : c))));
  const { rows } = rowsFromTable(asExcel);
  const preview = previewImport(menu, rows);
  assert.equal(preview.counts.error, 0);
  assert.equal(preview.counts.unchanged, menu.items.length);
});

test('round trip is not vacuous: a changed cell shows up as exactly one updated row', () => {
  const menu = fullMenu();
  const { rows } = csvToRows(menuToCsv(menu));
  rows[2].price = '55';
  const preview = previewImport(menu, rows);
  assert.equal(preview.counts.updated, 1);
  assert.equal(preview.counts.unchanged, menu.items.length - 1);
  assert.deepEqual(preview.rows[2].changes, [{ field: 'price', from: 49.5, to: 55 }]);
});
