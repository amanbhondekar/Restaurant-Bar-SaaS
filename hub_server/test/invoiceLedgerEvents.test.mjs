import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every change to a bill leaves an event (G0-4). These tests drive the REAL invoice store through a bill's life and read what the
// event history says afterwards -- including the six hub fields (paid_by, voided_by, refund_by, split_mode, split_at, split_by) that
// the cloud copy of a bill never carried.
const RID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-events-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';
fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
  paired: true, restaurant_id: RID, name: 'Test Kitchen', pairing_code: 'TST-0001', city: 'Nagpur', enrollment_code: 'X', devices: []
}));

const { invoiceStore } = await import('../lib/invoiceStore.js');
const { invoiceEventStore } = await import('../lib/invoiceEventStore.js');
const { verifyChain } = await import('../lib/invoiceEvents.js');

const EVENTS_FILE = path.join(dataDir, 'invoice_events.jsonl');

let seq = 0;
const tickets = (n = 1) => Array.from({ length: n }, () => {
  const k = ++seq;
  return { id: `t${k}`, ticket_number: 100 + k, created_at: `2026-10-26T10:0${k % 10}:00.000Z`, items: [{ id: 'dal', name: 'Dal', qty: 2, price: 150 }, { id: 'naan', name: 'Naan', qty: 4, price: 50 }] };
});
const issue = (over = {}) => {
  const r = invoiceStore.issueInvoice({ tickets: tickets(), tableId: ++seq, tableName: 'T4', restaurantId: RID, currency: '₹', taxConfig: {}, ...over });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.invoice;
};
const history = (invoice, restaurantId = RID) => invoiceEventStore.list(restaurantId, invoice.id);
const types = invoice => history(invoice).map(e => e.type);

beforeEach(() => {
  invoiceStore.invoices = [];
  fs.rmSync(EVENTS_FILE, { force: true });
  invoiceEventStore.reload();
});

// --- issuing -------------------------------------------------------------------------------------

test('issuing a bill records one event that holds the whole bill as it was issued', () => {
  const invoice = issue();
  const events = history(invoice);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'issued');
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].restaurant_id, RID);
  assert.equal(events[0].payload.invoice.invoice_number, invoice.invoice_number);
  assert.equal(events[0].payload.invoice.grand_total, invoice.grand_total);
  assert.deepEqual(events[0].payload.invoice.items.map(i => i.name), ['Dal', 'Naan']);
  assert.deepEqual(events[0].payload.invoice.tax_rows, invoice.tax_rows);
});

test('asking again for the same bill returns it and records nothing more', () => {
  const t = tickets();
  const a = invoiceStore.issueInvoice({ tickets: t, tableId: 9, tableName: 'T9', restaurantId: RID, currency: '₹', taxConfig: {} });
  const b = invoiceStore.issueInvoice({ tickets: t, tableId: 9, tableName: 'T9', restaurantId: RID, currency: '₹', taxConfig: {} });
  assert.equal(b.duplicate, true);
  assert.equal(history(a.invoice).length, 1);
});

test('a bill that could not be issued leaves no event', () => {
  const none = invoiceStore.issueInvoice({ tickets: [], tableId: 1, restaurantId: RID });
  assert.equal(none.ok, false);
  const bad = invoiceStore.issueInvoice({ tickets: tickets(), tableId: 2, tableName: 'T2', restaurantId: RID, currency: '₹', taxConfig: {}, adjustments: { discounts: [{ type: 'percent', value: 500 }] } });
  assert.equal(bad.ok, false);
  assert.equal(invoiceEventStore.listUnsynced(RID).length, 0);
});

test('the person who issued it is recorded when the caller says who', () => {
  const invoice = issue({ actor: 'Priya' });
  assert.equal(history(invoice)[0].actor, 'Priya');
  assert.equal(history(issue())[0].actor, null);
});

// --- settling ------------------------------------------------------------------------------------

test('paying records who took the payment, how, and the reference -- fields the cloud copy never held', () => {
  const invoice = issue();
  invoiceStore.markPaid(invoice.id, RID, { method: 'upi', actor: 'Priya', payment_ref: 'UPI123' });
  const e = history(invoice)[1];
  assert.equal(e.type, 'paid');
  assert.equal(e.actor, 'Priya');
  assert.deepEqual(e.payload.changes.payment_status, { from: 'pending', to: 'paid' });
  assert.deepEqual(e.payload.changes.payment_method, { from: null, to: 'upi' });
  assert.deepEqual(e.payload.changes.payment_ref, { from: null, to: 'UPI123' });
  assert.deepEqual(e.payload.changes.paid_by, { from: null, to: 'Priya' });
  assert.ok(e.payload.changes.paid_at.to);
});

test('voiding records the reason and who voided it', () => {
  const invoice = issue();
  invoiceStore.voidInvoice(invoice.id, RID, { reason: 'Wrong table', actor: 'Ravi' });
  const e = history(invoice)[1];
  assert.equal(e.type, 'voided');
  assert.equal(e.actor, 'Ravi');
  assert.deepEqual(e.payload.changes.payment_status, { from: 'pending', to: 'voided' });
  assert.deepEqual(e.payload.changes.voided_reason, { from: null, to: 'Wrong table' });
  assert.deepEqual(e.payload.changes.voided_by, { from: null, to: 'Ravi' });
});

test('refunding records the reason and who refunded it, and the status it came from', () => {
  const invoice = issue();
  invoiceStore.markPaid(invoice.id, RID, { method: 'cash', actor: 'Priya' });
  invoiceStore.refund(invoice.id, RID, { reason: 'Cold food', actor: 'Asha' });
  const e = history(invoice)[2];
  assert.equal(e.type, 'refunded');
  assert.equal(e.actor, 'Asha');
  assert.deepEqual(e.payload.changes.payment_status, { from: 'paid', to: 'refunded' });
  assert.deepEqual(e.payload.changes.refund_reason, { from: null, to: 'Cold food' });
  assert.deepEqual(e.payload.changes.refund_by, { from: null, to: 'Asha' });
});

test('a change the store refuses leaves no event', () => {
  const invoice = issue();
  invoiceStore.markPaid(invoice.id, RID, { method: 'cash', actor: 'Priya' });
  const before = history(invoice).length;
  const refused = [
    invoiceStore.voidInvoice(invoice.id, RID, { reason: 'x', actor: 'Ravi' }),         // a paid bill is refunded, not voided
    invoiceStore.markPaid(invoice.id, RID, { method: 'cash' }),                         // already paid
    invoiceStore.refund(invoice.id, RID, { reason: '', actor: 'Asha' }),                // no reason
    invoiceStore.markPaid('inv_unknown', RID, { method: 'cash' }),                      // not a bill
    invoiceStore.markPaid(invoice.id, OTHER, { method: 'cash' })                        // another restaurant's
  ];
  assert.ok(refused.every(r => r.ok === false));
  assert.equal(history(invoice).length, before);
  assert.equal(invoiceEventStore.list(RID, 'inv_unknown').length, 0);
});

test('a bill that is refused for an invalid method leaves no event', () => {
  const invoice = issue();
  assert.equal(invoiceStore.markPaid(invoice.id, RID, { method: 'bitcoin' }).ok, false);
  assert.deepEqual(types(invoice), ['issued']);
});

// --- splitting -----------------------------------------------------------------------------------

test('splitting records the mode, the shares, when and by whom', () => {
  const invoice = issue();
  invoiceStore.splitBySeats(invoice.id, RID, { count: 3, actor: 'Priya' });
  const e = history(invoice)[1];
  assert.equal(e.type, 'split');
  assert.equal(e.actor, 'Priya');
  assert.deepEqual(e.payload.changes.split_mode, { from: null, to: 'seats' });
  assert.deepEqual(e.payload.changes.split_by, { from: null, to: 'Priya' });
  assert.ok(e.payload.changes.split_at.to);
  assert.equal(e.payload.changes.splits.to.length, 3);
});

test('undoing a split keeps what it destroyed: the shares, the mode, the time and who split it', () => {
  const invoice = issue();
  invoiceStore.splitBySeats(invoice.id, RID, { count: 2, actor: 'Priya' });
  const shares = invoiceStore.getInvoice(invoice.id, RID).splits;
  invoiceStore.unsplit(invoice.id, RID, { actor: 'Ravi' });
  const e = history(invoice)[2];
  assert.equal(e.type, 'unsplit');
  assert.equal(e.actor, 'Ravi');
  assert.deepEqual(e.payload.changes.splits, { from: shares, to: null });
  assert.deepEqual(e.payload.changes.split_mode, { from: 'seats', to: null });
  assert.deepEqual(e.payload.changes.split_by, { from: 'Priya', to: null });
});

test('split, undo, split another way leaves all three steps -- the sequence the cloud copy used to erase', () => {
  const invoice = issue();
  invoiceStore.splitBySeats(invoice.id, RID, { count: 2, actor: 'Priya' });
  invoiceStore.unsplit(invoice.id, RID, { actor: 'Priya' });
  const res = invoiceStore.splitByItems(invoice.id, RID, { splits: [{ item_indices: [0] }, { item_indices: [1] }], actor: 'Priya' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(types(invoice), ['issued', 'split', 'unsplit', 'split']);
  assert.equal(history(invoice)[1].payload.changes.split_mode.to, 'seats');
  assert.equal(history(invoice)[3].payload.changes.split_mode.to, 'items');
});

test('undoing a split that was not made, or after a share was paid, leaves no event', () => {
  const invoice = issue();
  assert.equal(invoiceStore.unsplit(invoice.id, RID, { actor: 'Ravi' }).ok, false);
  invoiceStore.splitBySeats(invoice.id, RID, { count: 2, actor: 'Priya' });
  invoiceStore.markSplitPaid(invoice.id, RID, { splitIndex: 0, method: 'cash', actor: 'Priya' });
  const before = history(invoice).length;
  assert.equal(invoiceStore.unsplit(invoice.id, RID, { actor: 'Ravi' }).ok, false);
  assert.equal(history(invoice).length, before);
});

test('paying a share records the share; paying the last one also settles the bill and says who', () => {
  const invoice = issue();
  invoiceStore.splitBySeats(invoice.id, RID, { count: 2, actor: 'Priya' });
  invoiceStore.markSplitPaid(invoice.id, RID, { splitIndex: 0, method: 'cash', actor: 'Priya' });
  invoiceStore.markSplitPaid(invoice.id, RID, { splitIndex: 1, method: 'upi', actor: 'Asha', payment_ref: 'U9' });
  const [, , first, last] = history(invoice);
  assert.deepEqual([first.type, last.type], ['split_paid', 'split_paid']);
  assert.equal(first.payload.changes.payment_status, undefined, 'the bill is not settled yet');
  assert.deepEqual(last.payload.changes.payment_status, { from: 'pending', to: 'paid' });
  assert.deepEqual(last.payload.changes.payment_method, { from: null, to: 'split' });
  assert.deepEqual(last.payload.changes.paid_by, { from: null, to: 'Asha' });
  assert.equal(last.actor, 'Asha');
});

test('refunding a split bill records every share that was refunded', () => {
  const invoice = issue();
  invoiceStore.splitBySeats(invoice.id, RID, { count: 2, actor: 'Priya' });
  invoiceStore.markSplitPaid(invoice.id, RID, { splitIndex: 0, method: 'cash', actor: 'Priya' });
  invoiceStore.markSplitPaid(invoice.id, RID, { splitIndex: 1, method: 'cash', actor: 'Priya' });
  invoiceStore.refund(invoice.id, RID, { reason: 'Complaint', actor: 'Asha' });
  const e = history(invoice).at(-1);
  assert.equal(e.type, 'refunded');
  assert.deepEqual(e.payload.changes.splits.to.map(s => [s.payment_status, s.refund_by]), [['refunded', 'Asha'], ['refunded', 'Asha']]);
});

// --- a failing history never stops a bill ------------------------------------------------------

test('a change that changed nothing leaves no event', () => {
  const invoice = issue();
  assert.equal(invoiceStore.recordChange('paid', invoice, { ...invoice }, 'P'), null);
  assert.equal(history(invoice).length, 1);
});

test('if the history cannot be written, the bill is still paid, and the failure is said out loud', () => {
  const invoice = issue();
  const realAppend = invoiceEventStore.append;
  const realError = console.error;
  const said = [];
  invoiceEventStore.append = () => { throw new Error('disk full'); };
  console.error = (...args) => said.push(args.join(' '));
  let result;
  try {
    result = invoiceStore.markPaid(invoice.id, RID, { method: 'cash', actor: 'P' });
  } finally {
    invoiceEventStore.append = realAppend;
    console.error = realError;
  }
  assert.equal(result.ok, true, 'the payment went through');
  assert.equal(invoiceStore.getInvoice(invoice.id, RID).payment_status, 'paid');
  assert.ok(said.some(line => /disk full/.test(line)), 'and the failure was reported');
});

// --- the whole history ---------------------------------------------------------------------------

test('every one of the six hub fields the cloud copy never carried is in the history', () => {
  const a = issue();
  invoiceStore.splitBySeats(a.id, RID, { count: 2, actor: 'Priya' });
  invoiceStore.markSplitPaid(a.id, RID, { splitIndex: 0, method: 'cash', actor: 'Priya' });
  invoiceStore.markSplitPaid(a.id, RID, { splitIndex: 1, method: 'cash', actor: 'Priya' });
  invoiceStore.refund(a.id, RID, { reason: 'r', actor: 'Asha' });
  const b = issue();
  invoiceStore.voidInvoice(b.id, RID, { reason: 'wrong', actor: 'Ravi' });
  const seen = new Set();
  for (const bill of [a, b]) for (const e of history(bill)) for (const key of Object.keys(e.payload.changes || {})) seen.add(key);
  for (const field of ['paid_by', 'voided_by', 'refund_by', 'split_mode', 'split_at', 'split_by']) assert.ok(seen.has(field), `${field} is recorded`);
});

test('replaying the events from the issued bill gives back the bill as it stands, for every kind of life', () => {
  // As JSON: a line's `isVeg: undefined` is no value at all once stored, and a field that is null and one that is absent are the same fact.
  const strip = o => Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(o))).filter(([k, v]) => v !== null && k !== 'synced_to_cloud'));
  const replay = bill => {
    const [first, ...rest] = history(bill);
    const state = { ...first.payload.invoice };
    for (const e of rest) for (const [k, { to }] of Object.entries(e.payload.changes)) { if (to === null) delete state[k]; else state[k] = to; }
    return state;
  };

  const paid = issue();
  invoiceStore.markPaid(paid.id, RID, { method: 'cash', actor: 'P' });

  const voided = issue();
  invoiceStore.voidInvoice(voided.id, RID, { reason: 'oops', actor: 'R' });

  const refunded = issue();
  invoiceStore.markPaid(refunded.id, RID, { method: 'card', actor: 'P', payment_ref: 'C1' });
  invoiceStore.refund(refunded.id, RID, { reason: 'cold', actor: 'A' });

  const split = issue();
  invoiceStore.splitBySeats(split.id, RID, { count: 3, actor: 'P' });
  invoiceStore.unsplit(split.id, RID, { actor: 'P' });
  invoiceStore.splitBySeats(split.id, RID, { count: 2, actor: 'P' });
  invoiceStore.markSplitPaid(split.id, RID, { splitIndex: 0, method: 'cash', actor: 'P' });
  invoiceStore.markSplitPaid(split.id, RID, { splitIndex: 1, method: 'upi', actor: 'A', payment_ref: 'U1' });

  for (const bill of [paid, voided, refunded, split]) {
    assert.deepEqual(strip(replay(bill)), strip(invoiceStore.getInvoice(bill.id, RID)), bill.invoice_number);
  }
});

test('the history of a bill verifies as one chain, and each bill has its own', () => {
  const a = issue();
  const b = issue();
  invoiceStore.markPaid(a.id, RID, { method: 'cash', actor: 'P' });
  invoiceStore.markPaid(b.id, RID, { method: 'cash', actor: 'P' });
  invoiceStore.refund(a.id, RID, { reason: 'r', actor: 'A' });
  assert.deepEqual(history(a).map(e => e.seq), [1, 2, 3]);
  assert.deepEqual(history(b).map(e => e.seq), [1, 2]);
  assert.equal(verifyChain(history(a)).ok, true);
  assert.equal(verifyChain(history(b)).ok, true);
});

test('the history is on disk, so it outlives the hub', () => {
  const invoice = issue();
  invoiceStore.markPaid(invoice.id, RID, { method: 'cash', actor: 'P' });
  invoiceEventStore.reload();
  assert.deepEqual(types(invoice), ['issued', 'paid']);
});

test('every event of a new bill starts out not yet in the cloud', () => {
  issue();
  assert.equal(invoiceEventStore.listUnsynced(RID).length, 1);
});

// --- bills that were here before events ---------------------------------------------------------

test('a bill with no history is given a baseline that says what it looked like when the hub began keeping one', () => {
  const old = { id: 'inv_old', restaurant_id: RID, invoice_number: 'INV-000001', grand_total: 500, payment_status: 'paid', payment_method: 'cash', items: [], tax_rows: [], synced_to_cloud: true };
  invoiceStore.invoices = [old];
  const r = invoiceStore.recordBaselines(RID);
  assert.equal(r.recorded, 1);
  const [e] = history(old);
  assert.equal(e.type, 'baseline');
  assert.equal(e.seq, 1);
  assert.equal(e.payload.invoice.grand_total, 500);
  assert.match(e.payload.note, /history before this is not known/i);
});

test('baselines are recorded once, and only for this restaurant\'s bills', () => {
  invoiceStore.invoices = [
    { id: 'inv_a', restaurant_id: RID, invoice_number: 'INV-000001', payment_status: 'pending', items: [] },
    { id: 'inv_b', restaurant_id: OTHER, invoice_number: 'INV-000001', payment_status: 'pending', items: [] }
  ];
  assert.equal(invoiceStore.recordBaselines(RID).recorded, 1);
  assert.equal(invoiceStore.recordBaselines(RID).recorded, 0);
  assert.equal(invoiceEventStore.list(OTHER, 'inv_b').length, 0);
});

test('a bill issued after a baseline carries on from it, and a baselined bill can change like any other', () => {
  invoiceStore.invoices = [{ id: 'inv_old', restaurant_id: RID, invoice_number: 'INV-000001', payment_status: 'pending', grand_total: 100, items: [], tax_rows: [] }];
  invoiceStore.recordBaselines(RID);
  invoiceStore.markPaid('inv_old', RID, { method: 'cash', actor: 'P' });
  assert.deepEqual(types({ id: 'inv_old' }), ['baseline', 'paid']);
  assert.equal(verifyChain(history({ id: 'inv_old' })).ok, true);
});

test('a bill that changes with no history at all is given a baseline first, so the first change is not a blind spot', () => {
  invoiceStore.invoices = [{ id: 'inv_old', restaurant_id: RID, invoice_number: 'INV-000001', payment_status: 'pending', grand_total: 100, items: [], tax_rows: [] }];
  invoiceStore.markPaid('inv_old', RID, { method: 'cash', actor: 'P' });
  assert.deepEqual(types({ id: 'inv_old' }), ['baseline', 'paid']);
  assert.equal(history({ id: 'inv_old' })[0].payload.invoice.payment_status, 'pending', 'the baseline is the state BEFORE the change');
});
