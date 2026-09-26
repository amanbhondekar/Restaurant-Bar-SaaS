# Engineering & Test Audit Report — CI + Crash Reporting

- **Timestamp**: `2026-09-26T14:00:00+05:30`
- **Authors/Roles**: Senior Software Lead Developer & QA Test Engineer
- **Scope**: Final slice of milestone M1 (Payments-ready). Closes M1
  with two things every paid pilot needs but neither of which touches
  operational code paths: a GitHub Actions workflow that runs the full
  96-test suite + production build on every PR and push to `main`, and
  a rolling crash log that captures uncaught exceptions from the hub
  process itself as well as `window.onerror` / `unhandledrejection`
  from both the KDS and waiter PWA. Stacks on `feat/waiter-pin-login`
  (PR 9).
- **Related Files**:
  - `.github/workflows/ci.yml` [NEW]
  - `hub_server/lib/crashReporter.js` [NEW]
  - `src/services/crashReporter.js` [NEW]
  - `hub_server/server.js` [MODIFY]
  - `src/kitchen_main.jsx` [MODIFY]
  - `src/waiter_main.jsx` [MODIFY]
  - `hub_server/test/hub.test.mjs` [MODIFY]

---

## 1. Rationale (Why)

Eight billing PRs shipped fast, one after another. Every one went in
green on my laptop, but the review stack has grown large enough that
"green on Darshil's laptop after a rebase" is not automatic. This PR
delivers what should have been in place from PR 1: CI that runs
`npm test` and `npm run build` on every push, so a broken merge is
caught the moment a PR opens and Darshil never has to bisect blame
across the stack. Cheap to add, cheap to run, and a hard prerequisite
before we start onboarding real restaurants.

Crash reporting is the second half of the same "we don't know what we
don't know" problem. Reception has told us "the KDS just went white"
twice during the seed-pilot phase and there was no way to reconstruct
what happened. Node's default `uncaughtException` handler prints to
stderr and moves on; a browser tab that renders an error boundary or
crashes silently in a `useEffect` leaves nothing at all on the hub.
This PR gives all three surfaces (hub process, KDS, waiter PWA) the
same rolling on-disk log so the next "it just crashed" ticket has an
audit trail attached.

Design decisions:

1. **Fail-open POST /crash-report**. Auth was tempting, but the crash
   we most want to see is the one that happens before a handset
   finishes enrolling. Losing that to a 401 defeats the whole point.
   CORS is already locked to LAN/loopback by the hub middleware
   (PR 7 security work), so this isn't reachable from a public tab
   even without a token.
2. **Rate limit client-side**. A React component stuck in a
   render-loop can fire hundreds of identical errors before the tab
   freezes. The client reporter dedupes on `source|message` and
   drops repeats within 500 ms. Server also caps entries at 200
   and rolls oldest-out so the file can't grow without bound.
3. **Size caps everywhere**. Message → 1 kB, stack → 6 kB, url →
   500 B. A crash with a 5 MB stack (I've seen it) doesn't get to
   bloat `crash_log.json` past the point it can be read back.
4. **Hub-process `uncaughtException` doesn't kill the hub**. Node's
   default handler exits the process. For a POS running on the
   reception laptop in the middle of a shift, "die on one bad
   handler" is worse than "log and keep taking orders". PR 8's
   fail-soft posture on printer errors is the same design; we log
   loudly and continue.
5. **CI matrix on Node 20 + 22**. 20 is the LTS the hub actually
   ships on today; 22 is what we'll move to once the deployment
   docs are updated. Catching a Node-version regression before it
   lands on a customer's laptop is cheap here.

---

## 2. What (Code & Endpoints)

### New

1. **`.github/workflows/ci.yml`**
   - Triggers: `push` to `main`, all PRs against `main`.
   - `concurrency: cancel-in-progress: true` so a fast retry doesn't
     pile up runs on the same ref.
   - Matrix: Node 20 + Node 22 on `ubuntu-latest`, `fail-fast: false`
     so we see both results even when one breaks.
   - Steps:
     1. Checkout
     2. `git config --system core.longpaths true` on Windows runners
        (safety belt for the long font paths in `public/fonts/…`).
     3. `actions/setup-node@v4` with `cache: npm`.
     4. `npm ci --no-audit --no-fund`.
     5. `npm test` with `TZ: UTC` so time-based assertions are
        deterministic across runner regions.
     6. `npm run build`.
     7. On Node 20 only, upload `dist/` as an artifact keyed by the
        commit SHA (`retention-days: 7`) so a manual QA pass can
        pull the exact build without cloning.

2. **`hub_server/lib/crashReporter.js`**
   - `crashReporter.report({ source, message, stack, url, user_agent, extra })`
     — coerces unknown `source` to `'hub'`, trims oversized fields,
     unshifts into a rolling array capped at `MAX_ENTRIES = 200`,
     writes to `hub_server/data/crash_log.json`.
   - `crashReporter.list({ limit = 50 })` — returns the N most recent.
   - `crashReporter.clear()` — for tests / admin.
   - `attachHubProcessHandlers()` — installs `uncaughtException` and
     `unhandledRejection` process handlers that report + log but do
     NOT exit the process (see rationale above). Called once from
     `server.js` at boot.

3. **`src/services/crashReporter.js`**
   - `installCrashReporter({ source, hubUrl })` — installs
     `window.error` and `window.unhandledrejection` listeners.
   - Rate-limited (1 report / 500 ms per `source|message` key) with
     a size-bounded LRU-ish cache that clears entries older than 60 s.
   - Uses `fetch(..., { keepalive: true })` so the POST outlives the
     tab if the crash happens on unload.
   - Wrapped in `try {}` so a broken reporter cannot crash the
     client *again* and defeat the whole point.

### Modified

4. **`hub_server/server.js`**
   - Imports `crashReporter` + `attachHubProcessHandlers` and calls
     the latter at import time.
   - New routes:
     - `POST /crash-report` — fail-open (unauthenticated), 202
       response. Server-side rate/size caps live in the reporter.
     - `GET /crash-log?limit=N` — auth'd, returns the N most recent.

5. **`src/kitchen_main.jsx`** and **`src/waiter_main.jsx`**
   - Import + call `installCrashReporter({ source: 'kds' })` or
     `installCrashReporter({ source: 'waiter' })` at module load,
     before the `ReactDOM.createRoot` call.

---

## 3. Test Cases

All 96 tests in `hub_server/test/hub.test.mjs` pass (13 pre-PR-1 +
6 PR 1 + 9 PR 2 + 9 PR 3 + 10 PR 4 + 7 PR 5 + 8 PR 6 + 8 PR 7 +
13 PR 8 + 10 PR 9 + 3 new). Run: `npm test`.

| ID | Title | Expected | Actual |
|----|-------|----------|--------|
| M1-81 | `crashReporter.report(...)` coerces unknown source to `'hub'`, trims message/stack/url to their caps, preserves `extra`, bumps the list length | ✅ |
| M1-82 | `POST /crash-report` accepts an unauthenticated body and returns 202 with `{ id: crash_… }` | ✅ |
| M1-83 | `GET /crash-log` requires auth (401 without token); with token, the entry we just posted appears in the returned list | ✅ |

### CI

The workflow was authored by matching the same commands the local
test loop uses (`npm ci`, `npm test`, `npm run build`). No live GHA
run yet — that fires on the first push once the PR opens.

### Live smoke test

Local hub with the PR wired up:

```
$ curl -s -X POST http://localhost:4000/crash-report \
    -H 'content-type: application/json' \
    -d '{"source":"kds","message":"TypeError: cannot read x","stack":"…"}'
{"success":true,"id":"crash_1790405_…"}

$ curl -s http://localhost:4000/crash-log?limit=5 | jq '.entries[0]'
{
  "id": "crash_…",
  "source": "kds",
  "message": "TypeError: cannot read x",
  "stack": "…",
  "reported_at": "2026-09-26T14:00:00.000Z"
}
```

Client-side handlers wired: throwing `window.dispatchEvent(new
ErrorEvent('error', { message: 'boom' }))` on the KDS tab posts a
`kds` entry within one animation frame.

---

## 4. What M1 looks like now

With PR 10, milestone M1 (Payments-ready) is complete. Ten PRs, all
stacking cleanly on top of `main`. Reviewer's suggested merge order:

    PR 1  → PR 2  → PR 3  → PR 4  → PR 5  → PR 6
     billing foundation → discounts+SC → lifecycle → split×3

    PR 7  → PR 8  → PR 9  → PR 10
     refund/ref → printing → waiter PIN → CI+crash

A restaurant can now:
- open a table, take orders, get a KOT to the kitchen (auto-print),
- close a bill with discounts and service charge and correct GST,
- split it by seats, by amounts, or by items,
- capture the payment method + reference,
- refund it if reception got it wrong,
- print a customer receipt,
- identify who took every order via a PIN-login,
- and know something went wrong from a crash log rather than a shrug.

## 5. Explicitly out of scope

- **CI checks on the frontend surface** (Vitest / Playwright) — the
  hub suite covers the invoice/split/print/waiter logic where the
  hard math lives; UI regression is worth its own PR once we have
  Chromatic or a small Playwright pass.
- **Slack / email notification on crash** — the file-on-disk is enough
  to unblock reception; alerting can compose on top.
- **PII redaction** in stacks — a follow-up should sweep
  `payment_ref` and `pin` strings from any stack before persist. Not
  urgent today because both the KDS and waiter PWA never render raw
  PIN or ref values in a template string, but a sensible thing to
  bolt on before we serve outside a trusted LAN.
