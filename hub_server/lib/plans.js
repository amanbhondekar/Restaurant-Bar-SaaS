/**
 * Subscription plans and entitlements (M3 · PR 16).
 *
 * Pure module — no I/O, no clock unless injected — so the same rules can be
 * shared by the hub, the owner console, and the signup flow, and tested
 * deterministically.
 *
 * Design rules:
 *
 * 1. Never take a restaurant offline over a plan or payment problem. A hub
 *    that stops accepting orders mid-service is worse than one that serves
 *    for free. When a subscription is suspended, cancelled, expired, or past
 *    its grace window, the tenant DEGRADES to the starter plan's limits and
 *    features — order entry, KOT printing, and billing keep working.
 *
 * 2. Limits only gate NEW additions (enrolling a device, adding a waiter).
 *    A tenant already over a limit after a downgrade keeps what they have;
 *    existing devices, staff and history are never deleted or hidden.
 *
 * 3. A hub that predates plan sync (no `plan` in its config) is treated as
 *    'pro' rather than 'starter', so updating the hub software never silently
 *    strips features from a paying pilot tenant.
 *
 * `null` for a limit means unlimited.
 */

export const PLAN_ORDER = ['starter', 'pro', 'enterprise'];
export const DEFAULT_PLAN = 'starter';
export const LEGACY_PLAN = 'pro';
export const PAST_DUE_GRACE_DAYS = 7;

export const FEATURES = Object.freeze({
  SPLIT_BILL: 'split_bill',
  REFUNDS: 'refunds',
  MODIFIERS: 'modifiers',
  DAY_PART_PRICING: 'day_part_pricing',
  MULTI_STATION_KOT: 'multi_station_kot'
});

export const PLANS = Object.freeze({
  starter: {
    id: 'starter',
    label: 'Starter',
    limits: { devices: 3, waiters: 5, tables: 15, printers: 1 },
    features: {
      split_bill: false,
      refunds: false,
      modifiers: false,
      day_part_pricing: false,
      multi_station_kot: false
    }
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    limits: { devices: 10, waiters: 25, tables: 60, printers: 4 },
    features: {
      split_bill: true,
      refunds: true,
      modifiers: true,
      day_part_pricing: true,
      multi_station_kot: true
    }
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    limits: { devices: null, waiters: null, tables: null, printers: null },
    features: {
      split_bill: true,
      refunds: true,
      modifiers: true,
      day_part_pricing: true,
      multi_station_kot: true
    }
  }
});

/** Cheapest plan that includes `feature`, for "upgrade to X" hints. */
export function minimumPlanFor(feature) {
  return PLAN_ORDER.find(id => PLANS[id].features[feature]) || null;
}

/** Whitelist a raw plan id; unknown/missing values return `fallback`. */
export function normalizePlanId(raw, fallback = DEFAULT_PLAN) {
  const id = String(raw ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLANS, id) ? id : fallback;
}

function toTime(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Work out which plan a tenant is entitled to RIGHT NOW.
 *
 * `tenant` is the plan slice of the hub config / restaurants row:
 *   { plan, plan_status, trial_ends_at, current_period_end }
 *
 * Returns:
 *   {
 *     plan,            // effective plan id used for limits + features
 *     requested_plan,  // what the tenant is subscribed to
 *     status,          // normalised plan_status
 *     degraded,        // true when effective plan is lower than requested
 *     in_grace,        // true while past_due but still inside the grace window
 *     grace_ends_at,   // ISO string while in_grace
 *     reason           // why it degraded (null when not degraded)
 *   }
 */
export function resolveEffectivePlan(tenant = {}, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const hasPlan = tenant && tenant.plan !== undefined && tenant.plan !== null && tenant.plan !== '';
  const requested = hasPlan ? normalizePlanId(tenant.plan) : LEGACY_PLAN;
  const status = String(tenant?.plan_status || 'active').toLowerCase();

  const base = {
    plan: requested,
    requested_plan: requested,
    status,
    degraded: false,
    in_grace: false,
    grace_ends_at: null,
    reason: null
  };

  const degrade = (reason) => ({ ...base, plan: DEFAULT_PLAN, degraded: requested !== DEFAULT_PLAN, reason });

  switch (status) {
    case 'active':
      return base;

    case 'trialing': {
      const trialEnd = toTime(tenant.trial_ends_at);
      if (trialEnd !== null && nowMs > trialEnd) return degrade('TRIAL_EXPIRED');
      return base;
    }

    case 'past_due': {
      const periodEnd = toTime(tenant.current_period_end);
      // No period end recorded: be generous rather than cut a tenant off on
      // incomplete data.
      if (periodEnd === null) return { ...base, in_grace: true };
      const graceEnd = periodEnd + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;
      if (nowMs <= graceEnd) {
        return { ...base, in_grace: true, grace_ends_at: new Date(graceEnd).toISOString() };
      }
      return degrade('PAYMENT_OVERDUE');
    }

    case 'suspended':
      return degrade('SUSPENDED');

    case 'cancelled':
    case 'canceled':
      return degrade('CANCELLED');

    default:
      // Unknown status from a newer cloud schema: don't punish the tenant.
      return base;
  }
}

export function getLimits(planId) {
  return { ...PLANS[normalizePlanId(planId)].limits };
}

export function getFeatures(planId) {
  return { ...PLANS[normalizePlanId(planId)].features };
}

export function hasFeature(planId, feature) {
  return PLANS[normalizePlanId(planId)].features[feature] === true;
}

/**
 * Can the tenant add one more of `key` (devices | waiters | tables | printers)?
 * `current` is how many they already have. Returns `{ ok: true }` or a
 * structured refusal the API can return verbatim.
 */
export function checkLimit(planId, key, current) {
  const plan = PLANS[normalizePlanId(planId)];
  const limit = plan.limits[key];
  if (limit === undefined) return { ok: true };
  if (limit === null) return { ok: true, limit: null };
  const count = Number(current) || 0;
  if (count < limit) return { ok: true, limit };

  const nextPlan = PLAN_ORDER.slice(PLAN_ORDER.indexOf(plan.id) + 1)
    .find(id => PLANS[id].limits[key] === null || PLANS[id].limits[key] > limit) || null;

  return {
    ok: false,
    code: 'PLAN_LIMIT_REACHED',
    status: 403,
    limit_key: key,
    limit,
    current: count,
    plan: plan.id,
    upgrade_to: nextPlan,
    error: `Your ${plan.label} plan allows ${limit} ${key}. ` +
      (nextPlan ? `Upgrade to ${PLANS[nextPlan].label} to add more.` : 'Contact support to raise this limit.')
  };
}

/** Structured refusal for a feature the plan does not include. */
export function featureRefusal(planId, feature) {
  const plan = PLANS[normalizePlanId(planId)];
  const upgradeTo = minimumPlanFor(feature);
  return {
    ok: false,
    code: 'PLAN_FEATURE_UNAVAILABLE',
    status: 403,
    feature,
    plan: plan.id,
    upgrade_to: upgradeTo,
    error: `${feature.replace(/_/g, ' ')} is not included in your ${plan.label} plan.` +
      (upgradeTo ? ` Upgrade to ${PLANS[upgradeTo].label} to use it.` : '')
  };
}

/**
 * Strip menu fields the plan doesn't include, so handsets don't render UI for
 * them and the pricer never sees them. Items degrade to their plain form:
 *
 *   - no `modifiers`         → `modifier_groups` removed (item is sold as-is)
 *   - no `day_part_pricing`  → `day_parts` removed (base/variant price applies)
 *   - no `multi_station_kot` → `station` removed (everything fires to 'hot')
 *
 * Variants and 86'd availability are core and never stripped. The input is
 * not mutated; items that need no change are returned as-is.
 */
export function applyPlanToMenuItems(items, features) {
  if (!Array.isArray(items)) return items;
  const f = features || {};
  const dropModifiers = f.modifiers === false;
  const dropDayParts = f.day_part_pricing === false;
  const dropStation = f.multi_station_kot === false;
  if (!dropModifiers && !dropDayParts && !dropStation) return items;

  return items.map(item => {
    if (!item || typeof item !== 'object') return item;
    const needs =
      (dropModifiers && 'modifier_groups' in item) ||
      (dropDayParts && 'day_parts' in item) ||
      (dropStation && 'station' in item);
    if (!needs) return item;
    const copy = { ...item };
    if (dropModifiers) delete copy.modifier_groups;
    if (dropDayParts) delete copy.day_parts;
    if (dropStation) delete copy.station;
    return copy;
  });
}
