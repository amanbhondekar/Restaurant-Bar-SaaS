import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_DEFAULTS, reconcileAlerts, isQuietHours, dueNotifications, unattendedAlerts, describeAlert, alertWords, rankAlerts
} from '../../common/alertEngine.js';

// Phase 2 of docs/SUPER_ADMIN_BUILD_SHEET.md, task P2-2, the lifecycle half (§8): conditions that are true now, alerts that are open, and what
// to do about the difference. Pure: the worker reads the database and the clock, and calls these.
//
// What is pinned, to the millisecond and on both sides: when a reminder is due (ten minutes after the last page, not nine minutes fifty-nine
// seconds), how many reminders there are (three, then the alert is flagged), and when the founders are asleep (a P2 never pages overnight; a
// P1 does). Getting any of these wrong either wakes someone for nothing or lets a dead restaurant sit unnoticed.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Tuesday 2026-10-27, 12:00 in India (06:30 UTC).
const NOW = Date.parse('2026-10-27T06:30:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();
const at = iso => Date.parse(iso);

const cond = (rule_key, restaurant_id = 'r-1', over = {}) => ({
  restaurant_id, restaurant_name: restaurant_id === 'r-1' ? 'Hotel Mejwani' : 'Other', rule_key,
  severity: { hub_silent_service: 'P1', orders_shelved: 'P1', hub_silent_long: 'P2', sync_backlog: 'P2', payment_past_due: 'P2', service_hours_missing: 'P3' }[rule_key],
  dedupe_key: `${rule_key}:${restaurant_id}`, detail: {}, ...over
});
let nextId = 1;
const alert = (rule_key = 'hub_silent_service', over = {}) => ({
  id: nextId++, restaurant_id: 'r-1', restaurant_name: 'Hotel Mejwani', rule_key,
  severity: cond(rule_key).severity, dedupe_key: `${rule_key}:r-1`, state: 'open', opened_at: ago(HOUR), acked_at: null,
  escalation_level: 0, last_notified_at: null, unattended_at: null, detail: {}, ...over
});

// --- the defaults ----------------------------------------------------------------------------------------------------------------

test('the defaults are the ones the founders chose: re-notify every ten minutes, three times, and nobody paged for a P2 between 22:00 and 08:00', () => {
  assert.deepEqual(ALERT_DEFAULTS, { escalateAfterMs: 10 * MIN, reminders: 3, quiet: { timeZone: 'Asia/Kolkata', from: '22:00', to: '08:00' } });
});

// --- opening and resolving -------------------------------------------------------------------------------------------------------

test('a condition with no open alert opens one, and a condition that already has one opens nothing more', () => {
  const c = [cond('orders_shelved'), cond('sync_backlog')];
  const plan = reconcileAlerts(c, [alert('orders_shelved')]);
  assert.deepEqual(plan.open.map(x => x.dedupe_key), ['sync_backlog:r-1']);
  assert.deepEqual(plan.resolve, []);
});

test('an alert whose condition has cleared is resolved, whether or not somebody had acknowledged it', () => {
  const open = [alert('orders_shelved'), alert('sync_backlog', { state: 'acked', acked_at: ago(5 * MIN) })];
  const plan = reconcileAlerts([], open);
  assert.deepEqual(plan.resolve.map(r => r.id), open.map(a => a.id));
  assert.ok(plan.resolve.every(r => r.reason === 'condition_cleared'));
  assert.deepEqual(plan.open, []);
});

test('the same rule for two restaurants is two alerts, and one clearing leaves the other', () => {
  const c = [cond('orders_shelved', 'r-1'), cond('orders_shelved', 'r-2')];
  assert.equal(reconcileAlerts(c, []).open.length, 2);
  const a1 = alert('orders_shelved');
  const a2 = alert('orders_shelved', { restaurant_id: 'r-2', dedupe_key: 'orders_shelved:r-2' });
  const plan = reconcileAlerts([cond('orders_shelved', 'r-2')], [a1, a2]);
  assert.deepEqual(plan.resolve.map(r => r.id), [a1.id]);
});

test('a condition repeated in the input opens one alert, not two', () => {
  const plan = reconcileAlerts([cond('orders_shelved'), cond('orders_shelved')], []);
  assert.equal(plan.open.length, 1);
});

test('when the read of the fleet was not complete, nothing is resolved: a truncated list is not a healthy fleet', () => {
  const plan = reconcileAlerts([cond('sync_backlog')], [alert('orders_shelved')], { complete: false });
  assert.deepEqual(plan.resolve, []);
  assert.deepEqual(plan.open.map(x => x.dedupe_key), ['sync_backlog:r-1'], 'though what is certainly true still opens');
});

test('an unknown restaurant\'s alert is still resolved only by its own condition clearing', () => {
  const stray = alert('orders_shelved', { restaurant_id: 'gone', dedupe_key: 'orders_shelved:gone' });
  assert.deepEqual(reconcileAlerts([cond('orders_shelved')], [stray]).resolve.map(r => r.id), [stray.id]);
});

test('an alert that is already resolved does not hold its key: the condition opens a fresh one, and the resolved one is not resolved again', () => {
  const done = alert('orders_shelved', { state: 'resolved' });
  const plan = reconcileAlerts([cond('orders_shelved')], [done]);
  assert.deepEqual(plan.open.map(x => x.dedupe_key), ['orders_shelved:r-1']);
  assert.deepEqual(plan.resolve, []);
  assert.deepEqual(reconcileAlerts([], [done]).resolve, [], 'nor when the condition has cleared');
});

test('reconciling does not change what it is given', () => {
  const c = [cond('orders_shelved')];
  const o = [alert('sync_backlog')];
  const before = JSON.stringify([c, o]);
  reconcileAlerts(c, o);
  assert.equal(JSON.stringify([c, o]), before);
});

// --- quiet hours -----------------------------------------------------------------------------------------------------------------

test('the founders are asleep from 22:00 until 08:00 their time, and awake otherwise, to the millisecond', () => {
  const quiet = iso => isQuietHours(Date.parse(iso), ALERT_DEFAULTS.quiet);
  assert.equal(quiet('2026-10-27T16:29:59.999Z'), false, '21:59:59.999 in India');
  assert.equal(quiet('2026-10-27T16:30:00.000Z'), true, '22:00');
  assert.equal(quiet('2026-10-27T20:30:00.000Z'), true, '02:00 the next day');
  assert.equal(quiet('2026-10-28T02:29:59.999Z'), true, '07:59:59.999');
  assert.equal(quiet('2026-10-28T02:30:00.000Z'), false, '08:00');
  assert.equal(quiet('2026-10-27T06:30:00.000Z'), false, 'midday');
});

test('quiet hours are read in the time zone they are given', () => {
  const q = { timeZone: 'Europe/London', from: '22:00', to: '08:00' };
  assert.equal(isQuietHours(NOW, q), true, '06:30 in London (GMT in late October) is before 08:00, though 12:00 in India is midday');
  assert.equal(isQuietHours(NOW + 90 * MIN, q), false, '08:00 in London');
});

test('a quiet window that does not cross midnight works too', () => {
  const q = { timeZone: 'Asia/Kolkata', from: '13:00', to: '15:00' };
  assert.equal(isQuietHours(NOW, q), false, '12:00');
  assert.equal(isQuietHours(NOW + HOUR, q), true, '13:00');
  assert.equal(isQuietHours(NOW + 3 * HOUR, q), false, '15:00');
});

test('quiet hours that cannot be read are an error, not "never quiet"', () => {
  assert.throws(() => isQuietHours(NOW, { timeZone: 'Not/AZone', from: '22:00', to: '08:00' }), { name: 'RangeError', message: /time zone/ }, 'and an error that says what is wrong');
  assert.throws(() => isQuietHours(NOW, { timeZone: 'Asia/Kolkata', from: '25:00', to: '08:00' }));
  assert.throws(() => isQuietHours(NOW, { timeZone: 'Asia/Kolkata', from: '22:00', to: '22:00' }), 'a window of no length or of all day is a typo');
  assert.throws(() => isQuietHours(NOW, null));
});

// --- who is paged, and when ------------------------------------------------------------------------------------------------------

test('a new P1 alert is paged at once, at normal urgency', () => {
  const a = alert('hub_silent_service');
  const [n, ...rest] = dueNotifications([a], NOW);
  assert.equal(rest.length, 0);
  assert.equal(n.alert_id, a.id);
  assert.equal(n.level, 0);
  assert.equal(n.kind, 'new');
  assert.equal(n.urgency, 'normal');
  assert.equal(n.severity, 'P1');
});

test('after a page the next reminder is due in ten minutes: not at nine minutes fifty-nine seconds, and at ten', () => {
  const sent = ms => alert('hub_silent_service', { escalation_level: 0, last_notified_at: ago(ms) });
  assert.deepEqual(dueNotifications([sent(10 * MIN - 1)], NOW), []);
  const [n] = dueNotifications([sent(10 * MIN)], NOW);
  assert.equal(n.level, 1);
  assert.equal(n.kind, 'reminder');
  assert.equal(n.urgency, 'high', 'a reminder is more urgent than the first page');
});

test('there are three reminders, each ten minutes after the one before, and then no more', () => {
  const lvl = (level, ms) => alert('orders_shelved', { escalation_level: level, last_notified_at: ago(ms) });
  assert.equal(dueNotifications([lvl(1, 10 * MIN)], NOW)[0].level, 2);
  assert.equal(dueNotifications([lvl(2, 10 * MIN)], NOW)[0].level, 3);
  assert.deepEqual(dueNotifications([lvl(3, 10 * MIN)], NOW), [], 'three reminders is all');
  assert.deepEqual(dueNotifications([lvl(3, 5 * HOUR)], NOW), [], 'however long it has been');
});

test('the number of reminders is configurable', () => {
  const a = alert('orders_shelved', { escalation_level: 1, last_notified_at: ago(10 * MIN) });
  assert.deepEqual(dueNotifications([a], NOW, { ...ALERT_DEFAULTS, reminders: 1 }), []);
  assert.equal(dueNotifications([a], NOW, { ...ALERT_DEFAULTS, reminders: 2 })[0].level, 2);
});

test('the gap between reminders is configurable', () => {
  const a = alert('orders_shelved', { escalation_level: 0, last_notified_at: ago(5 * MIN) });
  assert.deepEqual(dueNotifications([a], NOW), []);
  assert.equal(dueNotifications([a], NOW, { ...ALERT_DEFAULTS, escalateAfterMs: 5 * MIN }).length, 1);
});

test('an alert somebody has acknowledged is not paged again, nor reminded', () => {
  assert.deepEqual(dueNotifications([alert('orders_shelved', { state: 'acked', acked_at: ago(MIN) })], NOW), []);
  assert.deepEqual(dueNotifications([alert('orders_shelved', { state: 'acked', escalation_level: 1, last_notified_at: ago(20 * MIN) })], NOW), []);
});

test('a resolved alert is never paged', () => {
  assert.deepEqual(dueNotifications([alert('orders_shelved', { state: 'resolved' })], NOW), []);
});

test('a P3 is shown and never sent', () => {
  assert.deepEqual(dueNotifications([alert('service_hours_missing')], NOW), []);
});

test('an alert of a kind this does not know is not sent: nobody is paged on a guess', () => {
  assert.deepEqual(dueNotifications([alert('orders_shelved', { severity: 'P9' })], NOW), []);
  assert.deepEqual(dueNotifications([alert('orders_shelved', { severity: null })], NOW), []);
});

// --- quiet hours and what they hold back -----------------------------------------------------------------------------------------

const NIGHT = at('2026-10-27T20:30:00.000Z');   // 02:00 in India
const nightAgo = ms => new Date(NIGHT - ms).toISOString();

test('a P2 never pages overnight: it waits, and is paged when the founders wake', () => {
  const a = alert('payment_past_due', { opened_at: nightAgo(HOUR) });
  assert.deepEqual(dueNotifications([a], NIGHT), []);
  const morning = at('2026-10-28T02:30:00.000Z');   // 08:00
  const [n] = dueNotifications([a], morning);
  assert.equal(n.level, 0, 'a first page, not a reminder: nobody has been told');
  assert.equal(n.kind, 'new');
});

test('a P1 pages at any hour', () => {
  const [n] = dueNotifications([alert('hub_silent_service', { opened_at: nightAgo(HOUR) })], NIGHT);
  assert.equal(n.level, 0);
});

test('a P1 reminder is sent overnight too', () => {
  const a = alert('orders_shelved', { escalation_level: 1, last_notified_at: nightAgo(10 * MIN) });
  assert.equal(dueNotifications([a], NIGHT)[0].level, 2);
});

test('a P2 reminder that falls due overnight waits for the morning', () => {
  const a = alert('sync_backlog', { escalation_level: 0, last_notified_at: nightAgo(10 * MIN) });
  assert.deepEqual(dueNotifications([a], NIGHT), []);
  assert.equal(dueNotifications([a], at('2026-10-28T02:30:00.000Z'))[0].level, 1);
});

test('the quiet hours used are the ones in the configuration', () => {
  const a = alert('sync_backlog');
  const never = { ...ALERT_DEFAULTS, quiet: { timeZone: 'Asia/Kolkata', from: '03:00', to: '04:00' } };
  assert.equal(dueNotifications([a], NIGHT, never).length, 1, '02:00 is not quiet in that configuration');
});

// --- the order of the pages ------------------------------------------------------------------------------------------------------

test('what is due comes worst first, then oldest first, so the most urgent page goes out first', () => {
  const p2old = alert('payment_past_due', { opened_at: ago(5 * HOUR) });
  const p1new = alert('orders_shelved', { opened_at: ago(MIN) });
  const p1old = alert('hub_silent_service', { opened_at: ago(2 * HOUR) });
  assert.deepEqual(dueNotifications([p2old, p1new, p1old], NOW).map(n => n.alert_id), [p1old.id, p1new.id, p2old.id]);
});

// --- unattended ------------------------------------------------------------------------------------------------------------------

test('an alert nobody has answered after the last reminder and ten more minutes is flagged unattended', () => {
  const waiting = ms => alert('orders_shelved', { escalation_level: 3, last_notified_at: ago(ms) });
  assert.deepEqual(unattendedAlerts([waiting(10 * MIN - 1)], NOW), []);
  const due = waiting(10 * MIN);
  assert.deepEqual(unattendedAlerts([due], NOW).map(a => a.id), [due.id]);
});

test('it is not flagged while reminders are still to come, once acknowledged, or twice', () => {
  const lvl2 = alert('orders_shelved', { escalation_level: 2, last_notified_at: ago(HOUR) });
  const acked = alert('orders_shelved', { escalation_level: 3, state: 'acked', last_notified_at: ago(HOUR) });
  const already = alert('orders_shelved', { escalation_level: 3, last_notified_at: ago(HOUR), unattended_at: ago(MIN) });
  const unsent = alert('orders_shelved', { escalation_level: 0, last_notified_at: null });
  assert.deepEqual(unattendedAlerts([lvl2, acked, already, unsent], NOW), []);
});

test('only P1 and P2 are ever unattended: a P3 is never paged, so nobody can have missed it', () => {
  assert.deepEqual(unattendedAlerts([alert('service_hours_missing', { escalation_level: 3, last_notified_at: ago(HOUR) })], NOW), []);
});

test('the unattended flag follows the configured number of reminders', () => {
  const a = alert('orders_shelved', { escalation_level: 1, last_notified_at: ago(10 * MIN) });
  assert.deepEqual(unattendedAlerts([a], NOW), []);
  assert.equal(unattendedAlerts([a], NOW, { ...ALERT_DEFAULTS, reminders: 1 }).length, 1);
});

// --- what the page says ----------------------------------------------------------------------------------------------------------

test('a page names the restaurant, the rule, how bad it is and since when, in the founders\' own time', () => {
  const a = alert('hub_silent_service', { opened_at: '2026-10-27T06:15:00.000Z', detail: { last_seen_at: '2026-10-27T05:50:00.000Z', silent_ms: 40 * MIN } });
  const m = describeAlert(a, 0, ALERT_DEFAULTS);
  assert.match(m.title, /P1/);
  assert.match(m.title, /Hotel Mejwani/);
  assert.match(m.body, /hub/i);
  assert.match(m.body, /since 11:45/, 'opened at 06:15 UTC is 11:45 in India');
  assert.match(m.body, /40 minutes/);
});

test('each rule has its own words, and every one says what to look at', () => {
  const words = {
    hub_silent_service: /hub.*(not|no word)/i,
    orders_shelved: /3 orders/i,
    hub_silent_long: /hub/i,
    sync_backlog: /60 bills/i,
    payment_past_due: /payment/i,
    service_hours_missing: /service hours/i
  };
  const detail = { orders_shelved: { count: 3 }, sync_backlog: { count: 60 }, hub_silent_service: { silent_ms: 20 * MIN, last_seen_at: ago(20 * MIN) }, hub_silent_long: { last_seen_at: ago(40 * HOUR) } };
  for (const [rule, pattern] of Object.entries(words)) {
    const m = describeAlert(alert(rule, { detail: detail[rule] ?? {} }), 0, ALERT_DEFAULTS);
    assert.match(m.body, pattern, rule);
    assert.ok(m.title.length > 0 && m.body.length > 0);
  }
});

test('a silence is said in minutes up to two hours, then in hours, and is never "0 minutes"', () => {
  const said = ms => describeAlert(alert('hub_silent_service', { detail: { silent_ms: ms } }), 0, ALERT_DEFAULTS).body;
  assert.match(said(30 * 1000), /for 1 minute\b/, 'a silence under a minute is still a minute, not none');
  assert.match(said(MIN), /for 1 minute\b/);
  assert.match(said(119 * MIN), /for 119 minutes/);
  assert.match(said(120 * MIN), /for 2 hours/);
  assert.match(said(5 * HOUR + 59 * MIN), /for 5 hours/);
});

test('one shelved order is "1 order", not "1 orders"', () => {
  assert.match(describeAlert(alert('orders_shelved', { detail: { count: 1 } }), 0, ALERT_DEFAULTS).body, /1 order\b(?!s)/);
});

test('a reminder says it is a reminder and which one', () => {
  const a = alert('orders_shelved', { detail: { count: 2 } });
  assert.doesNotMatch(describeAlert(a, 0, ALERT_DEFAULTS).title, /reminder/i);
  assert.match(describeAlert(a, 2, ALERT_DEFAULTS).title, /reminder 2 of 3/i);
});

test('a page never carries a secret or a guest: only what the rule needs', () => {
  const a = alert('orders_shelved', { detail: { count: 2, phone: '9822012345', token: 'sk_live_abc', guest: 'Ravi' } });
  const m = describeAlert(a, 0, ALERT_DEFAULTS);
  const text = JSON.stringify(m);
  for (const leak of ['9822012345', 'sk_live_abc', 'Ravi']) assert.ok(!text.includes(leak), leak);
});

test('a restaurant\'s name is passed on as text and cannot make the page say something else', () => {
  const m = describeAlert(alert('orders_shelved', { restaurant_name: 'Bad\nname\r\n<b>x</b>', detail: { count: 1 } }), 0, ALERT_DEFAULTS);
  assert.ok(!/[\r\n]/.test(m.title), 'a title is one line');
});

test('an alert of a rule it has no words for still says which rule it is', () => {
  const m = describeAlert(alert('orders_shelved', { rule_key: 'something_new', severity: 'P2' }), 0, ALERT_DEFAULTS);
  assert.match(m.body, /something_new/);
});

// --- the words of an alert, on their own (for the inbox) -----------------------------------------------------------------------------

test('an alert\'s words are what it is and what is wrong, with no "since" and no severity: the screen has its own columns for those', () => {
  const w = alertWords('orders_shelved', { count: 3 });
  assert.deepEqual(Object.keys(w).sort(), ['text', 'what']);
  assert.equal(w.what, 'orders shelved');
  assert.match(w.text, /^3 orders were shelved/);
  assert.doesNotMatch(w.text, /since|P1/i);
});

test('the words used for a page and for the inbox are the same words', () => {
  for (const [rule, detail] of [['hub_silent_service', { silent_ms: 20 * MIN }], ['sync_backlog', { count: 60 }], ['payment_past_due', {}], ['service_hours_missing', {}]]) {
    const page = describeAlert(alert(rule, { detail }), 0, ALERT_DEFAULTS);
    const w = alertWords(rule, detail);
    assert.ok(page.body.startsWith(w.text), rule);
    assert.ok(page.title.endsWith(w.what), rule);
  }
});

test('words for a rule it does not know say which rule it is, and never fail on a missing or odd detail', () => {
  assert.match(alertWords('something_new', {}).text, /something_new/);
  assert.equal(alertWords('something_new', {}).what, 'something_new');
  for (const odd of [undefined, null, 'x', 5, [1]]) assert.doesNotThrow(() => alertWords('orders_shelved', odd), String(odd));
  assert.match(alertWords('orders_shelved', null).text, /0 orders/);
});

// --- the order of the inbox ------------------------------------------------------------------------------------------------------

const row = (id, over = {}) => ({ id, state: 'open', severity: 'P1', opened_at: ago(HOUR), unattended_at: null, resolved_at: null, ...over });

test('what is waiting for an answer comes first, then what somebody has taken on', () => {
  const list = [row(1, { state: 'acked' }), row(2), row(3, { state: 'acked', severity: 'P2' }), row(4, { severity: 'P2' })];
  assert.deepEqual(rankAlerts(list).map(a => a.id), [2, 4, 1, 3]);
});

test('among those waiting: what nobody has answered at all first, then the worse, then the one that has waited longest', () => {
  const list = [
    row(1, { severity: 'P2', opened_at: ago(5 * HOUR) }),
    row(2, { severity: 'P1', opened_at: ago(MIN) }),
    row(3, { severity: 'P1', opened_at: ago(3 * HOUR) }),
    row(4, { severity: 'P3', opened_at: ago(9 * HOUR) }),
    row(5, { severity: 'P2', opened_at: ago(MIN), unattended_at: ago(MIN) })
  ];
  assert.deepEqual(rankAlerts(list).map(a => a.id), [5, 3, 2, 1, 4]);
});

test('alerts that tie on everything keep a steady order, by id', () => {
  const list = [row(9, { opened_at: ago(HOUR) }), row(3, { opened_at: ago(HOUR) }), row(7, { opened_at: ago(HOUR) })];
  assert.deepEqual(rankAlerts(list).map(a => a.id), [3, 7, 9]);
});

test('resolved alerts, when listed, are the most recently closed first', () => {
  const list = [row(1, { state: 'resolved', resolved_at: ago(5 * HOUR) }), row(2, { state: 'resolved', resolved_at: ago(MIN) }), row(3, { state: 'resolved', resolved_at: ago(2 * HOUR) })];
  assert.deepEqual(rankAlerts(list).map(a => a.id), [2, 3, 1]);
});

test('ranking does not change the list it is given, and a time that is not one does not break it', () => {
  const list = [row(2, { opened_at: 'soon' }), row(1)];
  const before = JSON.stringify(list);
  assert.doesNotThrow(() => rankAlerts(list));
  assert.equal(JSON.stringify(list), before);
});

test('closed alerts that closed at the same moment keep a steady order, by id', () => {
  const same = ago(HOUR);
  const list = [row(9, { state: 'resolved', resolved_at: same }), row(3, { state: 'resolved', resolved_at: same }), row(7, { state: 'resolved', resolved_at: same })];
  assert.deepEqual(rankAlerts(list).map(a => a.id), [3, 7, 9]);
});

test('ranking leaves the list it was given in its own order, even when ranking would move things', () => {
  const list = [row(2, { severity: 'P3' }), row(1, { severity: 'P1' })];
  const before = list.map(a => a.id);
  assert.deepEqual(rankAlerts(list).map(a => a.id), [1, 2], 'the ranked copy is reordered');
  assert.deepEqual(list.map(a => a.id), before, 'the original is not');
});
