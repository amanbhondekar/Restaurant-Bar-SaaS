import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { isOperator } from './provision.js';
import { createLimiter } from './bookingPage.js';
import { PAGE_HEADERS } from './publicBooking.js';
import { OPS_LIMITS, shapeTenant, fleetSummary, attentionList, rankTenants, shapeEvent, shapeSubscription } from './ops.js';

// The operator console (§4.9): what its page talks to, and the page itself.
//
// It shows EVERY restaurant at once, so the question that matters is who it will talk to: only someone holding the console's own token, and
// not for long if they are guessing. It is READ-ONLY: there is no route here that writes, and the service role it reads with has no write
// privilege on what it reads (migration 021), so nothing here could be talked into one.
//
// The token is its own, not the one that creates restaurants (`SIGNUP_OPERATOR_TOKEN`), so that looking can be given to someone without
// giving them the power to provision. Unset, or too short to be safe, means the console is OFF: the failure mode of a missing environment
// variable must not be "anyone may see every restaurant".

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bearer = req => (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) ?? [])[1] ?? '';

const SUBSCRIPTION_COLUMNS = 'razorpay_subscription_id, status, plan, plan_change_to, cancel_requested_at, current_start, current_end, last_event_at, created_at';

const CLOUD_DOWN = { success: false, code: 'CLOUD', error: 'The database did not answer. Try again in a moment.' };
const NOT_FOUND = { success: false, code: 'NOT_FOUND', error: 'Not found.' };

/** Whether the console is on: it has a database to read and a token long enough to be a secret. */
export const opsEnabled = (cloud, token, limits = OPS_LIMITS) => Boolean(cloud) && typeof token === 'string' && token.length >= limits.minTokenLength;

export function opsRoutes({ cloud, token, now = Date.now, limits = OPS_LIMITS }) {
  const router = express.Router();
  const on = opsEnabled(cloud, token, limits);
  const guessing = createLimiter({ max: limits.failures.max, windowMs: limits.failures.windowMs, now });

  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });

  router.use((req, res, next) => {
    if (!on) return res.status(503).json({ success: false, code: 'NOT_CONFIGURED', error: 'The operator console is not switched on.' });
    // Turned away before the token is looked at, so that a guesser who is lucky on the eleventh try learns nothing from it.
    const caller = req.ip || 'unknown';
    if (guessing.count(caller) >= limits.failures.max) {
      return res.status(429).json({ success: false, code: 'TOO_MANY', error: 'Too many wrong tries. Wait a while and try again.' });
    }
    if (!isOperator(bearer(req), token)) {
      guessing.hit(caller);
      return res.status(401).json({ success: false, code: 'NOT_OPERATOR', error: 'This is for the operator.' });
    }
    return next();
  });

  router.get('/fleet', async (req, res) => {
    const at = now();
    const [tenants, events] = await Promise.all([
      cloud.from('ops_tenants').select('*').order('created_at', { ascending: false }).limit(limits.maxTenants),
      cloud.from('ops_events').select('*').order('received_at', { ascending: false }).limit(limits.eventsOnFleet)
    ]);
    const failed = tenants.error || events.error;
    if (failed) {
      console.error('[ops] could not read the fleet:', failed.message);
      return res.status(502).json(CLOUD_DOWN);
    }
    const shaped = rankTenants((tenants.data ?? []).map(row => shapeTenant(row, at)));
    return res.json({
      success: true,
      generated_at: new Date(at).toISOString(),
      // Exactly as many as one answer can hold might be all of them or might not, so it is said.
      truncated: shaped.length >= limits.maxTenants,
      summary: fleetSummary(shaped),
      attention: attentionList(shaped),
      tenants: shaped,
      events: (events.data ?? []).map(shapeEvent)
    });
  });

  router.get('/tenants/:id', async (req, res) => {
    const { id } = req.params;
    if (!ID_PATTERN.test(id)) return res.status(404).json(NOT_FOUND);
    const at = now();
    const [tenant, subscriptions, events] = await Promise.all([
      cloud.from('ops_tenants').select('*').eq('restaurant_id', id).maybeSingle(),
      cloud.from('subscriptions').select(SUBSCRIPTION_COLUMNS).eq('restaurant_id', id).order('created_at', { ascending: false }).limit(limits.subscriptionsOnTenant),
      cloud.from('ops_events').select('*').eq('restaurant_id', id).order('received_at', { ascending: false }).limit(limits.eventsOnTenant)
    ]);
    const failed = tenant.error || subscriptions.error || events.error;
    if (failed) {
      console.error('[ops] could not read a restaurant:', failed.message);
      return res.status(502).json(CLOUD_DOWN);
    }
    if (!tenant.data) return res.status(404).json(NOT_FOUND);
    return res.json({
      success: true,
      generated_at: new Date(at).toISOString(),
      tenant: shapeTenant(tenant.data, at),
      subscriptions: (subscriptions.data ?? []).map(shapeSubscription),
      events: (events.data ?? []).map(shapeEvent)
    });
  });

  // Anything else, signed in or not, is not here. There is nothing to write to.
  router.use((req, res) => res.status(404).json(NOT_FOUND));
  return router;
}

/** Serves `ops.html` at /ops, under the same policy as the booking page (no inline script), kept out of search engines. */
export function opsPageRoutes({ distDir, enabled }) {
  const router = express.Router();
  const page = path.join(path.resolve(distDir), 'ops.html');

  router.get(['/ops', '/ops/'], (req, res) => {
    if (!enabled) return res.status(404).type('text/plain').send('Not found');
    if (!fs.existsSync(page)) return res.status(503).type('text/plain').send('The operator console has not been built. Run "npm run build" where this service runs.');
    res.set({ ...PAGE_HEADERS, 'X-Robots-Tag': 'noindex, nofollow' });
    return res.sendFile(page);
  });
  return router;
}
