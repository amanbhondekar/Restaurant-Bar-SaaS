# Owner view, cloud role enforcement, and a pairing bug that stopped any new restaurant onboarding

**Date:** 2026-10-23T04:00:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## THE BUG THAT MATTERED MOST: A FRESH HUB COULD NOT PAIR
With the SQL running on a real Postgres (previous report) I tried the first thing a new restaurant does: provision a tenant,
then pair its hub with the code on its screen. The hub looked the restaurant up with a plain `SELECT` on `restaurants`, before it
was bound to anything. Row-level security shows a login only its own restaurant, an unbound login has none, so the query
returned **zero rows** and the hub reported "No restaurant found matching pairing code". **Against a real cloud, a freshly
provisioned restaurant could never be paired.** The pairing tests had a fake cloud that returned the row, which is why nobody
saw it.

Fixed by migration 015's `restaurant_for_pairing_code()`: a `SECURITY DEFINER` function that returns only the non-secret columns
pairing needs (id, name, slug, city, code, plan and its dates) for exactly one code, matched exactly (a code of `%` finds
nothing), and callable only by a signed-in session (the hub's anonymous sign-in counts). Binding still needs the provisioning
secret; knowing a code gets a caller a name and a city, not access. The hub uses it and falls back to the old read if the
function is not there yet, so a cloud that has not run 015 behaves as it did.

## THE OWNER'S REMOTE VIEW (roadmap §3, Owner console)
- **A read-only page** (`owner.html`, `src/owner/`): sign in with an email and password, then the plan and its state, sales for
  today / this week / this month set against the period before (the hub's own `salesReport`, so the numbers match the reception
  Sales tab), best sellers and busy hours, the last closed shifts with variances, what is out or running low, the average rating
  and the low ones. It says how long ago the hub last sent anything and warns past six hours, because an off laptop leaves the
  page as old as its last upload. It builds as its own 23 kB bundle.
- **The database makes it read-only, not the page.** An owner signs in with the same database role the hub uses, and every policy
  so far said "any staff login of this restaurant, for anything". Migration 015 rewrites the tenant tables' policies: any staff
  login may READ its restaurant's rows, only the hub's own identity (`kitchen`) may INSERT, UPDATE or DELETE them. So an owner or
  manager reads everything and writes nothing, and so does a login with a role it was never meant to have. The hub is unchanged: it
  is `kitchen`.
- **Two columns no login can read:** the hash of the hub's provisioning secret and the PIN hashes, taken out of what
  `authenticated` may `SELECT` (so `SELECT *` on those two tables is refused and columns are named).
- **`provision_owner()`**: the operator's way to make someone an owner or manager (closed to everyone else, safe to repeat,
  refuses any other role, and refuses a login that already works for another restaurant). `docs/OWNER_VIEW.md` is the runbook.
- **A correctness point the real database check forced:** takings are counted on the day the money moved, so a bill issued last
  month and refunded today belongs in today's refunds. The page therefore reads the bills anything happened to (issued, paid,
  refunded or voided) since the oldest comparison window began, not only those issued then. A test pins it on the real schema.

## TESTS
- `cloudOwner.test.mjs` (14, on the real engine): pairing lookup (unbound hub finds its restaurant and only the public columns,
  case and spacing, an unknown code or `%` finds nothing, anon cannot ask, the table itself is still closed); an owner reads their
  own restaurant on every table and nothing of another's; an owner and a manager insert, update and delete nothing; the hub still
  writes its own rows and not another's; an owner of one restaurant cannot read another's; nobody can read the secret hash or a PIN
  hash; a login with a waiter row writes nothing; orders and their lines (a line cannot hang on another restaurant's order);
  only the operator can make an owner, and making one is repeatable and refuses what could not be right.
- `ownerData.test.mjs` (16): paging a long ledger, partial figures flagged, the refund-from-last-month case, an unattached login,
  one failing section, the sales equal the hub's own `salesReport`, stock levels equal the hub's `levelOf`, feedback rounding and
  the low-rating boundary, freshness words; then the same code **against the real schema, signed in as an owner** through a small
  PostgREST-style adapter over PGlite: their numbers and none of another tenant's, the cash-ups, stock and feedback, the hub's own
  login, a stranger attached to nothing, and the owner's own client refused the secret column.
- `OwnerApp.test.jsx` (24): sign-in (typed values, validation, wrong password vs service error vs network failure, an existing
  session, sign-out), the dashboard (plan, trial, takings, periods, freshness, shifts, stock, feedback with guest text shown as text
  and never as markup), every failure shape, and what it will not do: it never writes, never asks for the secret, a PIN hash or
  `*`, and has no control but sign-out, refresh and the period buttons.
- `pairing.test.mjs` (+4): the lookup function is used with the cleaned code, an old cloud is read the old way (without `*` or the
  secret column), a missing function and any other function failure are told apart.
- Mutations: 15 of migration 015 and 5 of the hub's lookup, 17 of the data layer and 18 of the screen. All caught except two
  equivalent ones (the email trim, which an `<input type="email">` does itself, and a redundant policy). Four earlier survivors were
  real gaps, now covered.

## ALSO CHANGED
`cloudDb.as()` now serialises acting-as calls: one connection serves everything and the role is a property of the session, so the
owner snapshot's parallel reads would otherwise have seen each other's role. The source-reading contract test and the privilege
test learned about the new lookup read and about column-level `SELECT`.

## COUNTS
Hub **1200 passing** (1166 before), frontend **748** (724 before), build clean. Migrations are now 001-015.

## NOT DONE
- **Not deployed.** It needs a hosted Supabase project (migrations applied, a login created and attached) and a static host.
  Everything above is proven on a real Postgres engine, not on Supabase; PostgREST, the auth service and the project's own defaults
  are not in PGlite.
- Bookings and the walk-in queue are not on the page; password reset and single sign-on are not built; a login belongs to one
  restaurant, so an owner of two needs two logins.
- On the reception laptop a person's role is still stored but not enforced (anyone signed in can still void a bill). The cloud now
  enforces roles for owners and managers; the hub's own routes do not.
