import { paymentEvents, summarize, round2 } from './reconciliation.js';

// Sales analytics from the bill ledger (§3 analytics). Pure functions: no I/O, and the clock is a parameter.
//
// Everything here is derived from the invoices the cash screen already trusts, through the same payment
// events, so the figures cannot drift from what reception reconciles at close. Days, weeks and months are the
// RESTAURANT'S: the hub runs on the reception laptop, in the restaurant's own timezone, which is the only
// sense in which "today" means anything to the person reading it.
//
// A comparison is always like for like. "Today so far" is set against "yesterday up to the same time", never
// against all of yesterday: comparing half a day with a whole one makes every morning look like a collapse.

const MIN = 60 * 1000;
const pad = n => String(n).padStart(2, '0');
const parse = v => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

// --- windows --------------------------------------------------------------------------------------------

/** Local midnight at the start of `d`'s day. */
export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Local calendar date as "YYYY-MM-DD". */
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const sameClock = (day, like) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), like.getHours(), like.getMinutes(), like.getSeconds(), like.getMilliseconds());

/** The same moment one month earlier, clipped to the month's end (31 March -> 28 February, not 3 March). */
function monthBack(d) {
  const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
  const m = d.getMonth() === 0 ? 11 : d.getMonth() - 1;
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(d.getDate(), last), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

const PRESETS = {
  // `previous_label` is spelt out in full: it is read straight into "up 12% on <this>" and "set against <this>".
  // (It was once called `previous`, which the real comparison window then overwrote.)
  today: { label: 'Today so far', previous_label: 'yesterday so far' },
  week: { label: 'This week so far', previous_label: 'last week so far' },
  month: { label: 'This month so far', previous_label: 'last month so far' }
};
export const PRESET_IDS = Object.keys(PRESETS);

/**
 * A reporting window and the window it is compared with. `custom` takes `{ from, to }`; the one before it is
 * the same length, ending where this one starts.
 */
export function windowFor(preset, now = new Date(), custom = {}) {
  if (preset === 'custom') {
    const from = new Date(custom.from);
    const to = new Date(custom.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { ok: false, code: 'INVALID_RANGE', error: 'Give a start and an end date.' };
    if (!(to > from)) return { ok: false, code: 'INVALID_RANGE', error: 'The end must be after the start.' };
    if (to - from > 366 * 24 * 60 * MIN) return { ok: false, code: 'INVALID_RANGE', error: 'A period can be at most a year.' };
    const span = to - from;
    return { ok: true, preset, label: 'Selected period', previous_label: 'the period before', from, to, previous: { from: new Date(from - span), to: from } };
  }
  const spec = PRESETS[preset];
  if (!spec) return { ok: false, code: 'INVALID_PERIOD', error: `Period must be one of ${[...PRESET_IDS, 'custom'].join(', ')}.` };

  const today = startOfDay(now);
  if (preset === 'today') {
    const back = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    return { ok: true, preset, ...spec, from: today, to: now, previous: { from: back, to: sameClock(back, now) } };
  }
  if (preset === 'week') {
    // Monday is the start of a restaurant's week.
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
    const lastMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
    return { ok: true, preset, ...spec, from: monday, to: now, previous: { from: lastMonday, to: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()) } };
  }
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return { ok: true, preset, ...spec, from: first, to: now, previous: { from: monthBack(first), to: monthBack(now) } };
}

// --- sales ----------------------------------------------------------------------------------------------

const inside = (ms, from, to) => ms !== null && ms >= from.getTime() && ms < to.getTime();

/**
 * What happened in [from, to): money taken, bills issued and their average, bills voided, the dishes that sold
 * and the hours they sold in.
 *
 * `takings` is what was actually paid and refunded in the window, by method -- the cash screen's own
 * definition -- while `bills` counts what was RAISED. They are different questions (a bill raised at 11:50 pm
 * and paid at 12:10 am is one bill on one day and takings on the next), and the screen says which is which.
 */
export function salesFor(invoices, restaurantId, { from, to }) {
  const list = (Array.isArray(invoices) ? invoices : []).filter(i => i && (!restaurantId || i.restaurant_id === restaurantId));
  const summary = summarize(paymentEvents(list, restaurantId), { fromMs: from.getTime(), toMs: to.getTime() });

  const issued = list.filter(i => inside(parse(i.issued_at), from, to));
  const bills = issued.filter(i => i.payment_status !== 'voided');
  const billed = round2(bills.reduce((s, i) => s + (Number(i.grand_total) || 0), 0));
  const voided = list.filter(i => i.payment_status === 'voided' && inside(parse(i.voided_at), from, to));

  const dishes = new Map();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, bills: 0, billed: 0 }));
  for (const bill of bills) {
    const h = hours[new Date(bill.issued_at).getHours()];
    h.bills += 1;
    h.billed = round2(h.billed + (Number(bill.grand_total) || 0));
    for (const line of Array.isArray(bill.items) ? bill.items : []) {
      const name = String(line?.name ?? '').trim();
      if (!name) continue;
      const d = dishes.get(name) ?? { name, qty: 0, revenue: 0 };
      d.qty += Number(line.qty) || 0;
      d.revenue = round2(d.revenue + (Number(line.line_total) || (Number(line.qty) || 0) * (Number(line.price) || 0)));
      dishes.set(name, d);
    }
  }
  const ranked = [...dishes.values()].sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || a.name.localeCompare(b.name));

  return {
    takings: { payments: summary.totals.payments_total, refunds: summary.totals.refunds_total, net: summary.totals.net, by_method: Object.fromEntries(Object.entries(summary.by_method).map(([m, v]) => [m, v.net])) },
    bills: { count: bills.length, billed, average: bills.length ? round2(billed / bills.length) : null },
    voided: { count: voided.length, total: round2(voided.reduce((s, i) => s + (Number(i.grand_total) || 0), 0)) },
    top_dishes: ranked.slice(0, 5),
    dish_count: ranked.length,
    by_hour: hours,
    busiest_hour: hours.reduce((best, h) => (h.bills > best.bills ? h : best), { hour: null, bills: 0 }).hour
  };
}

// --- comparison -----------------------------------------------------------------------------------------

const METRICS = {
  net: r => r.takings.net,
  bills: r => r.bills.count,
  average_bill: r => r.bills.average,
  refunds: r => r.takings.refunds,
  voided: r => r.voided.count
};

/** One metric against the same metric a period earlier. `pct` is null when there is nothing to divide by. */
export function delta(current, previous) {
  if (current === null || previous === null || current === undefined || previous === undefined) {
    return { current: current ?? null, previous: previous ?? null, change: null, pct: null, direction: 'unknown' };
  }
  const change = round2(current - previous);
  if (previous === 0) return { current, previous, change, pct: null, direction: current === 0 ? 'same' : 'new' };
  return { current, previous, change, pct: Math.round((change / previous) * 1000) / 10, direction: change > 0 ? 'up' : change < 0 ? 'down' : 'same' };
}

export const compare = (current, previous) => Object.fromEntries(Object.entries(METRICS).map(([k, pick]) => [k, delta(pick(current), pick(previous))]));

// --- guests ---------------------------------------------------------------------------------------------

/**
 * New against returning guests in a window, and how many of the previous window's new guests came back.
 * `visits` are seated bookings and queue entries (lib/loyalty.js). A guest is NEW if their first visit ever
 * falls in the window, RETURNING if they had been before it.
 */
export function guestCohorts(visits, win) {
  const list = (Array.isArray(visits) ? visits : []).map(v => ({ key: v?.phone_key, ms: parse(v?.at) })).filter(v => v.key && v.ms !== null);
  const first = new Map();
  for (const v of list) if (!first.has(v.key) || v.ms < first.get(v.key)) first.set(v.key, v.ms);

  const guestsIn = (from, to) => new Set(list.filter(v => inside(v.ms, from, to)).map(v => v.key));
  const current = guestsIn(win.from, win.to);
  const newNow = [...current].filter(k => inside(first.get(k), win.from, win.to));

  const before = guestsIn(win.previous.from, win.previous.to);
  const newBefore = [...before].filter(k => inside(first.get(k), win.previous.from, win.previous.to));
  const cameBack = newBefore.filter(k => current.has(k));

  return {
    guests: current.size,
    new: newNow.length,
    returning: current.size - newNow.length,
    previous: { guests: before.size, new: newBefore.length },
    // Of the guests who were new LAST period, how many came again this one. Null with nobody to measure.
    retention: newBefore.length ? { of: newBefore.length, returned: cameBack.length, pct: Math.round((cameBack.length / newBefore.length) * 100) } : null
  };
}

/**
 * Guests grouped by the month of their first visit, and how many have been back since. "Back" means a visit on a
 * LATER DAY: a booking and a walk-in on the same evening are one visit, not a return.
 */
export function monthlyCohorts(visits, now = new Date(), months = 6) {
  const byGuest = new Map();
  for (const v of Array.isArray(visits) ? visits : []) {
    const ms = parse(v?.at);
    if (!v?.phone_key || ms === null) continue;
    (byGuest.get(v.phone_key) ?? byGuest.set(v.phone_key, []).get(v.phone_key)).push(ms);
  }
  const earliest = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1).getTime();
  const rows = new Map();
  for (const times of byGuest.values()) {
    times.sort((a, b) => a - b);
    const firstDay = startOfDay(new Date(times[0]));
    if (times[0] < earliest) continue;
    const key = `${firstDay.getFullYear()}-${pad(firstDay.getMonth() + 1)}`;
    const row = rows.get(key) ?? { month: key, guests: 0, returned: 0 };
    row.guests += 1;
    if (times.some(t => startOfDay(new Date(t)) > firstDay)) row.returned += 1;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map(r => ({ ...r, returned_pct: Math.round((r.returned / r.guests) * 100) }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

// --- the whole report -----------------------------------------------------------------------------------

/** Everything the Sales screen and a summary need, for one window and the one it is compared with. */
export function salesReport({ invoices, visits, restaurantId, window: win }) {
  const current = salesFor(invoices, restaurantId, win);
  const previous = salesFor(invoices, restaurantId, win.previous);
  return {
    period: { preset: win.preset, label: win.label, previous_label: win.previous_label, from: win.from.toISOString(), to: win.to.toISOString(), previous_from: win.previous.from.toISOString(), previous_to: win.previous.to.toISOString() },
    current, previous,
    comparison: compare(current, previous),
    guests: guestCohorts(visits, win)
  };
}

// --- words ----------------------------------------------------------------------------------------------

const rupees = (n, currency = '₹') => `${currency}${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const hourLabel = h => (h === null ? null : `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`);

/** "up 12%", "down 8%", "new" (there was nothing before), "the same", or nothing when it cannot be said. */
export function changeWords(d) {
  if (!d || d.direction === 'unknown') return '';
  if (d.direction === 'same') return 'the same';
  if (d.direction === 'new') return 'new: nothing to compare with';
  return `${d.direction} ${Math.abs(d.pct)}%`;
}

/**
 * The summary as plain text for a message: takings with how it compares, bills, the average, voids and
 * refunds when there were any, the best sellers and the busiest hour. No figure is invented to fill a line.
 */
export function summaryText(report, { title, currency = '₹' } = {}) {
  const { current: c, comparison: k, period } = report;
  const lines = [title || period.label];
  const vs = change => (change ? ` (${change} on ${period.previous_label})` : '');
  lines.push(`Takings: ${rupees(c.takings.net, currency)}${vs(changeWords(k.net))}`);
  lines.push(`Bills: ${c.bills.count}${c.bills.average !== null ? ` · average ${rupees(c.bills.average, currency)}` : ''}${vs(changeWords(k.bills))}`);
  if (c.takings.refunds > 0) lines.push(`Refunded: ${rupees(c.takings.refunds, currency)}`);
  if (c.voided.count > 0) lines.push(`Voided: ${c.voided.count} ${c.voided.count === 1 ? 'bill' : 'bills'} (${rupees(c.voided.total, currency)})`);
  if (c.top_dishes.length) lines.push(`Best sellers: ${c.top_dishes.slice(0, 3).map(d => `${d.name} ×${d.qty}`).join(', ')}`);
  if (c.busiest_hour !== null) lines.push(`Busiest hour: ${hourLabel(c.busiest_hour)}`);
  if (report.guests && report.guests.guests > 0) lines.push(`Guests seated: ${report.guests.guests} (${report.guests.new} new, ${report.guests.returning} returning)`);
  return lines.join('\n');
}
