import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { BOOKING_LIMITS, createLimiter, validateGuestRequest } from './bookingPage.js';

// The public booking page (§4.6): what a guest's browser talks to, and the page itself.
//
// It lives in the operator service rather than in Supabase on purpose. This is the one place in the product a stranger can write
// something, so it is the one place that has to be able to say no: it checks the request, rate-limits the caller, and writes with
// the service key on the guest's behalf. The database stays closed to `anon`, as it has always been (migration 014), and the page is
// served from the same address as the API, so there is no cross-origin access to allow.
//
// A page is named by a random code in its address. An unknown code, a switched-off page and a malformed code all get the same answer,
// so nobody can tell which exist.

export const CODE_PATTERN = /^[a-z0-9]{10,32}$/;

/** TRUST_PROXY as Express wants it: true, a number of hops, or a name like "loopback". Unset or "false" trusts nobody's headers. */
export const parseTrustProxy = value => {
  if (value === undefined || value === null || value === '' || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return /^\d+$/.test(String(value)) ? Number(value) : value;
};

const NOT_FOUND = { success: false, code: 'NOT_FOUND', error: 'This booking page is not available.' };
const UNAVAILABLE = { success: false, code: 'UNAVAILABLE', error: 'We could not take that just now. Please try again in a minute, or phone the restaurant.' };

export function publicBookingRoutes({ cloud, now = Date.now, limits = BOOKING_LIMITS }) {
  const router = express.Router();
  const attempts = createLimiter({ ...limits.perIp.attempts, now });
  const accepted = createLimiter({ max: limits.perIp.max, windowMs: limits.perIp.windowMs, now });
  const perPhone = createLimiter({ ...limits.perPhone, now });

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Its own, small parser, inside the router so that its errors are answered by the handler at the foot of this file.
  router.use(express.json({ limit: '4kb' }));

  /** The page for a code, or null when there is none to show: unknown, switched off, or not a code at all. */
  async function pageFor(code) {
    if (!CODE_PATTERN.test(code) || !cloud) return { answer: [404, NOT_FOUND] };
    const found = await cloud.from('booking_pages').select('restaurant_id, enabled').eq('code', code).maybeSingle();
    if (found.error) {
      console.error('[booking] page lookup failed:', found.error.message);
      return { answer: [502, UNAVAILABLE] };
    }
    if (!found.data || !found.data.enabled) return { answer: [404, NOT_FOUND] };
    return { restaurantId: found.data.restaurant_id };
  }

  router.get('/booking/:code', async (req, res) => {
    const page = await pageFor(req.params.code);
    if (page.answer) return res.status(page.answer[0]).json(page.answer[1]);
    const restaurant = await cloud.from('restaurants').select('name, city').eq('id', page.restaurantId).maybeSingle();
    if (restaurant.error) {
      console.error('[booking] restaurant lookup failed:', restaurant.error.message);
      return res.status(502).json(UNAVAILABLE);
    }
    if (!restaurant.data) return res.status(404).json(NOT_FOUND);
    res.json({
      success: true,
      restaurant: { name: restaurant.data.name, city: restaurant.data.city ?? null },
      limits: { max_party: limits.maxParty, min_notice_mins: limits.minNoticeMins, max_ahead_days: limits.maxAheadDays }
    });
  });

  router.post('/booking/:code/requests', async (req, res) => {
    const ip = req.ip || 'unknown';
    const tooMany = () => res.status(429).json({ success: false, code: 'TOO_MANY', error: 'That is a lot of requests. Please wait a little, or phone the restaurant.' });
    if (!attempts.hit(ip)) return tooMany();

    const page = await pageFor(req.params.code);
    if (page.answer) return res.status(page.answer[0]).json(page.answer[1]);

    // A field no person sees. A bot that fills in every field fills this one too, and is told it worked.
    if (typeof req.body?.website === 'string' && req.body.website.trim() !== '') return res.status(201).json({ success: true });

    const checked = validateGuestRequest(req.body, { now: new Date(now()), limits });
    if (!checked.ok) return res.status(400).json({ success: false, code: 'INVALID_REQUEST', error: checked.errors[0].message, errors: checked.errors });

    if (!accepted.hit(ip)) return tooMany();
    if (!perPhone.hit(`${page.restaurantId}:${checked.request.phone}`)) return tooMany();

    // Requests for a time that has gone are of no use to anyone, and a hub that was off for a week would otherwise leave the inbox full.
    const lapsed = await cloud.from('booking_requests').delete().eq('restaurant_id', page.restaurantId).lte('requested_for', new Date(now() - limits.lapsedAfterMs).toISOString());
    if (lapsed.error) console.error('[booking] could not clear lapsed requests:', lapsed.error.message);

    const waiting = await cloud.from('booking_requests').select('id', { count: 'exact', head: true }).eq('restaurant_id', page.restaurantId);
    if (waiting.error) {
      console.error('[booking] could not count the inbox:', waiting.error.message);
      return res.status(502).json(UNAVAILABLE);
    }
    if ((waiting.count ?? 0) >= limits.pendingCap) {
      return res.status(503).json({ success: false, code: 'NOT_TAKING_REQUESTS', error: 'This restaurant is not taking online requests right now. Please phone them.' });
    }

    const saved = await cloud.from('booking_requests').insert({ restaurant_id: page.restaurantId, ...checked.request });
    if (saved.error) {
      console.error('[booking] could not save a request:', saved.error.message);
      return res.status(502).json(UNAVAILABLE);
    }
    res.status(201).json({ success: true });
  });

  // A body that is not JSON, or is far too big, is refused with words rather than a stack trace.
  router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ success: false, code: 'TOO_LARGE', error: 'That request is too big.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ success: false, code: 'INVALID_REQUEST', error: 'That request could not be read.' });
    return next(err);
  });

  return router;
}

/** The headers the page is served with: it keeps its own address to itself, runs no inline script, and talks only to this service. */
const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

/** Serves `reserve.html` at /book/:code and the built assets at /assets, and nothing else from the build. */
export function bookingPageRoutes({ distDir }) {
  const router = express.Router();
  const page = path.join(path.resolve(distDir), 'reserve.html');

  router.get('/book/:code', (req, res) => {
    if (!CODE_PATTERN.test(req.params.code)) return res.status(404).type('text/plain').send('Not found');
    if (!fs.existsSync(page)) return res.status(503).type('text/plain').send('The booking page has not been built. Run "npm run build" where this service runs.');
    res.set(PAGE_HEADERS);
    return res.sendFile(page);
  });

  router.use('/assets', express.static(path.join(path.resolve(distDir), 'assets'), { index: false, maxAge: '1y', immutable: true }));
  return router;
}
