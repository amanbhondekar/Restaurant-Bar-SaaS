// What the operator console says about each restaurant (§4.9): pure rules, a row from the `ops_tenants` view (migration 021) and the moment it
// is read in, and what comes out is how the restaurant is doing and why anyone should look at it. Nothing here reads a database or a clock.
//
// The thresholds are the product. A hub that has been quiet for 36 hours is a restaurant that was shut yesterday; one that has been quiet for 36
// hours and a millisecond is one to ring. A rule that fires too early teaches the operator to ignore the list, and one that fires too late is
// no use, so each is a named constant and each is pinned in the tests on both sides.
//
// Only what the screen needs is passed on. A column the view gains later, or a secret that somehow got into a row, goes no further than here.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const OPS_LIMITS = {
  hubLiveMs: 15 * MIN,          // a hub reports every five minutes: three missed is no longer "live"
  hubSilentMs: 36 * HOUR,       // beyond a closed day and a night
  hubGoneMs: 7 * DAY,           // a week of nothing is no longer a closed day
  neverSeenAfterMs: DAY,        // a restaurant gets a day to install its hub before it is flagged
  trialWarnMs: 3 * DAY,
  backlog: 50,                  // bills waiting to reach the cloud
  skewMs: 5 * MIN,              // what a laptop that slept does to its own clock
  eventsOnFleet: 30,
  eventsOnTenant: 50,
  subscriptionsOnTenant: 20,
  maxTenants: 1000,             // what Supabase returns in one answer; more than this is said, not hidden
  failures: { max: 10, windowMs: 15 * MIN },  // wrong tokens from one address before it is turned away
  minTokenLength: 20            // shorter than this is not a secret, and the console stays off
};

const STATUSES = ['active', 'trialing', 'past_due', 'suspended', 'cancelled'];
const PLANS = ['starter', 'pro', 'enterprise'];
const HUB_STATES = ['live', 'quiet', 'silent', 'never'];
const RANK = { high: 2, medium: 1 };

/** A moment in milliseconds, or null if `value` is not one. Only written dates are: the database sends text, and Date.parse('5') is a day in 2001. */
const time = value => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};
const iso = value => { const t = time(value); return t === null ? null : new Date(t).toISOString(); };

/** A whole number of things (never negative), or null when `value` is not one: not knowing is not the same as none. */
const whole = value => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const days = ms => (ms < DAY ? 'less than a day' : plural(Math.floor(ms / DAY), 'day'));
const clockWords = ms => (ms >= 2 * HOUR ? plural(Math.floor(ms / HOUR), 'hour') : plural(Math.floor(ms / MIN), 'minute'));

/** How lately the hub has been heard from: live, quiet (probably shut), silent, or never. */
export function hubState(row, now) {
  const seen = time(row.hub_seen_at);
  if (seen === null) return 'never';
  const age = now - seen;
  if (age <= OPS_LIMITS.hubLiveMs) return 'live';
  return age <= OPS_LIMITS.hubSilentMs ? 'quiet' : 'silent';
}

/**
 * Why anyone should look at this restaurant, worst first. A restaurant that has cancelled is not asking for attention (its hub is meant to be
 * off), except for takings that were shelved: those are money that never reached the cloud, whoever it belongs to.
 */
export function attentionFor(row, now) {
  const out = [];
  const add = (code, severity, message) => out.push({ code, severity, message });
  const status = row.plan_status;
  const stays = status !== 'cancelled';

  if (status === 'past_due') add('past_due', 'high', 'Payment is overdue.');
  if (status === 'suspended') add('suspended', 'high', 'This restaurant is suspended.');

  if (status === 'trialing') {
    const end = time(row.trial_ends_at);
    if (end !== null && end < now) add('trial_ended', 'high', `The trial ended ${days(now - end)} ago and nobody has subscribed.`);
    else if (end !== null && end - now <= OPS_LIMITS.trialWarnMs) add('trial_ending', 'medium', `The trial ends in ${days(end - now)}.`);
  }

  if (stays && time(row.subscription_cancel_requested_at) !== null) {
    const until = iso(row.subscription_period_end);
    add('cancel_requested', 'medium', until ? `Asked to cancel; the plan runs until ${until.slice(0, 10)}.` : 'Asked to cancel.');
  }

  const state = hubState(row, now);
  const created = time(row.created_at);
  if (stays && state === 'never' && created !== null && now - created > OPS_LIMITS.neverSeenAfterMs) {
    add('hub_never_seen', 'medium', 'The hub has never reported. It may not be set up yet.');
  }
  if (stays && state === 'silent') {
    const quiet = now - time(row.hub_seen_at);
    add('hub_silent', quiet > OPS_LIMITS.hubGoneMs ? 'high' : 'medium', `No word from the hub for ${days(quiet)}.`);
  }

  const shelved = whole(row.hub_quarantined);
  if (shelved > 0) {
    add('shelved', 'high', `${shelved} ${shelved === 1 ? 'order was' : 'orders were'} shelved and ${shelved === 1 ? 'has' : 'have'} not reached the cloud.`);
  }
  const waiting = whole(row.hub_queued);
  if (stays && waiting >= OPS_LIMITS.backlog) add('sync_backlog', 'medium', `${waiting} bills are waiting to reach the cloud.`);

  const reported = time(row.hub_reported_at);
  const heard = time(row.hub_seen_at);
  if (stays && reported !== null && heard !== null && Math.abs(reported - heard) > OPS_LIMITS.skewMs) {
    add('clock_skew', 'medium', `The hub's clock is ${clockWords(Math.abs(reported - heard))} ${reported > heard ? 'ahead' : 'behind'}.`);
  }

  // Worst first; within a severity, in the order above (the sort is stable).
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

/** One restaurant, shaped for the screen. */
export function shapeTenant(row, now) {
  const attention = attentionFor(row, now);
  return {
    id: row.restaurant_id,
    name: row.name,
    slug: row.slug ?? null,
    city: row.city ?? null,
    phone: row.phone ?? null,
    plan: row.plan ?? null,
    plan_status: row.plan_status ?? null,
    trial_ends_at: iso(row.trial_ends_at),
    current_period_end: iso(row.current_period_end),
    created_at: iso(row.created_at),
    // A subscription always has a status; one with none is no subscription, not a subscription full of nothing.
    subscription: row.subscription_status ? {
      status: row.subscription_status,
      plan: row.subscription_plan ?? null,
      plan_change_to: row.subscription_plan_change_to ?? null,
      cancel_requested_at: iso(row.subscription_cancel_requested_at),
      period_end: iso(row.subscription_period_end),
      last_event_at: iso(row.subscription_last_event_at)
    } : null,
    hub: {
      state: hubState(row, now),
      seen_at: iso(row.hub_seen_at),
      reported_at: iso(row.hub_reported_at),
      started_at: iso(row.hub_started_at),
      version: typeof row.hub_version === 'string' ? row.hub_version : null,
      queued: whole(row.hub_queued),
      quarantined: whole(row.hub_quarantined),
      last_synced_at: iso(row.hub_last_synced_at),
      devices: whole(row.hub_devices),
      waiters: whole(row.hub_waiters)
    },
    activity: { last_invoice_at: iso(row.last_invoice_at), invoices_7d: whole(row.invoices_7d) ?? 0 },
    attention,
    severity: attention[0]?.severity ?? null
  };
}

const named = (counts, value, known) => { counts[known.includes(value) ? value : 'other'] += 1; };

/** The fleet counted: by state, by plan, by how lately the hub was heard from, and by how much attention it needs. */
export function fleetSummary(tenants) {
  const zero = keys => Object.fromEntries([...keys, 'other'].map(k => [k, 0]));
  const summary = {
    tenants: tenants.length,
    by_status: zero(STATUSES),
    by_plan: zero(PLANS),
    hubs: Object.fromEntries(HUB_STATES.map(k => [k, 0])),
    attention: { high: 0, medium: 0 }
  };
  for (const t of tenants) {
    named(summary.by_status, t.plan_status, STATUSES);
    named(summary.by_plan, t.plan, PLANS);
    summary.hubs[t.hub.state] += 1;
    if (t.severity) summary.attention[t.severity] += 1;
  }
  return summary;
}

const byName = (a, b) => {
  const x = String(a.name).toLowerCase();
  const y = String(b.name).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};
const bySeverityThenName = (a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || byName(a, b);

/** The list to look at: one line per reason, worst first, then by restaurant. */
export function attentionList(tenants) {
  return tenants
    .flatMap(t => t.attention.map(a => ({ restaurant_id: t.id, name: t.name, ...a })))
    .sort(bySeverityThenName);
}

/** Restaurants worst first, then by name regardless of capitals. The list it is given is not reordered. */
export function rankTenants(tenants) {
  return [...tenants].sort(bySeverityThenName);
}

/** What happened, to whom and when, and nothing Razorpay sent. */
export function shapeEvent(row) {
  return {
    id: row.id,
    restaurant_id: row.restaurant_id ?? null,
    restaurant_name: row.restaurant_name ?? null,
    razorpay_subscription_id: row.razorpay_subscription_id ?? null,
    event: row.event,
    applied_plan_status: row.applied_plan_status ?? null,
    received_at: iso(row.received_at)
  };
}

/** A subscription by its state and its dates, without the payment link or the customer. */
export function shapeSubscription(row) {
  return {
    razorpay_subscription_id: row.razorpay_subscription_id,
    status: row.status,
    plan: row.plan ?? null,
    plan_change_to: row.plan_change_to ?? null,
    cancel_requested_at: iso(row.cancel_requested_at),
    current_start: iso(row.current_start),
    current_end: iso(row.current_end),
    last_event_at: iso(row.last_event_at),
    created_at: iso(row.created_at)
  };
}
