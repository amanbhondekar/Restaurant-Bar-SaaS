import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLANS, FEATURES, PAST_DUE_GRACE_DAYS, normalizePlanId, resolveEffectivePlan,
  checkLimit, featureRefusal, hasFeature, minimumPlanFor, applyPlanToMenuItems
} from '../lib/plans.js';

// ---------------------------------------------------------------------------
// M3 · PR 16 — Plan enforcement. Pure rules first, then a live hub fixture.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T10:00:00Z');
const iso = (offsetDays) => new Date(NOW.getTime() + offsetDays * DAY).toISOString();

test('plans: normalizePlanId whitelists and falls back', () => {
  assert.equal(normalizePlanId('PRO'), 'pro');
  assert.equal(normalizePlanId(' enterprise '), 'enterprise');
  assert.equal(normalizePlanId('platinum'), 'starter');
  assert.equal(normalizePlanId(undefined), 'starter');
  assert.equal(normalizePlanId('', 'pro'), 'pro');
});

test('plans: tiers are monotonic — a higher plan never has fewer features or lower limits', () => {
  const ids = ['starter', 'pro', 'enterprise'];
  for (let i = 1; i < ids.length; i++) {
    const lo = PLANS[ids[i - 1]];
    const hi = PLANS[ids[i]];
    for (const [feat, on] of Object.entries(lo.features)) {
      if (on) assert.equal(hi.features[feat], true, `${ids[i]} must keep ${feat}`);
    }
    for (const [key, lim] of Object.entries(lo.limits)) {
      if (hi.limits[key] === null) continue;
      assert.ok(lim !== null && hi.limits[key] >= lim, `${ids[i]} ${key} limit must not shrink`);
    }
  }
  assert.equal(minimumPlanFor(FEATURES.SPLIT_BILL), 'pro');
});

test('plans: resolveEffectivePlan — active, trialing, legacy and unknown status', () => {
  // Active keeps the plan.
  const active = resolveEffectivePlan({ plan: 'pro', plan_status: 'active' }, NOW);
  assert.equal(active.plan, 'pro');
  assert.equal(active.degraded, false);

  // A hub that predates plan sync (no plan at all) is treated as 'pro', not 'starter'.
  assert.equal(resolveEffectivePlan({}, NOW).plan, 'pro');
  assert.equal(resolveEffectivePlan(undefined, NOW).plan, 'pro');

  // Unknown plan id on the row resolves to starter; unknown status is not punished.
  assert.equal(resolveEffectivePlan({ plan: 'platinum' }, NOW).plan, 'starter');
  const weird = resolveEffectivePlan({ plan: 'pro', plan_status: 'incomplete_v2' }, NOW);
  assert.equal(weird.plan, 'pro');
  assert.equal(weird.degraded, false);

  // Trial: full plan until trial_ends_at, then degrade.
  assert.equal(resolveEffectivePlan({ plan: 'pro', plan_status: 'trialing', trial_ends_at: iso(3) }, NOW).plan, 'pro');
  const expired = resolveEffectivePlan({ plan: 'pro', plan_status: 'trialing', trial_ends_at: iso(-1) }, NOW);
  assert.equal(expired.plan, 'starter');
  assert.equal(expired.degraded, true);
  assert.equal(expired.reason, 'TRIAL_EXPIRED');
  assert.equal(expired.requested_plan, 'pro');
});

test('plans: past_due keeps the plan through the grace window, then degrades', () => {
  const within = resolveEffectivePlan(
    { plan: 'enterprise', plan_status: 'past_due', current_period_end: iso(-(PAST_DUE_GRACE_DAYS - 1)) }, NOW);
  assert.equal(within.plan, 'enterprise');
  assert.equal(within.in_grace, true);
  assert.ok(within.grace_ends_at);

  const after = resolveEffectivePlan(
    { plan: 'enterprise', plan_status: 'past_due', current_period_end: iso(-(PAST_DUE_GRACE_DAYS + 1)) }, NOW);
  assert.equal(after.plan, 'starter');
  assert.equal(after.degraded, true);
  assert.equal(after.reason, 'PAYMENT_OVERDUE');

  // Missing period end: be generous rather than cut off on incomplete data.
  const noEnd = resolveEffectivePlan({ plan: 'pro', plan_status: 'past_due' }, NOW);
  assert.equal(noEnd.plan, 'pro');
  assert.equal(noEnd.in_grace, true);
});

test('plans: suspended and cancelled degrade to starter; a starter tenant is never "degraded"', () => {
  assert.equal(resolveEffectivePlan({ plan: 'pro', plan_status: 'suspended' }, NOW).reason, 'SUSPENDED');
  assert.equal(resolveEffectivePlan({ plan: 'pro', plan_status: 'cancelled' }, NOW).plan, 'starter');
  assert.equal(resolveEffectivePlan({ plan: 'pro', plan_status: 'canceled' }, NOW).reason, 'CANCELLED');
  const starterCancelled = resolveEffectivePlan({ plan: 'starter', plan_status: 'cancelled' }, NOW);
  assert.equal(starterCancelled.plan, 'starter');
  assert.equal(starterCancelled.degraded, false);
});

test('plans: checkLimit gates only NEW additions and names the upgrade', () => {
  assert.equal(checkLimit('starter', 'devices', 2).ok, true);
  const full = checkLimit('starter', 'devices', 3);
  assert.equal(full.ok, false);
  assert.equal(full.code, 'PLAN_LIMIT_REACHED');
  assert.equal(full.status, 403);
  assert.equal(full.limit, 3);
  assert.equal(full.upgrade_to, 'pro');
  assert.match(full.error, /Starter plan allows 3 devices/);

  // Already over the limit after a downgrade: still refused, never negative / throwing.
  assert.equal(checkLimit('starter', 'waiters', 12).ok, false);

  // Enterprise is unlimited; unknown keys never block.
  assert.equal(checkLimit('enterprise', 'devices', 5000).ok, true);
  assert.equal(checkLimit('starter', 'unknown_key', 999).ok, true);
  assert.equal(checkLimit('enterprise', 'devices', 1).limit, null);
});

test('plans: featureRefusal and hasFeature agree', () => {
  assert.equal(hasFeature('starter', FEATURES.SPLIT_BILL), false);
  assert.equal(hasFeature('pro', FEATURES.SPLIT_BILL), true);
  const r = featureRefusal('starter', FEATURES.MODIFIERS);
  assert.equal(r.code, 'PLAN_FEATURE_UNAVAILABLE');
  assert.equal(r.upgrade_to, 'pro');
  assert.match(r.error, /modifiers is not included in your Starter plan/);
});

test('plans: applyPlanToMenuItems strips gated fields, keeps variants and 86\'d flags', () => {
  const items = [
    {
      id: 'a', name: 'Curry', price: 200, available: true, station: 'bar',
      variants: [{ id: 'v1', label: 'Half', price: 120, available: false }],
      modifier_groups: [{ id: 'g', label: 'Spice', min: 1, max: 1, options: [] }],
      day_parts: [{ id: 'dp', label: 'Lunch', starts_at: '12:00', ends_at: '15:00', price: 150 }]
    },
    { id: 'b', name: 'Plain', price: 50, available: true }
  ];
  const starter = applyPlanToMenuItems(items, PLANS.starter.features);
  assert.equal('modifier_groups' in starter[0], false);
  assert.equal('day_parts' in starter[0], false);
  assert.equal('station' in starter[0], false);
  assert.equal(starter[0].variants[0].available, false, "variants and 86'd stay on every plan");
  assert.equal(starter[1], items[1], 'untouched items are returned as-is');
  // Input is not mutated.
  assert.ok(items[0].modifier_groups && items[0].day_parts && items[0].station);

  // Pro keeps everything and returns the same array (no needless copy).
  assert.equal(applyPlanToMenuItems(items, PLANS.pro.features), items);
  // Missing features object = no gating.
  assert.equal(applyPlanToMenuItems(items, null), items);

  // Each flag strips only its own field.
  const onlyNoMods = applyPlanToMenuItems(items, { ...PLANS.pro.features, modifiers: false });
  assert.equal('modifier_groups' in onlyNoMods[0], false);
  assert.equal('day_parts' in onlyNoMods[0], true);
  assert.equal('station' in onlyNoMods[0], true);
});

// ---------------------------------------------------------------------------
// Live hub: subscribed to PRO but status 'cancelled' → effective plan STARTER.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 4598;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = 'PLANCODE';
const RESTAURANT_ID = '11111111-1111-1111-1111-111111111111';

const MENU = {
  restaurant_id: RESTAURANT_ID,
  categories: ['Mains'],
  items: [
    {
      id: 'x1', name: 'Tikka', price: 340, category: 'Mains', isVeg: false, available: true, station: 'bar',
      variants: [{ id: 'v_half', label: 'Half', price: 220 }, { id: 'v_full', label: 'Full', price: 340 }],
      modifier_groups: [{
        id: 'mg_spice', label: 'Spice', min: 1, max: 1,
        options: [{ id: 'hot', label: 'Hot', price_delta: 0 }, { id: 'mild', label: 'Mild', price_delta: 0 }]
      }],
      day_parts: [{ id: 'dp_all', label: 'All day', starts_at: '00:00', ends_at: '23:59', price: 100 }]
    }
  ]
};

let child;
let dataDir;
const tokens = [];

function api(pathname, { token, ...opts } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}${pathname}`, { ...opts, headers });
}

async function enroll(label, code = CODE) {
  const res = await api('/auth/device', { method: 'POST', body: JSON.stringify({ enrollment_code: code, device_label: label }) });
  return { res, body: await res.json() };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-plan-test-'));
  fs.writeFileSync(path.join(dataDir, 'menu_cache.json'), JSON.stringify(MENU));
  fs.writeFileSync(path.join(dataDir, 'tables_cache.json'), JSON.stringify({
    restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }]
  }));
  fs.writeFileSync(path.join(dataDir, 'tickets.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'sync_queue.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
    paired: true, restaurant_id: RESTAURANT_ID, name: 'Plan Test Kitchen', pairing_code: 'PLN-0001',
    city: 'Nagpur', enrollment_code: CODE, devices: [],
    plan: 'pro', plan_status: 'cancelled'
  }));

  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, PORT: String(PORT), HUB_DATA_DIR: dataDir,
      HUB_TRUST_LOOPBACK: 'false', SUPABASE_URL: 'https://example.supabase.co'
    },
    stdio: 'ignore'
  });

  const deadline = Date.now() + 20000;
  for (;;) {
    try { await fetch(`${BASE}/pairing-info`); break; }
    catch {
      if (Date.now() > deadline) throw new Error('plan-test hub did not start');
      await new Promise(r => setTimeout(r, 200));
    }
  }
});

after(() => {
  if (child) child.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('hub: a wrong enrollment code is refused with 401 and never leaks plan details', async () => {
  const { res, body } = await enroll('Probe', 'WRONGCODE');
  assert.equal(res.status, 401);
  assert.equal(body.code, undefined);
  assert.equal(body.plan, undefined);
});

test('hub: device limit — starter allows 3 enrollments, the 4th is refused with plan details', async () => {
  for (let i = 1; i <= 3; i++) {
    const { res, body } = await enroll(`Handset ${i}`);
    assert.equal(res.status, 200, `enrollment ${i} should succeed`);
    tokens.push(body.device_token);
  }
  const { res, body } = await enroll('Handset 4');
  assert.equal(res.status, 403);
  assert.equal(body.code, 'PLAN_LIMIT_REACHED');
  assert.equal(body.limit_key, 'devices');
  assert.equal(body.limit, 3);
  assert.equal(body.current, 3);
  assert.equal(body.plan, 'starter');
  assert.equal(body.upgrade_to, 'pro');
});

test('hub: GET /plan reports the degraded effective plan, limits, features and usage', async () => {
  const res = await api('/plan', { token: tokens[0] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan, 'starter');
  assert.equal(body.requested_plan, 'pro');
  assert.equal(body.status, 'cancelled');
  assert.equal(body.degraded, true);
  assert.equal(body.degraded_reason, 'CANCELLED');
  assert.equal(body.limits.devices, 3);
  assert.equal(body.features.split_bill, false);
  assert.equal(body.usage.devices, 3);
  assert.ok(Number.isInteger(body.usage.waiters));
});

test('hub: GET /plan requires a device token', async () => {
  assert.equal((await api('/plan')).status, 401);
});

test('hub: waiter limit — adding is refused once the plan limit is reached', async () => {
  const plan = await (await api('/plan', { token: tokens[0] })).json();
  const limit = plan.limits.waiters;
  let created = plan.usage.waiters;
  let n = 0;
  while (created < limit) {
    const r = await api('/waiters', { token: tokens[0], method: 'POST', body: JSON.stringify({ name: `Waiter ${++n}`, pin: '1234' }) });
    assert.equal(r.status, 201);
    created++;
  }
  const over = await api('/waiters', { token: tokens[0], method: 'POST', body: JSON.stringify({ name: 'One Too Many', pin: '1234' }) });
  assert.equal(over.status, 403);
  const body = await over.json();
  assert.equal(body.code, 'PLAN_LIMIT_REACHED');
  assert.equal(body.limit_key, 'waiters');
  assert.equal(body.limit, limit);
  assert.equal(body.success, false);
});

test('hub: GET /menu strips gated fields but keeps variants', async () => {
  const body = await (await api('/menu', { token: tokens[0] })).json();
  const item = body.items.find(i => i.id === 'x1');
  assert.ok(item);
  assert.equal('modifier_groups' in item, false);
  assert.equal('day_parts' in item, false);
  assert.equal('station' in item, false);
  assert.equal(item.variants.length, 2, 'variants are core and stay on every plan');
  assert.equal(item.effective_price, 340, 'day-part price must not apply when the plan lacks day-part pricing');
});

test('hub: orders price at the base variant (no day-part) and stamp the default station', async () => {
  const res = await api('/orders', {
    token: tokens[0], method: 'POST',
    body: JSON.stringify({ table_id: 1, table_name: 'T1', items: [{ id: 'x1', qty: 1, variant_id: 'v_full' }] })
  });
  assert.equal(res.status, 201);
  const { ticket } = await res.json();
  assert.equal(ticket.items[0].price, 340, 'base variant price, not the ₹100 day-part');
  assert.equal(ticket.items[0].day_part_id, null);
  assert.equal(ticket.items[0].station, 'hot', "station routing is gated, so everything fires to 'hot'");
});

test('hub: a stale handset sending modifiers is refused (SPURIOUS_MODIFIERS), not silently mispriced', async () => {
  const res = await api('/orders', {
    token: tokens[0], method: 'POST',
    body: JSON.stringify({
      table_id: 1, table_name: 'T1',
      items: [{ id: 'x1', qty: 1, variant_id: 'v_full', modifiers: [{ group_id: 'mg_spice', option_id: 'hot' }] }]
    })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.details[0].reason, 'SPURIOUS_MODIFIERS');
});

test('hub: split-bill and refund routes return 403 PLAN_FEATURE_UNAVAILABLE on starter', async () => {
  const cases = [
    ['/invoices/any/split-by-seats', { count: 2 }, 'split_bill'],
    ['/invoices/any/split-by-items', { assignments: [] }, 'split_bill'],
    ['/invoices/any/split-by-amounts', { shares: [] }, 'split_bill'],
    ['/invoices/any/refund', { reason: 'test' }, 'refunds']
  ];
  for (const [route, payload, feature] of cases) {
    const res = await api(route, { token: tokens[0], method: 'POST', body: JSON.stringify(payload) });
    assert.equal(res.status, 403, route);
    const body = await res.json();
    assert.equal(body.code, 'PLAN_FEATURE_UNAVAILABLE', route);
    assert.equal(body.feature, feature, route);
    assert.equal(body.upgrade_to, 'pro', route);
  }
});

test('hub: core flows are never blocked by a degraded plan (order entry, bill preview, KOT reprint)', async () => {
  const preview = await api('/tables/1/invoice/preview', { token: tokens[0], method: 'POST', body: JSON.stringify({}) });
  assert.equal(preview.status, 200);
  const active = await api('/orders/active', { token: tokens[0] });
  assert.equal(active.status, 200);
  const { tickets } = await active.json();
  assert.ok(tickets.length >= 1);
  const kot = await api(`/orders/${tickets[0].id}/print-kot`, { token: tokens[0], method: 'POST' });
  assert.equal(kot.status, 200);
});
