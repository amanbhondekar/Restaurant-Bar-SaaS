# Fix — test suite flakiness: dynamic fixture ports and two non-hermetic tests

**Date:** 2026-10-13T14:30:00+05:30
**Branch:** `integration/m3-land`
**Milestone:** Housekeeping (makes the suite trustworthy as a merge gate)

---

## WHY

Recorded as a known issue in the PR 18 report: across 12 consecutive `npm test` runs, 10 were
455/455 and 2 failed inside hub-fixture tests — once with 3 failures, once with a file that did
not finish at all (427 of 455 reported). A suite that is only *probably* green cannot gate a
merge: every red run has to be investigated by hand, and the habit of re-running until it passes
is exactly how a real regression gets waved through.

Three separate faults were behind it.

### 1. Hardcoded fixture ports

Eight test files each pinned a port by hand (4591–4599). Two ways that breaks:

- **Across files.** The runner executes test *files* in parallel. Two files on the same number
  race; the loser's requests go to the other file's hub. This is what made 8 plans tests fail
  with 404s after the M3 merge (`plans.test.mjs` and `catalogRoutes.test.mjs` both held 4598).
- **Across runs.** A port from the previous run can still be held in `TIME_WAIT`, so a fixture
  intermittently fails to bind one it "owns".

Five of the eight files also hand-rolled their own fixture — a copy of `spawnHub.mjs` that spawns
`server.js` directly, waits only for `/pairing-info` to answer, and swallows stderr with
`stdio: 'ignore'`. Waiting for *any* answer on the port is the dangerous part: **a hub left over
from another file answers it too**, so the fixture reports ready and the whole file runs against
the wrong hub. `spawnHub.mjs` already guarded against that with a per-start nonce; the hand-rolled
copies did not.

### 2. `crashReporter` test counted a log shared by every run on the machine

`M1: crashReporter caps entries…` asserted `after === before + 1` on `crashReporter.list()`.
That module is imported **in-process**, so with no `HUB_DATA_DIR` set it reads and writes the
repository's own `hub_server/data/crash_log.json` — which every `npm test` run on the machine
appends to and nothing ever clears. `list()` also returns only its most recent page (50 by
default) out of a 200-entry store, so **once that file passed 50 entries the assertion could never
hold again.** Running the suite repeatedly to measure the flakiness is what pushed it over: it
failed on runs 10, 11 and 12 in a row, which is what gave it away as accumulated state rather than
a race.

This was a latent trap for anyone, not something this branch introduced — it would have fired for
any developer after ~50 cumulative suite runs, and the failure looks nothing like its cause.

### 3. A residual start-up race

Reserving a free port means opening a socket on `:0`, reading the port and closing it before the
hub binds it. Under a whole suite starting its hubs at once, something else can take it in that
gap.

## WHAT

### `hub_server/test/helpers/spawnHub.mjs`

- **`reservePort()`** (new, exported) — asks the OS for a free port. Reserved on `0.0.0.0`,
  which is what the hub binds: a port free only on `127.0.0.1` could still be taken on another
  interface. **The OS does not hand out a port that is in `TIME_WAIT`**, which is what removes
  fault 1's second half outright.
- **`startHub()` takes no port by default.** It reserves one per attempt and retries up to 5
  times with increasing backoff (100/200/300/400 ms) when the hub cannot take the port — a whole
  suite starting at once means a lost race is usually a pile-up, so spreading the retries out
  matters more than retrying fast. Passing an explicit `port` disables both: a caller naming a
  port is testing *that* port, and must see the failure as-is (`spawnHub.test.mjs` depends on it).
- **`config`** merges extra fields into `hub_config.json`, **`files`** writes extra files into
  the data directory — enough for the five hand-rolled fixtures to adopt the helper. `name` is
  applied *after* `config` so a fixture cannot clobber the readiness nonce, and `name` is now
  returned for tests that assert on what `/pairing-info` serves.

### All five hand-rolled fixtures migrated

`hub`, `kitchenOps`, `printers`, `reconciliation` and `plans` now call `startHub`. They gain the
nonce readiness check and the retry, and the suite loses ~130 lines of duplicated spawn/wait/
cleanup. `spawnHub.test.mjs` reserves its port instead of hardcoding 4596 — it still pins one
deliberately, because it binds a stale listener there to prove the guard works.

**No hardcoded fixture port and no direct `spawn(process.execPath, [SERVER])` remain in the suite.**

### `hub.test.mjs` crashReporter assertion

Replaced the count with what the test actually cares about — that the new entry is the newest in
the log, and that `list()` stays within its page — so it no longer depends on how many times the
suite has been run on this machine.

### Files

| File | Change |
|---|---|
| `hub_server/test/helpers/spawnHub.mjs` | `reservePort()`, port-free `startHub` with backoff retry, `config` / `files` options, `name` returned |
| `hub_server/test/{hub,kitchenOps,printers,reconciliation,plans}.test.mjs` | Migrated onto the helper; hardcoded ports, spawn blocks and cleanup removed |
| `hub_server/test/{catalogRoutes,tableMatching,spawnHub}.test.mjs` | Dropped hardcoded ports |
| `hub_server/test/hub.test.mjs` | crashReporter assertion made independent of accumulated log state |

Net **−69 lines**. **No production code was touched** — the diff is tests and the test helper only.

## TEST CASES

Flakiness is a rate, so it was measured as one rather than declared fixed.

| Stage | Runs | Bad runs | Rate |
|---|---|---|---|
| Before (recorded in the PR 18 report) | 12 | 2 | ~17% |
| After migration, 3 retries, no backoff | 55 | 2 | ~4% |
| After 5 retries with backoff | **25** | **0** | **0%** |

Each "bad run" is any run that did not report exactly 455 tests and 0 failures, so a file that
dies before running counts as bad. The three distinct failures seen along the way — plans
(ports), crashReporter (accumulated log), `catalogRoutes` sync-status and a fast `startHub`
failure under load — were each traced before being addressed, not re-run away.

Per-file after migration: `hub` 115/115, `kitchenOps` 29/29, `printers` 18/18,
`reconciliation` 15/15, `plans` 18/18, `catalogRoutes` 26/26, `tableMatching` 7/7,
`spawnHub` 1/1.

```bash
npm test      # 455/455, 25 consecutive clean runs
```

## NOT DONE / LIMITS

- **The start-up race is narrowed, not eliminated.** There is still a gap between releasing the
  reserved socket and the hub binding it; the retry covers it rather than closing it. The
  race-free fix is to let the hub bind `:0` itself and report the port it got, which means a
  production change to `server.js` for the benefit of tests — deliberately not done here.
- **25 clean runs is evidence, not proof.** The pre-fix rate was roughly 1 bad run in 6, so 25
  clean runs is a meaningful result, but a fault rarer than about 1 in 25 would not have shown up
  in this sample. Two of the failures observed earlier (`catalogRoutes` `/admin/sync-status`, and
  a `startHub` that failed in under a second under load) were never reproduced in isolation, so
  their root causes are inferred from the fix working, not separately confirmed.
- **The suite still writes to the repository's `hub_server/data/`.** Modules imported in-process
  (`crashReporter`, and anything else resolving `HUB_DATA_DIR` at import time) use the real data
  directory. The assertion no longer depends on it, but `npm test` still appends to
  `crash_log.json`. Making the whole run hermetic means pointing `HUB_DATA_DIR` at a temp
  directory for the test process, which needs checking against every in-process test first.
- `crash_log.json` is gitignored, so none of this accumulated state was ever committed — it was
  invisible precisely because it is ignored.

## STATUS

✅ VERIFIED — 455/455, 25 consecutive clean runs, no production code changed.
