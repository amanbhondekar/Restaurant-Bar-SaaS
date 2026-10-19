import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';
import { initCourseState, markStationReady } from '../lib/courses.js';
import { orderCourseColumns, itemCourseColumns, isMissingCourseColumn, withoutCourseColumns } from '../lib/courseSync.js';

// Course state reaching the cloud (migration 008). Pure mapping first, then the sync itself against
// a recording fake cloud, then the real hub to prove its routes actually enqueue the state.

const RID = RESTAURANT_ID;
const T0 = '2026-10-19T12:00:00.000Z';
const T1 = '2026-10-19T12:05:00.000Z';

const line = (name, station, course) => ({ id: name.toLowerCase().replace(/\W+/g, '_'), name, qty: 1, price: 100, station, course });
const ITEMS = [line('Veg Crispy', 'hot', 1), line('Masala Chaas', 'bar', 1), line('Dal Tadka', 'hot', 2)];
const stagedTicket = (over = {}) => ({
  id: 't_1', ticket_number: 142, restaurant_id: RID, table_name: 'T4', status: 'in_progress', total_amount: 300,
  items: ITEMS, order_request_id: 'req-1', created_at: T0, updated_at: T0,
  ...initCourseState(ITEMS, { staged: true }, T0), ...over
});

// --- the pure mapping ----------------------------------------------------------------------

test('course columns: a staged ticket sends its flag and the whole log', () => {
  const cols = orderCourseColumns(stagedTicket());
  assert.equal(cols.staged, true);
  assert.deepEqual(Object.keys(cols.course_log), ['1'], 'only course 1 has been fired; course 2 is held and has no entry');
  assert.equal(cols.course_log[1].fired_at, T0);
});

test('course columns: the log records which stations have finished, so a slow line is told from a held one', () => {
  const marked = markStationReady(stagedTicket(), 'bar', T1).ticket;
  assert.deepEqual(orderCourseColumns(marked).course_log[1].stations_ready, { bar: T1 });
});

test('course columns: a ticket that predates courses is filled in, not sent as null', () => {
  const old = { id: 'o', ticket_number: 1, status: 'in_progress', items: [line('X', 'hot', 1)], created_at: T0, updated_at: T0 };
  const cols = orderCourseColumns(old);
  assert.equal(cols.staged, false);
  assert.equal(cols.course_log[1].fired_at, T0);
});

test('course columns: a line sends its course and station, defaulting what is missing or invalid', () => {
  assert.deepEqual(itemCourseColumns({ course: 3, station: 'bar' }), { course: 3, station: 'bar' });
  assert.deepEqual(itemCourseColumns({}), { course: 1, station: 'hot' });
  assert.deepEqual(itemCourseColumns({ course: 42, station: 'garnish' }), { course: 1, station: 'hot' });
});

test('missing-column detection: only an unknown column that is one of ours counts', () => {
  const unknownColumn = col => ({ code: 'PGRST204', message: `Could not find the '${col}' column of 'orders' in the schema cache` });
  for (const col of ['course_log', 'staged', 'course', 'station']) assert.equal(isMissingCourseColumn(unknownColumn(col)), true, col);
  assert.equal(isMissingCourseColumn({ code: '42703', message: 'column "course_log" of relation "orders" does not exist' }), true);

  // An unrelated schema problem, a permission problem and a constraint failure must stay failures.
  assert.equal(isMissingCourseColumn(unknownColumn('order_request_id')), false, 'someone else\'s column');
  assert.equal(isMissingCourseColumn({ code: '42501', message: 'permission denied for table orders' }), false);
  assert.equal(isMissingCourseColumn({ code: '23514', message: 'new row violates check constraint "order_items_course_range" for column course' }), false);
  assert.equal(isMissingCourseColumn(null), false);
  assert.equal(isMissingCourseColumn(undefined), false);
});

test('missing-column detection: a column merely containing the word is not matched', () => {
  assert.equal(isMissingCourseColumn({ code: 'PGRST204', message: "Could not find the 'restaurant_stationery' column of 'orders' in the schema cache" }), false);
  assert.equal(isMissingCourseColumn({ code: 'PGRST204', message: "Could not find the 'staged_at' column of 'orders' in the schema cache" }), false);
});

test('withoutCourseColumns strips ours and nothing else', () => {
  assert.deepEqual(
    withoutCourseColumns({ name: 'Dal', qty: 1, course: 2, station: 'hot', staged: true, course_log: {} }),
    { name: 'Dal', qty: 1 }
  );
});

// --- the sync, against a recording fake cloud ----------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-sync-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
const { syncQueue } = await import('../lib/syncQueue.js');

/**
 * A cloud that records what it accepts. `missing` lists columns it does not have, as
 * 'table.column', and rejects a write that names one exactly as PostgREST would. `reject` forces an
 * unrelated failure.
 */
function fakeCloud({ missing = [], reject = null } = {}) {
  const log = { orders: [], items: [], updates: [], attempts: [] };
  const unknownColumn = (table, rows) => {
    for (const r of rows) for (const k of Object.keys(r)) if (missing.includes(`${table}.${k}`)) return k;
    return null;
  };
  return {
    log,
    auth: { getUser: async () => ({ data: { user: null } }) },
    from(table) {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        insert(record) {
          const rows = Array.isArray(record) ? record : [record];
          log.attempts.push({ table, rows });
          const bad = unknownColumn(table, rows);
          const error = reject ?? (bad ? { code: 'PGRST204', message: `Could not find the '${bad}' column of '${table}' in the schema cache` } : null);
          if (!error) (table === 'orders' ? log.orders : log.items).push(...rows);
          const result = error ? { data: null, error } : { data: { id: 'db-order-1' }, error: null };
          return { select: () => ({ single: async () => result }), then: (ok, no) => Promise.resolve({ error: result.error }).then(ok, no) };
        },
        update(patch) {
          return {
            eq: async (col, val) => {
              log.attempts.push({ table, patch, col, val });
              const bad = unknownColumn(table, [patch]);
              if (reject) return { error: reject };
              if (bad) return { error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${table}' in the schema cache` } };
              log.updates.push({ patch, col, val });
              return { error: null };
            }
          };
        }
      };
    }
  };
}

const withCloud = cloud => { syncQueue.cloud = cloud; syncQueue.lastFailureSystemic = false; return cloud; };
const quiet = async fn => { const w = console.warn, l = console.log, e = console.error; console.warn = console.log = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; console.error = e; } };

test('sync: an order reaches a migrated cloud with its course state and each line\'s course and station', async () => {
  const cloud = withCloud(fakeCloud());
  const ok = await quiet(() => syncQueue.syncOrderToSupabase(stagedTicket()));

  assert.equal(ok, true);
  assert.equal(cloud.log.orders.length, 1);
  assert.equal(cloud.log.orders[0].staged, true);
  assert.deepEqual(Object.keys(cloud.log.orders[0].course_log), ['1']);
  assert.deepEqual(cloud.log.items.map(i => [i.name, i.course, i.station]), [
    ['Veg Crispy', 1, 'hot'], ['Masala Chaas', 1, 'bar'], ['Dal Tadka', 2, 'hot']
  ]);
});

test('sync: a cloud that has not run migration 008 still gets the order -- without the course detail', async () => {
  const cloud = withCloud(fakeCloud({ missing: ['orders.staged', 'orders.course_log', 'order_items.course', 'order_items.station'] }));
  const ok = await quiet(() => syncQueue.syncOrderToSupabase(stagedTicket()));

  assert.equal(ok, true, 'the order must not wait on a schema change');
  assert.equal(cloud.log.orders.length, 1);
  assert.equal('course_log' in cloud.log.orders[0], false);
  assert.equal('staged' in cloud.log.orders[0], false);
  assert.equal(cloud.log.orders[0].ticket_number, 142, 'and it is still the same order');
  assert.equal(cloud.log.orders[0].order_request_id, 'req-1');
  assert.equal(cloud.log.items.length, 3);
  assert.equal(cloud.log.items.some(i => 'course' in i || 'station' in i), false);
  assert.equal(cloud.log.items[0].price, 100, 'the lines keep everything else');
});

test('sync: a cloud migrated on orders but not on order_items still gets every line', async () => {
  const cloud = withCloud(fakeCloud({ missing: ['order_items.course', 'order_items.station'] }));
  const ok = await quiet(() => syncQueue.syncOrderToSupabase(stagedTicket()));

  assert.equal(ok, true);
  assert.equal(cloud.log.orders[0].staged, true, 'the order kept its course state');
  assert.equal(cloud.log.items.length, 3);
  assert.equal(cloud.log.items.some(i => 'course' in i), false);
});

test('sync: an unrelated failure is still a failure, not retried as if it were a missing column', async () => {
  const cloud = withCloud(fakeCloud({ reject: { code: '42501', message: 'permission denied for table orders' } }));
  const ok = await quiet(() => syncQueue.syncOrderToSupabase(stagedTicket()));

  assert.equal(ok, false);
  assert.equal(cloud.log.attempts.filter(a => a.table === 'orders').length, 1, 'no second attempt');
  assert.equal(syncQueue.lastFailureSystemic, true, 'a refusal of the hub itself still holds the queue');
});

test('sync: a status change carries the course state with it', async () => {
  const cloud = withCloud(fakeCloud());
  const marked = markStationReady(stagedTicket(), 'bar', T1).ticket;
  const ok = await quiet(() => syncQueue.syncStatusToSupabase({
    ticketId: 142, status: 'in_progress', restaurantId: RID, course: orderCourseColumns(marked)
  }));

  assert.equal(ok, true);
  const [u] = cloud.log.updates;
  assert.equal(u.col, 'ticket_number');
  assert.equal(u.val, 142);
  assert.equal(u.patch.status, 'in_progress');
  assert.deepEqual(u.patch.course_log[1].stations_ready, { bar: T1 });
});

test('sync: on an unmigrated cloud the status still goes through on its own', async () => {
  const cloud = withCloud(fakeCloud({ missing: ['orders.staged', 'orders.course_log'] }));
  const ok = await quiet(() => syncQueue.syncStatusToSupabase({
    ticketId: 142, status: 'ready', restaurantId: RID, course: orderCourseColumns(stagedTicket())
  }));

  assert.equal(ok, true);
  assert.equal(cloud.log.updates.length, 1);
  assert.equal(cloud.log.updates[0].patch.status, 'ready');
  assert.equal('course_log' in cloud.log.updates[0].patch, false);
});

test('sync: a status item queued before this feature (no course) still works unchanged', async () => {
  const cloud = withCloud(fakeCloud());
  const ok = await quiet(() => syncQueue.syncStatusToSupabase({ ticketId: 7, status: 'completed', restaurantId: RID }));

  assert.equal(ok, true);
  assert.deepEqual(Object.keys(cloud.log.updates[0].patch).sort(), ['status', 'updated_at']);
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// --- the real hub: do its routes enqueue the state? ----------------------------------------

const MENU = {
  restaurant_id: RID,
  categories: ['Starters', 'Mains', 'Drinks'],
  items: [
    { id: 's1', name: 'Veg Crispy', price: 220, category: 'Starters', isVeg: true, available: true, station: 'hot', course: 1 },
    { id: 'm1', name: 'Dal Tadka', price: 260, category: 'Mains', isVeg: true, available: true, station: 'hot', course: 2 },
    { id: 'b1', name: 'Masala Chaas', price: 90, category: 'Drinks', isVeg: true, available: true, station: 'bar', course: 1 }
  ]
};

let hub;
before(async () => {
  hub = await startHub({
    trustLoopback: true,
    menu: MENU,
    tables: { restaurant_id: RID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] }
  });
});
after(() => hub?.stop());

const call = (p, { method = 'GET', body } = {}) =>
  fetch(`${hub.base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** The hub writes its queue asynchronously; wait for it to hold what the test expects. */
async function queueUntil(predicate, ms = 15000) {
  const file = path.join(hub.dataDir, 'sync_queue.json');
  const deadline = Date.now() + ms;
  let last = [];
  for (;;) {
    try { last = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { last = []; }
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise(r => setTimeout(r, 150));
  }
}
const statusOps = (queue, ticketNumber) => queue.filter(q => q.type === 'UPDATE_STATUS' && q.payload.ticketId === ticketNumber);

test('hub: a station finishing its part queues the course state even though the ticket is not ready yet', async () => {
  const placed = await (await call('/orders', {
    method: 'POST',
    body: { table_id: 1, table_name: 'T1', course_service: true, items: [{ id: 's1', qty: 1 }, { id: 'm1', qty: 1 }, { id: 'b1', qty: 1 }] }
  })).json();
  const ticket = placed.ticket;
  assert.equal(ticket.staged, true);

  const bar = await (await call(`/orders/${ticket.id}/stations/bar/ready`, { method: 'POST' })).json();
  assert.equal(bar.ticket_ready, false);

  const queue = await queueUntil(q => statusOps(q, ticket.ticket_number).length >= 1);
  const [op] = statusOps(queue, ticket.ticket_number);
  assert.ok(op, 'a partial station-ready used to enqueue nothing, so this state never reached the cloud');
  assert.equal(op.payload.status, 'in_progress');
  assert.equal(op.payload.course.staged, true);
  assert.ok(op.payload.course.course_log[1].stations_ready.bar, 'bar is recorded as finished');
  assert.equal(op.payload.course.course_log[1].stations_ready.hot, undefined, 'hot is not');
});

test('hub: firing the next course and recalling a ticket each queue the state as it now stands', async () => {
  const placed = await (await call('/orders', {
    method: 'POST',
    body: { table_id: 1, table_name: 'T1', course_service: true, items: [{ id: 's1', qty: 1 }, { id: 'm1', qty: 1 }] }
  })).json();
  const t = placed.ticket;

  assert.equal((await call(`/orders/${t.id}/stations/hot/ready`, { method: 'POST' })).status, 200);
  await queueUntil(q => statusOps(q, t.ticket_number).length >= 1);

  const fired = await call(`/orders/${t.id}/fire`, { method: 'POST', body: {} });
  assert.equal(fired.status, 200);
  const afterFire = await queueUntil(q => statusOps(q, t.ticket_number).length >= 2);
  const fireOp = statusOps(afterFire, t.ticket_number).at(-1);
  assert.deepEqual(Object.keys(fireOp.payload.course.course_log).sort(), ['1', '2'], 'both courses are now in the log');

  // Finish the whole ticket, then recall it.
  assert.equal((await call(`/orders/${t.id}/stations/hot/ready`, { method: 'POST' })).status, 200);
  // Course 1 alone being finished already made the ticket ready once, so this is the second ready.
  const readyOps = await queueUntil(q => statusOps(q, t.ticket_number).filter(o => o.payload.status === 'ready').length >= 2);
  const readyOp = statusOps(readyOps, t.ticket_number).filter(o => o.payload.status === 'ready').at(-1);
  assert.ok(readyOp.payload.course.course_log[2].ready_at, 'the ready status carries the log that says when it finished');

  assert.equal((await call(`/orders/${t.id}/recall`, { method: 'POST' })).status, 200);
  const recalled = await queueUntil(q => statusOps(q, t.ticket_number).at(-1)?.payload.course.course_log[2]?.recall_count === 1);
  const recallOp = statusOps(recalled, t.ticket_number).at(-1);
  assert.equal(recallOp.payload.status, 'in_progress');
  assert.equal(recallOp.payload.course.course_log[2].ready_at, undefined, 'the recalled course is no longer finished');
});
