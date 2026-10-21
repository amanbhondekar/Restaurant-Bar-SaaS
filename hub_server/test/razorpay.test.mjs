import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  verifyPaymentSignature, verifyWebhookSignature, toPaise, fromPaise,
  orderPayload, planStatusFor, readSubscriptionEvent, subscriptionPayload
} from '../lib/razorpay.js';

// The Razorpay parts that are ours rather than theirs: proving a payment really happened, and
// deciding what a subscription event means for a tenant's plan. No network, by design -- these are
// the pieces worth owning, and they are all deterministic.

const SECRET = 'rzp_test_secret_value';
const sign = (data, secret = SECRET) => crypto.createHmac('sha256', secret).update(data).digest('hex');

// --- a guest paying for a meal -----------------------------------------------------------------

test('a genuine Checkout result verifies', () => {
  const order_id = 'order_MN4xYz';
  const payment_id = 'pay_MN5abc';
  const signature = sign(`${order_id}|${payment_id}`);
  assert.equal(verifyPaymentSignature({ order_id, payment_id, signature }, SECRET), true);
});

test('a payment signed with the wrong secret, or for a different order, does not verify', () => {
  const order_id = 'order_MN4xYz';
  const payment_id = 'pay_MN5abc';
  assert.equal(verifyPaymentSignature({ order_id, payment_id, signature: sign(`${order_id}|${payment_id}`, 'someone elses secret') }, SECRET), false);
  // A guest replaying a signature from a cheaper bill is the attack this stops.
  assert.equal(verifyPaymentSignature({ order_id: 'order_OTHER', payment_id, signature: sign(`${order_id}|${payment_id}`) }, SECRET), false);
  assert.equal(verifyPaymentSignature({ order_id, payment_id: 'pay_OTHER', signature: sign(`${order_id}|${payment_id}`) }, SECRET), false);
});

test('a payment with anything missing is refused rather than throwing at a guest', () => {
  const good = { order_id: 'o', payment_id: 'p', signature: sign('o|p') };
  for (const key of ['order_id', 'payment_id', 'signature']) {
    assert.equal(verifyPaymentSignature({ ...good, [key]: undefined }, SECRET), false, key);
    assert.equal(verifyPaymentSignature({ ...good, [key]: '' }, SECRET), false, key);
  }
  assert.equal(verifyPaymentSignature(good, undefined), false, 'no secret configured');
  assert.equal(verifyPaymentSignature(null, SECRET), false);
  assert.equal(verifyPaymentSignature({ ...good, signature: 'short' }, SECRET), false, 'a wrong-length signature');
});

// --- webhooks --------------------------------------------------------------------------------

test('a webhook verifies against the RAW body, which is what Razorpay signed', () => {
  const raw = JSON.stringify({ event: 'subscription.charged', payload: {} });
  assert.equal(verifyWebhookSignature(raw, sign(raw), SECRET), true);

  // Re-serialising a parsed body is the usual way this is got wrong: same meaning, different bytes.
  const reserialised = JSON.stringify(JSON.parse(raw.replace('{"event"', '{ "event"')));
  assert.equal(verifyWebhookSignature(`${raw} `, sign(raw), SECRET), false, 'one trailing space is a different body');
  assert.equal(verifyWebhookSignature(reserialised, sign(raw), SECRET), true, 'identical bytes still pass');
});

test('a webhook that was not signed by Razorpay is refused', () => {
  const raw = '{"event":"subscription.cancelled"}';
  assert.equal(verifyWebhookSignature(raw, sign(raw, 'forged'), SECRET), false);
  assert.equal(verifyWebhookSignature(raw, '', SECRET), false);
  assert.equal(verifyWebhookSignature(raw, sign(raw), ''), false);
  assert.equal(verifyWebhookSignature({ event: 'x' }, sign(raw), SECRET), false, 'a parsed object is not a raw body');
});

// --- money -------------------------------------------------------------------------------------

test('rupees become integer paise, and anything that is not money is refused rather than rounded', () => {
  assert.equal(toPaise(992.25), 99225);
  assert.equal(toPaise(1), 100);
  assert.equal(toPaise(0), 0);
  assert.equal(toPaise(0.1 + 0.2), 30, 'no float drift into 30.000000000000004 paise');
  for (const bad of [-1, 'lots', null, undefined, NaN, Infinity]) assert.equal(toPaise(bad), null, String(bad));
  assert.equal(fromPaise(99225), 992.25);
  assert.equal(fromPaise('abc'), null);
});

test('an order carries the bill it is for, so a payment can always be traced back to one', () => {
  const invoice = { id: 'inv_42', invoice_number: 'INV-000042', grand_total: 992.25, table_name: 'T4' };
  const { ok, payload } = orderPayload({ invoice, restaurantId: 'rest-1' });
  assert.equal(ok, true);
  assert.equal(payload.amount, 99225);
  assert.equal(payload.currency, 'INR');
  assert.equal(payload.receipt, 'inv_42', 'the hub\'s own id, not the printed number');
  assert.deepEqual(payload.notes, { restaurant_id: 'rest-1', invoice_number: 'INV-000042', table: 'T4' });
});

test('a bill with nothing to collect is refused before Razorpay is asked', () => {
  for (const total of [0, -5, null, undefined, 'free']) {
    const r = orderPayload({ invoice: { id: 'inv_1', grand_total: total }, restaurantId: 'r' });
    assert.equal(r.ok, false, String(total));
    assert.equal(r.code, 'INVALID_AMOUNT');
  }
});

// --- what a subscription state means ------------------------------------------------------------

test('a payment problem becomes past_due, never suspended -- the restaurant keeps trading', () => {
  // This is the rule that matters: past_due runs the grace window in lib/plans.js. A card that
  // expired on a Friday night must not take the till down mid-service.
  assert.equal(planStatusFor('pending'), 'past_due');
  assert.equal(planStatusFor('halted'), 'past_due', 'even once Razorpay has given up retrying');
});

test('every subscription state maps to a plan status the hub already understands', () => {
  assert.deepEqual(
    ['created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired'].map(planStatusFor),
    ['trialing', 'trialing', 'active', 'past_due', 'past_due', 'cancelled', 'cancelled', 'cancelled']
  );
  assert.equal(planStatusFor('something_new'), null, 'an unknown state is not guessed at');
  assert.equal(planStatusFor(undefined), null);
});

// --- reading a webhook ----------------------------------------------------------------------------

const event = (name, entity = {}) => ({
  event: name,
  payload: { subscription: { entity: { id: 'sub_MN1abc', notes: { restaurant_id: 'rest-1' }, ...entity } } }
});

test('a charge tells the hub the tenant is paid up, and until when', () => {
  const read = readSubscriptionEvent(event('subscription.charged', { current_end: 1793000000 }));
  assert.equal(read.subscription_id, 'sub_MN1abc');
  assert.equal(read.plan_status, 'active');
  assert.equal(read.restaurant_id, 'rest-1');
  assert.equal(read.current_period_end, new Date(1793000000 * 1000).toISOString());
});

test('Razorpay counts seconds and everything here counts milliseconds', () => {
  // Getting this wrong puts every past-due tenant either instantly out of grace or in it until the
  // year 58000, and both look like the billing code "working" until someone checks a date.
  const read = readSubscriptionEvent(event('subscription.halted', { current_end: 1793000000 }));
  assert.equal(new Date(read.current_period_end).getFullYear(), 2026);
});

test('a failed charge is read as past_due with its period end, which is what the grace window needs', () => {
  const read = readSubscriptionEvent(event('subscription.pending', { current_end: 1793000000 }));
  assert.equal(read.plan_status, 'past_due');
  assert.ok(read.current_period_end, 'grace is measured from this, so it must survive');
});

test('cancelling ends it, and a subscription with no period end is still readable', () => {
  assert.equal(readSubscriptionEvent(event('subscription.cancelled')).plan_status, 'cancelled');
  assert.equal(readSubscriptionEvent(event('subscription.cancelled')).current_period_end, null);
});

test('an event we do not act on is ignored rather than guessed at', () => {
  assert.equal(readSubscriptionEvent(event('payment.failed')), null);
  assert.equal(readSubscriptionEvent({ event: 'subscription.charged' }), null, 'no subscription in the body');
  assert.equal(readSubscriptionEvent({ event: 'subscription.charged', payload: { subscription: { entity: {} } } }), null, 'no id');
  assert.equal(readSubscriptionEvent(null), null);
  assert.equal(readSubscriptionEvent({}), null);
});

test('a subscription with no tenant in its notes is readable but says so, rather than inventing one', () => {
  const read = readSubscriptionEvent({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_x' } } } });
  assert.equal(read.restaurant_id, null);
});

// --- creating a subscription -----------------------------------------------------------------------

test('a subscription carries its tenant in notes, so every webhook can be matched without a lookup', () => {
  const { ok, payload } = subscriptionPayload({ razorpayPlanId: 'plan_abc', restaurantId: 'rest-1' });
  assert.equal(ok, true);
  assert.equal(payload.plan_id, 'plan_abc');
  assert.deepEqual(payload.notes, { restaurant_id: 'rest-1' });
  assert.equal(payload.customer_notify, 1);
  assert.equal(payload.total_count, 12);
});

test('a plan with no Razorpay plan behind it, or no tenant, is refused with a reason', () => {
  assert.equal(subscriptionPayload({ restaurantId: 'rest-1' }).code, 'NO_PLAN');
  assert.equal(subscriptionPayload({ razorpayPlanId: 'plan_abc' }).code, 'NO_TENANT');
});
