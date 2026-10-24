import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPS_LIMITS, hubState, attentionFor, shapeTenant, fleetSummary, attentionList, rankTenants, shapeEvent, shapeSubscription
} from '../../signup_server/lib/ops.js';

// What the operator console says about each restaurant (§4.9). Pure rules: a row from the `ops_tenants` view and the moment it is read in,
// and what comes out is how the restaurant is doing and why anyone should look at it. Nothing here reads a database or a clock.
//
// The thresholds are the product, so each is pinned to the millisecond on both sides: a hub that has been quiet for 36 hours is a restaurant
// that closed yesterday, and one that has been quiet for 36 hours and a millisecond is a restaurant to ring. A rule that fires too early
// teaches the operator to ignore the list; one that fires too late is no use.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();
const ahead = ms => new Date(NOW + ms).toISOString();

const row = (over = {}) => ({
  restaurant_id: 'r-1', name: 'Hotel Mejwani', slug: 'hotel-mejwani', city: 'Nagpur', phone: '9822012345',
  plan: 'pro', plan_status: 'active', trial_ends_at: null, current_period_end: ahead(20 * DAY), created_at: ago(90 * DAY),
  subscription_status: 'active', subscription_plan: 'pro', subscription_cancel_requested_at: null, subscription_plan_change_to: null,
  subscription_period_end: ahead(20 * DAY), subscription_last_event_at: ago(10 * DAY),
  hub_seen_at: ago(2 * MIN), hub_reported_at: ago(2 * MIN + 1000), hub_started_at: ago(5 * HOUR), hub_version: '1.0.0',
  hub_queued: 0, hub_quarantined: 0, hub_last_synced_at: ago(3 * MIN), hub_devices: 3, hub_waiters: 5,
  last_invoice_at: ago(20 * MIN), invoices_7d: 140,
  ...over
});
const codes = (over, now = NOW) => attentionFor(row(over), now).map(a => a.code);
const only = (over, code, now = NOW) => attentionFor(row(over), now).find(a => a.code === code);

// --- the hub --------------------------------------------------------------------------------------------------------------------

test('a hub is live for fifteen minutes after it last reported, quiet until a day and a half, and silent after that', () => {
  const state = ms => hubState(row({ hub_seen_at: ago(ms) }), NOW);
  assert.equal(state(0), 'live');
  assert.equal(state(15 * MIN), 'live', 'three missed reports is still live');
  assert.equal(state(15 * MIN + 1), 'quiet');
  assert.equal(state(36 * HOUR), 'quiet', 'a restaurant that was shut yesterday');
  assert.equal(state(36 * HOUR + 1), 'silent');
  assert.equal(state(30 * DAY), 'silent');
});

test('a hub that has never reported is "never"; so is one whose time cannot be read; a time in the future is live', () => {
  // A bare number is not a time either: Date.parse('5') is a day in 2001.
  for (const seen of [null, undefined, '', 'yesterday', 'not a date', 5, 20261024, NOW, true, {}, []]) assert.equal(hubState(row({ hub_seen_at: seen }), NOW), 'never', String(seen));
  assert.equal(hubState(row({ hub_seen_at: ahead(2 * MIN) }), NOW), 'live', 'the two clocks differ by a little, and that is not a reason to worry');
});

// --- a healthy restaurant -------------------------------------------------------------------------------------------------------

test('a restaurant that is paid up, with a hub that reports and nothing waiting, has nothing to look at', () => {
  assert.deepEqual(attentionFor(row(), NOW), []);
  assert.equal(shapeTenant(row(), NOW).severity, null);
});

// --- money ----------------------------------------------------------------------------------------------------------------------

test('payment overdue and suspended are the two to ring about today', () => {
  assert.deepEqual([only({ plan_status: 'past_due' }, 'past_due').severity, only({ plan_status: 'past_due' }, 'past_due').message], ['high', 'Payment is overdue.']);
  assert.deepEqual([only({ plan_status: 'suspended' }, 'suspended').severity, only({ plan_status: 'suspended' }, 'suspended').message], ['high', 'This restaurant is suspended.']);
  assert.deepEqual(codes({ plan_status: 'trialing' }), [], 'a trial with no end date on it is not a problem we can name');
  assert.deepEqual(codes({ plan_status: 'cancelled' }), [], 'someone who left is not asking for attention');
});

test('a trial that has ended with nobody subscribed is high; one about to end is medium, from three days out', () => {
  const trial = ms => ({ plan_status: 'trialing', trial_ends_at: ms });
  const ended = only(trial(ago(1)), 'trial_ended');
  assert.deepEqual([ended.severity, ended.message], ['high', 'The trial ended less than a day ago and nobody has subscribed.']);
  assert.equal(only(trial(ago(3 * DAY + 2 * HOUR)), 'trial_ended').message, 'The trial ended 3 days ago and nobody has subscribed.');
  assert.equal(only(trial(ago(DAY)), 'trial_ended').message, 'The trial ended 1 day ago and nobody has subscribed.');

  assert.deepEqual(codes(trial(ahead(0))), ['trial_ending'], 'at the very moment it ends it is still ending, not ended');
  const soon = only(trial(ahead(3 * DAY)), 'trial_ending');
  assert.deepEqual([soon.severity, soon.message], ['medium', 'The trial ends in 3 days.']);
  assert.deepEqual(codes(trial(ahead(3 * DAY + 1))), [], 'four days out is not yet');
  assert.equal(only(trial(ahead(DAY)), 'trial_ending').message, 'The trial ends in 1 day.');
  assert.equal(only(trial(ahead(5 * HOUR)), 'trial_ending').message, 'The trial ends in less than a day.');
  assert.deepEqual(codes({ plan_status: 'active', trial_ends_at: ago(DAY) }), [], 'a trial that led to a subscription is history');
  assert.deepEqual(codes({ plan_status: 'past_due', trial_ends_at: ago(DAY) }), ['past_due'], 'and only trials are about trials');
});

test('a request to cancel is worth knowing about, with when the plan ends if that is known', () => {
  const asked = only({ subscription_cancel_requested_at: ago(DAY), subscription_period_end: '2026-11-10T00:00:00.000Z' }, 'cancel_requested');
  assert.deepEqual([asked.severity, asked.message], ['medium', 'Asked to cancel; the plan runs until 2026-11-10.']);
  assert.equal(only({ subscription_cancel_requested_at: ago(DAY), subscription_period_end: null }, 'cancel_requested').message, 'Asked to cancel.');
  assert.deepEqual(codes({ subscription_cancel_requested_at: ago(DAY), plan_status: 'cancelled' }), [], 'once it has ended there is nothing left to save');
});

// --- the hub ------------------------------------------------------------------------------------------------------------------

test('a restaurant whose hub has never reported is flagged once it is more than a day old, and not before', () => {
  const never = created => ({ hub_seen_at: null, hub_reported_at: null, hub_queued: null, hub_quarantined: null, hub_devices: null, hub_waiters: null, hub_version: null, hub_started_at: null, hub_last_synced_at: null, created_at: created });
  const flagged = only(never(ago(DAY + 1)), 'hub_never_seen');
  assert.deepEqual([flagged.severity, flagged.message], ['medium', 'The hub has never reported. It may not be set up yet.']);
  assert.deepEqual(codes(never(ago(DAY))), [], 'exactly a day old is not yet');
  assert.deepEqual(codes(never(ago(HOUR))), [], 'just signed up');
  assert.deepEqual(codes(never(null)), [], 'and with no sign-up time to go by there is no knowing it has had a day');
  assert.deepEqual(codes(never('garbage')), []);
  assert.deepEqual(codes({ ...never(ago(30 * DAY)), plan_status: 'cancelled' }), []);
});

test('a hub that has gone silent is medium, and high after a week', () => {
  const silent = ms => ({ hub_seen_at: ago(ms), hub_reported_at: ago(ms) });
  assert.deepEqual(codes(silent(36 * HOUR)), [], 'quiet is not silent');
  const a = only(silent(36 * HOUR + 1), 'hub_silent');
  assert.deepEqual([a.severity, a.message], ['medium', 'No word from the hub for 1 day.']);
  assert.equal(only(silent(3 * DAY + 5 * HOUR), 'hub_silent').message, 'No word from the hub for 3 days.');
  assert.equal(only(silent(7 * DAY), 'hub_silent').severity, 'medium');
  assert.equal(only(silent(7 * DAY + 1), 'hub_silent').severity, 'high');
  assert.equal(only(silent(7 * DAY + 1), 'hub_silent').message, 'No word from the hub for 7 days.');
  assert.deepEqual(codes({ ...silent(30 * DAY), plan_status: 'cancelled' }), [], 'a cancelled restaurant\'s hub is expected to be off');
});

test('orders that were shelved are takings that never reached the cloud: high, and worded for one or many', () => {
  assert.deepEqual(codes({ hub_quarantined: 0 }), []);
  const one = only({ hub_quarantined: 1 }, 'shelved');
  assert.deepEqual([one.severity, one.message], ['high', '1 order was shelved and has not reached the cloud.']);
  assert.equal(only({ hub_quarantined: 4 }, 'shelved').message, '4 orders were shelved and have not reached the cloud.');
  assert.deepEqual(codes({ hub_quarantined: 2, plan_status: 'cancelled' }), ['shelved'], 'still takings, whoever they belong to');
});

test('a long wait to reach the cloud is medium from fifty bills', () => {
  assert.deepEqual(codes({ hub_queued: 49 }), []);
  const a = only({ hub_queued: 50 }, 'sync_backlog');
  assert.deepEqual([a.severity, a.message], ['medium', '50 bills are waiting to reach the cloud.']);
  assert.deepEqual(codes({ hub_queued: 500, plan_status: 'cancelled' }), []);
  assert.equal(OPS_LIMITS.backlog, 50);
});

test('a hub whose clock is more than five minutes out is medium, ahead or behind', () => {
  const skew = ms => ({ hub_seen_at: ago(MIN), hub_reported_at: ago(MIN - ms) });
  assert.deepEqual(codes(skew(5 * MIN)), [], 'five minutes is within what a sleeping laptop does');
  const ahead6 = only(skew(6 * MIN), 'clock_skew');
  assert.deepEqual([ahead6.severity, ahead6.message], ['medium', 'The hub\'s clock is 6 minutes ahead.']);
  assert.equal(only({ hub_seen_at: ago(MIN), hub_reported_at: ago(MIN + 90 * MIN) }, 'clock_skew').message, 'The hub\'s clock is 90 minutes behind.');
  assert.equal(only(skew(5 * MIN + 1), 'clock_skew').severity, 'medium');
  assert.equal(only({ hub_seen_at: ago(MIN), hub_reported_at: ago(MIN - 5 * HOUR) }, 'clock_skew').message, 'The hub\'s clock is 5 hours ahead.');
  assert.equal(only({ hub_seen_at: ago(MIN), hub_reported_at: ago(MIN - 2 * HOUR) }, 'clock_skew').message, "The hub's clock is 2 hours ahead.", 'two hours is counted in hours');
  assert.equal(only({ hub_seen_at: ago(MIN), hub_reported_at: ago(MIN - 2 * HOUR + 1) }, 'clock_skew').message, "The hub's clock is 119 minutes ahead.", 'and a moment less is counted in minutes');
  assert.equal(only({ hub_seen_at: ago(MIN), hub_reported_at: ago(MIN - 6 * MIN - 40 * 1000) }, 'clock_skew').message, "The hub's clock is 6 minutes ahead.", 'counted down, not rounded up');
  assert.deepEqual(codes({ hub_seen_at: ago(MIN), hub_reported_at: null }), [], 'nothing to compare');
  assert.deepEqual(codes({ hub_seen_at: ago(MIN), hub_reported_at: 'garbage' }), []);
  assert.deepEqual(codes({ ...skew(2 * HOUR), plan_status: 'cancelled' }), []);
});

test('a restaurant can need attention for several reasons at once, worst first', () => {
  const t = shapeTenant(row({ plan_status: 'past_due', hub_quarantined: 2, hub_queued: 80, hub_seen_at: ago(2 * DAY), hub_reported_at: ago(2 * DAY) }), NOW);
  assert.deepEqual(t.attention.map(a => a.code), ['past_due', 'shelved', 'hub_silent', 'sync_backlog']);
  assert.equal(t.severity, 'high');
  const medium = shapeTenant(row({ hub_queued: 80 }), NOW);
  assert.equal(medium.severity, 'medium');
});

// --- the shape of a restaurant ------------------------------------------------------------------------------------------------

test('a restaurant is shaped for the screen: who, plan, subscription, hub, activity, and why to look', () => {
  const t = shapeTenant(row({ plan_status: 'past_due' }), NOW);
  assert.deepEqual(Object.keys(t).sort(), ['activity', 'attention', 'city', 'created_at', 'current_period_end', 'hub', 'id', 'name', 'phone', 'plan', 'plan_status', 'severity', 'slug', 'subscription', 'trial_ends_at']);
  assert.deepEqual([t.id, t.name, t.slug, t.city, t.phone, t.plan, t.plan_status], ['r-1', 'Hotel Mejwani', 'hotel-mejwani', 'Nagpur', '9822012345', 'pro', 'past_due']);
  assert.deepEqual(t.subscription, {
    status: 'active', plan: 'pro', plan_change_to: null, cancel_requested_at: null, period_end: ahead(20 * DAY), last_event_at: ago(10 * DAY)
  });
  assert.deepEqual(t.hub, {
    state: 'live', seen_at: ago(2 * MIN), reported_at: ago(2 * MIN + 1000), started_at: ago(5 * HOUR), version: '1.0.0',
    queued: 0, quarantined: 0, last_synced_at: ago(3 * MIN), devices: 3, waiters: 5
  });
  assert.deepEqual(t.activity, { last_invoice_at: ago(20 * MIN), invoices_7d: 140 });
});

test('a restaurant with no subscription and no hub report says so with nothing, and a count of nothing for bills', () => {
  const t = shapeTenant(row({
    subscription_status: null, subscription_plan: null, subscription_cancel_requested_at: null, subscription_plan_change_to: null, subscription_period_end: null, subscription_last_event_at: null,
    hub_seen_at: null, hub_reported_at: null, hub_started_at: null, hub_version: null, hub_queued: null, hub_quarantined: null, hub_last_synced_at: null, hub_devices: null, hub_waiters: null,
    last_invoice_at: null, invoices_7d: 0, created_at: ago(HOUR)
  }), NOW);
  assert.equal(t.subscription, null, 'no subscription at all, not a subscription full of nulls');
  assert.deepEqual(t.hub, { state: 'never', seen_at: null, reported_at: null, started_at: null, version: null, queued: null, quarantined: null, last_synced_at: null, devices: null, waiters: null });
  assert.deepEqual(t.activity, { last_invoice_at: null, invoices_7d: 0 });
});

test('only what the screen needs is passed on: a column the view gains later, or a secret that got into a row, goes no further', () => {
  const t = shapeTenant(row({ pairing_code: 'MJW-7492', hub_provisioning_secret_hash: '$2a$secret', settings: { x: 1 }, short_url: 'https://rzp.io/secret' }), NOW);
  assert.doesNotMatch(JSON.stringify(t), /MJW-7492|secret|rzp\.io|settings/);
});

test('a number that arrives as text is a number, and anything else is nothing', () => {
  const t = shapeTenant(row({ hub_queued: '12', hub_quarantined: 'x', hub_devices: -3, hub_waiters: 2.9, invoices_7d: '40' }), NOW);
  assert.deepEqual([t.hub.queued, t.hub.quarantined, t.hub.devices, t.hub.waiters, t.activity.invoices_7d], [12, null, null, 2, 40]);
  const blank = shapeTenant(row({ hub_queued: '', hub_devices: '   ', hub_quarantined: true, hub_waiters: [] }), NOW);
  assert.deepEqual([blank.hub.queued, blank.hub.devices, blank.hub.quarantined, blank.hub.waiters], [null, null, null, null], 'blank is not none');
  assert.equal(attentionFor(row({ hub_queued: '' }), NOW).length, 0);
});

test('times arrive as the database writes them and leave in one way; a version that is not text is not a version', () => {
  const t = shapeTenant(row({
    trial_ends_at: '2026-11-10T00:00:00+00:00', current_period_end: '2026-10-24 12:00:00+00', created_at: 'garbage', last_invoice_at: '2026-10-24T17:30:00+05:30',
    subscription_cancel_requested_at: '2026-10-23T00:00:00.123456+00:00', subscription_period_end: '2026-11-01T00:00:00+00:00', subscription_last_event_at: 5,
    hub_version: 5
  }), NOW);
  assert.deepEqual([t.trial_ends_at, t.current_period_end, t.created_at, t.activity.last_invoice_at], ['2026-11-10T00:00:00.000Z', '2026-10-24T12:00:00.000Z', null, '2026-10-24T12:00:00.000Z']);
  assert.deepEqual([t.subscription.cancel_requested_at, t.subscription.period_end, t.subscription.last_event_at], ['2026-10-23T00:00:00.123Z', '2026-11-01T00:00:00.000Z', null]);
  assert.equal(t.hub.version, null);
  const s = shapeSubscription({ razorpay_subscription_id: 's', status: 'active', cancel_requested_at: '2026-10-23T00:00:00+00:00', current_start: '2026-10-01 00:00:00+00', current_end: 'garbage', last_event_at: null, created_at: '2026-09-01T00:00:00+00:00' });
  assert.deepEqual([s.cancel_requested_at, s.current_start, s.current_end, s.last_event_at, s.created_at], ['2026-10-23T00:00:00.000Z', '2026-10-01T00:00:00.000Z', null, null, '2026-09-01T00:00:00.000Z']);
});

test('a row with almost nothing in it is still a restaurant: what is missing is nothing, and a bill count of nothing is none', () => {
  const t = shapeTenant({ restaurant_id: 'x', name: 'Bare' }, NOW);
  assert.deepEqual([t.id, t.name, t.slug, t.city, t.phone, t.plan, t.plan_status, t.trial_ends_at, t.current_period_end, t.created_at], ['x', 'Bare', null, null, null, null, null, null, null, null]);
  assert.equal(t.subscription, null);
  assert.deepEqual(t.hub, { state: 'never', seen_at: null, reported_at: null, started_at: null, version: null, queued: null, quarantined: null, last_synced_at: null, devices: null, waiters: null });
  assert.deepEqual(t.activity, { last_invoice_at: null, invoices_7d: 0 });
  assert.deepEqual([t.attention, t.severity], [[], null]);
});

// --- the whole fleet ----------------------------------------------------------------------------------------------------------

const FLEET = () => [
  shapeTenant(row({ restaurant_id: 'a', name: 'Alpha', plan: 'pro' }), NOW),
  shapeTenant(row({ restaurant_id: 'b', name: 'bravo', plan: 'starter', plan_status: 'trialing', trial_ends_at: ahead(2 * DAY) }), NOW),
  shapeTenant(row({ restaurant_id: 'c', name: 'Charlie', plan: 'starter', plan_status: 'past_due', hub_seen_at: ago(3 * DAY), hub_reported_at: ago(3 * DAY) }), NOW),
  shapeTenant(row({ restaurant_id: 'd', name: 'Delta', plan: 'enterprise', plan_status: 'suspended', hub_seen_at: null, hub_reported_at: null }), NOW),
  shapeTenant(row({ restaurant_id: 'e', name: 'Echo', plan: 'free', plan_status: 'paused', hub_seen_at: ago(HOUR), hub_reported_at: ago(HOUR) }), NOW),
  shapeTenant(row({ restaurant_id: 'f', name: 'Foxtrot', plan: 'pro', plan_status: 'cancelled', hub_seen_at: ago(30 * DAY), hub_reported_at: ago(30 * DAY) }), NOW)
];

test('the fleet is counted by state, plan, hub and by how much attention it needs; a value nobody expected is counted as "other"', () => {
  assert.deepEqual(fleetSummary(FLEET()), {
    tenants: 6,
    by_status: { active: 1, trialing: 1, past_due: 1, suspended: 1, cancelled: 1, other: 1 },
    by_plan: { starter: 2, pro: 2, enterprise: 1, other: 1 },
    hubs: { live: 2, quiet: 1, silent: 2, never: 1 },
    attention: { high: 2, medium: 1 }
  });
  assert.deepEqual(fleetSummary([]), {
    tenants: 0, by_status: { active: 0, trialing: 0, past_due: 0, suspended: 0, cancelled: 0, other: 0 },
    by_plan: { starter: 0, pro: 0, enterprise: 0, other: 0 }, hubs: { live: 0, quiet: 0, silent: 0, never: 0 }, attention: { high: 0, medium: 0 }
  });
});

test('the list to look at is one line per reason, worst first, then by restaurant', () => {
  const list = attentionList(FLEET());
  assert.deepEqual(list.map(a => [a.name, a.code, a.severity]), [
    ['Charlie', 'past_due', 'high'],
    ['Delta', 'suspended', 'high'],
    ['bravo', 'trial_ending', 'medium'],
    ['Charlie', 'hub_silent', 'medium'],
    ['Delta', 'hub_never_seen', 'medium']
  ]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['code', 'message', 'name', 'restaurant_id', 'severity']);
  assert.equal(list[0].restaurant_id, 'c');
});

test('a tie in severity is broken by name, whatever order the restaurants came in', () => {
  const backwards = [...FLEET()].reverse();
  assert.deepEqual(rankTenants(backwards).map(t => t.name), ['Charlie', 'Delta', 'bravo', 'Alpha', 'Echo', 'Foxtrot']);
  assert.deepEqual(attentionList(backwards).map(a => [a.name, a.code]), [['Charlie', 'past_due'], ['Delta', 'suspended'], ['bravo', 'trial_ending'], ['Charlie', 'hub_silent'], ['Delta', 'hub_never_seen']]);
});

test('restaurants are listed worst first, then by name regardless of capitals', () => {
  assert.deepEqual(rankTenants(FLEET()).map(t => t.name), ['Charlie', 'Delta', 'bravo', 'Alpha', 'Echo', 'Foxtrot']);
  const input = FLEET();
  rankTenants(input);
  assert.equal(input[0].name, 'Alpha', 'the list it was given is not reordered');
});

// --- events and subscriptions -------------------------------------------------------------------------------------------------

test('an event is what happened, to whom and when, and nothing Razorpay sent', () => {
  const e = shapeEvent({ id: 'e1', restaurant_id: 'r-1', restaurant_name: 'Hotel Mejwani', razorpay_subscription_id: 'sub_1', event: 'subscription.halted', applied_plan_status: 'past_due', received_at: ago(HOUR), payload: { customer: 'x@y.z' } });
  assert.deepEqual(e, { id: 'e1', restaurant_id: 'r-1', restaurant_name: 'Hotel Mejwani', razorpay_subscription_id: 'sub_1', event: 'subscription.halted', applied_plan_status: 'past_due', received_at: ago(HOUR) });
  assert.deepEqual(shapeEvent({ id: 'e2', event: 'x', received_at: ago(HOUR) }), { id: 'e2', restaurant_id: null, restaurant_name: null, razorpay_subscription_id: null, event: 'x', applied_plan_status: null, received_at: ago(HOUR) });
});

test('a subscription is shown by its state and its dates, without the payment link', () => {
  const s = shapeSubscription({
    razorpay_subscription_id: 'sub_1', status: 'active', plan: 'pro', plan_change_to: 'starter', cancel_requested_at: null,
    current_start: ago(10 * DAY), current_end: ahead(20 * DAY), last_event_at: ago(DAY), created_at: ago(60 * DAY), short_url: 'https://rzp.io/secret', razorpay_customer_id: 'cust_1'
  });
  assert.deepEqual(s, {
    razorpay_subscription_id: 'sub_1', status: 'active', plan: 'pro', plan_change_to: 'starter', cancel_requested_at: null,
    current_start: ago(10 * DAY), current_end: ahead(20 * DAY), last_event_at: ago(DAY), created_at: ago(60 * DAY)
  });
});
