import test from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_KINDS, eventKind, describeEvent } from '../../common/eventWords.js';

// Phase 2, P2-1: what an event on a restaurant's timeline says, in words, and which kind of thing it is. Pure: an event row in, a sentence out.
//
// What matters: a person reading the timeline sees what happened in plain language and not a type name or a JSON blob; the kind agrees with the
// database's own filter (migration 025: the API test pins that the two give the same answer on real events); a payload that is missing or odd never
// breaks the screen; and only the fields each event type is known to carry can reach it, so nothing else that ever lands in a payload is shown as words.

const ev = (type, over = {}) => ({
  id: 1, restaurant_id: 'r-1', occurred_at: '2026-10-27T10:00:00.000Z', source: 'system', actor_type: 'system', actor_id: null, actor_email: null, request_id: null,
  payload: {}, chain_seq: 1, row_hash: 'a'.repeat(64), type, ...over
});
const said = (type, over) => describeEvent(ev(type, over));

// --- kinds -------------------------------------------------------------------------------------------------------------------------

test('the kinds are billing, hub, alerts and admin actions, and there is an "other" for anything else', () => {
  assert.deepEqual(EVENT_KINDS, ['billing', 'hub', 'alerts', 'admin']);
});

test('an event is an alert if its type says so, an admin action if its type says that, otherwise by where it came from', () => {
  assert.equal(eventKind(ev('alert.opened')), 'alerts');
  assert.equal(eventKind(ev('alert.acked', { source: 'admin', actor_type: 'admin' })), 'alerts', 'an alert a person acknowledged is still an alert');
  assert.equal(eventKind(ev('admin.service_hours_set')), 'admin');
  assert.equal(eventKind(ev('subscription.halted', { source: 'razorpay' })), 'billing');
  assert.equal(eventKind(ev('hub.restarted', { source: 'hub' })), 'hub');
  assert.equal(eventKind(ev('something.else', { source: 'support' })), 'other');
});

test('the type wins over the source, as it does in the database: a Razorpay-sourced "alert." or "admin." event is not billing', () => {
  assert.equal(eventKind(ev('alert.opened', { source: 'razorpay' })), 'alerts');
  assert.equal(eventKind(ev('admin.x', { source: 'hub' })), 'admin');
  assert.equal(eventKind(ev('alert.x', { source: 'hub' })), 'alerts');
});

test('something that is not an event is "other", and never throws', () => {
  for (const odd of [null, undefined, {}, 'x', 5, [], { type: 5 }, { type: null, source: null }]) assert.equal(eventKind(odd), 'other', String(odd));
  for (const odd of [null, undefined, {}, 'x', 5, []]) assert.doesNotThrow(() => describeEvent(odd), String(odd));
});

// --- billing -----------------------------------------------------------------------------------------------------------------------

const billing = (type, payload = {}) => said(type, { source: 'razorpay', actor_type: 'webhook', payload });

test('Razorpay\'s events are said in words, and the plan status they left is said too', () => {
  const cases = [
    ['subscription.authenticated', 'Subscription authenticated'],
    ['subscription.activated', 'Subscription activated'],
    ['subscription.charged', 'Payment received'],
    ['subscription.pending', 'A payment is pending'],
    ['subscription.halted', 'Subscription halted: the payment could not be collected'],
    ['subscription.cancelled', 'Subscription cancelled'],
    ['subscription.paused', 'Subscription paused'],
    ['subscription.resumed', 'Subscription resumed'],
    ['subscription.completed', 'Subscription completed'],
    ['subscription.updated', 'Subscription changed']
  ];
  for (const [type, title] of cases) {
    const d = billing(type, { applied_plan_status: 'past_due' });
    assert.equal(d.kind, 'billing');
    assert.equal(d.title, title, type);
    assert.equal(d.text, 'The plan status is now past due.', type);
  }
});

test('an event with no plan status left says nothing about one, and a status with an underscore is read as words', () => {
  assert.equal(billing('subscription.charged', {}).text, '');
  assert.equal(billing('subscription.charged', { applied_plan_status: null }).text, '');
  assert.equal(billing('subscription.charged', { applied_plan_status: 'active' }).text, 'The plan status is now active.');
  assert.equal(billing('subscription.charged', { applied_plan_status: 'past_due' }).text, 'The plan status is now past due.');
});

test('a Razorpay event it has no words for says its name, in quotes, and nothing is invented about it', () => {
  const d = billing('payment.dispute.created', { applied_plan_status: 'active' });
  assert.equal(d.title, 'Razorpay event “payment.dispute.created”');
  assert.equal(d.kind, 'billing');
});

test('nothing in a billing payload beyond the plan status is shown: not the subscription id, not a customer', () => {
  const d = billing('subscription.charged', { applied_plan_status: 'active', razorpay_subscription_id: 'sub_SECRET123', customer: 'Ravi Kumar', email: 'ravi@example.test' });
  const text = JSON.stringify(d);
  for (const leak of ['sub_SECRET123', 'Ravi', 'ravi@example.test']) assert.ok(!text.includes(leak), leak);
});

// --- the hub -----------------------------------------------------------------------------------------------------------------------

const hub = (type, payload = {}) => said(type, { source: 'hub', actor_type: 'hub', payload });

test('a hub\'s first report, update and restart', () => {
  const first = hub('hub.first_report', { version: '1.4.2', started_at: '2026-10-27T09:00:00.000Z' });
  assert.deepEqual([first.kind, first.title, first.text], ['hub', 'The hub reported for the first time', 'Version 1.4.2.']);
  assert.equal(hub('hub.first_report', {}).text, '');
  const up = hub('hub.version_changed', { from: '1.4.2', to: '1.5.0' });
  assert.deepEqual([up.title, up.text], ['The hub was updated', 'From 1.4.2 to 1.5.0.']);
  assert.equal(hub('hub.version_changed', { from: null, to: '1.5.0' }).text, 'To 1.5.0.');
  assert.equal(hub('hub.version_changed', {}).text, '');
  assert.equal(hub('hub.restarted', { started_at: '2026-10-27T09:00:00.000Z' }).title, 'The hub restarted');
});

test('shelved orders: more, fewer, and cleared are each said as what they are, with the counts', () => {
  assert.deepEqual([hub('hub.shelved_changed', { from: 0, to: 2 }).title, hub('hub.shelved_changed', { from: 0, to: 2 }).text], ['Orders were shelved', 'Now 2 (was 0).']);
  assert.deepEqual([hub('hub.shelved_changed', { from: 2, to: 5 }).title, hub('hub.shelved_changed', { from: 2, to: 5 }).text], ['More orders were shelved', 'Now 5 (was 2).']);
  assert.deepEqual([hub('hub.shelved_changed', { from: 5, to: 2 }).title, hub('hub.shelved_changed', { from: 5, to: 2 }).text], ['Fewer orders are shelved', 'Now 2 (was 5).']);
  assert.deepEqual([hub('hub.shelved_changed', { from: 3, to: 0 }).title, hub('hub.shelved_changed', { from: 3, to: 0 }).text], ['Shelved orders were cleared', 'Was 3.']);
  assert.equal(hub('hub.shelved_changed', {}).title, 'The number of shelved orders changed');
});

test('a hub event it does not know says what it is, as a hub event', () => {
  const d = hub('hub.something_new', { x: 1 });
  assert.equal(d.kind, 'hub');
  assert.equal(d.title, 'Hub event “hub.something_new”');
});

// --- alerts ------------------------------------------------------------------------------------------------------------------------

const alert = (type, payload = {}, over = {}) => said(type, { source: 'system', payload, ...over });

test('an alert opening says how bad it is and what is wrong, in the same words as the inbox', () => {
  const d = alert('alert.opened', { alert_id: 7, rule_key: 'orders_shelved', severity: 'P1', detail: { count: 2 } });
  assert.equal(d.kind, 'alerts');
  assert.equal(d.title, 'Alert opened (P1): orders shelved');
  assert.match(d.text, /^2 orders were shelved/);
  const hubSilent = alert('alert.opened', { rule_key: 'hub_silent_service', severity: 'P1', detail: { silent_ms: 1200000 } });
  assert.equal(hubSilent.title, 'Alert opened (P1): hub silent while open');
  assert.match(hubSilent.text, /20 minutes/);
});

test('an acknowledgement names the person and says what they said; with nobody named it says a founder', () => {
  const d = alert('alert.acked', { alert_id: 7, rule_key: 'orders_shelved', reason: 'ringing the owner now' }, { source: 'admin', actor_type: 'admin', actor_email: 'aman@example.test' });
  assert.equal(d.title, 'Alert acknowledged by aman@example.test (orders shelved)');
  assert.equal(d.text, '“ringing the owner now”');
  assert.equal(alert('alert.acked', { rule_key: 'orders_shelved', reason: 'ringing the owner now' }, { source: 'admin', actor_type: 'admin' }).title, 'Alert acknowledged by a founder (orders shelved)');
});

test('a resolution by the system says the problem cleared; by a person, who and why', () => {
  const system = alert('alert.resolved', { rule_key: 'sync_backlog', reason: 'condition_cleared', by: 'system' });
  assert.equal(system.title, 'Alert resolved (bills waiting to sync): the problem cleared on its own');
  assert.equal(system.text, '');
  const person = alert('alert.resolved', { rule_key: 'sync_backlog', reason: 'the hub is back on', by: 'admin' }, { source: 'admin', actor_type: 'admin', actor_email: 'darshil@example.test' });
  assert.equal(person.title, 'Alert resolved by darshil@example.test (bills waiting to sync)');
  assert.equal(person.text, '“the hub is back on”');
});

test('paging: the first page, each reminder, a page that failed, and an alert nobody answered', () => {
  assert.equal(alert('alert.notified', { alert_id: 7, level: 0 }).title, 'The founders were paged');
  assert.equal(alert('alert.notified', { alert_id: 7, level: 1 }).title, 'Reminder 1 was sent');
  assert.equal(alert('alert.notified', { alert_id: 7, level: 3 }).title, 'Reminder 3 was sent');
  const failed = alert('alert.notify_failed', { alert_id: 7, level: 0, note: 'FetchError' });
  assert.equal(failed.title, 'A page could not be sent');
  assert.equal(failed.text, 'FetchError');
  assert.equal(alert('alert.unattended', { alert_id: 7, rule_key: 'orders_shelved' }).title, 'Nobody answered after every reminder');
});

test('an alert event it does not know says what it is, as an alert event', () => {
  const d = alert('alert.something_new', {});
  assert.equal(d.kind, 'alerts');
  assert.equal(d.title, 'Alert event “alert.something_new”');
});

test('an alert for a rule it has no words for names the rule rather than failing', () => {
  assert.equal(alert('alert.opened', { rule_key: 'something_new', severity: 'P2' }).title, 'Alert opened (P2): something_new');
});

// --- admin actions -----------------------------------------------------------------------------------------------------------------

test('service hours being set says where, and an admin event it does not know says what it is', () => {
  const d = said('admin.service_hours_set', { payload: { timezone: 'Asia/Kolkata', service_hours: { mon: [['11:00', '23:00']] } } });
  assert.deepEqual([d.kind, d.title, d.text], ['admin', 'Service hours were set', 'Time zone Asia/Kolkata.']);
  assert.ok(!JSON.stringify(d).includes('11:00'), 'not the hours themselves');
  assert.equal(said('admin.service_hours_set', { payload: {} }).text, '');
  const other = said('admin.something_new', { actor_email: 'aman@example.test' });
  assert.equal(other.kind, 'admin');
  assert.equal(other.title, 'Administrator action “admin.something_new”');
});

// --- anything else, and anything odd -----------------------------------------------------------------------------------------------

test('an event of a kind it does not know says its type and nothing more', () => {
  const d = said('support.note_added', { source: 'support', payload: { note: 'a private note about a guest' } });
  assert.deepEqual([d.kind, d.title, d.text], ['other', 'Event “support.note_added”', '']);
});

test('what comes out is exactly a kind, a title and a text, each a string, and a title is one line', () => {
  const samples = [
    alert('alert.opened', { rule_key: 'orders_shelved', severity: 'P1', detail: { count: 1 } }),
    alert('alert.acked', { rule_key: 'orders_shelved', reason: 'line one\nline two' }, { actor_email: 'a@b.c' }),
    billing('subscription.charged', { applied_plan_status: 'active' }),
    hub('hub.restarted'),
    said('weird\ntype\r\nname', { payload: { a: 1 } })
  ];
  for (const d of samples) {
    assert.deepEqual(Object.keys(d).sort(), ['kind', 'text', 'title']);
    assert.ok([...EVENT_KINDS, 'other'].includes(d.kind));
    assert.equal(typeof d.title, 'string');
    assert.equal(typeof d.text, 'string');
    assert.ok(!/[\r\n]/.test(d.title), JSON.stringify(d.title));
  }
});

test('a payload that is missing, null, a list or a string is treated as empty', () => {
  for (const payload of [undefined, null, [], 'x', 5, [1, 2]]) {
    for (const [type, over] of [['alert.opened', {}], ['hub.version_changed', { source: 'hub' }], ['subscription.charged', { source: 'razorpay' }], ['admin.service_hours_set', {}]]) {
      assert.doesNotThrow(() => said(type, { ...over, payload }), `${type} ${JSON.stringify(payload)}`);
      assert.equal(typeof said(type, { ...over, payload }).title, 'string');
    }
  }
});

test('values of the wrong type inside a payload are not shown as if they were right', () => {
  assert.equal(hub('hub.shelved_changed', { from: 'many', to: { x: 1 } }).title, 'The number of shelved orders changed');
  assert.equal(hub('hub.version_changed', { from: { a: 1 }, to: ['x'] }).text, '');
  assert.equal(hub('hub.first_report', { version: { a: 1 } }).text, '');
  assert.equal(alert('alert.notified', { level: 'two' }).title, 'The founders were paged');
  assert.equal(alert('alert.notified', { level: -1 }).title, 'The founders were paged');
  assert.equal(billing('subscription.charged', { applied_plan_status: { x: 1 } }).text, '');
});

test('describing does not change the event it is given', () => {
  const e = ev('alert.acked', { payload: { rule_key: 'orders_shelved', reason: 'x'.repeat(20) }, actor_email: 'a@b.c' });
  const before = JSON.stringify(e);
  describeEvent(e);
  assert.equal(JSON.stringify(e), before);
});

// --- what the mutation check pointed at ---------------------------------------------------------------------------------------------

test('a shelved count that did not change is not said to have gone up or down', () => {
  assert.equal(hub('hub.shelved_changed', { from: 2, to: 2 }).title, 'The number of shelved orders changed');
  assert.equal(hub('hub.shelved_changed', { from: 0, to: 0 }).text, '');
});

test('a resolution by the system for any reason but the problem clearing says what the reason was', () => {
  const d = alert('alert.resolved', { rule_key: 'sync_backlog', reason: 'closed by a script', by: 'system' });
  assert.equal(d.title, 'Alert resolved (bills waiting to sync)');
  assert.equal(d.text, '“closed by a script”');
});

test('only a whole number of one or more is a reminder: "2" and 1.5 are not', () => {
  for (const level of ['2', 1.5, null, true, [2]]) assert.equal(alert('alert.notified', { level }).title, 'The founders were paged', String(level));
});

test('an alert with no rule named says it is "an alert", not "undefined"', () => {
  assert.equal(alert('alert.opened', { severity: 'P1' }).title, 'Alert opened (P1): an alert');
  assert.equal(alert('alert.acked', {}, { actor_email: 'a@b.c' }).title, 'Alert acknowledged by a@b.c (an alert)');
  assert.equal(alert('alert.opened', { rule_key: 5, severity: 'P1' }).title, 'Alert opened (P1): an alert');
});

test('a title is one line even when what it is built from is not', () => {
  const separator = String.fromCharCode(0x2028);
  const newline = String.fromCharCode(10);
  const d = alert('alert.opened', { rule_key: ['line one', 'line two', 'three'].join(newline), severity: 'P1' });
  assert.ok(!/[\r\n]/.test(d.title), JSON.stringify(d.title));
  const acked = alert('alert.acked', { rule_key: 'a' + separator + 'b' }, { actor_email: 'x' + newline + 'y@z.c' });
  assert.ok(!/[\r\n]/.test(acked.title) && !acked.title.includes(separator), JSON.stringify(acked.title));
});
