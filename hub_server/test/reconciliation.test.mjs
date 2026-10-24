import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import { startHub } from './helpers/spawnHub.mjs';
import {
  METHODS, paymentEvents, summarize, invoiceSideNotes, validateCloseInput, buildRecord, ledgerCsv, csvCell, round2
} from '../lib/reconciliation.js';

// ---------------------------------------------------------------------------
// M1 completion — payment reconciliation: ledger, per-method totals, shift close.
// Fixed timestamps (UTC) so nothing depends on when the suite runs.
// ---------------------------------------------------------------------------

const RID = '11111111-1111-1111-1111-111111111111';
const T = (day, hh, mm = 0) => `2026-10-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;
const ms = iso => Date.parse(iso);

function inv(over) {
  return { id: `id_${over.invoice_number}`, restaurant_id: RID, table_name: 'T1', payment_status: 'pending', ...over };
}

// "Today" is 2 Oct. INV-5 was sold yesterday and refunded today.
const INVOICES = [
  inv({ invoice_number: 'INV-1', grand_total: 500, payment_status: 'paid', payment_method: 'cash', paid_at: T(2, 10) }),
  inv({ invoice_number: 'INV-2', grand_total: 300, payment_status: 'paid', payment_method: 'upi', payment_ref: 'UPI123', paid_at: T(2, 11) }),
  inv({ invoice_number: 'INV-3', grand_total: 700, payment_status: 'paid', payment_method: 'card', payment_ref: '=cmd|calc', paid_at: T(2, 12) }),
  inv({
    invoice_number: 'INV-4', grand_total: 500, payment_status: 'paid', payment_method: 'split', paid_at: T(2, 12, 35),
    splits: [
      { index: 0, label: 'Seat 1', share_amount: 200, payment_status: 'paid', payment_method: 'cash', paid_at: T(2, 12, 30) },
      { index: 1, label: 'Seat 2', share_amount: 300, payment_status: 'paid', payment_method: 'upi', paid_at: T(2, 12, 35), payment_ref: 'UPI9' }
    ]
  }),
  inv({ invoice_number: 'INV-5', grand_total: 400, payment_status: 'refunded', payment_method: 'cash', paid_at: T(1, 9), refund_at: T(2, 13), refund_reason: 'wrong dish' }),
  inv({ invoice_number: 'INV-6', grand_total: 250, payment_status: 'voided', voided_at: T(2, 14) }),
  inv({ invoice_number: 'INV-7', grand_total: 150, payment_status: 'pending' }),
  // Another tenant's invoice must never leak in.
  { id: 'x', restaurant_id: 'other', invoice_number: 'INV-X', grand_total: 9999, payment_status: 'paid', payment_method: 'cash', paid_at: T(2, 10) }
];

test('ledger: payments and refunds are derived per event, split shares individually, other tenants excluded', () => {
  const ev = paymentEvents(INVOICES, RID);
  const key = e => `${e.kind}:${e.invoice_number}:${e.method}:${e.amount}`;
  assert.deepEqual(ev.map(key), [
    'payment:INV-5:cash:400',   // yesterday
    'payment:INV-1:cash:500',
    'payment:INV-2:upi:300',
    'payment:INV-3:card:700',
    'payment:INV-4:cash:200',
    'payment:INV-4:upi:300',
    'refund:INV-5:cash:400'     // today
  ]);
  assert.equal(ev.some(e => e.invoice_number === 'INV-X'), false);
  assert.equal(ev.some(e => e.invoice_number === 'INV-6' || e.invoice_number === 'INV-7'), false, 'voided and unpaid invoices are not payments');
  assert.equal(ev.find(e => e.split_label === 'Seat 2').reference, 'UPI9');
  // A split invoice's parent "split" method is never double counted.
  assert.equal(ev.some(e => e.method === 'other'), false);
});

test('summary: a refund reduces the day it happens, in the method it was paid with', () => {
  const ev = paymentEvents(INVOICES, RID);
  const today = summarize(ev, { fromMs: ms(T(2, 0)), toMs: ms(T(3, 0)) });
  assert.deepEqual(today.by_method.cash, { payments_count: 2, payments_total: 700, refunds_count: 1, refunds_total: 400, net: 300 });
  assert.equal(today.by_method.upi.net, 600);
  assert.equal(today.by_method.card.net, 700);
  assert.equal(today.by_method.other.net, 0);
  assert.equal(today.totals.net, 1600);
  assert.equal(today.event_count, 6);

  const yesterday = summarize(ev, { fromMs: ms(T(1, 0)), toMs: ms(T(2, 0)) });
  assert.equal(yesterday.by_method.cash.net, 400, "yesterday's sale was cash in the drawer that day");
  assert.equal(METHODS.length, 4);
});

test('summary: windows are half-open, so an event on the boundary is counted exactly once', () => {
  const ev = paymentEvents(INVOICES, RID);
  const boundary = ms(T(2, 11)); // INV-2 (upi 300) is paid exactly then
  const before = summarize(ev, { fromMs: ms(T(2, 0)), toMs: boundary });
  const after = summarize(ev, { fromMs: boundary, toMs: ms(T(3, 0)) });
  assert.equal(before.by_method.upi.net, 0);
  assert.equal(after.by_method.upi.net, 600);
  assert.equal(before.event_count + after.event_count, summarize(ev, { fromMs: ms(T(2, 0)), toMs: ms(T(3, 0)) }).event_count);
});

test('side notes: voids in the window and bills still unpaid', () => {
  const n = invoiceSideNotes(INVOICES, RID, { fromMs: ms(T(2, 0)), toMs: ms(T(3, 0)) });
  assert.deepEqual(n.voided, { count: 1, total: 250 });
  assert.deepEqual(n.unpaid, { count: 1, total: 150 });
  assert.deepEqual(invoiceSideNotes(INVOICES, RID, { fromMs: ms(T(3, 0)), toMs: ms(T(4, 0)) }).voided, { count: 0, total: 0 });
});

test('validation: counted cash is required and amounts must be sane; every problem is reported at once', () => {
  assert.equal(validateCloseInput({}).errors[0].code, 'COUNTED_CASH_REQUIRED');
  const bad = validateCloseInput({ counted_cash: -5, opening_float: 'abc', cash_removed: 1, reported: { upi: -1, bitcoin: 3 } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map(e => e.field).sort(), ['counted_cash', 'opening_float', 'reported.bitcoin', 'reported.upi']);
  assert.equal(validateCloseInput({ counted_cash: 100, cash_removed: 150 }).errors[0].code, 'REMOVED_EXCEEDS_COUNTED');
  assert.equal(validateCloseInput({ counted_cash: Infinity }).ok, false);
  assert.equal(validateCloseInput({ counted_cash: 1e12 }).ok, false);
  assert.equal(validateCloseInput(null).ok, false);

  const ok = validateCloseInput({ counted_cash: '1300.5', opening_float: '1000', reported: { upi: '600', card: '', other: null }, notes: '  ok  ', closed_by: 'Asha' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, { counted_cash: 1300.5, opening_float: 1000, cash_removed: 0, reported: { upi: 600 }, notes: 'ok', closed_by: 'Asha' });
});

test('record: expected cash = opening float + net cash; variance per method; status balanced or variance', () => {
  const ev = paymentEvents(INVOICES, RID);
  const summary = summarize(ev, { fromMs: ms(T(2, 0)), toMs: ms(T(3, 0)) });
  const side = invoiceSideNotes(INVOICES, RID, { fromMs: ms(T(2, 0)), toMs: ms(T(3, 0)) });
  const mk = values => buildRecord({
    summary, notesFromInvoices: side, periodStartMs: ms(T(2, 0)), periodEndMs: ms(T(3, 0)),
    values: { counted_cash: 0, opening_float: 0, cash_removed: 0, reported: {}, notes: '', closed_by: null, ...values }
  });

  const balanced = mk({ opening_float: 1000, counted_cash: 1300, cash_removed: 1000, reported: { upi: 600, card: 700 } });
  assert.equal(balanced.expected_cash, 1300);
  assert.equal(balanced.cash_variance, 0);
  assert.equal(balanced.status, 'balanced');
  assert.equal(balanced.closing_float, 300, 'what stays in the drawer for the next shift');
  assert.equal(balanced.methods.upi.variance, 0);
  assert.equal(balanced.methods.other.variance, undefined, 'no variance for a method with nothing reported');

  const short = mk({ opening_float: 1000, counted_cash: 1250 });
  assert.equal(short.cash_variance, -50);
  assert.equal(short.status, 'variance');

  const upiOff = mk({ opening_float: 1000, counted_cash: 1300, reported: { upi: 650 } });
  assert.equal(upiOff.methods.upi.variance, 50);
  assert.equal(upiOff.status, 'variance');
  assert.equal(upiOff.voided.count, 1);
  assert.equal(upiOff.unpaid_at_close.count, 1);
});

test('money: rounding stays at two decimals', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2('12.345'), 12.35);
  assert.equal(round2(undefined), 0);
});

test('csv: formulas in references are neutralised, quotes and commas are escaped, refunds are negative', () => {
  assert.equal(csvCell('=cmd|calc'), "'=cmd|calc");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('plain'), 'plain');

  const csv = ledgerCsv(paymentEvents(INVOICES, RID));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Time,Type,Method,Amount,Invoice,Table,Share,Reference');
  assert.ok(lines.some(l => l.includes('refund,cash,-400.00,INV-5')));
  assert.ok(lines.some(l => l.includes("'=cmd|calc")), 'the hostile reference is defused');
  assert.equal(lines.length, 8);
});

// ---------------------------------------------------------------------------
// Store + routes on a live hub (reception laptop = loopback, trusted).
// ---------------------------------------------------------------------------

let hub;

const call = (p, { method = 'GET', body } = {}) =>
  fetch(`${hub.base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  const nowIso = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const live = [
    inv({ invoice_number: 'INV-000001', grand_total: 500, payment_status: 'paid', payment_method: 'cash', paid_at: fiveMinAgo }),
    inv({ invoice_number: 'INV-000002', grand_total: 300, payment_status: 'paid', payment_method: 'upi', payment_ref: 'UPIX', paid_at: fiveMinAgo }),
    inv({ invoice_number: 'INV-000003', grand_total: 120, payment_status: 'pending', issued_at: nowIso })
  ];
  hub = await startHub({
    trustLoopback: true,
    menu: { restaurant_id: RID, categories: ['A'], items: [{ id: 'm1', name: 'X', price: 10, category: 'A', isVeg: true, available: true }] },
    tables: { restaurant_id: RID, tables: [{ id: 1, name: 'T1', section: 'M', capacity: 2 }] },
    enrollmentCode: 'RECCODE',
    config: { restaurant_id: RID, pairing_code: 'REC-0001' },
    // The ledger these tests reconcile has to be on disk before the hub reads it.
    files: { 'invoices.json': live }
  });
});

after(() => hub?.stop());

test('hub: preview shows the period before the first close and stores nothing', async () => {
  const p = await (await call('/reconciliation/preview')).json();
  assert.equal(p.success, true);
  assert.equal(p.since_last_close, false);
  assert.equal(p.by_method.cash.net, 500);
  assert.equal(p.by_method.upi.net, 300);
  assert.equal(p.totals.net, 800);
  assert.equal(p.suggested_opening_float, 0);
  assert.deepEqual(p.unpaid, { count: 1, total: 120 });
  assert.equal((await (await call('/reconciliations')).json()).records.length, 0);
});

test('hub: closing with a mismatch needs a note and reports the figures; nothing is saved', async () => {
  const res = await call('/reconciliation/close', { method: 'POST', body: { opening_float: 1000, counted_cash: 1450, reported: { upi: 300 } } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'NOTES_REQUIRED_FOR_VARIANCE');
  assert.equal(body.preview.expected_cash, 1500);
  assert.equal(body.preview.cash_variance, -50);
  assert.equal((await (await call('/reconciliations')).json()).records.length, 0);
});

test('hub: invalid input is a 400 listing every problem', async () => {
  const res = await call('/reconciliation/close', { method: 'POST', body: { counted_cash: -1, opening_float: 'x' } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'INVALID_INPUT');
  assert.ok(body.errors.length >= 2);
});

let firstRecord;
test('hub: a balanced close stores an immutable numbered record and starts the next period', async () => {
  const res = await call('/reconciliation/close', {
    method: 'POST',
    body: { opening_float: 1000, counted_cash: 1500, cash_removed: 1200, reported: { upi: 300 }, closed_by: 'Asha' }
  });
  assert.equal(res.status, 201);
  firstRecord = (await res.json()).record;
  assert.equal(firstRecord.number, 'REC-000001');
  assert.equal(firstRecord.status, 'balanced');
  assert.equal(firstRecord.expected_cash, 1500);
  assert.equal(firstRecord.closing_float, 300);
  assert.equal(firstRecord.closed_by, 'Asha');
  assert.equal(firstRecord.unpaid_at_close.count, 1);

  // Persisted to disk.
  const onDisk = JSON.parse(fs.readFileSync(path.join(hub.dataDir, 'reconciliations.json'), 'utf-8'));
  assert.equal(onDisk.length, 1);

  // The next period is empty: the same payments cannot be counted twice. The float carries over.
  const p = await (await call('/reconciliation/preview')).json();
  assert.equal(p.since_last_close, true);
  assert.equal(p.totals.net, 0);
  assert.equal(p.event_count, 0);
  assert.equal(p.suggested_opening_float, 300);
  assert.equal(p.last_record.number, 'REC-000001');
});

test('hub: a payment taken after the close lands in the next record only; a variance with a note closes as "variance"', async () => {
  const paid = await call('/invoices/INV-000003/mark-paid', { method: 'POST', body: { payment_method: 'cash', actor: 'Asha' } });
  assert.equal(paid.status, 200);

  const p = await (await call('/reconciliation/preview')).json();
  assert.equal(p.by_method.cash.net, 120);
  assert.equal(p.totals.net, 120);

  const res = await call('/reconciliation/close', {
    method: 'POST',
    body: { opening_float: 300, counted_cash: 400, notes: 'Rs 20 short, change given by mistake', closed_by: 'Asha' }
  });
  assert.equal(res.status, 201);
  const rec = (await res.json()).record;
  assert.equal(rec.number, 'REC-000002');
  assert.equal(rec.expected_cash, 420);
  assert.equal(rec.cash_variance, -20);
  assert.equal(rec.status, 'variance');
  assert.equal(rec.period_start, firstRecord.period_end, 'periods are contiguous');
});

test('hub: records list newest first, fetch by number, 404 for unknown', async () => {
  const list = (await (await call('/reconciliations')).json()).records;
  assert.deepEqual(list.map(r => r.number), ['REC-000002', 'REC-000001']);
  assert.equal((await (await call('/reconciliations/REC-000001')).json()).record.id, firstRecord.id);
  assert.equal((await call('/reconciliations/REC-999999')).status, 404);
});

test('hub: ledger CSV downloads with the right headers and honours from/to', async () => {
  const res = await call('/reconciliation/ledger.csv?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /payments-ledger\.csv/);
  const text = (await res.text()).replace(/^﻿/, '');
  const lines = text.trim().split('\r\n');
  assert.equal(lines[0], 'Time,Type,Method,Amount,Invoice,Table,Share,Reference');
  assert.equal(lines.length, 4, 'header + 3 payments');
  assert.ok(lines.some(l => l.includes('UPIX')));

  const empty = await (await call('/reconciliation/ledger.csv?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z')).text();
  assert.equal(empty.replace(/^﻿/, '').trim().split('\r\n').length, 1);
  assert.equal((await call('/reconciliation/ledger.csv?from=not-a-date')).status, 400);
});
