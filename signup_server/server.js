import express from 'express';
import { createClient } from '@supabase/supabase-js';

import { validateSignup, provisionArgs, describeProvisioned, newProvisioningSecret, isOperator } from './lib/provision.js';
import { verifyWebhookSignature, readSubscriptionEvent } from '../hub_server/lib/razorpay.js';

// The operator service (§4.4): the one place that holds privileged credentials.
//
// Two jobs, both impossible anywhere else in this product:
//
//   SIGNUP. `provision_restaurant()` is revoked from `anon` and `authenticated` by migration 007,
//   because anything that can call it can fill the restaurants table. It needs the service key, and
//   a hub must never hold that -- a hub sits on a restaurant's wifi.
//
//   RAZORPAY WEBHOOKS. A subscription's state arrives as a callback to a public address. A hub has
//   no public address, and should not hold the webhook secret either.
//
// It is deliberately tiny, holds no state, and is not part of the hub. Run it where the operator
// runs things; it is not something a restaurant installs.

const PORT = Number(process.env.SIGNUP_PORT) || 4500;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OPERATOR_TOKEN = process.env.SIGNUP_OPERATOR_TOKEN;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

export function createApp({ cloud, operatorToken = OPERATOR_TOKEN, webhookSecret = RAZORPAY_WEBHOOK_SECRET } = {}) {
  const app = express();

  // Razorpay signs the RAW bytes, so the webhook route must see them before anything parses and
  // re-serialises the body. Everywhere else takes ordinary JSON.
  app.use('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => res.json({ ok: true, configured: Boolean(cloud && operatorToken) }));

  /**
   * Create a tenant. Operator-only: a token in `Authorization: Bearer`, compared in constant time,
   * and absent configuration means refuse rather than allow.
   */
  app.post('/signup', async (req, res) => {
    // Strictly `Bearer <token>`. Also accepting a bare token would be forgiving to an operator with
    // curl, at the price of one more shape an auth path has to be reasoned about in. On this route
    // that trade goes the other way.
    const [, supplied = ''] = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) ?? [];
    if (!isOperator(supplied, operatorToken)) {
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

  /**
   * Razorpay tells us a subscription changed. The signature is checked against the raw body first:
   * without that this endpoint is a way for anyone to put any tenant on any plan.
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

    const { error } = await cloud
      .from('restaurants')
      .update({
        plan_status: read.plan_status,
        ...(read.current_period_end ? { current_period_end: read.current_period_end } : {})
      })
      .eq('id', read.restaurant_id);

    if (error) {
      // 5xx so Razorpay retries: losing a "paid" event would strand a paying restaurant past_due.
      console.error('[webhook] Could not apply the event:', error.message);
      return res.status(502).json({ success: false, code: 'UPDATE_FAILED', error: error.message });
    }

    console.log(`[webhook] ${read.event}: ${read.restaurant_id} is now ${read.plan_status}.`);
    res.json({ success: true, restaurant_id: read.restaurant_id, plan_status: read.plan_status });
  });

  return app;
}

// Started directly rather than imported by a test.
if (process.argv[1] && process.argv[1].endsWith('signup_server/server.js')) {
  const cloud = SUPABASE_URL && SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY) : null;
  if (!cloud) console.warn('⚠️ No SUPABASE_URL / SUPABASE_SERVICE_KEY: signup will refuse every request.');
  if (!OPERATOR_TOKEN) console.warn('⚠️ No SIGNUP_OPERATOR_TOKEN: signup will refuse every request.');
  createApp({ cloud }).listen(PORT, () => {
    console.log(`🔑 Operator service on :${PORT} (signup + Razorpay webhooks). Not for restaurants.`);
  });
}
