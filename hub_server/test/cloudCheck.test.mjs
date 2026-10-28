import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, checkTables, migrationsToRun, roundTrip } from '../lib/cloudCheck.js';
import { cloudSchema } from '../lib/sqlSchema.js';

// `npm run cloud:check` is how the cloud copy gets proven the day there is a real project. What can be
// proven now is that its LOGIC is right: it must tell a missing table from a missing column from a
// permission refusal, name the migration to run, and never leave its probe bill behind.

const SCHEMA = cloudSchema();
const RID = '11111111-1111-1111-1111-111111111111';

/** A project with these tables, minus the named columns, answering as PostgREST does. */
function fakeProject({ dropTables = [], dropColumns = [], deny = [] } = {}) {
  const has = (table, col) => !dropColumns.includes(`${table}.${col}`);
  return {
    from(table) {
      return {
        select(list) {
          const result = () => {
            if (dropTables.includes(table)) return { error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
            if (deny.includes(table)) return { error: { code: '42501', message: `permission denied for table ${table}` } };
            for (const col of String(list).split(',')) {
              if (!has(table, col.trim())) return { error: { code: 'PGRST204', message: `Could not find the '${col.trim()}' column of '${table}' in the schema cache` } };
            }
            return { error: null };
          };
          return { limit: async () => result() };
        }
      };
    }
  };
}

test('a refused query is told apart: missing table, missing column, permission, anything else', () => {
  assert.deepEqual(classify({ code: 'PGRST205', message: "Could not find the table 'public.recipes' in the schema cache" }, 'recipes'), { kind: 'table', table: 'recipes' });
  assert.deepEqual(classify({ code: '42P01', message: 'relation "public.recipes" does not exist' }, 'recipes'), { kind: 'table', table: 'recipes' });
  assert.deepEqual(classify({ code: 'PGRST204', message: "Could not find the 'course_log' column of 'orders' in the schema cache" }, 'orders'), { kind: 'column', table: 'orders', column: 'course_log' });
  assert.deepEqual(classify({ code: '42703', message: 'column orders.course_log does not exist' }, 'orders'), { kind: 'column', table: 'orders', column: 'course_log' });
  // The code alone is enough, whatever the wording: a different PostgREST version words these differently.
  assert.equal(classify({ code: 'PGRST205', message: 'x' }, 't').kind, 'table');
  assert.equal(classify({ code: '42P01', message: 'x' }, 't').kind, 'table');
  assert.equal(classify({ code: 'PGRST204', message: 'x' }, 't').kind, 'column');
  assert.equal(classify({ code: '42501', message: 'permission denied for table orders' }, 'orders').kind, 'permission');
  assert.equal(classify({ code: '57014', message: 'timeout' }, 'orders').kind, 'other');
  assert.equal(classify(null, 'orders'), null);
});

test('a project with everything is ready, table by table', async () => {
  const findings = await checkTables(fakeProject(), SCHEMA);
  assert.ok(findings.length >= 15, 'every table the migrations define was asked about');
  assert.deepEqual(findings.filter(f => !f.ok), []);
  assert.deepEqual(migrationsToRun(findings), []);
});

test('a project that stopped before migration 008 is told exactly which columns are missing, and to run 008', async () => {
  const findings = await checkTables(fakeProject({ dropColumns: ['orders.staged', 'orders.course_log', 'order_items.course', 'order_items.station'] }), SCHEMA);
  const bad = findings.filter(f => !f.ok);

  assert.deepEqual(bad.map(f => f.table).sort(), ['order_items', 'orders']);
  assert.deepEqual(bad.find(f => f.table === 'orders').missing.map(m => m.column).sort(), ['course_log', 'staged'], 'every absent column, not only the first one reported');
  assert.equal(bad.find(f => f.table === 'orders').missing[0].migration, '008_order_course_state.sql');
  assert.deepEqual(migrationsToRun(findings), ['008_order_course_state.sql']);
});

test('a missing table names the migration that creates it', async () => {
  const findings = await checkTables(fakeProject({ dropTables: ['reservations', 'walkins', 'recipes'] }), SCHEMA);
  const bad = findings.filter(f => !f.ok);
  assert.deepEqual(bad.map(f => [f.table, f.problem.kind, f.migration]).sort(), [
    ['recipes', 'table', '009_inventory_cloud.sql'],
    ['reservations', 'table', '011_reservations.sql'],
    ['walkins', 'table', '011_reservations.sql']
  ]);
  assert.deepEqual(migrationsToRun(findings), ['009_inventory_cloud.sql', '011_reservations.sql']);
});

test('a base-schema table is never answered with "run a migration" -- there is no migration for it', async () => {
  const findings = await checkTables(fakeProject({ dropTables: ['restaurants'] }), SCHEMA);
  assert.equal(findings.find(f => f.table === 'restaurants').problem.kind, 'table');
  assert.deepEqual(migrationsToRun(findings), []);
});

test('a key that may not read a table is reported as that, not as the table being absent', async () => {
  const findings = await checkTables(fakeProject({ deny: ['subscriptions'] }), SCHEMA);
  assert.equal(findings.find(f => f.table === 'subscriptions').problem.kind, 'permission');
  assert.deepEqual(migrationsToRun(findings), []);
});

// --- the probe bill ---------------------------------------------------------------------------------

/** A cloud that keeps `invoices` rows. `noUnique` lets an upsert duplicate; `refuse` refuses writes. */
function fakeInvoices({ noUnique = false, refuse = null, failDelete = false } = {}) {
  const rows = [];
  const log = [];
  const api = {
    rows, log,
    from(table) {
      assert.equal(table, 'invoices');
      return {
        upsert: async ([row]) => {
          log.push('upsert');
          if (refuse) return { error: refuse };
          const at = noUnique ? -1 : rows.findIndex(r => r.restaurant_id === row.restaurant_id && r.hub_ref === row.hub_ref);
          if (at >= 0) rows[at] = { ...rows[at], ...row }; else rows.push({ ...row });
          return { error: null };
        },
        select: () => {
          const filters = {};
          const q = {
            eq(c, v) { filters[c] = v; return q; },
            order() { return q; },
            then: (ok, no) => Promise.resolve({ data: rows.filter(r => Object.entries(filters).every(([c, v]) => r[c] === v)), error: null }).then(ok, no)
          };
          return q;
        },
        delete: () => {
          const filters = {};
          const q = {
            eq(c, v) { filters[c] = v; return q; },
            then: (ok, no) => {
              log.push('delete');
              if (failDelete) return Promise.resolve({ error: { message: 'permission denied' } }).then(ok, no);
              for (let i = rows.length - 1; i >= 0; i--) if (Object.entries(filters).every(([c, v]) => rows[i][c] === v)) rows.splice(i, 1);
              return Promise.resolve({ error: null }).then(ok, no);
            }
          };
          return q;
        }
      };
    }
  };
  return api;
}

test('the probe writes a bill, reads it back through the restore path, and leaves nothing behind', async () => {
  const cloud = fakeInvoices();
  const result = await roundTrip(cloud, RID);
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map(s => s.ok), [true, true, true, true, true]);
  assert.deepEqual(cloud.rows, [], 'the probe bill is gone');
});

test('the probe bill is voided, named as a probe, and cannot be mistaken for revenue', async () => {
  const cloud = fakeInvoices();
  // Stop before the delete so the row can be looked at.
  const keep = cloud.from;
  let deletes = 0;
  cloud.from = t => { const f = keep(t); const del = f.delete; f.delete = () => (++deletes >= 2 ? { eq() { return this; }, then: ok => Promise.resolve({ error: null }).then(ok) } : del()); return f; };
  await roundTrip(cloud, RID);
  const [row] = cloud.rows;
  assert.equal(row.payment_status, 'void');
  assert.equal(row.invoice_number, 'CLOUD-CHECK');
  assert.match(row.void_reason, /probe/);
  assert.equal(Number(row.grand_total), 1);
});

test('a write the cloud refuses (policy, key) fails the probe at the write and does not pretend the rest', async () => {
  const cloud = fakeInvoices({ refuse: { code: '42501', message: 'new row violates row-level security policy for table "invoices"' } });
  const result = await roundTrip(cloud, RID);
  assert.equal(result.ok, false);
  const failed = result.steps.filter(s => !s.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].name, /write the probe bill/);
  assert.match(failed[0].detail, /row-level security/);
  assert.equal(result.steps.length, 2, 'it stopped: it did not go on to read back what was never written');
});

test('without a unique key the second write duplicates, and the probe says so', async () => {
  const cloud = fakeInvoices({ noUnique: true });
  const result = await roundTrip(cloud, RID);
  assert.equal(result.ok, false);
  assert.match(result.steps.find(s => !s.ok).detail, /expected one row, found 2/);
});

test('a probe that cannot delete itself says so, so nobody is left wondering what the stray bill is', async () => {
  const result = await roundTrip(fakeInvoices({ failDelete: true }), RID);
  assert.equal(result.ok, false);
  assert.ok(result.steps.some(s => !s.ok && /delete/.test(s.name)));
});

test('the probe bill is only ever touched for the restaurant asked about', async () => {
  const cloud = fakeInvoices();
  cloud.rows.push({ restaurant_id: 'other-tenant', hub_ref: 'cloud_check_probe', invoice_number: 'CLOUD-CHECK' });
  await roundTrip(cloud, RID);
  assert.equal(cloud.rows.length, 1, 'another restaurant\'s row with the same ref is untouched');
  assert.equal(cloud.rows[0].restaurant_id, 'other-tenant');
});
