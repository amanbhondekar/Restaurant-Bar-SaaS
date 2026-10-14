# Reliability — the hub picks its own test port, and the suite stops oversubscribing the machine

**Date:** 2026-10-15T02:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.8 Reliability & observability

---

## WHY

The fixture-port race had been named as "the thing worth doing next" in three consecutive reports
and was getting steadily worse as hub fixtures accumulated:

| Point in time | Bad runs |
|---|---|
| Before the replication work | 0 in 25 |
| After cash-up replication | ~1 in 16 |
| After ledger restore | 1 in 3 |

Nothing about the race changed; there were simply about eleven hubs starting at once instead of
seven. Each round of mitigation — a nonce readiness check, then retries, then more retries with
backoff — bought less than the last, because none of them addressed the actual defect.

**That defect was reserving a port and then letting go of it.** `reservePort()` opened a socket on
`:0`, read the port, closed it, and handed the number to a hub that bound it a moment later.
Between the close and the bind, anything could take it. Retrying a race you cannot win is just a
way of losing it less often.

## WHAT

### The hub binds its own port

`PORT=0` now means "ask the operating system", and the hub reports what it got:

```
HUB_LISTENING_PORT=63998
📍 Local WiFi LAN Address: http://192.168.1.8:63998
```

`PORT` and `SERVER_URL` are resolved in the `listen` callback rather than fixed at module load,
because with `:0` the port is genuinely unknown until then. Every reader — `/pairing-info`, the
QR code, the enrolment URL, the dashboard — runs while serving a request or after start-up, so all
of them see the resolved values.

The machine-readable line is printed before the decorated banner. Today its consumer is the test
fixture; a Windows service wrapper (PR 20) will want exactly the same thing.

### The fixture asks instead of guessing

`startHub` no longer reserves anything. It spawns with `PORT=0`, reads `HUB_LISTENING_PORT` from
the child's stdout, and probes that port. **There is no window between choosing a port and holding
it, so there is nothing to race and nothing to retry** — `reservePort`, the retry loop and the
backoff are all gone, along with the "is this error a taken port?" guesswork that decided whether
retrying was even appropriate.

Passing an explicit `port` still works and still fails loudly, which `spawnHub.test.mjs` depends
on: it binds a stale listener on a known port to prove the readiness nonce rejects it.

### The suite stopped oversubscribing the machine

Fixing the race exposed a second, independent problem. With 16 CPUs, `node --test` runs up to 16
files at once — which meant every hub fixture starting simultaneously. The failures left after the
port fix were not port collisions at all but symptoms of that load: a dropped `fetch` mid-test, and
a Node test-runner IPC error (`Unable to deserialize cloned data`) in a file that does not even use
a hub.

`--test-concurrency=4` caps it. **It costs nothing**: 17 seconds either way, because the suite is
I/O-bound on hub start-up rather than CPU-bound.

### Files

| File | Change |
|---|---|
| `hub_server/server.js` | `PORT`/`SERVER_URL` resolved after `listen`; `HUB_LISTENING_PORT` line |
| `hub_server/test/helpers/spawnHub.mjs` | Reads the hub's reported port; `reservePort` and the retry loop removed |
| `package.json` | `--test-concurrency=4` |

## TEST CASES

Flakiness is a rate, so it was measured as one.

| Stage | Runs | Bad | Note |
|---|---|---|---|
| Before this change | 3 | 1 | `catalogRoutes` lost to an exhausted start retry |
| Hub picks its own port | 8 | 2 | **Neither was a port collision** — a dropped fetch and a Node IPC error, both load symptoms |
| Concurrency capped at 4 | **10** | **0** | 527/527 each time |

The port race itself is gone by construction rather than by measurement: there is no longer a
moment when a chosen port is unheld.

Also verified directly: `PORT=0` reports a real port and serves on it; the default path is
unchanged — the pilot hub restarted on 4000 with `server_url: http://192.168.1.8:4000`, and `/`,
`/admin` and `/dashboard` all serve.

```bash
npm test       # 527/527, 17s
npm run build  # clean
```

## NOT DONE / LIMITS

- **Ten clean runs is evidence, not proof.** At the previous rate (1 in 3) ten clean runs is a
  strong signal, but a fault rarer than about 1 in 10 would not have appeared.
- **The two load-induced failures were not diagnosed, only avoided.** Capping concurrency makes
  them stop happening; it does not explain why a `fetch` to a local hub failed, or why the test
  runner's IPC broke in an unrelated file. If either returns at concurrency 4, that reasoning is
  wrong and the real cause is still there.
- **Concurrency 4 is a guess**, picked because it is comfortably below the fixture count and
  costs no wall time. It is not tuned, and on a smaller CI machine it may be the wrong number —
  though it can only help there.
- **`reservePort` is gone**, so a future fixture that wants a port before starting something has
  nothing to call. That seemed better than keeping a function whose whole purpose was the race
  this removes.
- The suite still writes to the repository's own `hub_server/data/` from modules imported
  in-process. Unrelated to this, still open in §4.8.

## STATUS

✅ VERIFIED — 527/527 across 10 consecutive runs, build clean, pilot hub unchanged on port 4000.
