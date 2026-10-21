import crypto from 'crypto';

// Razorpay: the parts that are ours rather than theirs (§4.4 subscriptions, §4.5 order-and-pay).
//
// Two different flows use this, and they fail in different ways, so they are kept apart:
//
//   A GUEST PAYING FOR A MEAL. The hub creates an order through Razorpay's API, the guest's phone
//   loads Razorpay Checkout, and Checkout hands back `{ order_id, payment_id, signature }`. The
//   signature is an HMAC the hub verifies with its own secret -- no callback from Razorpay's servers
//   is involved, so this works on a hub that has no public address, which every hub here is.
//
//   THE RESTAURANT PAYING US. A subscription lives in Razorpay and its state arrives as webhooks.
//   Those need a public endpoint, which this product does not have yet (see the report). What is
//   here is the half that is ours either way: verifying that a webhook really came from Razorpay,
//   and deciding what each event means for the tenant's plan.
//
// Nothing here makes a network call. The signing and the meaning are the parts worth owning and
// testing; the HTTP is three lines at the call site.

/**
 * Verify a Checkout result. Razorpay signs `order_id|payment_id` with the key secret.
 *
 * Every failure answers false rather than throwing, and the compare is constant-time, because this
 * runs on input a guest's phone supplied: a timing difference or a stack trace is a way to learn
 * about the secret.
 */
export function verifyPaymentSignature(result, secret) {
  // Not destructured in the signature: this is called with whatever a guest's phone posted, and
  // destructuring null throws before the first line of the body could refuse it.
  const { order_id, payment_id, signature } = result ?? {};
  if (!order_id || !payment_id || !signature || !secret) return false;
  try {
    const expected = crypto.createHmac('sha256', String(secret)).update(`${order_id}|${payment_id}`).digest('hex');
    const a = Buffer.from(String(signature), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify a webhook. Razorpay signs the RAW request body, so the caller must pass exactly the bytes
 * that arrived -- re-serialising a parsed object changes key order and whitespace and the signature
 * will not match, which is the usual way this is got wrong.
 */
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (typeof rawBody !== 'string' || !signature || !secret) return false;
  try {
    const expected = crypto.createHmac('sha256', String(secret)).update(rawBody).digest('hex');
    const a = Buffer.from(String(signature), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Rupees as Razorpay wants them: integer paise. Anything that is not money is refused, not rounded. */
export function toPaise(rupees) {
  // Number(null) and Number('') are both 0, so a missing amount would otherwise become a bill for
  // nothing rather than a refusal.
  if (rupees === null || rupees === undefined || rupees === '') return null;
  const n = Number(rupees);
  if (!Number.isFinite(n) || n < 0) return null;
  const paise = Math.round(n * 100);
  return Number.isSafeInteger(paise) ? paise : null;
}

/** And back, for showing what was actually charged rather than what we asked for. */
export const fromPaise = paise => (Number.isFinite(Number(paise)) ? Math.round(Number(paise)) / 100 : null);

/**
 * The body for creating an order against a bill.
 *
 * `receipt` carries the hub's own invoice id so a payment can always be traced back to a bill, and
 * `notes` carry the tenant and table for the same reason: Razorpay's dashboard is where someone
 * looks when a guest says they paid and the bill says otherwise.
 */
export function orderPayload({ invoice, restaurantId }) {
  const amount = toPaise(invoice?.grand_total);
  if (amount === null || amount <= 0) return { ok: false, code: 'INVALID_AMOUNT', error: 'That bill has no amount to collect.' };
  return {
    ok: true,
    payload: {
      amount,
      currency: 'INR',
      receipt: String(invoice.id),
      notes: {
        restaurant_id: String(restaurantId ?? ''),
        invoice_number: String(invoice.invoice_number ?? ''),
        table: String(invoice.table_name ?? '')
      }
    }
  };
}

// --- subscriptions ------------------------------------------------------------------------------

/**
 * What a Razorpay subscription state means for a tenant's plan status.
 *
 * The hub already degrades correctly on `trialing`, `past_due`, `suspended` and `cancelled` (see
 * lib/plans.js), so the only job here is translation. The rule that matters: a payment problem
 * becomes `past_due`, NOT `suspended` -- past_due keeps the restaurant trading through its grace
 * window, and a restaurant whose card expired on a Friday night must not lose its till.
 */
const SUBSCRIPTION_STATUS = {
  created: 'trialing',       // made, not yet authenticated by the customer
  authenticated: 'trialing', // mandate in place, first charge not taken
  active: 'active',
  pending: 'past_due',       // a charge failed and Razorpay is retrying
  halted: 'past_due',        // retries exhausted -- still past_due, so the grace window applies
  cancelled: 'cancelled',
  completed: 'cancelled',    // ran to its natural end
  expired: 'cancelled'
};

export function planStatusFor(subscriptionStatus) {
  return SUBSCRIPTION_STATUS[String(subscriptionStatus)] ?? null;
}

/** The webhook events worth acting on, and the subscription state each implies. */
const WEBHOOK_EVENTS = {
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  'subscription.authenticated': 'authenticated',
  'subscription.pending': 'pending',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed',
  'subscription.paused': 'halted'
};

/**
 * What a verified webhook means. Returns null for an event we do not act on, which is most of them:
 * Razorpay sends a great many, and silently ignoring the rest is safer than guessing.
 *
 * The caller must have verified the signature first. This only reads.
 */
export function readSubscriptionEvent(body) {
  const event = String(body?.event ?? '');
  const state = WEBHOOK_EVENTS[event];
  if (!state) return null;

  const sub = body?.payload?.subscription?.entity;
  if (!sub?.id) return null;

  const planStatus = planStatusFor(state);
  if (!planStatus) return null;

  return {
    event,
    subscription_id: String(sub.id),
    subscription_status: state,
    plan_status: planStatus,
    // Seconds in Razorpay, milliseconds everywhere here. `current_end` is what the grace window in
    // lib/plans.js measures from, so getting the unit wrong would put every past-due tenant either
    // instantly out of grace or in it for fifty thousand years.
    current_period_end: sub.current_end ? new Date(Number(sub.current_end) * 1000).toISOString() : null,
    restaurant_id: sub.notes?.restaurant_id ? String(sub.notes.restaurant_id) : null
  };
}

/** The body for creating a subscription for a tenant on a plan. */
export function subscriptionPayload({ razorpayPlanId, restaurantId, totalCount = 12, customerNotify = true }) {
  if (!razorpayPlanId) return { ok: false, code: 'NO_PLAN', error: 'That plan has no Razorpay plan behind it yet.' };
  if (!restaurantId) return { ok: false, code: 'NO_TENANT', error: 'A subscription must belong to a restaurant.' };
  return {
    ok: true,
    payload: {
      plan_id: String(razorpayPlanId),
      total_count: totalCount,
      customer_notify: customerNotify ? 1 : 0,
      // Carried through every webhook, so an event can be matched to a tenant without a lookup
      // table that could drift.
      notes: { restaurant_id: String(restaurantId) }
    }
  };
}
