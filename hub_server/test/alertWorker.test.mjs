import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { makeAlertDb, assertAlertRole } from '../../alert_worker/lib/db.js';
import { createTick, startWorker } from '../../alert_worker/lib/worker.js';
import { ALERT_DEFAULTS } from '../../common/alertEngine.js';
import { cloudDb } from './helpers/cloudDb.mjs';

// Phase 2, P2-2: the alert worker's pass. It reads the fleet, works out which alerts are true, opens and resolves them, and pages whoever is due
// a page, once. The logic is exercised against a fake database and a fake channel, so time can be moved to the minute; then once against the real
// SQL functions on a real Postgres engine (PGlite), so the two agree.
//
// What matters: a page is never lost (a channel that fails is retried next pass), never duplicated by the worker itself, never sent to
// someone who has already said "I know", and never carries more than the rule needs. And a pass that cannot see the whole fleet must not
// conclude that everything is fine.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-27T06:30:00.000Z');   // Tuesday 12:00 in India
const iso = ms => new Date(ms).toISOString();

const HOURS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, [['11:00', '23:00']]]));
const META = { 'r-1': { timezone: 'Asia/Kolkata', service_hours: HOURS } };
const tenant = (over = {}) => ({ restaurant_id: 'r-1', name: 'Hotel Mejwani', plan_status: 'active', hub_seen_at: iso(T0 - 2 * MIN), hub_queued: 0, hub_quarantined: 0, ...over });

class FakeDb {
  // `heartbeat`: the hubs keep reporting as the test's clock moves, as a healthy hub does; a test about silence turns it off and sets hub_seen_at itself.
  constructor({ now = T0, tenants = [tenant()], meta = META, complete = true, heartbeat = true } = {}) {
    Object.assign(this, { now, tenants, meta, complete, heartbeat, alerts: [], nextId: 1, applied: [], failures: [], notifiedCalls: [], calls: [] });
  }
  async snapshot() {
    this.calls.push('snapshot');
    if (this.failSnapshot) throw new Error('database is down');
    if (this.heartbeat) for (const t of this.tenants) t.hub_seen_at = iso(this.now - 2 * MIN);
    return {
      now: iso(this.now), complete: this.complete, tenants: structuredClone(this.tenants), meta: structuredClone(this.meta),
      alerts: structuredClone(this.alerts.filter(a => a.state !== 'resolved'))
    };
  }
  async apply({ open, resolve, unattended }, requestId) {
    this.calls.push('apply');
    if (this.failApply) throw new Error('apply failed');
    this.applied.push({ open: structuredClone(open), resolve: structuredClone(resolve), unattended: [...unattended], requestId });
    const out = { opened: [], resolved: [], flagged: [] };
    for (const c of open) {
      const t = this.tenants.find(x => x.restaurant_id === c.restaurant_id);
      const a = { id: this.nextId++, restaurant_id: c.restaurant_id, restaurant_name: t?.name ?? null, rule_key: c.rule_key, severity: c.severity, dedupe_key: c.dedupe_key,
        state: 'open', detail: c.detail, opened_at: iso(this.now), acked_at: null, escalation_level: 0, last_notified_at: null, unattended_at: null };
      this.alerts.push(a);
      out.opened.push({ id: a.id, dedupe_key: a.dedupe_key });
    }
    for (const r of resolve) { const a = this.alerts.find(x => x.id === r.id); if (a && a.state !== 'resolved') { a.state = 'resolved'; out.resolved.push(a.id); } }
    for (const id of unattended) { const a = this.alerts.find(x => x.id === id); if (a && !a.unattended_at) { a.unattended_at = iso(this.now); out.flagged.push(id); } }
    return out;
  }
  async notified(id, level) {
    this.calls.push('notified');
    if (this.failNotified) throw new Error('notified failed');
    const a = this.alerts.find(x => x.id === id);
    if (!a || a.state !== 'open') return false;
    a.escalation_level = level; a.last_notified_at = iso(this.now); this.notifiedCalls.push([id, level]);
    return true;
  }
  async notifyFailed(id, level, note) { this.calls.push('notifyFailed'); this.failures.push({ id, level, note }); return true; }
  ack(id) { const a = this.alerts.find(x => x.id === id); a.state = 'acked'; a.acked_at = iso(this.now); }
}
const channel = () => {
  const c = { sent: [], failWith: null, async send(m) { if (c.failWith) throw c.failWith; c.sent.push(structuredClone(m)); } };
  return c;
};
const pass = (db, notifier, config = ALERT_DEFAULTS) => createTick({ db, notifier, config });

// --- a healthy fleet -------------------------------------------------------------------------------------------------------------

test('a healthy fleet opens nothing, pages nobody, and says so', async () => {
  const db = new FakeDb();
  const ch = channel();
  const out = await pass(db, ch)();
  assert.deepEqual([out.opened, out.resolved, out.flagged, out.notified, out.failed, out.errors], [[], [], [], [], [], []]);
  assert.equal(ch.sent.length, 0);
});

// --- opening and paging ----------------------------------------------------------------------------------------------------------

test('a shelved order opens a P1 alert and the founders are paged straight away, in the same pass', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  const out = await pass(db, ch)();
  assert.equal(out.opened.length, 1);
  assert.equal(ch.sent.length, 1);
  const m = ch.sent[0];
  assert.deepEqual([m.severity, m.level, m.kind, m.urgency, m.restaurant_id], ['P1', 0, 'new', 'normal', 'r-1']);
  assert.match(m.title, /P1.*Hotel Mejwani/);
  assert.match(m.body, /2 orders/);
  assert.deepEqual(db.notifiedCalls, [[m.alert_id, 0]]);
});

test('what the channel is given is a closed list of fields: nothing else a row or a rule ever carries can reach a phone', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2, phone: '9822012345', token: 'sk_live_x' })] });
  const ch = channel();
  await pass(db, ch)();
  assert.deepEqual(Object.keys(ch.sent[0]).sort(),
    ['alert_id', 'body', 'kind', 'level', 'restaurant_id', 'restaurant_name', 'severity', 'title', 'urgency']);
  assert.ok(!JSON.stringify(ch.sent).includes('9822012345'));
  assert.ok(!JSON.stringify(ch.sent).includes('sk_live_x'));
});

test('what is sent to the database to open is only what the alert is: no restaurant name, no phone', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2, phone: '9822012345' })] });
  await pass(db, channel())();
  const [o] = db.applied[0].open;
  assert.deepEqual(Object.keys(o).sort(), ['dedupe_key', 'detail', 'restaurant_id', 'rule_key', 'severity']);
});

test('a condition that stays true is one alert and one page, however many passes there are', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  const tick = pass(db, ch);
  for (let i = 0; i < 4; i++) { db.now += MIN; await tick(); }
  assert.equal(db.alerts.length, 1);
  assert.equal(ch.sent.length, 1, 'a reminder is not due for ten minutes');
});

test('the pass uses the database\'s clock, not the worker\'s', async () => {
  const db = new FakeDb({ now: Date.parse('2030-01-01T06:30:00.000Z'), heartbeat: false, tenants: [tenant({ hub_seen_at: '2030-01-01T05:00:00.000Z' })] });
  const out = await pass(db, channel())();
  assert.deepEqual(out.opened.map(o => o.dedupe_key), ['hub_silent_service:r-1'], 'ninety minutes of silence at the database\'s time, whatever this machine thinks');
});

// --- reminders, and then unattended ----------------------------------------------------------------------------------------------

test('reminders every ten minutes, three of them, higher urgency each time, and then the alert is flagged unattended, once', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  const tick = pass(db, ch);
  const levels = () => ch.sent.map(m => [m.level, m.urgency]);

  await tick();
  assert.deepEqual(levels(), [[0, 'normal']]);
  db.now += 10 * MIN - 1; await tick();
  assert.equal(ch.sent.length, 1, 'nine minutes fifty-nine seconds is not ten');
  db.now += 1; await tick();
  assert.deepEqual(levels(), [[0, 'normal'], [1, 'high']]);
  db.now += 10 * MIN; await tick();
  db.now += 10 * MIN; await tick();
  assert.deepEqual(levels().map(l => l[0]), [0, 1, 2, 3]);
  assert.match(ch.sent[3].title, /reminder 3 of 3/i);
  assert.equal(db.alerts[0].unattended_at, null, 'not yet: ten minutes after the last reminder');
  db.now += 10 * MIN; const out = await tick();
  assert.deepEqual(out.flagged, [db.alerts[0].id]);
  db.now += 3 * HOUR; await tick();
  assert.equal(ch.sent.length, 4, 'no fifth page');
  assert.equal(db.applied.filter(a => a.unattended.length).length, 1, 'flagged once');
});

test('an alert that somebody acknowledges is not paged again, and is never flagged', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  const tick = pass(db, ch);
  await tick();
  db.ack(db.alerts[0].id);
  for (let i = 0; i < 6; i++) { db.now += 10 * MIN; await tick(); }
  assert.equal(ch.sent.length, 1);
  assert.equal(db.alerts[0].unattended_at, null);
});

// --- resolving -------------------------------------------------------------------------------------------------------------------

test('when the condition clears the alert resolves by itself, acknowledged or not', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2, hub_queued: 80 })] });
  const tick = pass(db, channel());
  await tick();
  assert.equal(db.alerts.length, 2);
  db.ack(db.alerts[1].id);
  db.tenants[0].hub_quarantined = 0; db.tenants[0].hub_queued = 0;
  db.now += MIN;
  const out = await tick();
  assert.equal(out.resolved.length, 2);
  assert.ok(db.alerts.every(a => a.state === 'resolved'));
});

test('a pass that could not see the whole fleet resolves nothing', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const tick = pass(db, channel());
  await tick();
  db.tenants = [];   // the list came back short
  db.complete = false;
  db.now += MIN;
  const out = await tick();
  assert.deepEqual(out.resolved, []);
  assert.equal(db.alerts[0].state, 'open');
});

// --- quiet hours -----------------------------------------------------------------------------------------------------------------

test('overnight a P2 is held and a P1 is not; the P2 goes out when the founders wake', async () => {
  const night = Date.parse('2026-10-27T20:30:00.000Z');   // 02:00 in India
  const db = new FakeDb({ now: night, tenants: [tenant({ plan_status: 'past_due', hub_quarantined: 1 })], meta: {} });
  const ch = channel();
  const tick = pass(db, ch);
  await tick();
  assert.deepEqual(ch.sent.map(m => m.severity), ['P1'], 'only the P1');
  assert.equal(db.alerts.filter(a => a.severity === 'P2').length, 1, 'the P2 is open and visible, just not sent');
  db.now = Date.parse('2026-10-28T02:30:00.000Z');   // 08:00
  await tick();
  // Worst first: the P1's reminder (it was paged at 02:00 and never answered), then the P2's first page, which nobody has seen until now.
  assert.deepEqual(ch.sent.map(m => `${m.severity}:${m.level}`), ['P1:0', 'P1:1', 'P2:0']);
});

// --- a channel that fails --------------------------------------------------------------------------------------------------------

test('a page that could not be sent is recorded as such, is not marked sent, and is tried again on the next pass', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  ch.failWith = new Error('connect ECONNREFUSED');
  const tick = pass(db, ch);
  const first = await tick();
  assert.deepEqual(first.failed, [db.alerts[0].id]);
  assert.deepEqual(db.notifiedCalls, []);
  assert.equal(db.failures.length, 1);
  ch.failWith = null;
  db.now += MIN;
  const second = await tick();
  assert.deepEqual(second.notified, [db.alerts[0].id]);
  assert.equal(ch.sent.length, 1);
  assert.deepEqual(db.notifiedCalls, [[db.alerts[0].id, 0]], 'and it is level 0 still: nobody was told the first time');
});

test('what is kept about a failed page is the kind of failure and never the message: an error that mentions a token cannot leak it', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  const err = new Error('request to https://api.telegram.org/bot123456:SECRET-TOKEN/sendMessage failed');
  err.name = 'FetchError';
  ch.failWith = err;
  await pass(db, ch)();
  const note = db.failures[0].note;
  assert.ok(!note.includes('SECRET-TOKEN') && !note.includes('telegram'), note);
  assert.match(note, /FetchError/);
  assert.ok(note.length <= 200);
});

test('a channel can give its own safe words for a failure, and those are what is kept', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  ch.failWith = Object.assign(new Error('secret detail'), { publicNote: 'the channel answered 403' });
  await pass(db, ch)();
  assert.equal(db.failures[0].note, 'the channel answered 403');
});

test('one page failing does not stop the others being sent', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 }), tenant({ restaurant_id: 'r-2', name: 'Second', hub_quarantined: 1 })], meta: {} });
  const ch = channel();
  const real = ch.send.bind(ch);
  ch.send = async m => { if (m.restaurant_id === 'r-1') throw new Error('nope'); return real(m); };
  const out = await pass(db, ch)();
  assert.equal(out.failed.length, 1);
  assert.equal(out.notified.length, 1);
  assert.equal(ch.sent[0].restaurant_id, 'r-2');
});

test('a page that went out but could not be recorded is reported, does not stop the pass, and will go again: paging is at-least-once', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  db.failNotified = true;
  const out = await pass(db, ch)();
  assert.equal(ch.sent.length, 1);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /notified failed|record/i);
  db.failNotified = false;
  db.now += MIN;
  await pass(db, ch)();
  assert.equal(ch.sent.length, 2, 'the same page again, rather than a page lost');
});

test('an alert acknowledged while its page was being sent is not counted as paged, and that is not a problem', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel();
  const real = ch.send.bind(ch);
  ch.send = async m => { await real(m); db.ack(m.alert_id); };   // somebody taps "I know" just as it goes out
  const out = await pass(db, ch)();
  assert.equal(ch.sent.length, 1);
  assert.deepEqual(out.notified, []);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.failed, []);
});

test('if a failed page cannot be recorded either, that is reported too and nothing throws', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  const ch = channel(); ch.failWith = new Error('x');
  db.notifyFailed = async () => { throw new Error('and the database is gone'); };
  const out = await pass(db, ch)();
  assert.equal(out.errors.length, 1);
});

// --- a database that fails -------------------------------------------------------------------------------------------------------

test('a pass that cannot read the fleet does nothing at all, and says why', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  db.failSnapshot = true;
  const ch = channel();
  await assert.rejects(() => pass(db, ch)(), /database is down/);
  assert.deepEqual(db.calls, ['snapshot']);
  assert.equal(ch.sent.length, 0);
});

test('a pass whose alerts could not be written pages nobody for alerts that do not exist', async () => {
  const db = new FakeDb({ tenants: [tenant({ hub_quarantined: 2 })] });
  db.failApply = true;
  const ch = channel();
  await assert.rejects(() => pass(db, ch)(), /apply failed/);
  assert.equal(ch.sent.length, 0);
});

// --- starting up -----------------------------------------------------------------------------------------------------------------

test('quiet hours that cannot be read stop the worker being built, rather than leaving it never quiet', () => {
  assert.throws(() => createTick({ db: new FakeDb(), notifier: channel(), config: { ...ALERT_DEFAULTS, quiet: { timeZone: 'Nowhere/Land', from: '22:00', to: '08:00' } } }));
});

test('a worker needs a way to read the database and a way to page', () => {
  assert.throws(() => createTick({ db: null, notifier: channel() }));
  assert.throws(() => createTick({ db: new FakeDb(), notifier: null }));
  assert.throws(() => createTick({ db: new FakeDb(), notifier: {} }));
});

// --- the loop --------------------------------------------------------------------------------------------------------------------

const timers = () => {
  const t = { pending: null, set(fn, ms) { t.pending = { fn, ms }; return t.pending; }, clear(h) { if (t.pending === h) t.pending = null; } };
  return t;
};
const flush = () => new Promise(r => setImmediate(r));

test('the loop runs one pass, waits, runs another, and never overlaps two', async () => {
  const t = timers();
  let running = 0, peak = 0, runs = 0;
  const tick = async () => { running++; peak = Math.max(peak, running); runs++; await flush(); running--; return {}; };
  const w = startWorker({ tick, intervalMs: 60000, log: () => {}, setTimer: t.set, clearTimer: t.clear });
  await flush(); await flush();
  assert.equal(runs, 1);
  assert.equal(t.pending.ms, 60000);
  t.pending.fn(); t.pending.fn?.();
  await flush(); await flush();
  assert.equal(runs, 2);
  assert.equal(peak, 1);
  await w.stop();
});

test('a pass that fails is logged and the loop carries on', async () => {
  const t = timers();
  const logged = [];
  let runs = 0;
  const tick = async () => { runs++; if (runs === 1) throw new Error('database is down'); return {}; };
  const w = startWorker({ tick, intervalMs: 1000, log: (...a) => logged.push(a.join(' ')), setTimer: t.set, clearTimer: t.clear });
  await flush(); await flush();
  assert.match(logged.join('\n'), /database is down/);
  assert.ok(t.pending, 'and the next pass is scheduled');
  t.pending.fn();
  await flush(); await flush();
  assert.equal(runs, 2);
  await w.stop();
});

test('stopping cancels the next pass and waits for the one running', async () => {
  const t = timers();
  let finish;
  const tick = () => new Promise(r => { finish = r; });
  const w = startWorker({ tick, intervalMs: 1000, log: () => {}, setTimer: t.set, clearTimer: t.clear });
  await flush();
  let stopped = false;
  const p = w.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false, 'a pass is still running');
  finish({});
  await p;
  assert.equal(t.pending, null, 'nothing scheduled after stop');
});

test('stopping between passes cancels the pass that was waiting', async () => {
  const t = timers();
  let runs = 0;
  const w = startWorker({ tick: async () => { runs++; return {}; }, intervalMs: 1000, log: () => {}, setTimer: t.set, clearTimer: t.clear });
  await flush(); await flush();
  assert.ok(t.pending, 'a pass is waiting');
  const waiting = t.pending;
  await w.stop();
  assert.equal(t.pending, null, 'and stopping cancelled it');
  waiting.fn();
  await flush(); await flush();
  assert.equal(runs, 1, 'and even if it fired, a stopped worker does not run');
});

test('what a pass logs is its counts, not what it sent', async () => {
  const t = timers();
  const logged = [];
  const tick = async () => ({ opened: [1, 2], resolved: [], flagged: [], notified: [1], failed: [], errors: [] });
  const w = startWorker({ tick, intervalMs: 1000, log: (...a) => logged.push(a.join(' ')), setTimer: t.set, clearTimer: t.clear });
  await flush(); await flush();
  assert.match(logged.join('\n'), /opened 2/);
  await w.stop();
});

// --- the real thing: the SQL functions on a real engine ---------------------------------------------------------------------------

let cloud;
let TEN;
const F1 = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const q = (sql, params) => cloud.pg.query(sql, params);
const asWorker = (sql, params) => cloud.as('kullina_alerts', null, () => q(sql, params));

before(async () => {
  cloud = await cloudDb();
  await q(`DELETE FROM public.restaurants WHERE id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`);
  TEN = await cloud.seedTenants();
  await q(`INSERT INTO auth.users (id, email) VALUES ($1, 'aman@example.test')`, [F1]);
  await q(`SELECT public.seed_admin_user('aman@example.test', 'Aman')`);
  await q(`SELECT public.set_tenant_service_hours($1, 'Asia/Kolkata', $2::jsonb)`, [TEN.A.restaurant, JSON.stringify(HOURS)]);
  await q(`SELECT public.set_tenant_service_hours($1, 'Asia/Kolkata', $2::jsonb)`, [TEN.B.restaurant, JSON.stringify(HOURS)]);
});
after(async () => { await cloud?.close(); });

test('the worker may only connect as its own role: any other login is refused', async () => {
  await assert.rejects(() => assertAlertRole((s, p) => q(s, p)), /kullina_alerts/);
  await assertAlertRole((s, p) => asWorker(s, p));
});

test('end to end on the real functions: an alert opens, is paged once, is reminded ten minutes later, stops when acknowledged and resolves when the problem goes', async () => {
  const db = makeAlertDb((s, p) => asWorker(s, p));
  const ch = channel();
  const tick = createTick({ db, notifier: ch, config: { ...ALERT_DEFAULTS, quiet: { timeZone: 'Asia/Kolkata', from: '03:00', to: '03:01' } } });   // never overnight: the real clock decides when this runs
  await q(`INSERT INTO public.hub_status (restaurant_id, reported_at, queued, quarantined) VALUES ($1, now(), 0, 3) ON CONFLICT (restaurant_id) DO UPDATE SET quarantined = 3, queued = 0`, [TEN.A.restaurant]);

  const first = await tick();
  const mine = first.opened.find(o => o.dedupe_key === `orders_shelved:${TEN.A.restaurant}`);
  assert.ok(mine, 'the shelved orders opened an alert');
  const pages = () => ch.sent.filter(m => m.alert_id === mine.id);
  assert.equal(pages().length, 1);
  assert.match(pages()[0].body, /3 orders/);

  await tick();
  assert.equal(pages().length, 1, 'once');

  await q(`UPDATE public.alerts SET last_notified_at = now() - interval '10 minutes' WHERE id = $1`, [mine.id]);
  await tick();
  assert.deepEqual(pages().map(m => [m.level, m.urgency]), [[0, 'normal'], [1, 'high']]);

  await cloud.as('kullina_admin', null, async () => {
    await q(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: F1, aal: 'aal2', role: 'authenticated' })]);
    try { await q(`SELECT * FROM public.admin_ack_alert($1, 'on it, looking now')`, [mine.id]); } finally { await q(`SELECT set_config('request.jwt.claims', '', false)`); }
  });
  await q(`UPDATE public.alerts SET last_notified_at = now() - interval '30 minutes' WHERE id = $1`, [mine.id]);
  await tick();
  assert.equal(pages().length, 2, 'acknowledged: no more');

  await q(`UPDATE public.hub_status SET quarantined = 0 WHERE restaurant_id = $1`, [TEN.A.restaurant]);
  const last = await tick();
  assert.ok(last.resolved.includes(mine.id));
  const [row] = (await q(`SELECT state, resolve_reason, resolved_by FROM public.alerts WHERE id = $1`, [mine.id])).rows;
  assert.deepEqual(row, { state: 'resolved', resolve_reason: 'condition_cleared', resolved_by: null });

  const types = (await q(`SELECT type FROM public.tenant_events WHERE restaurant_id = $1 AND (payload ->> 'alert_id')::bigint = $2 ORDER BY id`, [TEN.A.restaurant, mine.id])).rows.map(r => r.type);
  assert.deepEqual(types, ['alert.opened', 'alert.notified', 'alert.notified', 'alert.acked', 'alert.resolved']);
});

test('end to end: a failing channel leaves the alert due, records the failure once, and the page goes when the channel is back', async () => {
  const db = makeAlertDb((s, p) => asWorker(s, p));
  const ch = channel();
  const tick = createTick({ db, notifier: ch, config: { ...ALERT_DEFAULTS, quiet: { timeZone: 'Asia/Kolkata', from: '03:00', to: '03:01' } } });
  await q(`INSERT INTO public.hub_status (restaurant_id, reported_at, queued, quarantined) VALUES ($1, now(), 0, 1) ON CONFLICT (restaurant_id) DO UPDATE SET quarantined = 1, queued = 0`, [TEN.B.restaurant]);
  ch.failWith = Object.assign(new Error('boom https://x/bot123:TOKEN'), { name: 'FetchError' });
  const a = await tick();
  const id = a.opened.find(o => o.dedupe_key === `orders_shelved:${TEN.B.restaurant}`).id;
  await tick();
  const failures = (await q(`SELECT payload FROM public.tenant_events WHERE type = 'alert.notify_failed' AND (payload ->> 'alert_id')::bigint = $1`, [id])).rows;
  assert.equal(failures.length, 1, 'the second failure within ten minutes is not recorded again');
  assert.ok(!JSON.stringify(failures).includes('TOKEN'));
  assert.equal((await q(`SELECT last_notified_at FROM public.alerts WHERE id = $1`, [id])).rows[0].last_notified_at, null);
  ch.failWith = null;
  await tick();
  assert.equal(ch.sent.filter(m => m.alert_id === id).length, 1);
});

test('end to end: a restaurant with no hours is flagged "service hours missing" and is never paged for it', async () => {
  const db = makeAlertDb((s, p) => asWorker(s, p));
  const ch = channel();
  const tick = createTick({ db, notifier: ch, config: { ...ALERT_DEFAULTS, quiet: { timeZone: 'Asia/Kolkata', from: '03:00', to: '03:01' } } });
  await q(`DELETE FROM public.tenant_admin_meta WHERE restaurant_id = $1`, [TEN.B.restaurant]);
  const out = await tick();
  assert.ok(out.opened.some(o => o.dedupe_key === `service_hours_missing:${TEN.B.restaurant}`));
  assert.ok(!ch.sent.some(m => m.severity === 'P3'));
});
