import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pairing a hub to a tenant (M3 · PR 17). The interesting cases are the ones where the cloud
// does not simply answer "here is your restaurant": a self-serve product must not quietly bind a
// real restaurant to a demo tenant because its internet was down.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pairing-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';

const { hubConfig } = await import('../lib/hubConfig.js');

const TENANT = {
  id: '33333333-3333-3333-3333-333333333333',
  name: 'Spice Garden Bistro',
  slug: 'spice-garden-bistro',
  city: 'Bengaluru',
  pairing_code: 'SPG-4821',
  plan: 'pro',
  plan_status: 'trialing',
  trial_ends_at: '2026-10-28T00:00:00.000Z',
  current_period_end: null
};

/** A cloud that holds `rows`, or refuses, or throws -- the three ways a lookup can end. */
function fakeCloud({ rows = [], error = null, throws = false } = {}) {
  return {
    from() {
      return {
        select: () => ({
          ilike: (_col, value) => ({
            maybeSingle: async () => {
              if (throws) throw new Error('getaddrinfo ENOTFOUND');
              if (error) return { data: null, error };
              const hit = rows.find(r => r.pairing_code.toUpperCase() === String(value).toUpperCase());
              return { data: hit || null, error: null };
            }
          })
        })
      };
    }
  };
}

const configured = on => {
  process.env.SUPABASE_URL = on ? 'https://realproject.supabase.co' : 'https://example.supabase.co';
};

function reset(cloud) {
  hubConfig.cloud = cloud;
  // Start from an unpaired hub, the state a freshly installed reception laptop is in.
  hubConfig.config = { paired: false };
}

test.after(() => { configured(false); });

// --- the happy path ----------------------------------------------------------------------------

test('pairing: a code the cloud knows binds the hub to that tenant', async () => {
  configured(true);
  reset(fakeCloud({ rows: [TENANT] }));

  const result = await hubConfig.pairWithCode('SPG-4821');
  assert.equal(result.success, true);
  assert.equal(result.restaurant.restaurant_id, TENANT.id);
  assert.equal(result.restaurant.name, 'Spice Garden Bistro');
  assert.equal(result.restaurant.paired, true);
});

test('pairing: the code is matched however the operator types it', async () => {
  configured(true);
  reset(fakeCloud({ rows: [TENANT] }));
  const result = await hubConfig.pairWithCode('  spg-4821 ');
  assert.equal(result.success, true);
});

test('pairing: a newly provisioned tenant reports that it is on a trial, and until when', async () => {
  // provision_restaurant (migration 007) creates tenants as trialing, so this is what the
  // reception laptop sees on the very first pairing. Saying "Pro" without saying "trial" would
  // be how a restaurant discovers the difference only when features start disappearing.
  configured(true);
  reset(fakeCloud({ rows: [TENANT] }));

  const result = await hubConfig.pairWithCode('SPG-4821');
  assert.equal(result.plan.status, 'trialing');
  assert.equal(result.plan.plan, 'pro', 'a live trial still gets the plan it is trialling');
  assert.equal(result.plan.trial_ends_at, TENANT.trial_ends_at);
});

test('pairing: an expired trial is reported as the Starter it has degraded to', async () => {
  configured(true);
  reset(fakeCloud({ rows: [{ ...TENANT, trial_ends_at: '2020-01-01T00:00:00.000Z' }] }));

  const result = await hubConfig.pairWithCode('SPG-4821');
  assert.equal(result.success, true, 'service is never refused over a plan');
  assert.equal(result.plan.plan, 'starter');
});

// --- the cases that made this slice worth doing -------------------------------------------------

test('pairing: a configured cloud saying "no such code" is final, not overruled by the demo list', async () => {
  // MJW-7492 is a built-in demo tenant. Against a real project it must not exist.
  configured(true);
  reset(fakeCloud({ rows: [TENANT] }));

  const result = await hubConfig.pairWithCode('MJW-7492');
  assert.equal(result.success, false);
  assert.equal(result.code, 'UNKNOWN_PAIRING_CODE');
  assert.equal(hubConfig.config.paired, false, 'and the hub is left unpaired');
});

test('pairing: an unreachable cloud refuses rather than guessing from the demo list', async () => {
  // The trap this slice closes: a real restaurant pairing while its internet is down would have
  // been bound to whatever demo tenant happened to share its code, and looked successful.
  configured(true);
  reset(fakeCloud({ throws: true }));

  const result = await hubConfig.pairWithCode('MJW-7492');
  assert.equal(result.success, false);
  assert.equal(result.code, 'CLOUD_UNREACHABLE');
  assert.match(result.error, /internet/i, 'and says what to do about it');
  assert.equal(hubConfig.config.paired, false);
});

test('pairing: a cloud that errors is treated as unreachable, not as an empty answer', async () => {
  configured(true);
  reset(fakeCloud({ error: { message: 'permission denied', code: '42501' } }));

  const result = await hubConfig.pairWithCode('MJW-7492');
  assert.equal(result.success, false);
  assert.equal(result.code, 'CLOUD_UNREACHABLE');
});

test('pairing: with no cloud configured at all, the demo tenants still work', async () => {
  // The offline demo is a real use of this product and must keep working. "There is no cloud"
  // is a different situation from "the cloud does not know this code".
  configured(false);
  reset(fakeCloud({ throws: true }));

  const result = await hubConfig.pairWithCode('MJW-7492');
  assert.equal(result.success, true);
  assert.equal(result.restaurant.name, 'Hotel Mejwani');
});

test('pairing: with no cloud configured, an unknown code is still refused', async () => {
  configured(false);
  reset(fakeCloud({ throws: true }));

  const result = await hubConfig.pairWithCode('ZZZ-0000');
  assert.equal(result.success, false);
  assert.equal(result.code, 'UNKNOWN_PAIRING_CODE');
});

// --- input handling ------------------------------------------------------------------------------

test('pairing: a missing or malformed code is refused before anything is asked of the cloud', async () => {
  configured(true);
  reset(fakeCloud({ rows: [TENANT] }));

  for (const bad of [undefined, null, '', 42, {}]) {
    const result = await hubConfig.pairWithCode(bad);
    assert.equal(result.success, false, `'${String(bad)}' should be refused`);
  }
  assert.equal(hubConfig.config.paired, false);
});

test('cloudConfigured: the placeholder project does not count as a cloud', () => {
  configured(false);
  assert.equal(hubConfig.cloudConfigured(), false);
  configured(true);
  assert.equal(hubConfig.cloudConfigured(), true);
});
