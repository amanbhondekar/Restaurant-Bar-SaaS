import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE_LABEL, LIMIT_LABEL, PLAN_LABEL, featureRows, formatWhen, limitRows, planBanner, planLabel, usageTone
} from '../../src/admin/lib/plan.js';
import { PLANS, getFeatures, getLimits, resolveEffectivePlan } from '../lib/plans.js';

// The owner console's plan view (M3 · PR 18). The hub's plans.js is the oracle: whatever it
// enforces is what this page has to be able to name and draw.

const NOW = new Date('2026-06-15T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = days => new Date(NOW.getTime() + days * DAY).toISOString();

/** Build what GET /plan answers for a tenant row, the same way server.js does. */
function planResponse(tenant, usage = { devices: 0, waiters: 0, printers: 0 }) {
  const eff = resolveEffectivePlan(tenant, NOW);
  return {
    plan: eff.plan,
    requested_plan: eff.requested_plan,
    status: eff.status,
    degraded: eff.degraded,
    degraded_reason: eff.reason,
    in_grace: eff.in_grace,
    grace_ends_at: eff.grace_ends_at,
    limits: getLimits(eff.plan),
    features: getFeatures(eff.plan),
    usage,
    synced_at: null
  };
}

// --- drift guards: the page must be able to name everything the hub enforces ------------------

test('plan view: every plan, feature and limit the hub defines has a label', () => {
  for (const id of Object.keys(PLANS)) {
    assert.ok(PLAN_LABEL[id], `plan '${id}' needs a label`);
    assert.equal(planLabel(id), PLAN_LABEL[id]);
  }
  for (const feature of Object.keys(PLANS.starter.features)) {
    assert.ok(FEATURE_LABEL[feature], `feature '${feature}' needs a label`);
  }
  for (const limit of Object.keys(PLANS.starter.limits)) {
    assert.ok(LIMIT_LABEL[limit], `limit '${limit}' needs a label`);
  }
});

test('plan view: an unknown key still renders, falling back to the key itself', () => {
  assert.equal(planLabel('platinum'), 'platinum');
  const rows = featureRows({ features: { teleportation: true } });
  assert.equal(rows[0].label, 'teleportation');
  assert.equal(rows[0].text, 'Included');
});

// --- the banner ------------------------------------------------------------------------------

test('plan view: a healthy subscription says nothing', () => {
  assert.equal(planBanner(planResponse({ plan: 'pro', plan_status: 'active' })), null);
  assert.equal(planBanner(planResponse({ plan: 'pro', plan_status: 'trialing', trial_ends_at: iso(5) })), null);
  // A hub that predates plan sync resolves to pro and is not degraded.
  assert.equal(planBanner(planResponse({})), null);
  assert.equal(planBanner(null), null);
});

test('plan view: each way a plan degrades gets its own explanation', () => {
  const cases = [
    [{ plan: 'pro', plan_status: 'trialing', trial_ends_at: iso(-1) }, 'TRIAL_EXPIRED', 'free trial'],
    [{ plan: 'pro', plan_status: 'past_due', current_period_end: iso(-30) }, 'PAYMENT_OVERDUE', 'overdue'],
    [{ plan: 'pro', plan_status: 'suspended' }, 'SUSPENDED', 'suspended'],
    [{ plan: 'pro', plan_status: 'cancelled' }, 'CANCELLED', 'cancelled']
  ];
  for (const [tenant, reason, phrase] of cases) {
    const response = planResponse(tenant);
    assert.equal(response.degraded_reason, reason, `${reason} should be the hub's reason`);
    const banner = planBanner(response);
    assert.equal(banner.tone, 'error');
    assert.equal(banner.title, 'Running on Starter, not Pro');
    assert.match(banner.body, new RegExp(phrase, 'i'));
    // Degrading never stops service, and the banner has to say so.
    assert.match(banner.body, /never switched off/);
  }
});

test('plan view: inside the past-due grace period the tone is a warning, not an error', () => {
  const response = planResponse({ plan: 'pro', plan_status: 'past_due', current_period_end: iso(-1) });
  assert.equal(response.degraded, false);
  assert.equal(response.in_grace, true);
  const banner = planBanner(response);
  assert.equal(banner.tone, 'warning');
  assert.equal(banner.title, 'Payment overdue');
  assert.match(banner.body, /Everything still works until /);
});

test('plan view: past_due with no period end is in grace and reads without a date', () => {
  const response = planResponse({ plan: 'pro', plan_status: 'past_due' });
  assert.equal(response.in_grace, true);
  assert.equal(response.grace_ends_at, null);
  assert.equal(planBanner(response).body, 'Everything still works. After that this restaurant drops to Starter.');
});

test('plan view: degradation outranks the grace period', () => {
  // Not a state the hub produces today, but the page must not promise service on a degraded plan.
  const banner = planBanner({ degraded: true, in_grace: true, plan: 'starter', requested_plan: 'pro', degraded_reason: 'SUSPENDED' });
  assert.equal(banner.tone, 'error');
});

test('plan view: an unrecognised reason still degrades with a usable sentence', () => {
  const banner = planBanner({ degraded: true, plan: 'starter', requested_plan: 'pro', degraded_reason: 'CHARGEBACK_V2' });
  assert.equal(banner.tone, 'error');
  assert.match(banner.body, /not active/);
});

// --- limits and usage ------------------------------------------------------------------------

test('plan view: usageTone warns one short of the limit and alarms at it', () => {
  assert.equal(usageTone(0, 3), 'green');
  assert.equal(usageTone(1, 3), 'green');
  assert.equal(usageTone(2, 3), 'amber');
  assert.equal(usageTone(3, 3), 'rust');
  assert.equal(usageTone(9, 3), 'rust', 'over the limit stays at the top tone');
  assert.equal(usageTone(5, null), 'none', 'an uncapped limit has no tone');
  assert.equal(usageTone(undefined, 3), 'none', 'an uncounted limit has no tone');
});

test('plan view: counted limits read as "n of m" with a bar', () => {
  const response = planResponse({ plan: 'starter', plan_status: 'active' }, { devices: 3, waiters: 1, printers: 0 });
  const rows = limitRows(response);
  const devices = rows.find(r => r.key === 'devices');
  assert.equal(devices.text, '3 of 3');
  assert.equal(devices.tone, 'rust');
  assert.equal(devices.percent, 100);
  assert.equal(devices.counted, true);

  const waiters = rows.find(r => r.key === 'waiters');
  assert.equal(waiters.text, '1 of 5');
  assert.equal(waiters.percent, 20);
  assert.equal(waiters.tone, 'green');
});

test('plan view: tables is capped but not counted by the hub', () => {
  // PR 16 enforces the tables cap at provisioning, not on the hub: truncating a live floor plan
  // mid-service would be an outage. The row shows the cap with no count and no bar.
  const rows = limitRows(planResponse({ plan: 'starter', plan_status: 'active' }));
  const tables = rows.find(r => r.key === 'tables');
  assert.equal(tables.counted, false);
  assert.equal(tables.current, null);
  assert.equal(tables.text, '– of 15');
  assert.equal(tables.percent, 0);
});

test('plan view: enterprise limits read as unlimited and draw no bar', () => {
  const rows = limitRows(planResponse({ plan: 'enterprise', plan_status: 'active' }, { devices: 42, waiters: 9, printers: 2 }));
  for (const row of rows) {
    assert.equal(row.unlimited, true, `${row.key} should be uncapped on enterprise`);
    assert.equal(row.tone, 'none');
    assert.equal(row.percent, 0);
  }
  assert.equal(rows.find(r => r.key === 'devices').text, '42 of unlimited');
});

test('plan view: a row is produced for every limit, in the hub\'s own order', () => {
  const rows = limitRows(planResponse({ plan: 'pro', plan_status: 'active' }));
  assert.deepEqual(rows.map(r => r.key), Object.keys(PLANS.pro.limits));
});

// --- features --------------------------------------------------------------------------------

test('plan view: features report exactly what the plan grants', () => {
  const starter = featureRows(planResponse({ plan: 'starter', plan_status: 'active' }));
  assert.ok(starter.every(r => r.on === false), 'starter grants none of the gated features');
  assert.ok(starter.every(r => r.text === 'Not on this plan'));

  const pro = featureRows(planResponse({ plan: 'pro', plan_status: 'active' }));
  assert.ok(pro.every(r => r.on === true));
  assert.ok(pro.every(r => r.text === 'Included'));

  // A cancelled Pro tenant is shown Starter's features, not the ones they paid for.
  const cancelled = featureRows(planResponse({ plan: 'pro', plan_status: 'cancelled' }));
  assert.ok(cancelled.every(r => r.on === false));
});

test('plan view: missing limits or features render as nothing rather than throwing', () => {
  assert.deepEqual(limitRows({}), []);
  assert.deepEqual(featureRows({}), []);
  assert.deepEqual(limitRows(null), []);
  assert.deepEqual(featureRows(undefined), []);
});

// --- timestamps ------------------------------------------------------------------------------

test('plan view: a hub that has never reached the cloud says so', () => {
  assert.equal(formatWhen(null), 'never');
  assert.equal(formatWhen(undefined), 'never');
  assert.equal(formatWhen(''), 'never');
  assert.equal(formatWhen('not a date'), 'never');
});

test('plan view: a real timestamp is rendered, not passed through raw', () => {
  const shown = formatWhen('2026-06-15T10:00:00Z');
  assert.notEqual(shown, 'never');
  assert.ok(!shown.includes('T'), 'the raw ISO string should not reach the page');
  assert.match(shown, /2026/);
});
