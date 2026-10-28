import test from 'node:test';
import assert from 'node:assert/strict';
import { pushMenu, pushTables, menuItemRow, tableRow, tablesFromCloud } from '../lib/catalogSync.js';
import { normalizeCloudMenuItem } from '../lib/menuNormalize.js';

const RID = '11111111-1111-1111-1111-111111111111';

/**
 * A recording stand-in for the supabase-js client. `rows` is what the cloud already holds per table;
 * `fail` makes the named operation ("tables.upsert", …) answer with an error.
 */
function fakeCloud({ rows = {}, fail = {} } = {}) {
  const calls = [];
  const tableOf = name => (rows[name] ||= []);
  const client = {
    calls,
    from(name) {
      return {
        upsert(part, opts) {
          calls.push({ op: 'upsert', table: name, rows: part, opts });
          if (fail[`${name}.upsert`]) return Promise.resolve({ error: fail[`${name}.upsert`] });
          for (const row of part) {
            const at = tableOf(name).findIndex(r => r.restaurant_id === row.restaurant_id && r.hub_ref === row.hub_ref);
            if (at === -1) tableOf(name).push({ id: `cloud-${name}-${tableOf(name).length}`, ...row });
            else Object.assign(tableOf(name)[at], row);
          }
          return Promise.resolve({ error: null });
        },
        select() {
          return { eq: () => Promise.resolve({ data: tableOf(name).map(({ id, hub_ref }) => ({ id, hub_ref })), error: null }) };
        },
        delete() {
          return {
            eq: (col, val) => ({
              in: (col2, ids) => {
                calls.push({ op: 'delete', table: name, restaurant_id: val, ids });
                if (fail[`${name}.delete`]) return Promise.resolve({ error: fail[`${name}.delete`] });
                rows[name] = tableOf(name).filter(r => !ids.includes(r.id));
                return Promise.resolve({ error: null });
              }
            })
          };
        }
      };
    }
  };
  return client;
}

const item = (id, extra = {}) => ({ id, name: `Item ${id}`, price: 100, category: 'Mains', isVeg: true, available: true, ...extra });

test('menuItemRow: keeps the hub id and sends explicit empties so cleared fields clear in the cloud', () => {
  const row = menuItemRow(RID, item('m7', { isVeg: false, available: false }));
  assert.equal(row.hub_ref, 'm7');
  assert.equal(row.restaurant_id, RID);
  assert.equal(row.category_name, 'Mains');
  assert.equal(row.is_veg, false);
  assert.equal(row.available, false);
  assert.deepEqual(row.variants, []);
  assert.deepEqual(row.modifier_groups, []);
  assert.deepEqual(row.day_parts, []);
  assert.equal(row.station, null);
  assert.equal('id' in row, false, 'the cloud generates its own uuid');
});

test('menuItemRow: variants, modifiers, day-parts and station travel', () => {
  const variants = [{ id: 'v1', label: 'Half', price: 90 }];
  const row = menuItemRow(RID, item('m1', { variants, station: 'bar' }));
  assert.deepEqual(row.variants, variants);
  assert.equal(row.station, 'bar');
});

test('tableRow: display_order is the position in the layout', () => {
  assert.equal(tableRow(RID, { id: 4, name: 'T4', section: 'AC', capacity: 4 }, 7).display_order, 7);
  assert.equal(tableRow(RID, { id: 4, name: 'T4', section: 'AC', capacity: 4 }, 7).hub_ref, '4');
});

test('pushMenu: upserts categories and items on (restaurant_id, hub_ref), in order', async () => {
  const cloud = fakeCloud();
  const result = await pushMenu(cloud, RID, { categories: ['Starters', 'Mains'], items: [item('a'), item('b')] });

  assert.deepEqual(result, { categories: 2, items: 2, removed: 0 });
  const upserts = cloud.calls.filter(c => c.op === 'upsert');
  assert.deepEqual(upserts.map(c => c.table), ['menu_categories', 'menu_items']);
  assert.ok(upserts.every(c => c.opts.onConflict === 'restaurant_id,hub_ref'));
  assert.deepEqual(upserts[0].rows.map(r => [r.hub_ref, r.display_order]), [['Starters', 0], ['Mains', 1]]);
});

test('pushMenu: removes cloud rows the snapshot no longer holds, only after upserting', async () => {
  const cloud = fakeCloud({
    rows: {
      menu_items: [
        { id: 'c1', restaurant_id: RID, hub_ref: 'a' },
        { id: 'c2', restaurant_id: RID, hub_ref: 'gone' },
        { id: 'c3', restaurant_id: RID, hub_ref: null } // made in the dashboard: not on the hub, so removed
      ],
      menu_categories: [{ id: 'k1', restaurant_id: RID, hub_ref: 'Old' }]
    }
  });
  const result = await pushMenu(cloud, RID, { categories: ['Mains'], items: [item('a')] });

  assert.equal(result.removed, 3);
  const firstDelete = cloud.calls.findIndex(c => c.op === 'delete');
  const lastUpsert = cloud.calls.map(c => c.op).lastIndexOf('upsert');
  assert.ok(lastUpsert < firstDelete, 'a push interrupted before the deletes loses nothing');
  const deletes = cloud.calls.filter(c => c.op === 'delete');
  assert.deepEqual(deletes.find(d => d.table === 'menu_items').ids.sort(), ['c2', 'c3']);
  assert.ok(deletes.every(d => d.restaurant_id === RID), 'deletes are scoped to the restaurant');
});

test('pushMenu: an emptied menu clears the cloud menu', async () => {
  const cloud = fakeCloud({ rows: { menu_items: [{ id: 'c1', restaurant_id: RID, hub_ref: 'a' }] } });
  const result = await pushMenu(cloud, RID, { categories: [], items: [] });
  assert.equal(result.removed, 1);
});

test('pushMenu: large menus go up in chunks', async () => {
  const cloud = fakeCloud();
  const items = Array.from({ length: 250 }, (_, i) => item(`i${i}`));
  await pushMenu(cloud, RID, { categories: ['Mains'], items });
  const sizes = cloud.calls.filter(c => c.op === 'upsert' && c.table === 'menu_items').map(c => c.rows.length);
  assert.deepEqual(sizes, [100, 100, 50]);
});

test('pushMenu: a cloud error is thrown for the queue to judge, and nothing is deleted', async () => {
  const boom = Object.assign(new Error('column "hub_ref" does not exist'), { code: '42703' });
  const cloud = fakeCloud({ fail: { 'menu_items.upsert': boom }, rows: { menu_items: [{ id: 'c1', restaurant_id: RID, hub_ref: 'x' }] } });
  await assert.rejects(pushMenu(cloud, RID, { categories: [], items: [item('a')] }), err => err.code === '42703');
  assert.equal(cloud.calls.some(c => c.op === 'delete'), false);
});

test('pushTables: round trip keeps layout order and removes deleted tables', async () => {
  const cloud = fakeCloud({ rows: { tables: [{ id: 't-old', restaurant_id: RID, hub_ref: '9' }] } });
  const layout = { tables: [
    { id: 2, name: 'T2', section: 'AC', capacity: 4 },
    { id: 1, name: 'T1', section: 'Main', capacity: 2 }
  ] };
  const result = await pushTables(cloud, RID, layout);

  assert.deepEqual(result, { tables: 2, removed: 1 });
  const upsert = cloud.calls.find(c => c.op === 'upsert');
  assert.deepEqual(upsert.rows.map(r => [r.hub_ref, r.display_order]), [['2', 0], ['1', 1]]);
});

test('recovery: tables come back with their hub ids, in the order the layout was pushed', () => {
  const pushedRows = [
    { id: 'u-b', hub_ref: '12', name: 'Window', section: 'AC', capacity: 4, display_order: 0 },
    { id: 'u-a', hub_ref: '3', name: 'T3', section: 'Main', capacity: 2, display_order: 1 },
    { id: 'u-c', hub_ref: null, name: 'Legacy', section: null, capacity: null, display_order: 2 }
  ];
  const tables = tablesFromCloud(pushedRows);
  assert.deepEqual(tables.map(t => t.id), [12, 3, 'u-c']);
  assert.deepEqual(tables[2], { id: 'u-c', name: 'Legacy', section: 'Main Dining', capacity: 4 });
});

test('recovery: a row from before the migration keeps its cloud id because the backfill makes hub_ref equal it', () => {
  const [t] = tablesFromCloud([{ id: '8f14e45f-ceea-4672-9a7b-123456789abc', hub_ref: '8f14e45f-ceea-4672-9a7b-123456789abc', name: 'T1', section: 'Main', capacity: 2 }]);
  assert.equal(t.id, '8f14e45f-ceea-4672-9a7b-123456789abc');
});

test('recovery: a pushed menu item reads back as the item that was pushed', () => {
  const original = item('m3', {
    isVeg: false,
    station: 'bar',
    variants: [{ id: 'v1', label: 'Half', price: 90, available: true }],
    day_parts: [{ id: 'd1', label: 'Lunch', starts_at: '12:00', ends_at: '15:00', price: 80 }]
  });
  const row = { ...menuItemRow(RID, original), id: 'cloud-uuid' };
  const back = normalizeCloudMenuItem({ ...row, id: row.hub_ref || row.id });
  assert.deepEqual(back, original);
});
