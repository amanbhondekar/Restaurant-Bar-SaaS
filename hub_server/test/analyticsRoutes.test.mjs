import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// Scheduled summaries and the sales routes (§3 analytics). The store first, on a data directory of its own,
// then a real hub. Every date is built from local constructors so the tests mean the same under any TZ.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reports-'));
process.env.HUB_DATA_DIR = dataDir;
const { ReportStore } = await import('../lib/reportStore.js');
const REPORTS = path.join(dataDir, 'reports.json');

const RID = 'r1';
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const iso = (...a) => at(...a).toISOString();
let n = 0;
const bill = (over = {}) => ({
  id: `inv_${++n}`, restaurant_id: RID, invoice_number: `INV-${n}`, table_name: 'T1',
  issued_at: iso(2026, 10, 20, 13), grand_total: 500, payment_status: 'paid', payment_method: 'cash', paid_at: iso(2026, 10, 20, 13, 10),
  items: [{ name: 'Dal', qty: 5, price: 100, line_total: 500 }], ...over
});
// "Now" is Thursday 22 Oct 2026, mid-morning: the 21st is the last whole day, the week of 12-19 Oct the last whole week.
const NOW = at(2026, 10, 22, 9);
const fresh = () => { fs.rmSync(REPORTS, { force: true }); return new ReportStore(); };
const ensure = (store, invoices, extra = {}) => store.ensure({ invoices, visits: [], restaurantId: RID, now: NOW, ...extra });

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// --- the store -------------------------------------------------------------------------------------------

test('a day that has ended and had business gets a summary; a quiet day and today do not', () => {
  const store = fresh();
  const made = ensure(store, [bill({ issued_at: iso(2026, 10, 20, 13), paid_at: iso(2026, 10, 20, 13, 10) }), bill({ issued_at: iso(2026, 10, 22, 8), paid_at: iso(2026, 10, 22, 8, 5) })]);
  const days = store.list(RID).filter(s => s.kind === 'day').map(s => s.key);
  assert.deepEqual(days, ['2026-10-20'], 'the 21st was quiet, the 22nd is not over');
  assert.ok(made >= 1);
});

test('preparing is idempotent: a timer, a restart and opening the screen make nothing twice', () => {
  const store = fresh();
  const invoices = [bill()];
  assert.ok(ensure(store, invoices) > 0);
  assert.equal(ensure(store, invoices), 0);
  assert.equal(ensure(new ReportStore(), invoices), 0, 'a new process reading the same file');
});

test('a day with only a refund is a day with business: the ledger names it refund_at', () => {
  const store = fresh();
  // Sold the day before; refunded on the 21st. The 21st has no bill but money went out.
  ensure(store, [bill({ issued_at: iso(2026, 10, 19, 13), paid_at: iso(2026, 10, 19, 13, 10), payment_status: 'refunded', refund_at: iso(2026, 10, 21, 11) })]);
  const day = store.list(RID).find(s => s.key === '2026-10-21');
  assert.ok(day, 'the refund day was summarised');
  assert.match(day.text, /Refunded: ₹500/);
});

test('a finished Monday-to-Monday week gets a weekly summary naming its range', () => {
  const store = fresh();
  ensure(store, [bill({ issued_at: iso(2026, 10, 14, 13), paid_at: iso(2026, 10, 14, 13, 10) })]);
  const weeks = store.list(RID).filter(s => s.kind === 'week');
  assert.deepEqual(weeks.map(s => s.key), ['2026-10-12']);
  assert.equal(weeks[0].from, at(2026, 10, 12, 0).toISOString());
  assert.equal(weeks[0].to, at(2026, 10, 19, 0).toISOString());
  assert.match(weeks[0].title, /^Weekly summary/);
  assert.match(weeks[0].text, /Takings: ₹500/);
});

test('a summary is frozen: a refund made after it was written does not rewrite it', () => {
  const store = fresh();
  const sale = bill({ issued_at: iso(2026, 10, 20, 13), paid_at: iso(2026, 10, 20, 13, 10) });
  ensure(store, [sale]);
  const before = store.list(RID).find(s => s.key === '2026-10-20').text;
  assert.match(before, /Takings: ₹500/);

  ensure(store, [{ ...sale, payment_status: 'refunded', refund_at: iso(2026, 10, 21, 18) }]);
  assert.equal(store.list(RID).find(s => s.key === '2026-10-20').text, before);
});

test('a hub switched on after a long quiet spell does not write months of summaries', () => {
  const store = fresh();
  ensure(store, [bill({ issued_at: iso(2026, 8, 1, 13), paid_at: iso(2026, 8, 1, 13, 10) })]);
  assert.deepEqual(store.list(RID), [], 'August is further back than the catch-up reaches, and nothing since');

  const busy = Array.from({ length: 30 }, (_, i) => bill({ issued_at: iso(2026, 9, 20 + (i % 30 > 9 ? 0 : i), 13), paid_at: iso(2026, 9, 20 + (i % 30 > 9 ? 0 : i), 13, 5) }));
  const store2 = fresh();
  ensure(store2, [...busy, bill({ issued_at: iso(2026, 10, 21, 13), paid_at: iso(2026, 10, 21, 13, 5) })]);
  const days = store2.list(RID).filter(s => s.kind === 'day');
  assert.ok(days.length <= 14, `at most a fortnight of days (${days.length})`);
  assert.ok(days.every(s => s.key >= '2026-10-08'), 'none older than 14 days');
});

test('another restaurant\'s bills are never summarised', () => {
  const store = fresh();
  ensure(store, [bill({ restaurant_id: 'other' })]);
  assert.deepEqual(store.list(RID), []);
  assert.deepEqual(store.list('other'), []);
});

test('the owner\'s number is normalised, kept across a restart, and removable; nonsense is refused', () => {
  const store = fresh();
  assert.equal(store.contactFor(RID), null);
  assert.deepEqual(store.setContact(RID, 'abc').code, 'INVALID_PHONE');
  assert.equal(store.contactFor(RID), null, 'a refusal changes nothing');

  const set = store.setContact(RID, '98765 43210');
  assert.equal(set.ok, true);
  assert.equal(set.phone, '919876543210');
  assert.equal(new ReportStore().contactFor(RID), '919876543210', 'persisted');

  assert.deepEqual(store.setContact(RID, ''), { ok: true, phone: null });
  assert.equal(new ReportStore().contactFor(RID), null);
});

test('each summary carries a WhatsApp link: to the owner when a number is set, to a chooser when not', () => {
  const store = fresh();
  ensure(store, [bill()]);
  const open = store.list(RID)[0];
  assert.match(open.whatsapp, /^https:\/\/wa\.me\/\?text=/, 'no number: the person chooses who');

  store.setContact(RID, '9876543210');
  const aimed = store.list(RID)[0];
  assert.match(aimed.whatsapp, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.ok(decodeURIComponent(aimed.whatsapp).includes('Takings: ₹500'), 'the text is in the link');
});

test('newest first, and a week lists above the day that ends it', () => {
  const store = fresh();
  // Monday the 12th starts both a day and a week; the 14th is a day within that week.
  ensure(store, [bill({ issued_at: iso(2026, 10, 12, 13), paid_at: iso(2026, 10, 12, 13, 5) }), bill({ issued_at: iso(2026, 10, 14, 13), paid_at: iso(2026, 10, 14, 13, 5) })]);
  assert.deepEqual(store.list(RID).map(s => `${s.kind}:${s.key}`), ['day:2026-10-14', 'week:2026-10-12', 'day:2026-10-12']);
});

test('marking sent stamps it once; the first time stands; another restaurant\'s summary cannot be marked', () => {
  const store = fresh();
  ensure(store, [bill()]);
  const id = store.list(RID)[0].id;
  assert.equal(store.list(RID)[0].sent_at, null);

  const first = store.markSent(RID, id, new Date('2026-10-22T09:00:00Z'));
  assert.equal(first.summary.sent_at, '2026-10-22T09:00:00.000Z');
  const again = store.markSent(RID, id, new Date('2026-10-23T09:00:00Z'));
  assert.equal(again.summary.sent_at, '2026-10-22T09:00:00.000Z');
  assert.equal(new ReportStore().list(RID)[0].sent_at, '2026-10-22T09:00:00.000Z', 'persisted');

  assert.equal(store.markSent('other', id).code, 'NOT_FOUND');
  assert.equal(store.markSent(RID, 'day:nope').code, 'NOT_FOUND');
});

test('a damaged reports file starts empty rather than stopping the hub', () => {
  fs.writeFileSync(REPORTS, '{ not json');
  assert.deepEqual(new ReportStore().list(RID), []);
  fs.writeFileSync(REPORTS, JSON.stringify([1, 2]));
  assert.deepEqual(new ReportStore().list(RID), []);
  fs.writeFileSync(REPORTS, JSON.stringify({ summaries: [null, { id: 'x' }, 7], contacts: 'no' }));
  const s = new ReportStore();
  assert.deepEqual(s.list(RID), []);
  assert.equal(s.contactFor(RID), null);
});

// --- a real hub ------------------------------------------------------------------------------------------

const MENU = [{ id: 'tea', name: 'Chai', price: 40, station: 'bar', category: 'Drinks', is_available: true }];
const TABLES = [{ id: 1, name: 'T1', capacity: 4, restaurant_id: RESTAURANT_ID }];
const ago = (days, h = 13) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const hubBill = (id, days, total, over = {}) => ({
  id, restaurant_id: RESTAURANT_ID, invoice_number: id, table_name: 'T1', issued_at: ago(days), paid_at: ago(days, 14),
  grand_total: total, payment_status: 'paid', payment_method: 'cash', items: [{ name: 'Chai', qty: total / 40, price: 40, line_total: total }], ...over
});

let hub; let remote;
before(async () => {
  const files = { 'invoices.json': [hubBill('b_yesterday', 1, 400), hubBill('b_two', 2, 200), hubBill('b_old', 20, 800)] };
  hub = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES, enrollmentCode: 'SALESCODE', files });
  remote = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES, enrollmentCode: 'SALESREMOTE', files });
});
after(() => { hub?.stop(); remote?.stop(); });
const json = r => r.json();

test('hub: /admin/sales answers a preset period with the figures, the comparison, guests and cohorts', async () => {
  const res = await call(hub, '/admin/sales?period=month');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.success, true);
  assert.deepEqual(body.periods, ['today', 'week', 'month', 'custom']);
  assert.equal(body.period.preset, 'month');
  for (const key of ['current', 'previous', 'comparison', 'guests', 'cohorts', 'currency']) assert.ok(key in body, key);
  assert.equal(typeof body.current.takings.net, 'number');
  assert.equal(body.current.by_hour.length, 24);
});

test('hub: every preset period says what it is set against, because the screen prints it', async () => {
  for (const period of ['today', 'week', 'month']) {
    const body = await json(await call(hub, `/admin/sales?period=${period}`));
    assert.match(body.period.label, /so far$/, period);
    assert.match(body.period.previous_label, /so far$/, period);
  }
});

test('hub: with no period it is today; a custom range is honoured; a bad one is refused with the reason', async () => {
  assert.equal((await json(await call(hub, '/admin/sales'))).period.preset, 'today');

  const from = ago(5, 0); const to = ago(0, 0);
  const custom = await json(await call(hub, `/admin/sales?period=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
  assert.equal(custom.period.preset, 'custom');
  assert.equal(custom.current.takings.net, 600, 'yesterday 400 + two days ago 200; the bill from 20 days ago is outside');

  const bad = await call(hub, '/admin/sales?period=custom&from=nonsense&to=also');
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'INVALID_RANGE');
  const unknown = await call(hub, '/admin/sales?period=fortnight');
  assert.equal(unknown.status, 400);
  assert.equal((await json(unknown)).code, 'INVALID_PERIOD');
});

test('hub: /admin/reports prepares summaries on the way in, and the contact and sent routes work', async () => {
  const list = await json(await call(hub, '/admin/reports'));
  assert.equal(list.success, true);
  assert.equal(list.contact, null);
  const days = list.summaries.filter(s => s.kind === 'day');
  assert.equal(days.length, 2, 'yesterday and the day before; the bill from twenty days ago is past the catch-up reach');
  assert.ok(days.every(s => s.sent_at === null && /^https:\/\/wa\.me\//.test(s.whatsapp)));

  const put = await call(hub, '/admin/reports/contact', { method: 'PUT', body: { phone: '9876543210' } });
  assert.equal(put.status, 200);
  assert.equal((await json(put)).contact, '919876543210');
  const aimed = await json(await call(hub, '/admin/reports'));
  assert.equal(aimed.contact, '919876543210');
  assert.match(aimed.summaries[0].whatsapp, /^https:\/\/wa\.me\/919876543210\?text=/);

  const bad = await call(hub, '/admin/reports/contact', { method: 'PUT', body: { phone: 'abc' } });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'INVALID_PHONE');

  const sent = await call(hub, `/admin/reports/${encodeURIComponent(aimed.summaries[0].id)}/sent`, { method: 'POST' });
  assert.equal(sent.status, 200);
  assert.ok((await json(sent)).sent_at);
  assert.ok((await json(await call(hub, '/admin/reports'))).summaries[0].sent_at);

  assert.equal((await call(hub, '/admin/reports/day%3Anope/sent', { method: 'POST' })).status, 404);
});

test('hub: the revenue is reception\'s alone -- a handset, a screen at the pass, and a stranger are all refused', async () => {
  const enrol = async scope => (await json(await call(remote, '/auth/device', { method: 'POST', body: { enrollment_code: 'SALESREMOTE', device_label: scope, ...(scope === 'kitchen' ? { scope } : {}) } }))).device_token;
  const handset = await enrol('handset');
  const screen = await enrol('kitchen');

  const routes = [['GET', '/admin/sales'], ['GET', '/admin/reports'], ['PUT', '/admin/reports/contact'], ['POST', '/admin/reports/day%3A2026-10-01/sent']];
  for (const [method, p] of routes) {
    for (const [who, token] of [['handset', handset], ['screen', screen], ['stranger', undefined]]) {
      const res = await call(remote, p, { method, token, body: method === 'GET' ? undefined : {} });
      assert.ok([401, 403].includes(res.status), `${who} on ${method} ${p} got ${res.status}`);
      assert.equal((await json(res)).success, false);
    }
  }
});
