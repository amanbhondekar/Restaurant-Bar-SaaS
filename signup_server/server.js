import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

import { validateSignup, provisionArgs, describeProvisioned, newProvisioningSecret, isOperator } from './lib/provision.js';
import { createRazorpayApi } from './lib/razorpayApi.js';
import { publicBookingRoutes, bookingPageRoutes, parseTrustProxy } from './lib/publicBooking.js';
import { BILLABLE_PLANS, planIdFor, planForRazorpayPlanId, offeredPlans, validatePlan, isLive, canCancel, describeSubscription } from './lib/billing.js';
import { verifyWebhookSignature, readSubscriptionEvent, subscriptionPayload } from '../hub_server/lib/razorpay.js';

// The operator service (§4.4): the one place that holds privileged credentials.
//
// Three jobs, all impossible anywhere else in this product:
//
//   SIGNUP. `provision_restaurant()` is revoked from `anon` and `authenticated` by migration 007,
//   because anything that can call it can fill the restaurants table. It needs the service key, and
//   a hub must never hold that -- a hub sits on a restaurant's wifi.
//
//   RAZORPAY WEBHOOKS. A subscription's state arrives as a callback to a public address. A hub has
//   no public address, and should not hold the webhook secret either.
//
//   SUBSCRIPTIONS. Creating one, cancelling it and changing its plan need the Razorpay keys, which a
//   hub must not hold either. A restaurant's hub (or its owner) ASKS; this service decides and calls
//   Razorpay. Nothing here moves money: creating a subscription only produces the page on which the
//   owner authorises payment, and until they do nothing is charged.
//
//   THE PUBLIC BOOKING PAGE. A guest asks a restaurant for a table. This is the one place a stranger can
//   write something that reaches a restaurant, so it is the one place that has to be able to say no: it
//   checks and rate-limits the request and writes it with the service key on the guest's behalf, and the
//   database stays closed to `anon`. It serves the page itself, so there is no separate host to run.
//
// It is deliberately small, keeps no state of its own beyond a rate limit, and is not part of the hub.
// Run it where the operator runs things; it is not something a restaurant installs.

const PORT = Number(process.env.SIGNUP_PORT) || 4500;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPERATOR_TOKEN = process.env.SIGNUP_OPERATOR_TOKEN;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

/** Who may start, change or cancel a restaurant's subscription: its owner, its managers, and its own hub (the `kitchen` identity). */
const TENANT_ROLES = new Set(['owner', 'manager', 'kitchen']);

const DEFAULT_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const bearer = req => (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) ?? [])[1] ?? '';

export function createApp({
  cloud,
  operatorToken = OPERATOR_TOKEN,
  webhookSecret = RAZORPAY_WEBHOOK_SECRET,
  env = process.env,
  razorpay = createRazorpayApi({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }),
  now = Date.now,
  minGapMs = 5000,
  distDir = DEFAULT_DIST,
  trustProxy = env.TRUST_PROXY
} = {}) {
  const app = express();

  // Behind a proxy every guest would otherwise look like one caller, and be limited together. Only a proxy that is really there
  // may be trusted: a header anyone can write must not choose which caller a request counts against.
  app.set('trust proxy', parseTrustProxy(trustProxy));

  // Razorpay signs the RAW bytes, so the webhook route must see them before anything parses and
  // re-serialises the body. Everywhere else takes ordinary JSON.
  app.use('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }));

  // The public booking page's API (with a small body limit of its own, ahead of the general parser), and the page itself.
  app.use('/public', publicBookingRoutes({ cloud, now }));
  app.use(bookingPageRoutes({ distDir }));

  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => res.json({ ok: true, configured: Boolean(cloud && operatorToken), billing: Boolean(cloud && razorpay.configured()) }));

  /**
   * Create a tenant. Operator-only: a token in `Authorization: Bearer`, compared in constant time,
   * and absent configuration means refuse rather than allow.
   */
  app.post('/signup', async (req, res) => {
    // Strictly `Bearer <token>`. Also accepting a bare token would be forgiving to an operator with
    // curl, at the price of one more shape an auth path has to be reasoned about in. On this route
    // that trade goes the other way.
    if (!isOperator(bearer(req), operatorToken)) {
      return res.status(401).json({ success: false, code: 'NOT_OPERATOR', error: 'This service is for the operator.' });
    }
    if (!cloud) {
      return res.status(503).json({ success: false, code: 'NOT_CONFIGURED', error: 'This service has no Supabase credentials.' });
    }

    const checked = validateSignup(req.body);
    if (!checked.ok) {
      return res.status(400).json({ success: false, code: 'INVALID_SIGNUP', error: checked.errors[0].message, errors: checked.errors });
    }

    // Generated here and never stored: the database keeps a bcrypt hash, and the hub keeps the
    // secret in its own .env. There is deliberately no third copy.
    const secret = newProvisioningSecret();
    const { data, error } = await cloud.rpc('provision_restaurant', provisionArgs(checked.signup, secret));
    if (error) {
      console.error('[signup] provision_restaurant refused:', error.message);
      return res.status(502).json({ success: false, code: 'PROVISION_FAILED', error: error.message });
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.restaurant_id) {
      return res.status(502).json({ success: false, code: 'PROVISION_FAILED', error: 'The database did not return a restaurant.' });
    }

    console.log(`[signup] Provisioned ${checked.signup.name} (${row.pairing_code}).`);
    res.status(201).json({ success: true, ...describeProvisioned(row, secret) });
  });

  // ----- a restaurant's own subscription -------------------------------------------------------------------------------------
  //
  // The caller proves which restaurant it is with its cloud session (the `Authorization: Bearer` access token a hub already
  // holds). The restaurant is read from that session, never from the request: a body that names another restaurant is simply not
  // looked at.

  const fail = (res, status, code, error) => res.status(status).json({ success: false, code, error });

  /** Resolves the caller to `{ restaurantId, role }`, or answers the request itself and returns null. */
  async function tenantOf(req, res) {
    const token = bearer(req);
    if (!cloud || !token) {
      fail(res, 401, 'NOT_SIGNED_IN', 'Sign in to the cloud first. This hub has not connected yet.');
      return null;
    }
    const { data, error } = await cloud.auth.getUser(token);
    const user = data?.user;
    if (error || !user?.id) {
      fail(res, 401, 'NOT_SIGNED_IN', 'The cloud did not recognise this sign-in.');
      return null;
    }
    const found = await cloud.from('staff_users').select('restaurant_id, role').eq('user_id', user.id).limit(1).maybeSingle();
    if (found.error || !found.data?.restaurant_id) {
      fail(res, 403, 'NO_RESTAURANT', 'This sign-in does not belong to a restaurant.');
      return null;
    }
    if (!TENANT_ROLES.has(found.data.role)) {
      fail(res, 403, 'ROLE_NOT_ALLOWED', 'Only the owner, a manager or the hub itself can manage the subscription.');
      return null;
    }
    return { restaurantId: found.data.restaurant_id, role: found.data.role };
  }

  /** The restaurant's newest subscription. A failed lookup is an error, never "none": that would invite a second subscription. */
  async function latestOf(restaurantId, res) {
    const { data, error } = await cloud.from('subscriptions').select('*').eq('restaurant_id', restaurantId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) {
      console.error('[subscriptions] lookup failed:', error.message);
      fail(res, 502, 'LOOKUP_FAILED', 'Could not look up the subscription. Try again in a moment.');
      return undefined;
    }
    return data ?? null;
  }

  // A restaurant that has just asked Razorpay for something waits a few seconds before asking again, so a stuck button cannot
  // hammer it. Kept in memory: losing it on a restart costs one early retry.
  const lastAsked = new Map();
  const tooSoon = restaurantId => {
    const at = lastAsked.get(restaurantId);
    if (at !== undefined && now() - at < minGapMs) return true;
    lastAsked.set(restaurantId, now());
    return false;
  };

  const refused = (res, made) => fail(res, 502, made.code, made.error);

  app.get('/subscriptions/current', async (req, res) => {
    const tenant = await tenantOf(req, res);
    if (!tenant) return;
    const latest = await latestOf(tenant.restaurantId, res);
    if (latest === undefined) return;
    res.json({ success: true, billing_configured: razorpay.configured(), plans: offeredPlans(env), subscription: describeSubscription(latest) });
  });

  app.post('/subscriptions', async (req, res) => {
    const tenant = await tenantOf(req, res);
    if (!tenant) return;

    const checked = validatePlan(req.body);
    if (!checked.ok) return fail(res, 400, checked.code, checked.error);
    const razorpayPlanId = planIdFor(checked.plan, env);
    if (!razorpayPlanId) return fail(res, 503, 'PLAN_NOT_OFFERED', 'That plan cannot be bought yet.');
    if (!razorpay.configured()) return fail(res, 503, 'NOT_CONFIGURED', 'Online billing is not set up on this service.');

    const latest = await latestOf(tenant.restaurantId, res);
    if (latest === undefined) return;
    if (latest && isLive(latest.status)) {
      if (latest.status !== 'created') {
        return fail(res, 409, 'ALREADY_SUBSCRIBED', 'This restaurant already has a subscription. Change its plan or cancel it instead.');
      }
      if (latest.plan !== checked.plan) {
        return fail(res, 409, 'PENDING_OTHER_PLAN', 'A payment page for another plan is already open. Finish it, or let it lapse, before choosing a different plan.');
      }
      // The same plan's payment page is already open: give it back, rather than a second subscription that could be authorised too.
      if (latest.short_url) return res.json({ success: true, reused: true, subscription: describeSubscription(latest) });
      // Razorpay gave no link for it, or it was not kept. Another subscription must not be made beside it; it lapses by itself.
      return fail(res, 409, 'PENDING_PAYMENT', 'A payment page for this plan is already open, but its link was not kept. It lapses by itself. Try again later.');
    }
    if (tooSoon(tenant.restaurantId)) return fail(res, 429, 'TOO_SOON', 'Please wait a few seconds before trying again.');

    const body = subscriptionPayload({ razorpayPlanId, restaurantId: tenant.restaurantId, plan: checked.plan });
    const made = await razorpay.createSubscription(body.payload);
    if (!made.ok) return refused(res, made);

    const row = {
      restaurant_id: tenant.restaurantId,
      razorpay_subscription_id: made.data.id,
      razorpay_plan_id: razorpayPlanId,
      plan: checked.plan,
      status: made.data.status || 'created',
      short_url: made.data.short_url ?? null
    };
    const saved = await cloud.from('subscriptions').insert(row);
    if (saved.error) {
      // Razorpay has it and we do not. The owner still gets the page, and the first webhook for it (it carries the restaurant in
      // its notes) records it. Refusing here would leave a subscription nobody knows about and no way to its payment page.
      console.error(`[subscriptions] ${made.data.id} was created at Razorpay but not recorded:`, saved.error.message);
    }
    console.log(`[subscriptions] ${tenant.restaurantId} started ${checked.plan} (${made.data.id}).`);
    res.status(201).json({ success: true, recorded: !saved.error, subscription: describeSubscription({ ...row, created_at: new Date(now()).toISOString() }) });
  });

  app.post('/subscriptions/cancel', async (req, res) => {
    const tenant = await tenantOf(req, res);
    if (!tenant) return;
    const latest = await latestOf(tenant.restaurantId, res);
    if (latest === undefined) return;
    if (!latest) return fail(res, 404, 'NO_SUBSCRIPTION', 'This restaurant has no subscription.');
    if (latest.status === 'created') return fail(res, 409, 'NOTHING_TO_CANCEL', 'No payment was made on this one, so there is nothing to cancel. The payment page simply lapses.');
    if (!canCancel(latest.status)) return fail(res, 409, 'NOT_ACTIVE', 'This subscription is not running, so there is nothing to cancel.');
    if (latest.cancel_requested_at) return res.json({ success: true, already: true, subscription: describeSubscription(latest) });

    const made = await razorpay.cancelSubscription(latest.razorpay_subscription_id, { atCycleEnd: true });
    if (!made.ok) return refused(res, made);

    const at = new Date(now()).toISOString();
    const saved = await cloud.from('subscriptions').update({ cancel_requested_at: at, updated_at: at }).eq('razorpay_subscription_id', latest.razorpay_subscription_id);
    if (saved.error) console.error(`[subscriptions] ${latest.razorpay_subscription_id} was cancelled at Razorpay but not marked:`, saved.error.message);
    console.log(`[subscriptions] ${tenant.restaurantId} cancelled ${latest.razorpay_subscription_id} at the end of the period.`);
    res.json({ success: true, subscription: describeSubscription({ ...latest, cancel_requested_at: at }) });
  });

  app.post('/subscriptions/change-plan', async (req, res) => {
    const tenant = await tenantOf(req, res);
    if (!tenant) return;
    const checked = validatePlan(req.body);
    if (!checked.ok) return fail(res, 400, checked.code, checked.error);
    const razorpayPlanId = planIdFor(checked.plan, env);
    if (!razorpayPlanId) return fail(res, 503, 'PLAN_NOT_OFFERED', 'That plan cannot be bought yet.');

    const latest = await latestOf(tenant.restaurantId, res);
    if (latest === undefined) return;
    if (!latest) return fail(res, 404, 'NO_SUBSCRIPTION', 'This restaurant has no subscription.');
    if (latest.status !== 'active') return fail(res, 409, 'NOT_ACTIVE', 'A plan can be changed once the first payment has gone through.');
    if (latest.cancel_requested_at) return fail(res, 409, 'CANCELLING', 'This subscription ends at the end of the period. Start a new one then.');
    if (latest.plan === checked.plan) return fail(res, 409, 'SAME_PLAN', 'The restaurant is already on that plan.');
    if (latest.plan_change_to === checked.plan) return res.json({ success: true, already: true, subscription: describeSubscription(latest) });
    if (!razorpay.configured()) return fail(res, 503, 'NOT_CONFIGURED', 'Online billing is not set up on this service.');
    if (tooSoon(tenant.restaurantId)) return fail(res, 429, 'TOO_SOON', 'Please wait a few seconds before trying again.');

    const made = await razorpay.changePlan(latest.razorpay_subscription_id, { planId: razorpayPlanId, atCycleEnd: true });
    if (!made.ok) return refused(res, made);

    const at = new Date(now()).toISOString();
    const saved = await cloud.from('subscriptions').update({ plan_change_to: checked.plan, updated_at: at }).eq('razorpay_subscription_id', latest.razorpay_subscription_id);
    if (saved.error) console.error(`[subscriptions] ${latest.razorpay_subscription_id} was changed at Razorpay but not marked:`, saved.error.message);
    console.log(`[subscriptions] ${tenant.restaurantId} scheduled a change to ${checked.plan} (${latest.razorpay_subscription_id}).`);
    res.json({ success: true, subscription: describeSubscription({ ...latest, plan_change_to: checked.plan }) });
  });

  /**
   * Razorpay tells us a subscription changed. The signature is checked against the raw body first:
   * without that this endpoint is a way for anyone to put any tenant on any plan.
   *
   * What is done with a verified event, in this order, and why it is safe to do it twice (a failure answers 5xx and Razorpay
   * redelivers, so every step must be):
   *   1. an event OLDER than the last one applied to this subscription is logged and left alone (late, out-of-order delivery
   *      must not put a restaurant back to past_due after it paid);
   *   2. the restaurant's plan status (and, for a payment, its plan) is set;
   *   3. the subscription is recorded;
   *   4. the event is logged, once: a redelivery of the same event id is acknowledged and not logged twice.
   */
  app.post('/webhooks/razorpay', async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : String(req.body ?? '');
    const signature = req.headers['x-razorpay-signature'];

    if (!webhookSecret) {
      console.error('[webhook] No RAZORPAY_WEBHOOK_SECRET set; refusing.');
      return res.status(503).json({ success: false, code: 'NOT_CONFIGURED' });
    }
    if (!verifyWebhookSignature(raw, signature, webhookSecret)) {
      console.warn('[webhook] Rejected an unsigned or wrongly signed webhook.');
      return res.status(401).json({ success: false, code: 'BAD_SIGNATURE' });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.status(400).json({ success: false, code: 'BAD_BODY' });
    }

    const read = readSubscriptionEvent(body);
    // Razorpay sends a great many events. Anything we do not act on is acknowledged, not retried:
    // answering 4xx would make it redeliver forever.
    if (!read) return res.json({ success: true, ignored: true });
    if (!read.restaurant_id) {
      console.warn(`[webhook] ${read.event} for ${read.subscription_id} carries no restaurant_id; ignoring.`);
      return res.json({ success: true, ignored: true, reason: 'NO_TENANT' });
    }
    if (!cloud) return res.status(503).json({ success: false, code: 'NOT_CONFIGURED' });

    const retry = (what, error) => {
      // 5xx so Razorpay retries: losing a "paid" event would strand a paying restaurant past_due.
      console.error(`[webhook] Could not ${what}:`, error.message);
      return res.status(502).json({ success: false, code: 'UPDATE_FAILED', error: error.message });
    };
    const eventId = String(req.headers['x-razorpay-event-id'] || '') || null;
    const logEvent = applied => cloud.from('subscription_events').insert({
      restaurant_id: read.restaurant_id,
      razorpay_subscription_id: read.subscription_id,
      razorpay_event_id: eventId,
      event: read.event,
      applied_plan_status: applied,
      payload: body
    });

    const known = await cloud.from('subscriptions').select('last_event_at, plan_change_to').eq('razorpay_subscription_id', read.subscription_id).maybeSingle();
    if (known.error) return retry('read the subscription', known.error);

    if (known.data?.last_event_at && read.event_at && Date.parse(read.event_at) < Date.parse(known.data.last_event_at)) {
      const logged = await logEvent(null);
      if (logged.error && logged.error.code !== '23505') return retry('log the stale event', logged.error);
      console.warn(`[webhook] ${read.event} for ${read.subscription_id} is older than what is applied; left alone.`);
      return res.json({ success: true, ignored: true, reason: 'STALE', ...(logged.error ? { duplicate: true } : {}) });
    }

    // Only a subscription that is being paid for sets the plan. A failed charge or a cancellation changes the STATUS, which is
    // what degrades the restaurant, and leaves the plan alone.
    const plan = read.subscription_status === 'active'
      ? (planForRazorpayPlanId(read.razorpay_plan_id, env) ?? (BILLABLE_PLANS.includes(read.plan) ? read.plan : null))
      : null;

    const updated = await cloud
      .from('restaurants')
      .update({
        plan_status: read.plan_status,
        ...(plan ? { plan } : {}),
        ...(read.current_period_end ? { current_period_end: read.current_period_end } : {})
      })
      .eq('id', read.restaurant_id)
      .select('id');
    if (updated.error) return retry('apply the event', updated.error);
    if (!updated.data?.length) {
      // The restaurant is gone (deleted, cascade): nothing to apply the event to, and a 5xx would be retried for ever.
      console.warn(`[webhook] ${read.event} names restaurant ${read.restaurant_id}, which does not exist; ignoring.`);
      return res.json({ success: true, ignored: true, reason: 'UNKNOWN_TENANT' });
    }

    const recorded = await cloud.from('subscriptions').upsert({
      restaurant_id: read.restaurant_id,
      razorpay_subscription_id: read.subscription_id,
      status: read.subscription_status,
      last_event_at: read.event_at ?? new Date(now()).toISOString(),
      updated_at: new Date(now()).toISOString(),
      ...(read.razorpay_plan_id ? { razorpay_plan_id: read.razorpay_plan_id } : {}),
      ...(plan ? { plan } : {}),
      // A scheduled change is done once a charge at that plan arrives; a charge at the old plan leaves it pending.
      ...(plan && known.data?.plan_change_to === plan ? { plan_change_to: null } : {}),
      ...(read.current_period_start ? { current_start: read.current_period_start } : {}),
      ...(read.current_period_end ? { current_end: read.current_period_end } : {})
    }, { onConflict: 'razorpay_subscription_id' });
    if (recorded.error) return retry('record the subscription', recorded.error);

    const logged = await logEvent(read.plan_status);
    const duplicate = logged.error?.code === '23505';
    if (logged.error && !duplicate) return retry('log the event', logged.error);

    console.log(`[webhook] ${read.event}: ${read.restaurant_id} is now ${read.plan_status}${plan ? ` on ${plan}` : ''}.`);
    res.json({ success: true, restaurant_id: read.restaurant_id, plan_status: read.plan_status, ...(plan ? { plan } : {}), ...(duplicate ? { duplicate: true } : {}) });
  });

  return app;
}

// Started directly rather than imported by a test.
if (process.argv[1] && process.argv[1].endsWith('signup_server/server.js')) {
  const cloud = SUPABASE_URL && SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY) : null;
  if (!cloud) console.warn('⚠️ No SUPABASE_URL / SUPABASE_SERVICE_KEY: signup will refuse every request.');
  if (!OPERATOR_TOKEN) console.warn('⚠️ No SIGNUP_OPERATOR_TOKEN: signup will refuse every request.');
  const razorpay = createRazorpayApi({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET });
  if (!razorpay.configured()) console.warn('⚠️ No RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET: subscriptions cannot be started.');
  const offered = offeredPlans(process.env);
  if (razorpay.configured() && offered.length === 0) console.warn('⚠️ No RAZORPAY_PLAN_PRO / RAZORPAY_PLAN_ENTERPRISE: there is no plan to subscribe to.');
  createApp({ cloud, razorpay }).listen(PORT, () => {
    console.log(`🔑 Operator service on :${PORT} (signup, subscriptions, Razorpay webhooks). Not for restaurants.`);
  });
}
