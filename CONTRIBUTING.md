# Contributing

This is how work is done here. The rules exist because a restaurant's till and kitchen run on this code, and because most of
the real defects found so far were found by a test written to catch them, not by looking at a passing build.

## Setting up

```bash
npm ci
npm run hub          # the LAN hub (Node / Express) on :4000
npm run dev          # the Vite front end
```

Node 20 or 22. `npm test` runs both suites; `npm run test:hub` (Node's test runner, real hubs on throwaway data directories)
and `npm run test:web` (Vitest + Testing Library in jsdom) run on their own, and CI runs them as separate steps so a red run
says which side broke.

Never point a test, or a scratch run, at `hub_server/data/`: that is a real hub's own data. Tests use temporary directories;
to look at a screen in a browser without touching it, run a scratch hub with its own `HUB_DATA_DIR` and port.

## The audit log: every change gets a report

For **every code change or feature** (see `Darshil_docs/README.md`):

1. Say **what** changed: files, routes, props, migrations.
2. Say **why**: the defect, the requirement or the reasoning.
3. Show **tests**: what was run, what it printed, and what was not run.
4. Save it as `Darshil_docs/reports/report_YYYY-MM-DD_HHMMSS_<name>.md` and add a row to the index in `Darshil_docs/README.md`.

Then bring `docs/ROADMAP.md` in line (test counts, the section the work belongs to, and anything newly open) and add a line
to `CHANGELOG.md` under **Unreleased**. Say plainly what is not done. A report that only lists successes is not finished.

## Tests come first

- Write the test, **watch it fail** on the old code, then change the code. A test that never failed proved nothing.
- **Mutation-check what matters.** Break the rule on purpose (drop a guard, flip a comparison, remove a field) and the suite
  must notice. A survivor is either a gap to close or an equivalent change to explain in the report; never ignore one.
- Money, permissions, and anything a customer or a till depends on get this treatment without exception.
- Prefer real things to mocks. The hub tests boot a real server; the SQL tests run the migrations on a real Postgres engine
  (PGlite); the front-end tests render the real component against a fake hub (`src/test/helpers/fakeHub.js`) and a fake
  socket. Mock the edge, not the logic.
- Tests must not depend on the clock, the timezone or the machine: use fake timers, a local-date fixture, and a hub that
  binds port `0`.

## Rules of the house

- **Default-deny.** A new route is closed to a narrow device token until someone opens it on purpose (`requireDevice`,
  `requireKitchenDevice`, `requireReceptionFor`). A new event type reaches a kitchen screen only if it is named in
  `hub_server/lib/liveFeed.js`.
- **The hub prices, not the client.** Handsets send ids and quantities; the hub prices from its own menu.
- **Money moves on the day it moved.** Takings are counted by payment time, and a grand total is rounded to the rupee.
- **Offline first.** The hub works with the line down; anything that needs the cloud must queue and survive a restart.
- **Migrations are additive and re-runnable.** State every role's privileges explicitly; never rely on a platform default.
- **Say what you did not verify.** "Passes on a real Postgres engine" and "proven on a hosted project" are different claims.

## Commits and pull requests

- One idea per commit, in the imperative, with the reason in the body.
- Read the test result before committing. A commit that is knowingly red is a debt someone else pays.
- Do not commit `hub_server/data/` (the pilot hub's own files), `.env` files or generated ledgers.
- A pull request description lists what changed by theme, the test counts, what is not done, and a test plan.

## Where things are

| | |
|---|---|
| `hub_server/` | the LAN hub: `server.js` routes, `lib/` rules and stores, `test/` the hub suite |
| `src/` | the front ends: `admin/`, `waiter_mobile/`, `station/`, `diner/`, `owner/`, `kitchen_main.jsx`; `lib/` shared logic |
| `src/test/` | the front-end suite |
| `database/migrations/` | the cloud schema, in order |
| `docs/` | `ROADMAP.md` (the map), `ARCHITECTURE.md`, `OWNER_VIEW.md`, the API and deployment guides |
| `Darshil_docs/` | the audit log |
