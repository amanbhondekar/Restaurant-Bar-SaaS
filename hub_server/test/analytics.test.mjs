import test from 'node:test';
import assert from 'node:assert/strict';

import { windowFor, salesFor, compare, delta, guestCohorts, monthlyCohorts, salesReport, summaryText, changeWords, dayKey } from '../lib/analytics.js';
import { paymentEvents, summarize } from '../lib/reconciliation.js';

// Sales analytics from the bill ledger. Everything is in the restaurant's LOCAL time, so every date here is
// built with local constructors and the tests mean the same under any TZ.

const RID = 'r1';
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const iso = (...a) => at(...a).toISOString();

// --- windows ---------------------------------------------------------------------------------------------

test('today so far is set against yesterday UP TO THE SAME TIME, never against all of yesterday', () => {
  const w = windowFor('today', at(2026, 10, 22, 14, 30));
  assert.deepEqual([w.ok, w.preset, w.label], [true, 'today', 'Today so far']);
  assert.equal(w.from.getTime(), at(2026, 10, 22, 0).getTime());
  assert.equal(w.to.getTime(), at(2026, 10, 22, 14, 30).getTime());
  assert.equal(w.previous.from.getTime(), at(2026, 10, 21, 0).getTime());
  assert.equal(w.previous.to.getTime(), at(2026, 10, 21, 14, 30).getTime(), 'half a day against half a day');
});

test('a week starts on Monday, and is compared with last week up to the same point', () => {
  const wed = windowFor('week', at(2026, 10, 21, 9));          // Wednesday
  assert.equal(dayKey(wed.from), '2026-10-19');
  assert.equal(dayKey(wed.previous.from), '2026-10-12');
  assert.equal(wed.previous.to.getTime(), at(2026, 10, 14, 9).getTime());

  assert.equal(dayKey(windowFor('week', at(2026, 10, 25, 9)).from), '2026-10-19', 'Sunday belongs to the week that began the Monday before');
  assert.equal(dayKey(windowFor('week', at(2026, 10, 19, 9)).from), '2026-10-19', 'on a Monday the week has just begun');
});

test('a month is compared with last month up to the same day, and a short month clips rather than spilling over', () => {
  const m = windowFor('month', at(2026, 10, 22, 10));
  assert.equal(dayKey(m.from), '2026-10-01');
  assert.equal(dayKey(m.previous.from), '2026-09-01');
  assert.equal(m.previous.to.getTime(), at(2026, 9, 22, 10).getTime());

  assert.equal(dayKey(windowFor('month', at(2026, 3, 31, 10)).previous.to), '2026-02-28', '31 March -> 28 February, not 3 March');
  assert.equal(dayKey(windowFor('month', at(2028, 3, 31, 10)).previous.to), '2028-02-29', 'and 29 in a leap year');
  assert.equal(dayKey(windowFor('month', at(2026, 1, 15, 10)).previous.from), '2025-12-01', 'January looks back to December of the year before');
});

test('a custom period is compared with the one of the same length just before it', () => {
  const w = windowFor('custom', new Date(), { from: iso(2026, 10, 10, 0), to: iso(2026, 10, 15, 0) });
  assert.equal(w.ok, true);
  assert.equal(w.previous.to.getTime(), at(2026, 10, 10, 0).getTime());
  assert.equal(w.previous.from.getTime(), at(2026, 10, 5, 0).getTime());
  assert.equal(w.previous_label, 'the period before');
});

test('every period says what it is set against: the screen and the summaries read this wording', () => {
  // Found in a browser, not by a test: the preset table called it `previous`, the report read `previous_label`,
  // and the real comparison window then overwrote the text -- "set against ." and "up 5% on undefined".
  for (const preset of ['today', 'week', 'month', 'custom']) {
    const w = windowFor(preset, at(2026, 10, 22, 14), { from: iso(2026, 10, 10, 0), to: iso(2026, 10, 15, 0) });
    assert.equal(typeof w.label, 'string', preset);
    assert.ok(w.label.length > 0, `${preset} has a label`);
    assert.equal(typeof w.previous_label, 'string', preset);
    assert.ok(w.previous_label.length > 0, `${preset} says what it is set against`);
    assert.ok(w.previous.from instanceof Date && w.previous.to instanceof Date, `${preset} still has its comparison window`);
  }
  assert.equal(windowFor('today', at(2026, 10, 22, 14)).previous_label, 'yesterday so far');
});

test('a summary made from any period never says "undefined"', () => {
  for (const preset of ['today', 'week', 'month']) {
    const w = windowFor(preset, at(2026, 10, 22, 14));
    const text = summaryText(salesReport({ invoices: [paid({ issued_at: iso(2026, 10, 22, 9), paid_at: iso(2026, 10, 22, 9, 5) }), paid({ issued_at: iso(2026, 10, 21, 9), paid_at: iso(2026, 10, 21, 9, 5), grand_total: 100 })], visits: [], restaurantId: RID, window: w }), { title: 'T' });
    assert.doesNotMatch(text, /undefined|null|NaN/, preset);
  }
});

test('a custom period that makes no sense is refused with the reason', () => {
  const bad = (custom, code) => assert.deepEqual(windowFor('custom', new Date(), custom).code, code);
  bad({}, 'INVALID_RANGE');
  bad({ from: 'nonsense', to: iso(2026, 10, 15) }, 'INVALID_RANGE');
  bad({ from: iso(2026, 10, 15), to: iso(2026, 10, 10) }, 'INVALID_RANGE');
  bad({ from: iso(2026, 10, 15), to: iso(2026, 10, 15) }, 'INVALID_RANGE');
  bad({ from: iso(2024, 1, 1), to: iso(2026, 1, 1) }, 'INVALID_RANGE');
  assert.equal(windowFor('fortnight', new Date()).code, 'INVALID_PERIOD');
});

// --- sales -----------------------------------------------------------------------------------------------

let n = 0;
/** A bill as the ledger holds it. */
const bill = (over = {}) => ({
  id: `inv_${++n}`, restaurant_id: RID, invoice_number: `INV-${n}`, table_name: 'T1',
  issued_at: iso(2026, 10, 21, 13), grand_total: 200, payment_status: 'pending',
  items: [{ name: 'Dal', qty: 2, price: 100, line_total: 200 }], ...over
});
const paid = (over = {}) => bill({ payment_status: 'paid', payment_method: 'cash', paid_at: iso(2026, 10, 21, 13, 10), ...over });
const DAY = { from: at(2026, 10, 21, 0), to: at(2026, 10, 22, 0) };

test('takings are exactly what the cash screen calls takings: payments less refunds, by method', () => {
  const invoices = [
    paid({ grand_total: 500, payment_method: 'cash' }),
    paid({ grand_total: 300, payment_method: 'upi' }),
    paid({ grand_total: 200, payment_method: 'cash', payment_status: 'refunded', refund_at: iso(2026, 10, 21, 15) })
  ];
  const s = salesFor(invoices, RID, DAY);
  assert.deepEqual([s.takings.payments, s.takings.refunds, s.takings.net], [1000, 200, 800]);
  assert.deepEqual([s.takings.by_method.cash, s.takings.by_method.upi], [500, 300]);
  // The very same definition, not a second one that can drift.
  const ledger = summarize(paymentEvents(invoices, RID), { fromMs: DAY.from.getTime(), toMs: DAY.to.getTime() });
  assert.equal(s.takings.net, ledger.totals.net);
});

test('a refund belongs to the day it happened, not the day of the sale', () => {
  const invoices = [paid({ grand_total: 400, payment_status: 'refunded', refund_at: iso(2026, 10, 22, 11) })];
  assert.deepEqual([salesFor(invoices, RID, DAY).takings.payments, salesFor(invoices, RID, DAY).takings.refunds], [400, 0]);
  const next = { from: at(2026, 10, 22, 0), to: at(2026, 10, 23, 0) };
  assert.deepEqual([salesFor(invoices, RID, next).takings.payments, salesFor(invoices, RID, next).takings.refunds], [0, 400]);
});

test('a bill raised late and paid after midnight is one bill on one day and takings on the next', () => {
  const invoices = [paid({ issued_at: iso(2026, 10, 21, 23, 50), paid_at: iso(2026, 10, 22, 0, 10), grand_total: 600 })];
  const d1 = salesFor(invoices, RID, DAY);
  const d2 = salesFor(invoices, RID, { from: at(2026, 10, 22, 0), to: at(2026, 10, 23, 0) });
  assert.deepEqual([d1.bills.count, d1.takings.net], [1, 0]);
  assert.deepEqual([d2.bills.count, d2.takings.net], [0, 600]);
});

test('bills are what was RAISED: unpaid ones count, voided ones do not, and the average is of those', () => {
  const invoices = [bill({ grand_total: 100 }), paid({ grand_total: 300 }), bill({ grand_total: 900, payment_status: 'voided', voided_at: iso(2026, 10, 21, 14) })];
  const s = salesFor(invoices, RID, DAY);
  assert.deepEqual([s.bills.count, s.bills.billed, s.bills.average], [2, 400, 200]);
  assert.deepEqual([s.voided.count, s.voided.total], [1, 900]);
});

test('with no bills the average is nothing, not zero', () => {
  const s = salesFor([], RID, DAY);
  assert.deepEqual([s.bills.count, s.bills.average, s.takings.net, s.busiest_hour, s.top_dishes], [0, null, 0, null, []]);
});

test('a void is counted on the day it happened, even if the bill was raised on another', () => {
  const invoices = [bill({ issued_at: iso(2026, 10, 20, 20), payment_status: 'voided', voided_at: iso(2026, 10, 21, 10), grand_total: 250 })];
  assert.deepEqual([salesFor(invoices, RID, DAY).voided.count, salesFor(invoices, RID, DAY).bills.count], [1, 0]);
});

test('the window is half-open: a bill at the start counts, one at the very end belongs to the next period', () => {
  const edge = [bill({ issued_at: DAY.from.toISOString() }), bill({ issued_at: DAY.to.toISOString() })];
  assert.equal(salesFor(edge, RID, DAY).bills.count, 1);
});

test('another restaurant\'s bills never count', () => {
  const invoices = [paid({ grand_total: 500 }), paid({ grand_total: 9999, restaurant_id: 'someone-else' })];
  const s = salesFor(invoices, RID, DAY);
  assert.deepEqual([s.takings.net, s.bills.count], [500, 1]);
});

test('a split bill is takings share by share, and one bill', () => {
  const invoices = [bill({
    grand_total: 600, payment_status: 'paid', payment_method: 'split',
    splits: [
      { index: 0, share_amount: 300, payment_status: 'paid', payment_method: 'cash', paid_at: iso(2026, 10, 21, 14) },
      { index: 1, share_amount: 300, payment_status: 'paid', payment_method: 'upi', paid_at: iso(2026, 10, 21, 14, 5) }
    ]
  })];
  const s = salesFor(invoices, RID, DAY);
  assert.deepEqual([s.bills.count, s.takings.net, s.takings.by_method.cash, s.takings.by_method.upi], [1, 600, 300, 300]);
});

test('dishes are added up across bills and ranked by revenue, then quantity, then name', () => {
  const line = (name, qty, line_total) => ({ name, qty, price: line_total / qty, line_total });
  const invoices = [
    bill({ items: [line('Dal', 2, 200), line('Naan', 6, 180)] }),
    bill({ items: [line('Dal', 1, 100), line('Biryani', 1, 300)] }),
    bill({ items: [line('Chai', 3, 90), line('Ale', 3, 90), line('Lassi', 1, 20)] })
  ];
  const s = salesFor(invoices, RID, DAY);
  assert.deepEqual(s.top_dishes.map(d => [d.name, d.qty, d.revenue]), [['Dal', 3, 300], ['Biryani', 1, 300], ['Naan', 6, 180], ['Ale', 3, 90], ['Chai', 3, 90]]);   // equal revenue: more portions first; equal both: by name
  assert.equal(s.dish_count, 6, 'the count is of all of them, the list is the top five');
});

test('a line with no total is worked out from quantity and price, and one with no name is skipped', () => {
  const invoices = [bill({ items: [{ name: 'Tea', qty: 2, price: 20 }, { name: '  ', qty: 1, line_total: 50 }, null] })];
  assert.deepEqual(salesFor(invoices, RID, DAY).top_dishes.map(d => [d.name, d.revenue]), [['Tea', 40]]);
});

test('hours are the restaurant\'s own, and the busiest is the one with most bills', () => {
  const invoices = [13, 13, 13, 20, 20].map(h => bill({ issued_at: iso(2026, 10, 21, h, 30), grand_total: 100 }));
  const s = salesFor(invoices, RID, DAY);
  assert.deepEqual([s.by_hour[13].bills, s.by_hour[20].bills, s.by_hour[13].billed, s.busiest_hour, s.by_hour.length], [3, 2, 300, 13, 24]);
});

// --- comparison ------------------------------------------------------------------------------------------

test('a change is up, down, the same, or NEW when there was nothing to divide by', () => {
  assert.deepEqual(delta(120, 100), { current: 120, previous: 100, change: 20, pct: 20, direction: 'up' });
  assert.deepEqual(delta(75, 100), { current: 75, previous: 100, change: -25, pct: -25, direction: 'down' });
  assert.equal(delta(100, 100).direction, 'same');
  assert.deepEqual([delta(50, 0).direction, delta(50, 0).pct], ['new', null], 'a percentage of nothing is not 100%, it is not a number');
  assert.equal(delta(0, 0).direction, 'same');
});

test('percentages are to one decimal place', () => {
  assert.equal(delta(1000, 3000).pct, -66.7);
  assert.equal(delta(1001, 1000).pct, 0.1);
});

test('a figure that does not exist yet (no bills, so no average) is unknown, never a fall to zero', () => {
  assert.equal(delta(null, 200).direction, 'unknown');
  assert.equal(delta(200, null).direction, 'unknown');
  assert.equal(delta(undefined, undefined).change, null);
});

test('a comparison covers takings, bills, average bill, refunds and voids', () => {
  const k = compare(salesFor([paid({ grand_total: 600 })], RID, DAY), salesFor([], RID, DAY));
  assert.deepEqual(Object.keys(k).sort(), ['average_bill', 'bills', 'net', 'refunds', 'voided']);
  assert.deepEqual([k.net.direction, k.bills.direction, k.average_bill.direction, k.refunds.direction], ['new', 'new', 'unknown', 'same']);
});

// --- guests ----------------------------------------------------------------------------------------------

const visit = (key, ...when) => ({ phone_key: key, at: iso(...when) });
const WIN = { from: at(2026, 10, 15, 0), to: at(2026, 10, 22, 0), previous: { from: at(2026, 10, 8, 0), to: at(2026, 10, 15, 0) } };

test('a guest is NEW if their first visit ever is in the window, RETURNING if they had been before', () => {
  const g = guestCohorts([visit('a', 2026, 9, 1), visit('a', 2026, 10, 16), visit('b', 2026, 10, 17), visit('c', 2026, 10, 18)], WIN);
  assert.deepEqual([g.guests, g.new, g.returning], [3, 2, 1]);
});

test('a guest who came three times is one guest', () => {
  const g = guestCohorts([visit('a', 2026, 10, 16), visit('a', 2026, 10, 17), visit('a', 2026, 10, 18)], WIN);
  assert.deepEqual([g.guests, g.new, g.returning], [1, 1, 0]);
});

test('retention: of the guests who were new LAST period, how many came again this one', () => {
  const g = guestCohorts([
    visit('a', 2026, 10, 9), visit('a', 2026, 10, 16),     // new last period, came back
    visit('b', 2026, 10, 10),                                // new last period, did not
    visit('c', 2026, 10, 11), visit('c', 2026, 10, 20),    // new last period, came back
    visit('d', 2026, 9, 1), visit('d', 2026, 10, 9)        // not new last period: does not count
  ], WIN);
  assert.deepEqual(g.retention, { of: 3, returned: 2, pct: 67 });
  assert.deepEqual(g.previous, { guests: 4, new: 3 });
});

test('with nobody new last period there is no retention to report, not 0%', () => {
  assert.equal(guestCohorts([visit('a', 2026, 10, 16)], WIN).retention, null);
});

test('visits with no guest identity or no readable time are ignored', () => {
  const g = guestCohorts([{ at: iso(2026, 10, 16) }, { phone_key: 'x', at: 'nonsense' }, null, visit('ok', 2026, 10, 16)], WIN);
  assert.equal(g.guests, 1);
  assert.deepEqual(guestCohorts(undefined, WIN).guests, 0);
});

test('cohorts by month: guests by month of first visit, and how many came back on a LATER day', () => {
  const rows = monthlyCohorts([
    visit('a', 2026, 8, 5), visit('a', 2026, 9, 5),            // August, came back
    visit('b', 2026, 8, 6),                                      // August, did not
    visit('c', 2026, 8, 7, 18), visit('c', 2026, 8, 7, 21),    // August, same evening twice: ONE visit, not a return
    visit('d', 2026, 10, 2)                                      // October
  ], at(2026, 10, 22), 6);
  assert.deepEqual(rows, [
    { month: '2026-10', guests: 1, returned: 0, returned_pct: 0 },
    { month: '2026-08', guests: 3, returned: 1, returned_pct: 33 }
  ]);
});

test('cohorts only look back as far as asked, newest month first', () => {
  const old = [visit('x', 2025, 1, 5), visit('x', 2025, 2, 5)];
  assert.deepEqual(monthlyCohorts(old, at(2026, 10, 22), 6), []);
  assert.equal(monthlyCohorts([...old, visit('y', 2026, 9, 1)], at(2026, 10, 22), 6).length, 1);
  assert.deepEqual(monthlyCohorts([], at(2026, 10, 22)), []);
});

// --- the words -------------------------------------------------------------------------------------------

test('a change in words: direction and size, or why there is no size', () => {
  assert.equal(changeWords(delta(120, 100)), 'up 20%');
  assert.equal(changeWords(delta(75, 100)), 'down 25%');
  assert.equal(changeWords(delta(100, 100)), 'the same');
  assert.equal(changeWords(delta(5, 0)), 'new: nothing to compare with');
  assert.equal(changeWords(delta(null, 5)), '');
  assert.equal(changeWords(undefined), '');
});

function reportFor(invoices, visits = []) {
  return salesReport({ invoices, visits, restaurantId: RID, window: { ...windowFor('custom', new Date(), { from: DAY.from.toISOString(), to: DAY.to.toISOString() }), preset: 'day', label: 'Daily summary', previous_label: 'the day before' } });
}

test('a summary reads as a message: takings and how they compare, bills, voids, best sellers, the busiest hour', () => {
  const invoices = [
    paid({ grand_total: 800, issued_at: iso(2026, 10, 21, 20), paid_at: iso(2026, 10, 21, 20, 20), items: [{ name: 'Biryani', qty: 2, price: 400, line_total: 800 }] }),
    paid({ grand_total: 400, issued_at: iso(2026, 10, 20, 20), paid_at: iso(2026, 10, 20, 20, 20) }),                      // the day before
    bill({ grand_total: 150, payment_status: 'voided', voided_at: iso(2026, 10, 21, 22) })
  ];
  const text = summaryText(reportFor(invoices), { title: 'Daily summary — Wed 21 Oct' });
  assert.equal(text.split('\n')[0], 'Daily summary — Wed 21 Oct');
  assert.match(text, /Takings: ₹800 \(up 100% on the day before\)/);
  assert.match(text, /Bills: 1 · average ₹800 \(the same on the day before\)/);   // the voided bill is not a bill; yesterday also had one
  assert.match(text, /Voided: 1 bill \(₹150\)/);
  assert.match(text, /Best sellers: Biryani ×2/);
  assert.match(text, /Busiest hour: 8pm/);
});

test('a summary leaves out what it has nothing to say about, and invents no comparison', () => {
  const text = summaryText(reportFor([paid({ grand_total: 300 })]), { title: 'T' });
  assert.doesNotMatch(text, /Voided|Refunded|Guests seated/);
  assert.match(text, /Takings: ₹300 \(new: nothing to compare with on the day before\)/);
});

test('refunds appear when there were some, and voids are singular or plural', () => {
  const text = summaryText(reportFor([
    paid({ grand_total: 500, payment_status: 'refunded', refund_at: iso(2026, 10, 21, 16) }),
    bill({ payment_status: 'voided', voided_at: iso(2026, 10, 21, 17) }), bill({ payment_status: 'voided', voided_at: iso(2026, 10, 21, 18) })
  ]), { title: 'T' });
  assert.match(text, /Refunded: ₹500/);
  assert.match(text, /Voided: 2 bills/);
});

test('midnight and noon are said as 12am and 12pm, not 0am', () => {
  const at12 = summaryText(reportFor([bill({ issued_at: iso(2026, 10, 21, 12, 30) })]), { title: 'T' });
  const at0 = summaryText(reportFor([bill({ issued_at: iso(2026, 10, 21, 0, 30) })]), { title: 'T' });
  assert.match(at12, /Busiest hour: 12pm/);
  assert.match(at0, /Busiest hour: 12am/);
});

test('guests seated are reported only when there were some', () => {
  const visits = [visit('a', 2026, 10, 21, 19), visit('b', 2026, 10, 21, 20), visit('a', 2026, 10, 1, 19)];
  assert.match(summaryText(reportFor([paid()], visits), { title: 'T' }), /Guests seated: 2 \(1 new, 1 returning\)/);
});
