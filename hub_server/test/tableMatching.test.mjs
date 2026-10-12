import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Billing integrity: a ticket must land on the table it was rung up on, and nowhere else.
//
// Cloud-pulled tables keep UUID ids, so the first table added on the hub gets id 1. Tickets used
// to be matched to a table by id OR by a name alias (t<id>, "table <id>", the bare id), which let
// that table capture every open ticket of the cloud table that happened to be named "T1".

// ticketStore reads HUB_DATA_DIR when it is first imported. Point it at a throwaway directory so
// the unit-level assertions below never go near hub_server/data. (The hub the HTTP tests spawn
// gets its own directory from startHub.)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-match-'));
process.env.HUB_DATA_DIR = scratch;
const { ticketMatchesTable } = await import('../lib/ticketStore.js');

const T1 = '2f6b0c3e-8a41-4d57-9d3e-1c5a7e0b9a11';
const T2 = '9b7d2e44-5c1f-4a8b-8e6a-3f0d1b2c4d55';

const MENU = {
  restaurant_id: RESTAURANT_ID,
  categories: ['Starters'],
  items: [
    { id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true },
    { id: 'm2', name: 'Chicken Sukka', price: 220, category: 'Starters', isVeg: false, available: true },
    { id: 'm4', name: 'Mutton Saoji', price: 340, category: 'Starters', isVeg: false, available: true }
  ]
};
// A cloud-pulled layout: UUID ids, no revision, no next_id.
const TABLES = {
  restaurant_id: RESTAURANT_ID,
  tables: [
    { id: T1, name: 'T1', section: 'Main Hall', capacity: 4 },
    { id: T2, name: 'T2', section: 'Main Hall', capacity: 4 }
  ]
};

let hub;
let t1Ticket;
let patioTicket;

before(async () => {
  hub = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES });
});

after(() => {
  hub?.stop();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const json = res => res.json();
const place = async body => {
  const res = await call(hub, '/orders', { method: 'POST', body });
  const text = await res.text();
  assert.equal(res.status, 201, `fixture order must be accepted: ${text}`);
  return JSON.parse(text).ticket;
};
const floor = async () => (await json(await call(hub, '/tables'))).tables;
const floorRow = async name => (await floor()).find(t => t.name === name);
const activeTicketIds = async () => (await json(await call(hub, '/orders/active'))).tickets.map(t => t.id);
const layoutRevision = async () => (await json(await call(hub, '/tables/layout'))).revision;
const billLines = async id => {
  const res = await call(hub, `/tables/${id}/invoice`);
  assert.equal(res.status, 200, `a bill was expected for table ${id}`);
  return (await json(res)).invoice;
};

// ---------------------------------------------------------------- unit level

test('ticketMatchesTable: a ticket that carries a table id matches that id and nothing else', () => {
  assert.equal(typeof ticketMatchesTable, 'function', 'ticketStore must export ticketMatchesTable');

  const moved = { table_id: 13, table_name: 'T5' };
  assert.equal(ticketMatchesTable(moved, 13), true);
  assert.equal(ticketMatchesTable(moved, '13'), true, 'route params arrive as strings');
  assert.equal(ticketMatchesTable(moved, 5), false, 'its name must not capture table 5 through the t<id> alias');
  assert.equal(ticketMatchesTable(moved, 5, 'T5'), false, 'nor through a table that happens to be named T5');
  assert.equal(ticketMatchesTable({ table_id: 5, table_name: 'Window' }, 5, 'T5'), true, 'a rename does not detach a ticket from its id');

  assert.equal(ticketMatchesTable({ table_id: T1, table_name: 'T1' }, T1), true, 'UUID ids compare as strings');
  assert.equal(ticketMatchesTable({ table_id: T1, table_name: 'T1' }, 1, 'T1'), false);
  assert.equal(ticketMatchesTable({ table_id: 4, table_name: 'Table 7' }, 7), false, 'the "table <id>" alias is ignored too');
  assert.equal(ticketMatchesTable({ table_id: 4, table_name: '7' }, 7), false, 'and so is the bare id');

  assert.equal(ticketMatchesTable({ table_id: 0, table_name: 'T5' }, 0), true, '0 is an id, not "no id"');
  assert.equal(ticketMatchesTable({ table_id: 0, table_name: 'T5' }, 5), false);
});

test('ticketMatchesTable: a legacy ticket with no table id keeps the name rules', () => {
  assert.equal(typeof ticketMatchesTable, 'function', 'ticketStore must export ticketMatchesTable');

  // null, undefined, '' and a missing key all mean "this ticket carries no table id".
  for (const noId of [{ table_id: null }, { table_id: undefined }, { table_id: '' }, {}]) {
    const label = JSON.stringify(noId) || String(noId);
    const named = table_name => ({ ...noId, table_name });
    assert.equal(ticketMatchesTable(named('T5'), 5), true, `t<id> ${label}`);
    assert.equal(ticketMatchesTable(named('t5'), '5'), true, `t<id>, lower case ${label}`);
    assert.equal(ticketMatchesTable(named('Table 5'), 5), true, `table <id> ${label}`);
    assert.equal(ticketMatchesTable(named('table 5'), 5), true, `table <id>, lower case ${label}`);
    assert.equal(ticketMatchesTable(named('5'), 5), true, `bare id ${label}`);
    assert.equal(ticketMatchesTable(named('T5'), 6), false, `another table ${label}`);

    // The table name is only a rule when the caller supplies it.
    assert.equal(ticketMatchesTable(named('Window'), 5), false, `no table name given ${label}`);
    assert.equal(ticketMatchesTable(named('window'), 5, 'Window'), true, `table name, case-insensitive ${label}`);
    assert.equal(ticketMatchesTable(named('Window'), 5, 'Garden'), false, `a different table name ${label}`);
    assert.equal(ticketMatchesTable(named('Window'), 5, ''), false, `an empty table name matches nothing ${label}`);
  }
});

// ---------------------------------------------------------------- over HTTP

test('a table added on the hub gets id 1 next to cloud tables that have UUID ids', async () => {
  const res = await call(hub, '/admin/tables/layout', {
    method: 'PUT',
    body: {
      base_revision: 0,
      sections: ['Main Hall'],
      tables: [
        { id: T1, name: 'T1', section: 'Main Hall', capacity: 4 },
        { id: T2, name: 'T2', section: 'Main Hall', capacity: 4 },
        { name: 'Patio A', section: 'Main Hall', capacity: 2 }
      ]
    }
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.tables.slice(0, 2).map(t => t.id), [T1, T2]);
  assert.equal(body.tables[2].name, 'Patio A');
  assert.equal(body.tables[2].id, 1, 'the hub numbers its own tables from 1, whatever the cloud ids are');
});

test("a table's bill lists only the tickets rung up on that table, not those of the cloud table named like it", async () => {
  t1Ticket = await place({ table_id: T1, table_name: 'T1', items: [{ id: 'm1', qty: 1 }] });
  patioTicket = await place({ table_id: 1, table_name: 'Patio A', items: [{ id: 'm2', qty: 2 }] });

  const invoice = await billLines(1);
  assert.deepEqual(invoice.items.map(i => i.name), ['Chicken Sukka'], "table 1's bill must hold Patio A's line only");
  assert.deepEqual(invoice.tickets.map(t => t.id), [patioTicket.id]);
  assert.equal(invoice.subtotal, 440);

  const cloud = await billLines(T1);
  assert.deepEqual(cloud.items.map(i => i.name), ['Paneer Tikka'], "and T1's bill holds T1's line only");
  assert.equal(cloud.subtotal, 230);

  const t1 = await floorRow('T1');
  const patio = await floorRow('Patio A');
  assert.deepEqual([t1.status, t1.activeOrderTotal], ['kot', 230]);
  assert.deepEqual([patio.status, patio.activeOrderTotal], ['kot', 440]);
});

test("clearing a table closes only that table's tickets", async () => {
  const res = await call(hub, '/tables/1/clear', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.cleared_count, 1, 'one ticket, the one rung up on Patio A');
  assert.deepEqual(body.invoice.items.map(i => i.name), ['Chicken Sukka'], 'and the invoice bills that ticket only');

  const open = await activeTicketIds();
  assert.ok(open.includes(t1Ticket.id), "T1's ticket must still be open");
  assert.ok(!open.includes(patioTicket.id), "Patio A's ticket is closed");

  const t1 = await floorRow('T1');
  assert.deepEqual([t1.status, t1.activeOrderTotal], ['kot', 230], 'T1 still shows occupied');
  assert.equal((await floorRow('Patio A')).status, 'available');
});

test('a legacy ticket with no table id is still found by name on the floor, the bill and the clear', async () => {
  const legacy = await place({ table_name: 'T2', items: [{ id: 'm1', qty: 1 }] });
  assert.equal(legacy.table_id, null, 'fixture: this ticket really carries no table id');

  // The floor grid matches it to the table whose name it carries.
  const onFloor = await floorRow('T2');
  assert.deepEqual([onFloor.status, onFloor.activeOrderTotal], ['kot', 230]);

  // The bill and the clear take the t<id> alias, exactly as before.
  assert.deepEqual((await billLines(2)).items.map(i => i.name), ['Paneer Tikka']);
  const res = await call(hub, '/tables/2/clear', { method: 'POST' });
  assert.equal((await json(res)).cleared_count, 1);

  assert.equal((await floorRow('T2')).status, 'available');
  const open = await activeTicketIds();
  assert.ok(!open.includes(legacy.id), 'the legacy ticket is closed');
  assert.ok(open.includes(t1Ticket.id), "and T1's ticket is untouched");
});

test('a ticket that carries a table id is never handed to another table through its name: bill, floor and open-bill lock agree', async () => {
  // Rung up on T2, but its name reads "Table 1", an alias table 1 (Patio A) used to honour.
  await place({ table_id: T2, table_name: 'Table 1', items: [{ id: 'm4', qty: 1 }] });

  assert.deepEqual((await billLines(T2)).items.map(i => i.name), ['Mutton Saoji'], 'T2 owns it');
  const noBill = await call(hub, '/tables/1/invoice');
  assert.equal(noBill.status, 404, 'table 1 has nothing to bill');
  assert.equal((await json(noBill)).code, 'NO_OPEN_TICKETS');

  const t2 = await floorRow('T2');
  assert.deepEqual([t2.status, t2.activeOrderTotal], ['kot', 340]);
  const patio = await floorRow('Patio A');
  assert.deepEqual([patio.status, patio.activeOrderTotal], ['available', 0], 'the floor does not give it to table 1');

  // The open-bill lock reads the same floor: T2 is locked, table 1 is not.
  const save = async (t2Name, patioName) => call(hub, '/admin/tables/layout', {
    method: 'PUT',
    body: {
      base_revision: await layoutRevision(),
      sections: ['Main Hall'],
      tables: [
        { id: T1, name: 'T1', section: 'Main Hall', capacity: 4 },
        { id: T2, name: t2Name, section: 'Main Hall', capacity: 4 },
        { id: 1, name: patioName, section: 'Main Hall', capacity: 2 }
      ]
    }
  });
  const locked = await save('T2 renamed', 'Patio A');
  assert.equal(locked.status, 409);
  const lockedBody = await json(locked);
  assert.equal(lockedBody.code, 'TABLE_HAS_OPEN_BILL');
  assert.deepEqual(lockedBody.details, [{ id: T2, name: 'T2', action: 'rename' }]);

  const free = await save('T2', 'Patio B');
  const freeText = await free.text();
  assert.equal(free.status, 200, `table 1 has no open bill and can be renamed: ${freeText}`);
});
