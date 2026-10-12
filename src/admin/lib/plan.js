// The owner console's plan view, without React (M3 · PR 18). Everything here turns one GET /plan
// answer into what the page shows: the labels, the banner, and how close each count is to its limit.

export const PLAN_LABEL = { starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' };

export const FEATURE_LABEL = {
  split_bill: 'Split a bill',
  refunds: 'Refunds',
  modifiers: 'Dish options (spice, extras)',
  day_part_pricing: 'Day-part pricing',
  multi_station_kot: 'Multi-station kitchen tickets'
};

export const LIMIT_LABEL = { devices: 'Waiter handsets', waiters: 'Waiters', tables: 'Tables', printers: 'Printers' };

// What each degradation means for the restaurant, in the owner's words rather than the status code's.
const DEGRADED_COPY = {
  TRIAL_EXPIRED: 'The free trial has ended, so this restaurant is on Starter for now.',
  PAYMENT_OVERDUE: 'A payment is overdue and the grace period has passed, so this restaurant is on Starter for now.',
  SUSPENDED: 'This subscription is suspended, so this restaurant is on Starter for now.',
  CANCELLED: 'This subscription was cancelled, so this restaurant is on Starter for now.'
};

const FALLBACK_DEGRADED = 'This subscription is not active, so this restaurant is on Starter for now.';

export const planLabel = id => PLAN_LABEL[id] || id;

/** An ISO timestamp as a readable local time; anything missing or unparseable reads as never. */
export function formatWhen(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The one message at the top of the tab, or null when the subscription is healthy.
 * Degradation outranks the grace period: once a tenant has actually dropped to Starter, saying
 * "everything still works" would be wrong.
 */
export function planBanner(plan) {
  if (!plan) return null;
  if (plan.degraded) {
    return {
      tone: 'error',
      title: `Running on ${planLabel(plan.plan)}, not ${planLabel(plan.requested_plan)}`,
      body: `${DEGRADED_COPY[plan.degraded_reason] || FALLBACK_DEGRADED} Orders, billing and the kitchen display are never switched off.`
    };
  }
  if (plan.in_grace) {
    const until = plan.grace_ends_at ? ` until ${formatWhen(plan.grace_ends_at)}` : '';
    return {
      tone: 'warning',
      title: 'Payment overdue',
      body: `Everything still works${until}. After that this restaurant drops to Starter.`
    };
  }
  return null;
}

/**
 * How close a count is to its limit, as the tone the row is drawn in -- so "at the limit" is
 * visible without reading the numbers. `limit` of null means the plan does not cap it.
 */
export function usageTone(current, limit) {
  if (limit === null || limit === undefined) return 'none';
  if (!Number.isFinite(current)) return 'none';
  if (current >= limit) return 'rust';
  if (current >= limit - 1) return 'amber';
  return 'green';
}

/**
 * One row per limit the plan defines. `usage` only covers what the hub counts: the tables cap is
 * applied when a restaurant is set up, not here, so that row shows the cap with no count.
 */
export function limitRows(plan) {
  const limits = plan?.limits || {};
  return Object.keys(limits).map(key => {
    const limit = limits[key];
    const current = plan?.usage?.[key];
    const counted = Number.isFinite(current);
    const unlimited = limit === null || limit === undefined;
    return {
      key,
      label: LIMIT_LABEL[key] || key,
      limit,
      current: counted ? current : null,
      counted,
      unlimited,
      tone: usageTone(current, limit),
      // Only meaningful for a counted, capped row; the bar is hidden otherwise.
      percent: unlimited || !counted || !limit ? 0 : Math.min(100, Math.round((current / limit) * 100)),
      text: `${counted ? current : '–'}${unlimited ? ' of unlimited' : ` of ${limit}`}`
    };
  });
}

/** One row per feature the plan defines, in a stable order. */
export function featureRows(plan) {
  const features = plan?.features || {};
  return Object.keys(features).map(key => ({
    key,
    label: FEATURE_LABEL[key] || key,
    on: Boolean(features[key]),
    text: features[key] ? 'Included' : 'Not on this plan'
  }));
}
