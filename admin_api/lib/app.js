import express from 'express';

import { verifyJwt, JwtError } from './jwt.js';
import { SECURITY_HEADERS, corsHeaders, ipAllowed, createLimiter, requestIdFrom } from './security.js';
import { toCsv } from './csv.js';
import { OPS_LIMITS, shapeTenant, fleetSummary, attentionList, rankTenants, shapeEvent, shapeSubscription } from '../../common/opsRules.js';

// The admin API (Phase 1, P1-3 / P1-5 / P1-6): what the console's web page talks to.
//
// It is DEFAULT-DENY. Every route it has is in ROUTES below, a test pins that list, and anything else, signed in or not, is "not here". There is
// no route that changes a restaurant: in Phase 1 the only write is the record that a founder signed in. It never holds the service key (the
// config refuses to start with one) and reaches the database only as `kullina_admin`, through the admin_* functions, which check the caller again.
//
// What it will not do: believe a token it cannot verify, accept one in a URL, say WHY a token was refused (the log knows, the caller does not),
// show a figure without the moment it was read (invariant I8), or show the last answer when a read fails.

/** Every route, and the only ones. The method is part of the route: a POST to a GET-only path is as absent as any other path. */
export const ROUTES = Object.freeze([
  'GET /healthz',
  'GET /api/me',
  'POST /api/session',
  'GET /api/audit',
  'GET /api/audit.csv',
  'GET /api/audit/verify',
  'GET /api/fleet',
  'GET /api/tenants/:id'
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = ['hub', 'razorpay', 'admin', 'system', 'support'];
const TYPE = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_AUDIT = 500;
const WRONG_TRIES = { max: 10, windowMs: 15 * 60 * 1000 };

const NOT_FOUND = { success: false, code: 'NOT_FOUND', error: 'Not found.' };

const bearer = req => (String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i) ?? [])[1] ?? '';
const iso = value => { const t = value instanceof Date ? value.getTime() : Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const one = value => (Array.isArray(value) ? value[value.length - 1] : value);

/** The filters of the audit log, from a query string: each checked, or a message saying which one is wrong. */
export function auditFilters(query, { defaultLimit = 100 } = {}) {
  const get = name => { const v = one(query[name]); return v === undefined || v === '' ? null : String(v); };
  const out = { restaurant: null, type: null, source: null, actor: null, from: null, to: null, before: null, limit: defaultLimit };

  const restaurant = get('restaurant_id');
  if (restaurant !== null) { if (!UUID.test(restaurant)) return { error: 'restaurant_id is not an id.' }; out.restaurant = restaurant.toLowerCase(); }
  const actor = get('actor_id');
  if (actor !== null) { if (!UUID.test(actor)) return { error: 'actor_id is not an id.' }; out.actor = actor.toLowerCase(); }
  const type = get('type');
  if (type !== null) { if (!TYPE.test(type)) return { error: 'type is not an event type.' }; out.type = type; }
  const source = get('source');
  if (source !== null) { if (!SOURCES.includes(source)) return { error: `source is one of ${SOURCES.join(', ')}.` }; out.source = source; }
  for (const [name, key] of [['from', 'from'], ['to', 'to']]) {
    const value = get(name);
    if (value !== null) {
      const t = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
      if (!Number.isFinite(t)) return { error: `${name} is not a date.` };
      out[key] = new Date(t).toISOString();
    }
  }
  const before = get('before');
  if (before !== null) { if (!/^[1-9]\d{0,15}$/.test(before)) return { error: 'before is an event id.' }; out.before = before; }
  const limit = get('limit');
  if (limit !== null) {
    if (!/^\d{1,6}$/.test(limit) || Number(limit) < 1) return { error: 'limit is a number from 1 to 500.' };
    out.limit = Math.min(Number(limit), MAX_AUDIT);
  }
  return { filters: out };
}

const shapeAudit = row => ({
  id: Number(row.id),
  restaurant_id: row.restaurant_id ?? null,
  restaurant_name: row.restaurant_name ?? null,
  occurred_at: iso(row.occurred_at),
  source: row.source,
  type: row.type,
  actor_type: row.actor_type,
  actor_id: row.actor_id ?? null,
  actor_email: row.actor_email ?? null,
  request_id: row.request_id ?? null,
  payload: row.payload ?? {},
  chain_seq: Number(row.chain_seq),
  row_hash: row.row_hash
});

const AUDIT_SQL = 'SELECT * FROM public.admin_list_events($1::uuid, $2::text, $3::text, $4::uuid, $5::timestamptz, $6::timestamptz, $7::bigint, $8::integer)';
const auditArgs = f => [f.restaurant, f.type, f.source, f.actor, f.from, f.to, f.before, f.limit];

const CSV_COLUMNS = [
  ['id', 'Event'], ['occurred_at', 'When (UTC)'], ['restaurant_name', 'Restaurant'], ['restaurant_id', 'Restaurant id'], ['source', 'Source'],
  ['type', 'Type'], ['actor_type', 'Actor type'], ['actor_email', 'Actor'], ['actor_id', 'Actor id'], ['request_id', 'Request'], ['payload', 'Details']
];

/**
 * `db.asAdmin(claims, fn)` runs `fn(query)` as the dedicated role for the caller; `keys` says which keys a token may be verified against; `config`
 * is the checked configuration (config.js). `now` is the clock, for the tests.
 */
export function createAdminApp({ db, keys, config, now = Date.now, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 0);
  const maxTenants = config.maxTenants ?? OPS_LIMITS.maxTenants;
  const wrong = createLimiter({ ...WRONG_TRIES, now });

  // Everything that leaves carries the headers, the request id, and the CORS answer for the configured web origin only.
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    res.set(corsHeaders(req.headers.origin, config.webOrigins));
    res.locals.requestId = requestIdFrom(req.headers['x-request-id']);
    res.set('X-Request-Id', res.locals.requestId);
    next();
  });

  // An address that is not on the allowlist is told nothing exists, before anything else is looked at.
  app.use((req, res, next) => (ipAllowed(req.ip, config.ipAllowlist) ? next() : res.status(404).json(NOT_FOUND)));

  app.use((req, res, next) => (req.method === 'OPTIONS' ? res.status(204).end() : next()));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // --- everything under /api needs a real token with a second factor -----------------------------------------------------------------
  app.use('/api', async (req, res, next) => {
    if (wrong.blocked(req.ip)) return res.status(429).json({ success: false, code: 'TOO_MANY', error: 'Too many wrong tries. Wait a while and try again.' });
    let claims;
    try {
      claims = await verifyJwt(bearer(req), { keys, now: now(), audience: config.audience, issuer: config.issuer });
    } catch (err) {
      wrong.hit(req.ip);
      log.warn?.(`[admin_api] ${res.locals.requestId} refused a token: ${err instanceof JwtError ? err.code : 'unexpected'}`);
      return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', error: 'Sign in again.' });
    }
    if (claims.aal !== 'aal2') {
      return res.status(403).json({ success: false, code: 'MFA_REQUIRED', error: 'Sign in with your second factor.' });
    }
    req.admin = { sub: claims.sub, aal: claims.aal };
    return next();
  });

  /** Runs `work(query)` as the caller. A refusal by the database is a 403 (and a wrong try); a bad argument a 400; anything else a 502 with no data. */
  const asAdmin = (handler) => async (req, res) => {
    try {
      await handler(req, res, work => db.asAdmin(req.admin, work));
    } catch (err) {
      if (err?.code === '42501') {
        wrong.hit(req.ip);
        log.warn?.(`[admin_api] ${res.locals.requestId} the database refused the caller`);
        return res.status(403).json({ success: false, code: 'ADMIN_ONLY', error: 'This is for the administrators.' });
      }
      if (err?.code === '22023') return res.status(400).json({ success: false, code: 'BAD_REQUEST', error: 'That request was not understood.' });
      log.error?.(`[admin_api] ${res.locals.requestId} the database did not answer: ${err?.message}`);
      return res.status(502).json({ success: false, code: 'DATABASE', error: 'The database did not answer. Try again in a moment.' });
    }
  };

  const stamp = () => ({ success: true, generated_at: new Date(now()).toISOString() });

  app.get('/api/me', asAdmin(async (req, res, run) => {
    const rows = (await run(q => q('SELECT * FROM public.admin_whoami()'))).rows;
    const me = rows[0];
    return res.json({ ...stamp(), user: { id: me.user_id, email: me.email, display_name: me.display_name, role: me.role } });
  }));

  app.post('/api/session', asAdmin(async (req, res, run) => {
    const id = (await run(q => q('SELECT public.admin_record_signin($1::text) AS id', [res.locals.requestId]))).rows[0].id;
    return res.json({ ...stamp(), event_id: Number(id) });
  }));

  app.get('/api/audit', asAdmin(async (req, res, run) => {
    const parsed = auditFilters(req.query);
    if (parsed.error) return res.status(400).json({ success: false, code: 'BAD_REQUEST', error: parsed.error });
    const f = parsed.filters;
    const rows = (await run(q => q(AUDIT_SQL, auditArgs(f)))).rows.map(shapeAudit);
    return res.json({ ...stamp(), events: rows, next_before: rows.length === f.limit ? rows[rows.length - 1].id : null });
  }));

  app.get('/api/audit.csv', asAdmin(async (req, res, run) => {
    const parsed = auditFilters(req.query, { defaultLimit: MAX_AUDIT });
    if (parsed.error) return res.status(400).json({ success: false, code: 'BAD_REQUEST', error: parsed.error });
    const rows = (await run(q => q(AUDIT_SQL, auditArgs(parsed.filters)))).rows.map(shapeAudit);
    const day = new Date(now()).toISOString().slice(0, 10);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="kullina-audit-${day}.csv"` });
    return res.send(toCsv(CSV_COLUMNS, rows));
  }));

  app.get('/api/audit/verify', asAdmin(async (req, res, run) => {
    const raw = one(req.query.restaurant_id);
    if (raw !== undefined && raw !== '' && !UUID.test(String(raw))) return res.status(400).json({ success: false, code: 'BAD_REQUEST', error: 'restaurant_id is not an id.' });
    const restaurant = raw ? String(raw).toLowerCase() : null;
    const r = (await run(q => q('SELECT * FROM public.admin_verify_chain($1::uuid)', [restaurant]))).rows[0];
    return res.json({ ...stamp(), restaurant_id: restaurant, ok: r.ok, checked: Number(r.checked), broken_at: r.broken_at === null ? null : Number(r.broken_at), reason: r.reason ?? null });
  }));

  app.get('/api/fleet', asAdmin(async (req, res, run) => {
    const at = now();
    const { tenants, events } = await run(async q => ({
      tenants: (await q('SELECT * FROM public.admin_fleet($1::integer)', [maxTenants])).rows,
      events: (await q('SELECT * FROM public.admin_ops_events(NULL::uuid, $1::integer)', [OPS_LIMITS.eventsOnFleet])).rows
    }));
    const shaped = rankTenants(tenants.map(row => shapeTenant(row, at)));
    return res.json({
      success: true,
      generated_at: new Date(at).toISOString(),
      truncated: shaped.length >= maxTenants,
      summary: fleetSummary(shaped),
      attention: attentionList(shaped),
      tenants: shaped,
      events: events.map(shapeEvent)
    });
  }));

  app.get('/api/tenants/:id', asAdmin(async (req, res, run) => {
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(404).json(NOT_FOUND);
    const at = now();
    const { tenant, subscriptions, events } = await run(async q => ({
      tenant: (await q('SELECT * FROM public.admin_tenant($1::uuid)', [id.toLowerCase()])).rows[0],
      subscriptions: (await q('SELECT * FROM public.admin_tenant_subscriptions($1::uuid, $2::integer)', [id.toLowerCase(), OPS_LIMITS.subscriptionsOnTenant])).rows,
      events: (await q('SELECT * FROM public.admin_ops_events($1::uuid, $2::integer)', [id.toLowerCase(), OPS_LIMITS.eventsOnTenant])).rows
    }));
    if (!tenant) return res.status(404).json(NOT_FOUND);
    return res.json({
      success: true,
      generated_at: new Date(at).toISOString(),
      tenant: shapeTenant(tenant, at),
      subscriptions: subscriptions.map(shapeSubscription),
      events: events.map(shapeEvent)
    });
  }));

  // Anything else is not here, signed in or not.
  app.use((req, res) => res.status(404).json(NOT_FOUND));
  return app;
}
