// What an event on a restaurant's timeline says, in words (Phase 2, P2-1; docs/SUPER_ADMIN_BUILD_SHEET.md). Pure: an event row in, a kind and a sentence out.
// The timeline is meant to be READ by a person, so a type name and a block of JSON are not an answer: "Subscription halted: the payment could not be
// collected" is.
//
// Two things are guarded. Only the fields each event type is known to carry are used, by name, so nothing else that ever lands in a payload (a Razorpay
// customer, a subscription id, the service hours themselves) is turned into words on a screen. And a payload that is missing, or has a field of the
// wrong type, never breaks the screen and never says something it does not know: it says less.
//
// The KIND agrees with the database's filter (migration 025, `admin_tenant_timeline`): the type wins over the source (an alert is an alert, even one a
// person acknowledged), then Razorpay's events are billing and the hub's are hub. A test runs the two against real events to pin that they agree.

import { alertWords } from './alertEngine.js';

export const EVENT_KINDS = ['billing', 'hub', 'alerts', 'admin'];

const oneLine = text => String(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
const isText = value => typeof value === 'string' && value.trim() !== '';
const isCount = value => Number.isInteger(value) && value >= 0;
const quoted = (label, type) => `${label} “${oneLine(type)}”`;

/** Which kind of thing this event is: billing, hub, alerts, admin, or other. */
export function eventKind(event) {
  if (!event || typeof event !== 'object') return 'other';
  const type = typeof event.type === 'string' ? event.type : '';
  if (type.startsWith('alert.')) return 'alerts';
  if (type.startsWith('admin.')) return 'admin';
  if (event.source === 'razorpay') return 'billing';
  if (event.source === 'hub') return 'hub';
  return 'other';
}

const BILLING = {
  'subscription.authenticated': 'Subscription authenticated',
  'subscription.activated': 'Subscription activated',
  'subscription.charged': 'Payment received',
  'subscription.pending': 'A payment is pending',
  'subscription.halted': 'Subscription halted: the payment could not be collected',
  'subscription.cancelled': 'Subscription cancelled',
  'subscription.paused': 'Subscription paused',
  'subscription.resumed': 'Subscription resumed',
  'subscription.completed': 'Subscription completed',
  'subscription.updated': 'Subscription changed'
};

function billing(type, payload) {
  const title = BILLING[type] ?? quoted('Razorpay event', type);
  const status = payload.applied_plan_status;
  return { title, text: isText(status) ? `The plan status is now ${oneLine(status).replace(/_/g, ' ')}.` : '' };
}

function shelved(payload) {
  const { from, to } = payload;
  const generic = { title: 'The number of shelved orders changed', text: '' };
  if (!isCount(from) || !isCount(to) || from === to) return generic;
  if (to === 0) return { title: 'Shelved orders were cleared', text: `Was ${from}.` };
  if (from === 0) return { title: 'Orders were shelved', text: `Now ${to} (was ${from}).` };
  return { title: to > from ? 'More orders were shelved' : 'Fewer orders are shelved', text: `Now ${to} (was ${from}).` };
}

function hub(type, payload) {
  switch (type) {
    case 'hub.first_report': return { title: 'The hub reported for the first time', text: isText(payload.version) ? `Version ${oneLine(payload.version)}.` : '' };
    case 'hub.version_changed': {
      const from = isText(payload.from) ? oneLine(payload.from) : null;
      const to = isText(payload.to) ? oneLine(payload.to) : null;
      return { title: 'The hub was updated', text: from && to ? `From ${from} to ${to}.` : to ? `To ${to}.` : '' };
    }
    case 'hub.restarted': return { title: 'The hub restarted', text: '' };
    case 'hub.shelved_changed': return shelved(payload);
    default: return { title: quoted('Hub event', type), text: '' };
  }
}

/** The one thing an alert's events are about, in the inbox's own words. */
const whatOf = payload => (isText(payload.rule_key) ? alertWords(payload.rule_key, payload.detail).what : 'an alert');
const quote = reason => (isText(reason) ? `“${reason}”` : '');

function alerts(type, payload, event) {
  const what = whatOf(payload);
  const who = isText(event.actor_email) ? oneLine(event.actor_email) : 'a founder';
  switch (type) {
    case 'alert.opened': {
      const severity = isText(payload.severity) ? ` (${oneLine(payload.severity)})` : '';
      return { title: `Alert opened${severity}: ${what}`, text: isText(payload.rule_key) ? alertWords(payload.rule_key, payload.detail).text : '' };
    }
    case 'alert.acked': return { title: `Alert acknowledged by ${who} (${what})`, text: quote(payload.reason) };
    case 'alert.resolved':
      if (payload.by === 'admin') return { title: `Alert resolved by ${who} (${what})`, text: quote(payload.reason) };
      if (payload.reason === 'condition_cleared') return { title: `Alert resolved (${what}): the problem cleared on its own`, text: '' };
      return { title: `Alert resolved (${what})`, text: quote(payload.reason) };
    case 'alert.notified': return { title: Number.isInteger(payload.level) && payload.level >= 1 ? `Reminder ${payload.level} was sent` : 'The founders were paged', text: '' };
    case 'alert.notify_failed': return { title: 'A page could not be sent', text: isText(payload.note) ? oneLine(payload.note) : '' };
    case 'alert.unattended': return { title: 'Nobody answered after every reminder', text: '' };
    default: return { title: quoted('Alert event', type), text: '' };
  }
}

function admin(type, payload) {
  if (type === 'admin.service_hours_set') return { title: 'Service hours were set', text: isText(payload.timezone) ? `Time zone ${oneLine(payload.timezone)}.` : '' };
  return { title: quoted('Administrator action', type), text: '' };
}

/** `{ kind, title, text }` for one event: a one-line sentence and, where there is more to say, a second line. Never throws. */
export function describeEvent(event) {
  const kind = eventKind(event);
  if (!event || typeof event !== 'object') return { kind, title: 'An event', text: '' };
  const type = typeof event.type === 'string' ? event.type : '';
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
  const said = kind === 'billing' ? billing(type, payload)
    : kind === 'hub' ? hub(type, payload)
      : kind === 'alerts' ? alerts(type, payload, event)
        : kind === 'admin' ? admin(type, payload)
          : { title: quoted('Event', type), text: '' };
  return { kind, title: oneLine(said.title), text: said.text };
}
