import express from 'express';

import { verifyJwt, JwtError } from './jwt.js';
import { SECURITY_HEADERS, corsHeaders, ipAllowed, createLimiter, requestIdFrom } from './security.js';
import { toCsv } from './csv.js';
import { OPS_LIMITS, shapeTenant, fleetSummary, attentionList, rankTenants, shapeEvent, shapeSubscription } from '../../common/opsRules.js';
import { ALERT_DEFAULTS, alertWords, rankAlerts } from '../../common/alertEngine.js';

// The admin API (Phase 1, P1-3 / P1-5 / P1-6; the alerts inbox, Phase 2, P2-4): what the console's web page talks to.
//
// It is DEFAULT-DENY. Every route it has is in ROUTES below, a test pins that list, and anything else, signed in or not, is "not here". There is
// no route that changes a restaurant. Three things are written: the record that a founder signed in, and an alert being acknowledged or resolved,
// each with a reason in a person's words. It never holds the service key (the config refuses to start with one) and reaches the database only as
// `kullina_admin`, through the admin_* functions, which check the caller again.
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
  'GET /api/tenants/:id',
  'GET /api/alerts',
  'POST /api/alerts/:id/ack',
  'POST /api/alerts/:id/resolve',
  'GET /api/tenants/:id/timeline'
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = ['hub', 'razorpay', 'admin', 'system', 'support'];
const TYPE = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_AUDIT = 500;
const WRONG_TRIES = { max: 10, windowMs: 15 * 60 * 1000 };

const NOT_FOUND = { success: false, code: 'NOT_FOUND', error: 'Not found.' };

const ALERT_ID = /^[1-9]\d{0,15}$/;
const ALERT_STATES = ['active', 'open', 'acked', 'resolved'];
const MAX_ALERTS = 500;
const TIMELINE_KINDS = ['billing', 'hub', 'alerts', 'admin'];
const REASON = { min: 10, max: 500 };   // invariant I4: a reason in a person's words, ten characters at least
const BODY_LIMIT = '4kb';
const badRequest = error => ({ success: false, code: 'BAD_REQUEST', error });

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

/** The inbox's state and limit, from a query string: each checked, or a message saying which one is wrong. */
export function alertQuery(query) {
  const get = name => { const v = one(query[name]); return v === undefined || v === '' ? null : String(v); };
  const state = get('state') ?? 'active';
  if (!ALERT_STATES.includes(state)) return { error: `state is one of ${ALERT_STATES.join(', ')}.` };
  const raw = get('limit');
  if (raw !== null && (!/^\d{1,6}$/.test(raw) || Number(raw) < 1)) return { error: 'limit is a number from 1 to 500.' };
  return { state, limit: raw === null ? 100 : Math.min(Number(raw), MAX_ALERTS) };
}

/** A restaurant's timeline: which kind, from where, how many. Each checked, or a message saying which one is wrong. */
export function timelineQuery(query) {
  const get = name => { const v = one(query[name]); return v === undefined || v === '' ? null : String(v); };
  const kind = get('kind');
  if (kind !== null && !TIMELINE_KINDS.includes(kind)) return { error: `kind is one of ${TIMELINE_KINDS.join(', ')}.` };
  const before = get('before');
  if (before !== null && !/^[1-9]\d{0,15}$/.test(before)) return { error: 'before is an event id.' };
  const limit = get('limit');
  if (limit !== null && (!/^\d{1,6}$/.test(limit) || Number(limit) < 1)) return { error: 'limit is a number from 1 to 500.' };
  return { kind, before, limit: limit === null ? 50 : Math.min(Number(limit), MAX_AUDIT) };
}

/** What a person is told about the reason, or null if it will do: counted in characters, after trimming. */
export function reasonProblem(reason) {
  if (typeof reason !== 'string') return 'Give a reason, in your own words.';
  const length = [...reason.trim()].length;
  if (length < REASON.min) return `Give a reason of at least ${REASON.min} characters, in your own words.`;
  if (length > REASON.max) return `The reason can be at most ${REASON.max} characters.`;
  return null;
}

// Only what each rule's words need, by name (the same closed list the pages use), and nothing that ever lands in an alert's details beyond it.
const detailOf = detail => {
  const d = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
  const out = {};
  if (Number.isInteger(d.count) && d.count >= 0) out.count = d.count;
  if (Number.isFinite(d.silent_ms) && d.silent_ms >= 0) out.silent_ms = d.silent_ms;
  const seen = iso(d.last_seen_at);
  if (typeof d.last_seen_at === 'string' && seen !== null) out.last_seen_at = seen;
  return out;
};

const shapeAlert = row => {
  const detail = detailOf(row.detail);
  const { what, text } = alertWords(row.rule_key, detail);
  return {
    id: Number(row.id),
    restaurant_id: row.restaurant_id ?? null,
    restaurant_name: row.restaurant_name ?? null,
    rule_key: row.rule_key,
    severity: row.severity,
    state: row.state,
    what,
    text,
    detail,
    opened_at: iso(row.opened_at),
    acked_at: iso(row.acked_at),
    acked_by_email: row.acked_by_email ?? null,
    ack_reason: row.ack_reason ?? null,
    resolved_at: iso(row.resolved_at),
    // Who closed it, as a kind and never an id: a person did, or the worker did because the condition cleared.
    resolved_by: row.state === 'resolved' ? (row.resolved_by ? 'person' : 'system') : null,
    resolve_reason: row.resolve_reason ?? null,
    escalation_level: Number(row.escalation_level),
    reminders: ALERT_DEFAULTS.reminders,
    last_notified_at: iso(row.last_notified_at),
    unattended_at: iso(row.unattended_at)
  };
};

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
      if (err?.code === 'P0002') return res.status(404).json(NOT_FOUND);
      if (err?.code === '55000') return res.status(409).json({ success: false, code: 'CONFLICT', error: 'That alert is already resolved.' });
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

  // One restaurant's history on the spine, newest first, filtered by kind in the database (migration 025). Read-only.
  app.get('/api/tenants/:id/timeline', asAdmin(async (req, res, run) => {
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(404).json(NOT_FOUND);
    const parsed = timelineQuery(req.query);
    if (parsed.error) return res.status(400).json(badRequest(parsed.error));
    const { kind, before, limit } = parsed;
    const restaurant = id.toLowerCase();
    const { tenant, rows } = await run(async q => {
      const found = (await q('SELECT * FROM public.admin_tenant($1::uuid)', [restaurant])).rows[0];
      if (!found) return { tenant: null, rows: [] };
      const events = (await q('SELECT * FROM public.admin_tenant_timeline($1::uuid, $2::text, $3::bigint, $4::integer)', [restaurant, kind, before, limit])).rows;
      return { tenant: found, rows: events };
    });
    if (!tenant) return res.status(404).json(NOT_FOUND);
    const events = rows.map(row => shapeAudit({ ...row, restaurant_id: restaurant, restaurant_name: tenant.name }));
    return res.json({
      ...stamp(),
      restaurant: { id: restaurant, name: tenant.name },
      kind,
      events,
      next_before: events.length === limit ? events[events.length - 1].id : null
    });
  }));

  // --- the alerts inbox (P2-4) -------------------------------------------------------------------------------------------------------

  app.get('/api/alerts', asAdmin(async (req, res, run) => {
    const parsed = alertQuery(req.query);
    if (parsed.error) return res.status(400).json(badRequest(parsed.error));
    const { state, limit } = parsed;
    const ask = Math.min(limit + 1, MAX_ALERTS);   // one more than shown, to know whether the list was cut
    const lists = await run(async q => {
      const out = [];
      for (const s of state === 'active' ? ['open', 'acked'] : [state]) out.push((await q('SELECT * FROM public.admin_alerts($1::text, $2::integer)', [s, ask])).rows);
      return out;
    });
    const all = rankAlerts(lists.flat().map(shapeAlert));
    return res.json({
      ...stamp(),
      truncated: all.length > limit || (limit === MAX_ALERTS && lists.some(l => l.length === MAX_ALERTS)),
      counts: {
        open: all.filter(a => a.state === 'open').length,
        acked: all.filter(a => a.state === 'acked').length,
        unattended: all.filter(a => a.state === 'open' && a.unattended_at !== null).length
      },
      alerts: all.slice(0, limit)
    });
  }));

  // The body of a write is read here, after the caller is known to be an administrator and never before, and only as JSON of a few kilobytes.
  const parseJson = express.json({ limit: BODY_LIMIT, type: 'application/json' });
  const readJson = (req, res) => new Promise(resolve => parseJson(req, res, err => resolve(err ?? null)));

  /** Acknowledge or resolve: an administrator's action on one alert, with a reason in words. The database checks everything again. */
  const alertAction = action => asAdmin(async (req, res, run) => {
    if (!ALERT_ID.test(req.params.id)) return res.status(404).json(NOT_FOUND);
    await run(q => q('SELECT * FROM public.admin_whoami()'));   // who is asking, before anything they sent is read
    if (await readJson(req, res)) return res.status(400).json(badRequest('The request body must be JSON with a reason.'));
    const reason = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body.reason : undefined;
    const problem = reasonProblem(reason);
    if (problem) return res.status(400).json(badRequest(problem));
    const done = (await run(q => q(`SELECT * FROM public.admin_${action}_alert($1::bigint, $2::text)`, [req.params.id, reason.trim()]))).rows[0];
    return res.json({ ...stamp(), alert: { id: Number(done.id), state: done.state }, event_id: done.event_id === null ? null : Number(done.event_id) });
  });
  app.post('/api/alerts/:id/ack', alertAction('ack'));
  app.post('/api/alerts/:id/resolve', alertAction('resolve'));

  // Anything else is not here, signed in or not.
  app.use((req, res) => res.status(404).json(NOT_FOUND));
  return app;
}
