// The rules of a restaurant's subscription that are ours rather than Razorpay's (§4.4): which plans can be bought, where a
// subscription is in its life, and what a hub is allowed to be told about one. Pure, so each rule is tested on its own.

/** The plans that cost money. Starter is what a tenant falls back to, so there is nothing to subscribe to. */
export const BILLABLE_PLANS = ['pro', 'enterprise'];

const ENV_FOR = { pro: 'RAZORPAY_PLAN_PRO', enterprise: 'RAZORPAY_PLAN_ENTERPRISE' };

/**
 * The Razorpay plan behind one of ours, from the environment, or null. A plan with nothing configured is simply not offered:
 * the operator creates the plans in Razorpay's dashboard (with the price), and this is where they are named. Nothing here
 * knows a price, deliberately: what a plan costs is Razorpay's to say.
 */
export function planIdFor(plan, env = process.env) {
  const name = ENV_FOR[plan];
  const id = name ? String(env[name] ?? '').trim() : '';
  return id || null;
}

/** Which of the paid plans are on offer right now. */
export const offeredPlans = (env = process.env) => BILLABLE_PLANS.filter(plan => planIdFor(plan, env));

/** The reverse: which of ours a Razorpay plan id is. Null for one we do not know, never a guess. */
export function planForRazorpayPlanId(razorpayPlanId, env = process.env) {
  return BILLABLE_PLANS.find(plan => planIdFor(plan, env) === String(razorpayPlanId)) ?? null;
}

/** A plan someone asked to subscribe to: one of the paid ones. */
export function validatePlan(body) {
  const plan = body && typeof body === 'object' ? body.plan : undefined;
  if (BILLABLE_PLANS.includes(plan)) return { ok: true, plan };
  return { ok: false, code: 'INVALID_PLAN', error: `Choose a plan to subscribe to: ${BILLABLE_PLANS.join(' or ')}.` };
}

const LIVE = new Set(['created', 'authenticated', 'active', 'pending']);
const CANCELLABLE = new Set(['authenticated', 'active', 'pending']);

/**
 * Whether a subscription can still become, or be, a paying one. A second must not be started while one is: two authorised
 * subscriptions would bill the restaurant twice. `halted` is not live: Razorpay has stopped trying, and the way back is a
 * new subscription.
 */
export const isLive = status => LIVE.has(String(status));

/** Only one the owner has authorised can be cancelled; one never paid for simply lapses. */
export const canCancel = status => CANCELLABLE.has(String(status));

/**
 * What a hub is told about a subscription: enough to show where it stands and nothing that identifies the tenant elsewhere
 * (no tenant id, no Razorpay customer or plan id). The payment link only while the subscription is waiting to be paid.
 */
export function describeSubscription(row) {
  if (!row) return null;
  return {
    id: row.razorpay_subscription_id,
    status: row.status,
    plan: row.plan ?? null,
    plan_change_to: row.plan_change_to ?? null,
    current_end: row.current_end ?? null,
    cancel_requested_at: row.cancel_requested_at ?? null,
    ...(row.status === 'created' && row.short_url ? { short_url: row.short_url } : {}),
    created_at: row.created_at ?? null
  };
}
