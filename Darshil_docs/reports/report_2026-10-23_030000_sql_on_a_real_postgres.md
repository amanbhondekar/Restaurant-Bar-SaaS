# The SQL, run: migrations on a real Postgres, and what they actually allowed

**Date:** 2026-10-23T03:00:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
Every cloud test so far read the migrations or faked the client. None of them could say what the database would really
do, and the roadmap kept recording "migrations unrun; row-level security proven by nothing". There are no Supabase
credentials on this machine, but there does not have to be a Supabase project to run SQL: PGlite is Postgres compiled to
WebAssembly, needs no server or Docker, and runs inside the test suite. It is a **new dev dependency**
(`@electric-sql/pglite`); CI picks it up with `npm ci`.

## WHAT WAS BUILT
- `hub_server/test/helpers/cloudDb.mjs`: a database with the Supabase pieces the SQL leans on stubbed (the roles `anon`,
  `authenticated`, `service_role`; `auth.users` and `auth.uid()`), every file in `database/` applied in order, and helpers to
  act as a role or as a tenant's login and to insert a row the way a PostgREST upsert would. It also models **Supabase's
  default privileges**: a new table in `public` is granted to all three roles, which is what a hosted project's SQL editor
  does.
- `hub_server/test/cloudSql.test.mjs` (23 tests): the migrations apply in order and apply again; every tenant table has
  row-level security on and a policy; what each role may do to each table; cross-tenant reads and writes; every row the hub's
  own builders produce is accepted by the real constraints and is safe to push twice (on the real unique indexes); and the
  onboarding flow end to end.

## WHAT IT FOUND
**The "insert-only" and "service role only" claims in the migrations protected nothing.** Migrations 005, 006, 010 and 013 say
a table is insert-only, or the operator's, because the `authenticated` role has no `UPDATE`/`DELETE` grant. But the grants
were only ever added, and the default had already given everything. Run for real, a tenant's own login could:
- `UPDATE` its own `restaurants` row and set `plan = 'enterprise'`, `plan_status = 'active'`: **a tenant could grant itself a
  plan it had not paid for**;
- `UPDATE` or `DELETE` its own cash-ups and guest feedback, which are meant to be insert-only evidence;
- rewrite `staff_users` (its own role, or the user a staff row is bound to);
- `TRUNCATE` any table (row-level security does not constrain TRUNCATE);
and `anon` held every privilege on every table. Row-level security did still stop cross-tenant reads, and the policies are
sound; the gap was inside a tenant.

**Migration 014** says what each role may do to each table, explicitly, so it gives the same answer whatever a project's
defaults are: nothing for `anon`; for `authenticated`, read-only on `restaurants` and `staff_users`, full on the catalogs and
the diary, insert/update (never delete) on orders and bills, insert/read only on cash-ups and feedback, nothing on the
tables the hub does not use or the operator's tables. `service_role` is untouched. The policies on `restaurants` and
`staff_users` become `FOR SELECT` so the intent survives someone granting more later, and a table added from now on starts
with nothing for `anon` and `authenticated`, so a forgotten grant fails loudly instead of opening it to everyone. The privileges
were derived from what the code calls (`grep` of every `.from(...)` and `.rpc(...)`), not guessed.

**What held up, and is now proven rather than read:** the SQL applies on a real engine, in order, twice; every table's row
level security is on; tenants cannot see or write each other's rows; every row the hub builds fits the real constraints;
`provision_restaurant` makes a complete trialing tenant with a bcrypt-hashed secret and distinct slugs and pairing codes and
refuses a tenant that could never work; the hub binds with its secret and sees only its own restaurant; a wrong secret, an
unknown restaurant and a restaurant with no secret fail with the same words (nothing to enumerate); the cross-tenant takeover
that migration 001 closed stays closed; a reinstalled hub can rebind and the old login then loses access.

## THE ASSUMPTION THAT MATTERS
All of this rests on hosted Supabase granting new tables to `anon` and `authenticated` by default. I believe that is the
long-standing behaviour but I could not check it against a project, and Supabase has been changing its defaults. The fix does
not depend on it: 014 is an explicit statement and is a no-op where the defaults are already tighter.

## MUTATION CHECK
14 mutations of 014 and of the provisioning functions (a tenant may update its plan again, evidence editable, bills deletable,
the hub cannot update a bill, a diary table not writable, future tables open, anon keeping its privileges, binding without a
user, any secret binding, anon able to bind, tenants able to provision restaurants, a short secret accepted, the secret stored
in plaintext): 13 caught. The survivor is equivalent: the `FOR ALL` policy on `restaurants` is redundant once `UPDATE` is not
granted, so reverting the policy alone changes nothing (it stays as defence in depth).

## COUNTS
Hub **1166 passing** (1143 before). Frontend unchanged at 724. Migrations are now 001-014.

## NOT DONE
- Not run against a hosted Supabase project. PGlite is real Postgres but it is not Supabase: PostgREST, Realtime, the auth
  service and the dashboard's own behaviour are not in it, so "the database enforces this" is proven and "the hosted project
  enforces this" is not.
- `cloud:check` does not yet verify privileges on a live project. It would be the natural place to.
