// How the operator console says things: when, how long ago, what a status or an event is called, and which restaurants a filter keeps.
// Plain functions of the moment they are given; none reads a clock.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const DAYS_BEFORE_WEEKS = 45;   // "in 20 days" is worth knowing for a renewal; "in 3 weeks" is enough for a hub last seen in September

const NONE = '—';

const moment = iso => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

/** How long ago `iso` was, or how long until it is, as of `now` ("5 min ago", "in 3 days"). `none` for a time that is not one. */
export function relative(iso, now, none = NONE) {
  const t = moment(iso);
  if (t === null) return none;
  const diff = t - now;
  const span = Math.abs(diff);
  if (span < 45 * 1000) return 'just now';
  let words;
  if (span < HOUR) words = `${Math.max(1, Math.floor(span / MIN))} min`;
  else if (span < DAY) words = plural(Math.floor(span / HOUR), 'hour');
  else if (span < DAYS_BEFORE_WEEKS * DAY) words = plural(Math.floor(span / DAY), 'day');
  else words = plural(Math.floor(span / WEEK), 'week');
  return diff < 0 ? `${words} ago` : `in ${words}`;
}

/** A date, in the viewer's own time zone unless one is given. */
export function day(iso, timeZone) {
  const t = moment(iso);
  if (t === null) return NONE;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(timeZone ? { timeZone } : {}) });
}

const STATUS = { active: 'Active', trialing: 'On trial', past_due: 'Overdue', suspended: 'Suspended', cancelled: 'Cancelled' };
export const statusLabel = status => (status ? STATUS[status] ?? status : NONE);

const HUB = { live: 'Live', quiet: 'Quiet', silent: 'Silent', never: 'Never reported' };
export const hubLabel = state => HUB[state] ?? state;

export const severityLabel = severity => ({ high: 'High', medium: 'Medium' })[severity] ?? '';

const EVENTS = {
  'subscription.authenticated': 'Payment authorised',
  'subscription.activated': 'Subscription started',
  'subscription.charged': 'Payment taken',
  'subscription.pending': 'Payment pending',
  'subscription.halted': 'Payment failed, subscription halted',
  'subscription.paused': 'Subscription paused',
  'subscription.resumed': 'Subscription resumed',
  'subscription.updated': 'Subscription changed',
  'subscription.cancelled': 'Subscription cancelled',
  'subscription.completed': 'Subscription ran its course'
};
/** What a subscription event was, in plain words; one it does not know is shown as it came. */
export const eventLabel = event => EVENTS[event] ?? event;

/** Tones the screen colours by: good, warning, bad, or nothing in particular. */
export const statusTone = status => ({ active: 'good', trialing: 'info', past_due: 'bad', suspended: 'bad', cancelled: 'muted' })[status] ?? 'muted';
export const hubTone = state => ({ live: 'good', quiet: 'muted', silent: 'warning', never: 'warning' })[state] ?? 'muted';
export const severityTone = severity => ({ high: 'bad', medium: 'warning' })[severity] ?? 'muted';

const SKEW_MS = 5 * MIN;
/** How far a hub's clock is from the database's, when it is more than a sleeping laptop explains: "6 minutes ahead". */
export function clockSkew(hub) {
  const reported = moment(hub?.reported_at);
  const seen = moment(hub?.seen_at);
  if (reported === null || seen === null) return null;
  const gap = reported - seen;
  if (Math.abs(gap) <= SKEW_MS) return null;
  const span = Math.abs(gap);
  const words = span >= 2 * HOUR ? plural(Math.floor(span / HOUR), 'hour') : plural(Math.floor(span / MIN), 'minute');
  return `${words} ${gap > 0 ? 'ahead' : 'behind'}`;
}

/** What a restaurant's billing says on one line. */
export function billingLine(tenant, now) {
  if (tenant.plan_status === 'cancelled') return 'Cancelled';
  if (tenant.plan_status === 'trialing' && moment(tenant.trial_ends_at) !== null) {
    return moment(tenant.trial_ends_at) < now ? `Trial ended ${relative(tenant.trial_ends_at, now)}` : `Trial ends ${relative(tenant.trial_ends_at, now)}`;
  }
  const end = moment(tenant.current_period_end);
  if (end === null) return NONE;
  if (end < now) return `Ended ${relative(tenant.current_period_end, now)}`;
  return `${tenant.subscription?.cancel_requested_at ? 'Ends' : 'Renews'} ${relative(tenant.current_period_end, now)}`;
}

// --- looking through the fleet -----------------------------------------------------------------------------------------------------

export const VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'trial', label: 'On trial' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'silent', label: 'Hub silent' }
];

const IN_VIEW = {
  all: () => true,
  attention: t => Boolean(t.severity),
  trial: t => t.plan_status === 'trialing',
  overdue: t => t.plan_status === 'past_due' || t.plan_status === 'suspended',
  // A restaurant that has left is expected to have a hub that is off.
  silent: t => (t.hub?.state === 'silent' || t.hub?.state === 'never') && t.plan_status !== 'cancelled'
};

const digitsOf = text => String(text ?? '').replace(/\D/g, '');

/** Restaurants in a view whose name, city, address name or phone number has what was typed (capitals, spacing and punctuation do not matter). */
export function filterTenants(tenants, { text = '', view = 'all' } = {}) {
  const inView = IN_VIEW[view] ?? IN_VIEW.all;
  const query = String(text).trim().toLowerCase();
  const digits = /^[\d\s+()-]+$/.test(query) ? digitsOf(query) : '';
  return tenants.filter(t => {
    if (!inView(t)) return false;
    const words = [t.name, t.city, t.slug].map(x => String(x ?? '').toLowerCase()).join(' ');
    return words.includes(query) || (digits.length >= 3 && digitsOf(t.phone).includes(digits));
  });
}

/** How many each view would keep, whatever is typed. */
export function countViews(tenants) {
  return Object.fromEntries(VIEWS.map(v => [v.id, tenants.filter(IN_VIEW[v.id]).length]));
}
