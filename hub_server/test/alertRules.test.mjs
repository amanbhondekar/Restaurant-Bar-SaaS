import test from 'node:test';
import assert from 'node:assert/strict';

import { ALERT_RULES, serviceWindowAt, evaluateTenant, evaluateFleet } from '../../common/alertRules.js';
import { OPS_LIMITS } from '../../common/opsRules.js';

// Phase 2 of docs/SUPER_ADMIN_BUILD_SHEET.md, task P2-2, the rules half (§8): given a restaurant's row from the `ops_tenants` view, what the
// console knows about its service hours, and the moment it is read in, which conditions are true right now. Pure: no database, no clock.
//
// Two things are easy to get wrong, so they are pinned to the millisecond on both sides. A dead hub is only an emergency when the restaurant is
// OPEN: a laptop switched off at midnight is not an alert, and one that has not reported since the restaurant opened is. And a restaurant that
// opened five minutes ago has not "missed three heartbeats" just because its hub last spoke yesterday.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Tuesday 2026-10-27, 12:00 in India (06:30 UTC). India has no daylight saving, so the offsets below are exact.
const NOW = Date.parse('2026-10-27T06:30:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();
const ahead = ms => new Date(NOW + ms).toISOString();

const row = (over = {}) => ({
  restaurant_id: 'r-1', name: 'Hotel Mejwani', slug: 'hotel-mejwani', city: 'Nagpur', phone: '9822012345',
  plan: 'pro', plan_status: 'active', trial_ends_at: null, current_period_end: ahead(20 * DAY), created_at: ago(90 * DAY),
  subscription_status: 'active', subscription_plan: 'pro', subscription_cancel_requested_at: null, subscription_plan_change_to: null,
  subscription_period_end: ahead(20 * DAY), subscription_last_event_at: ago(10 * DAY),
  hub_seen_at: ago(2 * MIN), hub_reported_at: ago(2 * MIN), hub_started_at: ago(5 * HOUR), hub_version: '1.0.0',
  hub_queued: 0, hub_quarantined: 0, hub_last_synced_at: ago(3 * MIN), hub_devices: 3, hub_waiters: 5,
  last_invoice_at: ago(20 * MIN), invoices_7d: 140,
  ...over
});
const DAILY = [['11:00', '23:00']];
const hours = (perDay = DAILY) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, perDay]));
const meta = (over = {}) => ({ timezone: 'Asia/Kolkata', service_hours: hours(), ...over });
const keys = (r, m = meta(), now = NOW) => evaluateTenant(r, m, now).map(c => c.rule_key);
const find = (r, key, m = meta(), now = NOW) => evaluateTenant(r, m, now).find(c => c.rule_key === key);

// --- the rules and how bad each is -----------------------------------------------------------------------------------------------

test('every rule has a severity, and the sheet\'s are the ones used: shelved takings and a silent open restaurant are P1; the rest P2; a blind spot is only flagged', () => {
  assert.deepEqual(ALERT_RULES, {
    hub_silent_service: 'P1',
    orders_shelved: 'P1',
    hub_silent_long: 'P2',
    sync_backlog: 'P2',
    payment_past_due: 'P2',
    service_hours_missing: 'P3'
  });
});

test('a healthy restaurant raises nothing', () => {
  assert.deepEqual(evaluateTenant(row(), meta(), NOW), []);
});

// --- service hours ---------------------------------------------------------------------------------------------------------------

test('service hours are read in the restaurant\'s own time zone, not the server\'s', () => {
  // 12:00 in India is 10:30 in Dubai (not yet open at 11:00) and 06:30 in London.
  assert.equal(serviceWindowAt(meta(), NOW).state, 'open');
  assert.equal(serviceWindowAt(meta({ timezone: 'Asia/Dubai' }), NOW).state, 'closed');
  assert.equal(serviceWindowAt(meta({ timezone: 'Europe/London' }), NOW).state, 'closed');
});

test('a window is open from its opening minute and closed from its closing minute', () => {
  const at = iso => serviceWindowAt(meta(), Date.parse(iso)).state;
  assert.equal(at('2026-10-27T05:29:59.999Z'), 'closed', '10:59:59.999 in India');
  assert.equal(at('2026-10-27T05:30:00.000Z'), 'open', '11:00');
  assert.equal(at('2026-10-27T17:29:59.999Z'), 'open', '22:59:59.999');
  assert.equal(at('2026-10-27T17:30:00.000Z'), 'closed', '23:00');
});

test('an open window says since when it has been open', () => {
  const w = serviceWindowAt(meta(), NOW);
  assert.equal(w.state, 'open');
  assert.equal(w.since, NOW - HOUR, 'opened at 11:00 and it is 12:00');
});

test('days differ, and a day with no window is closed', () => {
  const m = meta({ service_hours: { ...hours(), tue: [] } });
  assert.equal(serviceWindowAt(m, NOW).state, 'closed');
  const noTue = { ...hours() }; delete noTue.tue;
  assert.equal(serviceWindowAt(meta({ service_hours: noTue }), NOW).state, 'closed');
});

test('two windows in a day (lunch and dinner) are each their own', () => {
  const m = meta({ service_hours: hours([['11:00', '15:00'], ['18:00', '23:00']]) });
  const at = iso => serviceWindowAt(m, Date.parse(iso));
  assert.equal(at('2026-10-27T06:30:00Z').state, 'open', '12:00');
  assert.equal(at('2026-10-27T10:30:00Z').state, 'closed', '16:00, the afternoon break');
  const dinner = at('2026-10-27T13:30:00Z');
  assert.equal(dinner.state, 'open', '19:00');
  assert.equal(dinner.since, Date.parse('2026-10-27T12:30:00Z'), 'since 18:00, not since lunch');
});

test('a window that runs past midnight belongs to the day it opened, and covers the early hours of the next', () => {
  const m = meta({ service_hours: { ...hours([]), tue: [['18:00', '02:00']] } });
  const at = iso => serviceWindowAt(m, Date.parse(iso));
  assert.equal(at('2026-10-27T18:30:00Z').state, 'open', 'Wednesday 00:00 in India: Tuesday\'s window, past midnight');
  const early = at('2026-10-27T20:00:00Z');   // Wednesday 01:30 in India: still Tuesday's window
  assert.equal(early.state, 'open');
  assert.equal(early.since, Date.parse('2026-10-27T12:30:00Z'), 'since Tuesday 18:00');
  assert.equal(at('2026-10-27T20:30:00Z').state, 'closed', 'Wednesday 02:00');
  assert.equal(at('2026-10-27T11:30:00Z').state, 'closed', 'Tuesday 17:00, before it opens');
});

test('the evening part of a window that runs past midnight is open too, since its own opening', () => {
  const m = meta({ service_hours: { ...hours([]), tue: [['18:00', '02:00']] } });
  const w = serviceWindowAt(m, Date.parse('2026-10-27T14:30:00Z'));   // Tuesday 20:00 in India
  assert.equal(w.state, 'open');
  assert.equal(w.since, Date.parse('2026-10-27T12:30:00Z'), 'since 18:00 that day');
  assert.equal(serviceWindowAt(m, Date.parse('2026-10-27T12:29:59.999Z')).state, 'closed', '17:59:59.999');
  assert.equal(serviceWindowAt(m, Date.parse('2026-10-27T12:30:00.000Z')).state, 'open', '18:00');
});

test('the moment a window opened is the minute it opened, whatever the seconds of the moment asked about', () => {
  assert.equal(serviceWindowAt(meta(), NOW + 30 * 1000 + 123).since, NOW - HOUR);
  assert.equal(serviceWindowAt(meta(), NOW + 59 * 1000 + 999).since, NOW - HOUR);
});

test('hours that are missing, empty or unreadable are "unknown", never guessed', () => {
  for (const bad of [
    null, undefined, {}, [], 'always', 42,
    { tue: 'all day' }, { tue: [['11:00']] }, { tue: [['11:00', '25:00']] }, { tue: [['9', '17']] },
    { tue: [['11:00', '11:00']] },
    { someday: [['11:00', '23:00']] },                 // not a weekday
    { tue: [['11:00', '15:00', '18:00']] },            // a window is an opening and a closing, not three times
    { tue: [['11:00', '23:00']], holiday: [] }         // a day it does not know, even beside good ones
  ]) {
    assert.equal(serviceWindowAt({ timezone: 'Asia/Kolkata', service_hours: bad }, NOW).state, 'unknown', JSON.stringify(bad));
  }
  assert.equal(serviceWindowAt(meta({ timezone: 'Not/AZone' }), NOW).state, 'unknown', 'a time zone nobody has heard of');
  assert.equal(serviceWindowAt(meta({ timezone: null }), NOW).state, 'unknown', 'no time zone at all');
  assert.equal(serviceWindowAt(null, NOW).state, 'unknown', 'no meta row');
  assert.equal(serviceWindowAt(undefined, NOW).state, 'unknown');
});

test('one bad day makes the whole table unreadable rather than quietly closed', () => {
  const m = meta({ service_hours: { ...hours(), wed: [['bad', 'worse']] } });
  assert.equal(serviceWindowAt(m, NOW).state, 'unknown');
});

// --- hub_silent_service ----------------------------------------------------------------------------------------------------------

test('a hub that has said nothing for MORE than fifteen minutes while the restaurant is open is P1; at exactly fifteen it is still live', () => {
  assert.equal(OPS_LIMITS.hubLiveMs, 15 * MIN, 'the same fifteen minutes the console already calls live');
  assert.equal(find(row({ hub_seen_at: ago(15 * MIN) }), 'hub_silent_service'), undefined);
  const c = find(row({ hub_seen_at: ago(15 * MIN + 1) }), 'hub_silent_service');
  assert.ok(c);
  assert.equal(c.severity, 'P1');
});

test('the same silence is nothing while the restaurant is shut', () => {
  const shut = meta({ service_hours: hours([['18:00', '23:00']]) });   // it is 12:00
  assert.equal(find(row({ hub_seen_at: ago(3 * HOUR) }), 'hub_silent_service', shut), undefined);
});

test('a restaurant that opened five minutes ago has not missed three reports, however long ago the hub last spoke', () => {
  const justOpened = meta({ service_hours: hours([['11:55', '23:00']]) });
  const stale = row({ hub_seen_at: ago(10 * HOUR) });   // last night
  assert.equal(find(stale, 'hub_silent_service', justOpened), undefined);
});

test('the silence that counts starts when the restaurant opened: fifteen minutes into service with no word is the first alert', () => {
  const stale = row({ hub_seen_at: ago(10 * HOUR) });
  // It is 12:00 in India. A restaurant that opened N minutes ago opened at 12:00 minus N minutes.
  const opened = minutesAgo => { const t = 12 * 60 - minutesAgo; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const at = minutesAgo => find(stale, 'hub_silent_service', meta({ service_hours: hours([[opened(minutesAgo), '23:00']]) }));
  assert.equal(at(15), undefined, 'exactly fifteen minutes is not yet more than fifteen');
  assert.equal(at(16)?.severity, 'P1', 'sixteen is');
});

test('a hub that was heard from since the restaurant opened is judged on its last report, not on the opening', () => {
  const m = meta({ service_hours: hours([['08:00', '23:00']]) });   // open four hours
  assert.equal(find(row({ hub_seen_at: ago(10 * MIN) }), 'hub_silent_service', m), undefined);
  assert.ok(find(row({ hub_seen_at: ago(16 * MIN) }), 'hub_silent_service', m));
});

test('a hub that has never reported is not "silent": that is a different problem and not this alert', () => {
  assert.equal(find(row({ hub_seen_at: null }), 'hub_silent_service'), undefined);
});

test('a hub_seen_at that is not a written date is treated as never seen, not as 1970', () => {
  assert.equal(find(row({ hub_seen_at: 'soon' }), 'hub_silent_service'), undefined);
  assert.equal(find(row({ hub_seen_at: 12345 }), 'hub_silent_service'), undefined);
});

test('a cancelled restaurant\'s hub is meant to be off, so its silence is not an alert', () => {
  assert.equal(find(row({ plan_status: 'cancelled', hub_seen_at: ago(HOUR) }), 'hub_silent_service'), undefined);
  for (const status of ['active', 'trialing', 'past_due', 'suspended']) {
    assert.ok(find(row({ plan_status: status, hub_seen_at: ago(HOUR) }), 'hub_silent_service'), status);
  }
});

test('when the hours are unknown the rule does not guess: it stays quiet and the blind spot is flagged instead', () => {
  const r = row({ hub_seen_at: ago(5 * HOUR) });
  const got = keys(r, meta({ service_hours: null }));
  assert.ok(!got.includes('hub_silent_service'));
  assert.ok(got.includes('service_hours_missing'));
});

test('the alert says when the hub was last heard from, and how long that is', () => {
  const c = find(row({ hub_seen_at: ago(40 * MIN) }), 'hub_silent_service');
  assert.equal(c.detail.last_seen_at, ago(40 * MIN));
  assert.equal(c.detail.silent_ms, 40 * MIN);
});

test('a restaurant open for twenty minutes whose hub last spoke yesterday reports twenty minutes of silence, not twenty hours', () => {
  const m = meta({ service_hours: hours([['11:40', '23:00']]) });
  const c = find(row({ hub_seen_at: ago(20 * HOUR) }), 'hub_silent_service', m);
  assert.equal(c.detail.silent_ms, 20 * MIN);
});

// --- orders_shelved --------------------------------------------------------------------------------------------------------------

test('shelved orders are P1 the moment there is one, whatever the hours and whatever the plan', () => {
  assert.equal(find(row({ hub_quarantined: 0 }), 'orders_shelved'), undefined);
  const c = find(row({ hub_quarantined: 1 }), 'orders_shelved');
  assert.equal(c.severity, 'P1');
  assert.equal(c.detail.count, 1);
  assert.equal(find(row({ hub_quarantined: 3, plan_status: 'cancelled' }), 'orders_shelved')?.detail.count, 3, 'money that never reached the cloud is money');
  assert.ok(find(row({ hub_quarantined: 1 }), 'orders_shelved', meta({ service_hours: null })), 'and does not need to know the hours');
});

test('a count that is not a count is not an alert', () => {
  for (const bad of [null, undefined, 'many', -1, NaN]) assert.equal(find(row({ hub_quarantined: bad }), 'orders_shelved'), undefined, String(bad));
  assert.equal(find(row({ hub_quarantined: '2' }), 'orders_shelved')?.detail.count, 2, 'the database sends text');
});

// --- sync_backlog ----------------------------------------------------------------------------------------------------------------

test('bills waiting to reach the cloud are a P2 from the console\'s own threshold, and not before', () => {
  assert.equal(OPS_LIMITS.backlog, 50);
  assert.equal(find(row({ hub_queued: 49 }), 'sync_backlog'), undefined);
  const c = find(row({ hub_queued: 50 }), 'sync_backlog');
  assert.equal(c.severity, 'P2');
  assert.equal(c.detail.count, 50);
  assert.equal(find(row({ hub_queued: 500, plan_status: 'cancelled' }), 'sync_backlog'), undefined, 'a cancelled restaurant\'s hub is meant to be off');
});

// --- hub_silent_long -------------------------------------------------------------------------------------------------------------

test('a hub quiet for more than a day and a half is a P2, whatever the hours', () => {
  assert.equal(find(row({ hub_seen_at: ago(36 * HOUR) }), 'hub_silent_long'), undefined, 'a restaurant that was shut yesterday');
  const c = find(row({ hub_seen_at: ago(36 * HOUR + 1) }), 'hub_silent_long');
  assert.equal(c.severity, 'P2');
  assert.equal(c.detail.last_seen_at, ago(36 * HOUR + 1));
  assert.ok(find(row({ hub_seen_at: ago(40 * HOUR) }), 'hub_silent_long', meta({ service_hours: null })));
});

test('the week-long silence is the same alert, not a second one', () => {
  const got = keys(row({ hub_seen_at: ago(8 * DAY) }));
  assert.equal(got.filter(k => k === 'hub_silent_long').length, 1);
  assert.equal(find(row({ hub_seen_at: ago(8 * DAY) }), 'hub_silent_long').detail.last_seen_at, ago(8 * DAY));
});

test('a cancelled restaurant is not chased for a silent hub', () => {
  assert.equal(find(row({ plan_status: 'cancelled', hub_seen_at: ago(10 * DAY) }), 'hub_silent_long'), undefined);
});

// --- payment_past_due ------------------------------------------------------------------------------------------------------------

test('a payment that is overdue is a P2, and only that status is', () => {
  assert.equal(find(row({ plan_status: 'past_due' }), 'payment_past_due').severity, 'P2');
  for (const s of ['active', 'trialing', 'suspended', 'cancelled', null, undefined]) {
    assert.equal(find(row({ plan_status: s }), 'payment_past_due'), undefined, String(s));
  }
});

// --- service_hours_missing -------------------------------------------------------------------------------------------------------

test('a running restaurant with no readable hours is flagged, and a P3 is never something to be paged about', () => {
  const c = find(row(), 'service_hours_missing', meta({ service_hours: null }));
  assert.equal(c.severity, 'P3');
  assert.equal(ALERT_RULES.service_hours_missing, 'P3');
});

test('it is not flagged for a restaurant whose hub has never reported, or one that has cancelled', () => {
  const none = meta({ service_hours: null });
  assert.equal(find(row({ hub_seen_at: null }), 'service_hours_missing', none), undefined);
  assert.equal(find(row({ plan_status: 'cancelled' }), 'service_hours_missing', none), undefined);
});

test('it is not flagged when the hours are known', () => {
  assert.equal(find(row(), 'service_hours_missing'), undefined);
});

// --- the whole picture -----------------------------------------------------------------------------------------------------------

test('each condition names the restaurant, the rule, a stable key and nothing that is a secret or a guest', () => {
  const r = row({ hub_seen_at: ago(HOUR), hub_quarantined: 2, phone: '9822012345', slug: 'hotel-mejwani' });
  const got = evaluateTenant(r, meta(), NOW);
  for (const c of got) {
    assert.equal(c.restaurant_id, 'r-1');
    assert.equal(c.restaurant_name, 'Hotel Mejwani');
    assert.equal(c.dedupe_key, `${c.rule_key}:r-1`);
    assert.equal(c.severity, ALERT_RULES[c.rule_key]);
    assert.ok(!JSON.stringify(c).includes('9822012345'), 'no phone number');
  }
  assert.deepEqual(Object.keys(got[0]).sort(), ['dedupe_key', 'detail', 'restaurant_id', 'restaurant_name', 'rule_key', 'severity']);
});

test('conditions come worst first, then by rule, so the same row always gives the same list', () => {
  const r = row({ hub_seen_at: ago(5 * DAY), hub_quarantined: 4, hub_queued: 80, plan_status: 'past_due' });
  const got = keys(r, meta({ service_hours: null }));
  assert.deepEqual(got, ['orders_shelved', 'hub_silent_long', 'payment_past_due', 'sync_backlog', 'service_hours_missing']);
});

test('the fleet is every restaurant\'s conditions together, each restaurant using its own hours', () => {
  const a = row({ restaurant_id: 'r-a', name: 'A', hub_seen_at: ago(HOUR) });
  const b = row({ restaurant_id: 'r-b', name: 'B', hub_seen_at: ago(HOUR) });
  const metaBy = { 'r-a': meta(), 'r-b': meta({ service_hours: hours([['18:00', '23:00']]) }) };   // B is shut
  const got = evaluateFleet([a, b], metaBy, NOW);
  assert.deepEqual(got.map(c => [c.restaurant_id, c.rule_key]), [['r-a', 'hub_silent_service']]);
});

test('a restaurant with no meta row at all is handled: its hours are unknown, not an error', () => {
  const got = evaluateFleet([row()], {}, NOW);
  assert.deepEqual(got.map(c => c.rule_key), ['service_hours_missing']);
});

test('evaluating does not change the rows it is given', () => {
  const r = row({ hub_seen_at: ago(HOUR) });
  const m = meta();
  const before = JSON.stringify([r, m]);
  evaluateTenant(r, m, NOW);
  assert.equal(JSON.stringify([r, m]), before);
});
