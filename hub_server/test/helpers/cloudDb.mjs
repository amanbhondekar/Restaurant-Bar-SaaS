import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// A real Postgres (PGlite, Postgres compiled to WebAssembly: no server, no Docker) with the pieces of Supabase the
// SQL depends on stubbed, and every file in database/ applied in order. This is what lets the tests run the
// migrations, the hub's rows and the row-level-security policies on an actual engine instead of reading them.
//
// What is stubbed, and how faithfully:
//   * the roles anon, authenticated and service_role (service_role bypasses RLS, as in Supabase);
//   * auth.users and auth.uid(), which reads the request.jwt.claim.sub setting, as Supabase's does;
//   * Supabase's DEFAULT PRIVILEGES: every table created in public is granted to all three roles. This is the
//     behaviour of a hosted project's SQL editor, and it is the worst case for the migrations -- a table that
//     is meant to be insert-only is only that if the migration REVOKEs, because the default has already granted
//     everything. The helper models it so the tests can say what each table really permits.
//
// What is NOT modelled: PostgREST, Realtime, Storage, and Supabase's own tables beyond auth.users.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'database');

export const migrationFiles = () => [
  'supabase_schema.sql',
  ...fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort().map(f => `migrations/${f}`)
];

const STUBS = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`;

/**
 * A fresh database with every migration applied. `apply: false` returns it with only the stubs, for a test that
 * wants to apply the files itself (to run them twice, say).
 */
export async function cloudDb({ apply = true } = {}) {
  // PostgREST hands back JSON: numbers as numbers (not the strings a driver gives for NUMERIC and BIGINT) and timestamps as
  // ISO strings. Parse the same way, so code under test sees what it would see from a real project.
  const parsers = { 1700: v => Number(v), 20: v => Number(v), 1184: v => new Date(v).toISOString() };
  const pg = new PGlite({ extensions: { uuid_ossp, pgcrypto }, parsers });
  await pg.exec(STUBS);

  // `onlyMigrations`: skip the base schema, which seeds demo rows and is run once. The migrations are the files that
  // claim to be safe to run again.
  const applyAll = async ({ onlyMigrations = false } = {}) => {
    for (const file of migrationFiles().filter(f => !onlyMigrations || f.startsWith('migrations/'))) {
      try {
        await pg.exec(fs.readFileSync(path.join(root, file), 'utf8'));
      } catch (err) {
        err.message = `${file}: ${err.message}`;
        throw err;
      }
    }
  };
  if (apply) await applyAll();

  // One connection serves everything, and a role is a property of the session, so two callers acting as different
  // users at once would see each other's role. Acting as someone is therefore one at a time. (Do not call `as` from
  // inside another `as`: it would wait for itself.)
  let turn = Promise.resolve();

  /** Run `fn` as a role (and, for authenticated, as a user), then put the session back to the superuser. */
  const as = (role, userId, fn) => {
    const run = turn.then(() => actAs(role, userId, fn));
    turn = run.catch(() => {});
    return run;
  };
  const actAs = async (role, userId, fn) => {
    await pg.exec(`SET ROLE ${role}`);
    await pg.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
    try {
      return await fn();
    } finally {
      await pg.exec('RESET ROLE');
      await pg.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    }
  };

  /** Two tenants, each with a staff user bound to it, the way provisioning leaves them. (Not the demo tenants the base schema seeds.) */
  const seedTenants = async () => {
    const ids = {
      A: { restaurant: 'a0a0a0a0-0000-4000-8000-000000000001', user: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      B: { restaurant: 'b0b0b0b0-0000-4000-8000-000000000002', user: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    };
    for (const [key, t] of Object.entries(ids)) {
      await pg.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [t.user, `kitchen-${key}@example.test`]);
      await pg.query(`INSERT INTO public.restaurants (id, name, slug, city, pairing_code) VALUES ($1, $2, $3, 'Nagpur', $4)`,
        [t.restaurant, `Restaurant ${key}`, `restaurant-${key.toLowerCase()}`, `PC-${key}`]);
      await pg.query(`INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role) VALUES ($1, $2, $3, 'kitchen')`,
        [t.restaurant, t.user, `Hub ${key}`]);
    }
    return ids;
  };

  /**
   * Insert one row built by the hub into a table, the way PostgREST's upsert would: only the columns the row names,
   * so a column's default still applies. `conflict` is 'update' (DO UPDATE) or 'ignore' (DO NOTHING).
   */
  const put = async (table, row, { conflict = null, key = 'restaurant_id,hub_ref' } = {}) => {
    const cols = Object.keys(row);
    const list = cols.map(c => `"${c}"`).join(', ');
    const action = conflict === 'ignore'
      ? `ON CONFLICT (${key}) DO NOTHING`
      : conflict === 'update'
        ? `ON CONFLICT (${key}) DO UPDATE SET ${cols.filter(c => !key.split(',').includes(c)).map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')}`
        : '';
    return pg.query(`INSERT INTO public.${table} (${list}) SELECT ${list} FROM jsonb_populate_record(null::public.${table}, $1::jsonb) ${action}`, [JSON.stringify(row)]);
  };

  return { pg, applyAll, as, seedTenants, put, close: () => pg.close() };
}
