import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cloudDb } from './helpers/cloudDb.mjs';
import { pgrestClient } from './helpers/pgrest.mjs';

// A replacement laptop gets everything back. The hub pushes its ledger, stock, bookings and feedback to the cloud and
// has a restore for each; until now those were tested against a fake that kept whatever it was given. Here the hub's
// OWN push and restore code runs against the real schema, constraints, indexes, row-level security and privileges,
// signed in as the hub (the `kitchen` login), with the stores wiped in between as a new laptop would be.
//
// The restaurant is the first tenant cloudDb seeds, so the hub's config can name it before the stores load.

const A_RID = 'a0a0a0a0-0000-4000-8000-000000000001';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-roundtrip-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: A_RID, name: 'Restaurant A', pairing_code: 'PC-A', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { syncQueue } = await import('../lib/syncQueue.js');
const { invoiceStore } = await import('../lib/invoiceStore.js');
const { reconciliationStore } = await import('../lib/reconciliationStore.js');
const { feedbackStore } = await import('../lib/feedbackStore.js');
const { inventoryStore } = await import('../lib/inventoryStore.js');
const { reservationStore } = await import('../lib/reservationStore.js');
const { emptyState: emptyStock } = await import('../lib/inventory.js');
const { emptyState: emptyDiary } = await import('../lib/reservations.js');
const { pushInvoice, countInvoices } = await import('../lib/invoiceSync.js');
const { pushReconciliation, reconciliationRow } = await import('../lib/reconciliationSync.js');
const { pushFeedback } = await import('../lib/feedbackSync.js');
const { pushInventory } = await import('../lib/inventorySync.js');
const { pushReservations } = await import('../lib/reservationSync.js');
const { pushMenu, pushTables, tablesFromCloud } = await import('../lib/catalogSync.js');
const { paymentEvents } = await import('../lib/reconciliation.js');

let cloud;
let T;
let hub;       // the hub's own client: signed in as the restaurant's kitchen login
let otherHub;
before(async () => {
  cloud = await cloudDb();
  T = await cloud.seedTenants();
  assert.equal(T.A.restaurant, A_RID, 'the seeded tenant is the one the hub is paired to');
  hub = pgrestClient(cloud, T.A.user);
  otherHub = pgrestClient(cloud, T.B.user);
  syncQueue.cloud = hub;
  syncQueue.checkConnection = async () => ({ online: true });
  syncQueue.isOnline = true;
});
after(async () => {
  await cloud?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const NOW = '2026-10-22T10:00:00.000Z';

// --- the ledger -----------------------------------------------------------------------------------------------

/** Bills in every state the hub really produces, made by driving the real invoice store. */
function makeBills() {
  const make = id => invoiceStore.issueInvoice({
    tickets: [{ id, ticket_number: 1, restaurant_id: A_RID, table_id: 1, table_name: 'T1', items: [{ id: 'd', name: 'Dal', qty: 2, price: 100 }], total_amount: 200 }],
    tableId: 1, tableName: 'T1', restaurantId: A_RID, currency: '₹', taxConfig: {}, adjustments: {}
  }).invoice;
  make('t_pending');
  const paid = make('t_paid'); invoiceStore.markPaid(paid.id, A_RID, { method: 'cash', payment_ref: 'REF-42' });
  const refunded = make('t_refunded'); invoiceStore.markPaid(refunded.id, A_RID, { method: 'upi' }); invoiceStore.refund(refunded.id, A_RID, { reason: 'cold food' });
  const voided = make('t_voided'); invoiceStore.voidInvoice(voided.id, A_RID, { reason: 'wrong table' });
  const split = make('t_split'); invoiceStore.splitBySeats(split.id, A_RID, { count: 2 });
  invoiceStore.markSplitPaid(split.id, A_RID, { splitIndex: 0, method: 'cash' });
  invoiceStore.markSplitPaid(split.id, A_RID, { splitIndex: 1, method: 'upi' });
}
const cashup = (n, over = {}) => ({
  id: `rec_${n}`, seq: n, number: `REC-00000${n}`, restaurant_id: A_RID, period_start: NOW, period_end: NOW, opening_float: 2000, counted_cash: 7450.5, cash_removed: 5000,
  closing_float: 2450.5, expected_cash: 7450, cash_variance: 0.5, status: 'variance', has_variance: true, methods: { cash: { net: 5450, counted: 7450.5 } },
  totals: { net: 9000 }, voided: { count: 1, total: 200 }, unpaid_at_close: { count: 0, total: 0 }, notes: 'short by 50p', closed_by: 'Priya', synced_to_cloud: false, ...over
});

test('a replacement laptop gets its whole ledger back from the real database: every bill in the state it was in, and the cash screen\'s figures unchanged', async () => {
  makeBills();
  const originals = invoiceStore.listInvoices(A_RID);
  assert.equal(originals.length, 5);
  const before = paymentEvents(originals, A_RID);
  assert.ok(before.some(e => e.kind === 'refund') && before.length >= 4, 'there are payments and a refund to lose');

  for (const bill of originals) await pushInvoice(hub, A_RID, bill);
  const records = [cashup(1, { cash_variance: 0, has_variance: false, status: 'balanced', notes: null }), cashup(2)];
  for (const r of records) await pushReconciliation(hub, A_RID, r);
  assert.equal(await countInvoices(hub, A_RID), 5);

  // A new laptop: nothing local at all.
  invoiceStore.invoices = []; invoiceStore.save();
  reconciliationStore.records = []; reconciliationStore.persist();

  const result = await syncQueue.restoreLedgerFromCloud(A_RID);
  assert.deepEqual([result.restored, result.invoices, result.cashups], [true, 5, 2]);

  const back = invoiceStore.listInvoices(A_RID);
  assert.deepEqual(back.map(b => b.payment_status).sort(), originals.map(b => b.payment_status).sort(), 'including the voided one the CHECK once refused');
  assert.deepEqual(paymentEvents(back, A_RID), before, 'the cash reconciliation is exactly what it was');
  // And the words that explain a void or a refund, which no total shows.
  const reason = status => back.find(b => b.payment_status === status);
  assert.equal(reason('voided').voided_reason, 'wrong table');
  assert.equal(reason('refunded').refund_reason, 'cold food');
  assert.equal(reason('paid') && back.find(b => b.payment_ref === 'REF-42')?.payment_ref, 'REF-42');
  assert.deepEqual(reconciliationStore.list(A_RID).map(r => [r.number, r.cash_variance, r.has_variance, r.closed_by]), [['REC-000002', 0.5, true, 'Priya'], ['REC-000001', 0, false, 'Priya']]);
  assert.ok(back.every(b => b.synced_to_cloud === true), 'and none of it is pushed straight back up');
});

test('a ledger that is only SHORT is found by counting and filled by the repair, on the real database', async () => {
  const [gone] = invoiceStore.listInvoices(A_RID).slice(-1);
  invoiceStore.invoices = invoiceStore.invoices.filter(b => b.id !== gone.id); invoiceStore.save();

  const gap = await syncQueue.checkLedgerGap(A_RID);
  assert.deepEqual([gap.checked, gap.short, gap.invoices], [true, true, 1]);

  const preview = await syncQueue.repairLedgerFromCloud(A_RID, { apply: false });
  assert.deepEqual([preview.ok, preview.applied, preview.added.invoices], [true, false, 1]);
  assert.equal(invoiceStore.listInvoices(A_RID).length, 4, 'looking changes nothing');

  const done = await syncQueue.repairLedgerFromCloud(A_RID, { apply: true });
  assert.equal(done.applied, true);
  assert.ok(invoiceStore.getInvoice(gone.id, A_RID), 'the bill is back');
});

test('pushing a bill again, changed, updates it; and one tenant\'s ledger is never another\'s', async () => {
  const bill = invoiceStore.listInvoices(A_RID).find(b => b.payment_status === 'paid' && !b.splits?.length);
  await pushInvoice(hub, A_RID, { ...bill, payment_status: 'refunded', refund_at: NOW, refund_reason: 'late' });
  const row = (await hub.from('invoices').select('payment_status, refunded_at, refund_reason').eq('hub_ref', bill.id)).data[0];
  assert.deepEqual([row.payment_status, row.refunded_at, row.refund_reason], ['refunded', NOW, 'late']);
  assert.equal(await countInvoices(hub, A_RID), 5, 'an update, not a second row');
  assert.equal(await countInvoices(otherHub, T.B.restaurant), 0);
  assert.equal(await countInvoices(otherHub, A_RID), 0, 'B cannot even count A\'s');
});

// --- guest feedback -----------------------------------------------------------------------------------------------

test('guest feedback comes back from the real database, and a retried push does not double it', async () => {
  feedbackStore.entries = []; feedbackStore.save();
  const made = [
    feedbackStore.add({ restaurantId: A_RID, table: 'T4', rating: 5, comment: 'Lovely dal', invoice: { id: 'inv_9', invoice_number: 'INV-000009' } }),
    feedbackStore.add({ restaurantId: A_RID, table: null, rating: 2, comment: null })
  ];
  for (const e of made) { await pushFeedback(hub, A_RID, e); await pushFeedback(hub, A_RID, e); }
  assert.equal((await hub.from('guest_feedback').select('id')).data.length, 2);

  feedbackStore.entries = []; feedbackStore.save();
  const result = await syncQueue.restoreFeedbackFromCloud(A_RID);
  assert.deepEqual([result.restored, result.count], [true, 2]);
  const back = feedbackStore.list(A_RID);
  assert.deepEqual(back.map(e => [e.rating, e.comment, e.table, e.invoice_number, e.invoice_id]).sort(), [[2, null, null, null, null], [5, 'Lovely dal', 'T4', 'INV-000009', 'inv_9']].sort());
  assert.equal(feedbackStore.listUnsynced(A_RID).length, 0);
});

// --- stock -----------------------------------------------------------------------------------------------------------

test('stock and recipes come back from the real database: ingredients with their costs, a recipe per size, and an extra\'s own line', async () => {
  inventoryStore.state = emptyStock(A_RID);
  const add = (name, unit, on_hand, low_at, extra = {}) => inventoryStore.addIngredient(A_RID, { name, unit, on_hand, low_at, ...extra }, {}).meta.item;
  const rice = add('Rice', 'kg', 5, 1, { par: 20, unit_cost: 62.5 });
  const cheese = add('Cheese', 'g', 100, 10, { unit_cost: 0.45 });
  const oil = add('Oil', 'l', 3, 0);   // no cost known: unknown is not free
  const menu = { items: [
    { id: 'biryani', name: 'Biryani', variants: [{ id: 'half', label: 'Half' }, { id: 'full', label: 'Full' }], modifier_groups: [{ id: 'g_extras', label: 'Extras', min: 0, max: 1, options: [{ id: 'o_cheese', label: 'Cheese', price_delta: 30 }] }] },
    { id: 'chai', name: 'Chai' }
  ] };
  const set = input => { const r = inventoryStore.setRecipe(A_RID, input, menu); assert.equal(r.ok, true, JSON.stringify(r)); };
  set({ item_id: 'biryani', variant_id: 'half', lines: [{ inventory_item_id: rice.id, qty: 0.2 }] });
  set({ item_id: 'biryani', variant_id: 'full', lines: [{ inventory_item_id: rice.id, qty: 0.35 }, { inventory_item_id: cheese.id, qty: 20, group_id: 'g_extras', option_id: 'o_cheese' }] });
  set({ item_id: 'chai', lines: [{ inventory_item_id: oil.id, qty: 0.01 }] });
  const original = { items: [...inventoryStore.state.items].sort((a, b) => a.name.localeCompare(b.name)), recipes: inventoryStore.state.recipes };

  const pushed = await pushInventory(hub, A_RID, inventoryStore.state);
  assert.deepEqual([pushed.items, pushed.recipes], [3, 3]);

  inventoryStore.state = emptyStock(A_RID); inventoryStore.save();
  const result = await syncQueue.restoreInventoryFromCloud(A_RID);
  assert.deepEqual([result.restored, result.items, result.recipes], [true, 3, 3]);

  const pick = i => ({ id: i.id, name: i.name, unit: i.unit, on_hand: i.on_hand, low_at: i.low_at, par: i.par, unit_cost: i.unit_cost });
  assert.deepEqual(inventoryStore.state.items.map(pick).sort((a, b) => a.name.localeCompare(b.name)), original.items.map(pick));
  assert.equal(inventoryStore.state.items.find(i => i.name === 'Oil').unit_cost, null, 'an unknown cost stays unknown, not zero');
  const recipeKey = r => `${r.item_id}|${r.variant_id}`;
  const byKey = list => Object.fromEntries(list.map(r => [recipeKey(r), r.lines]));
  assert.deepEqual(byKey(inventoryStore.state.recipes), byKey(original.recipes));
  assert.deepEqual(byKey(inventoryStore.state.recipes)['biryani|full'].map(l => l.option_id ?? null).sort(), [null, 'o_cheese']);
});

test('a push removes what the hub no longer holds, in its own restaurant only', async () => {
  await pushInventory(otherHub, T.B.restaurant, { items: [{ id: 'b_ing', name: 'Their saffron', unit: 'g', on_hand: 1, low_at: 0 }], recipes: [] });
  const kept = inventoryStore.state.items.filter(i => i.name !== 'Oil');
  await pushInventory(hub, A_RID, { items: kept, recipes: inventoryStore.state.recipes.filter(r => r.item_id !== 'chai') });
  const mine = (await hub.from('inventory_items').select('name')).data.map(r => r.name).sort();
  assert.deepEqual(mine, ['Cheese', 'Rice'], 'Oil is gone from the cloud');
  assert.equal((await hub.from('recipes').select('hub_ref')).data.length, 2, 'and so is the chai recipe');
  assert.equal((await otherHub.from('inventory_items').select('name')).data.length, 1, 'while the other restaurant\'s stock is untouched');
});

// --- bookings --------------------------------------------------------------------------------------------------------

test('the booking diary comes back from the real database: bookings in every status and the walk-in queue', async () => {
  const day = d => new Date(2026, 9, d, 13, 30).toISOString();
  const bookings = ['booked', 'seated', 'no_show', 'cancelled'].map((status, i) => ({
    id: `res_${i}`, guest_name: `Guest ${i}`, phone: '9198765432' + (10 + i), phone_key: String(i).repeat(64), party_size: 2 + i, at: day(22 + i), duration_mins: 90, status,
    ...(status === 'booked' ? { overbooked: true, note: 'Window table', reminded_at: day(22), reminded_by: 'Asha' } : {}), created_at: day(21),
    ...(status === 'seated' ? { seated_at: day(22) } : {}), ...(status === 'cancelled' ? { cancelled_at: day(21) } : {}), ...(status === 'no_show' ? { no_show_at: day(23) } : {})
  }));
  const walkins = ['waiting', 'notified', 'seated', 'left'].map((status, i) => ({ id: `wl_${i}`, guest_name: `Walk ${i}`, phone: '9198765511' + (10 + i), phone_key: String(9 - i).repeat(64), party_size: 1 + i, quoted_wait_mins: 10 * i, status, created_at: day(21),
    ...(['notified', 'seated'].includes(status) ? { notified_at: day(21) } : {}), ...(status === 'seated' ? { seated_at: day(22) } : {}), ...(status === 'left' ? { left_at: day(22) } : {}) }));
  reservationStore.state = { ...emptyDiary(A_RID), revision: 4, reservations: bookings, waitlist: walkins };
  reservationStore.save?.();

  await pushReservations(hub, A_RID, { reservations: bookings, waitlist: walkins });
  reservationStore.state = emptyDiary(A_RID); reservationStore.save?.();

  const result = await syncQueue.restoreReservationsFromCloud(A_RID);
  assert.deepEqual([result.restored, result.reservations, result.waitlist], [true, 4, 4]);
  const byId = list => Object.fromEntries(list.map(r => [r.id, r]));
  assert.deepEqual(byId(reservationStore.state.reservations), byId(bookings));
  assert.deepEqual(byId(reservationStore.state.waitlist), byId(walkins));
});

// --- the menu and the layout ------------------------------------------------------------------------------------------

test('the menu and the table layout reach the real database in the order and shape the hub keeps, and a removed dish is removed', async () => {
  const item = (id, name, extra = {}) => ({ id, name, price: 220, category: 'Mains', isVeg: true, available: true, variants: [], modifier_groups: [], day_parts: [], station: 'hot', ...extra });
  const spice = [{ id: 'g_spice', label: 'Spice', min: 1, max: 1, options: [{ id: 'mild', label: 'Mild', price_delta: 0, available: true }] }];
  await pushMenu(hub, A_RID, { categories: ['Mains', 'Drinks'], items: [item('m1', 'Dal', { modifier_groups: spice, variants: [{ id: 'h', label: 'Half', price: 120, available: true }] }), item('m2', 'Naan'), item('m3', 'Chai', { category: 'Drinks', station: 'bar' })] });
  const rows = (await hub.from('menu_items').select('hub_ref, name, modifier_groups, variants, station').order('hub_ref')).data;
  assert.deepEqual(rows.map(r => r.hub_ref), ['m1', 'm2', 'm3']);
  assert.deepEqual(rows[0].modifier_groups, spice, 'the nested choices survive as the JSON they are');
  assert.deepEqual(rows[0].variants, [{ id: 'h', label: 'Half', price: 120, available: true }]);

  const pruned = await pushMenu(hub, A_RID, { categories: ['Mains'], items: [item('m1', 'Dal'), item('m2', 'Naan')] });
  assert.equal(pruned.removed, 2, 'the chai and the Drinks category');
  assert.deepEqual((await hub.from('menu_items').select('hub_ref').order('hub_ref')).data.map(r => r.hub_ref), ['m1', 'm2']);

  await pushTables(hub, A_RID, { tables: [{ id: 3, name: 'T3', section: 'Terrace', capacity: 2 }, { id: 1, name: 'T1', section: 'Main', capacity: 4 }, { id: 2, name: 'T2', section: 'Main', capacity: 6 }] });
  const back = tablesFromCloud((await hub.from('tables').select('*').order('display_order')).data);
  assert.deepEqual(back.map(t => [t.id, t.name, t.section, t.capacity]), [[3, 'T3', 'Terrace', 2], [1, 'T1', 'Main', 4], [2, 'T2', 'Main', 6]], 'the layout order the hub pushed');
});
