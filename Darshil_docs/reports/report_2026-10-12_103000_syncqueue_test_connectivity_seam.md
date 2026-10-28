# Fix — syncQueue quarantine test stubbed the wrong seam

**Date:** 2026-10-12T10:30:00+05:30
**Branch:** `integration/m3-land`
**Commit:** `9a3e4d7`
**Milestone:** Housekeeping (unblocks CI as a merge gate)

---

## WHY

`npm test` reported 419/420 on a clean checkout. The one failure was
`SyncQueue: head-of-line blocking resolved with quarantine`:

```
AssertionError: Both items should be cleared from active queue
2 !== 0
```

The test was not wrong about the behaviour — it never reached it. It mocked
connectivity with `syncQueue.isOnline = true`, but `processQueue()` overwrites that
field from a live probe before it does anything else
(`hub_server/lib/syncQueue.js:334-336`):

```js
const connResult = await this.checkConnection();
const online = connResult.online;
this.isOnline = online;
if (!online) { ...; return; }          // line 344 — returns before touching the queue
```

With no real Supabase configured, `checkSupabaseConnection` short-circuits on the
`example.supabase.co` sentinel and reports offline, so `processQueue()` returned at line
344 and both queued items stayed put.

**The important part is not the red test, it is what the red test was hiding.** The
assertion only passed on a machine with a real `.env`. `/.github/workflows/ci.yml` runs
`npm test` with no Supabase secrets, so this test could never have passed in CI, and the
quarantine / head-of-line-blocking behaviour it guards was effectively unguarded
everywhere except one developer's laptop.

## WHAT

`SyncQueue`'s constructor already exposes the right seam and says so
(`hub_server/lib/syncQueue.js:60-62`):

```js
// Seams for tests: the connectivity probe and the cloud client.
this.checkConnection = checkSupabaseConnection;
this.cloud = supabase;
```

The test now stubs the probe instead of the flag, matching the idiom already used by
`hub_server/test/syncQueueCatalog.test.mjs:55`, and restores it alongside the existing
`syncOrderToSupabase` restore.

### Files

| File | Change |
|---|---|
| `hub_server/test/syncQueue.test.mjs` | Stub `checkConnection` (+2 lines), restore it on cleanup (+1), comment explaining why the flag alone is not enough (+2). |

```js
// Mock connection as online. processQueue() overwrites isOnline from
// checkConnection(), so the probe itself has to be stubbed, not just the flag.
const originalCheckConnection = syncQueue.checkConnection;
syncQueue.checkConnection = async () => ({ online: true });
syncQueue.isOnline = true;
```

No production code changed.

## TEST CASES

| ID | Title | Steps | Expected | Actual |
|---|---|---|---|---|
| SQ-1 | Quarantine clears head-of-line blocking | `node --test hub_server/test/syncQueue.test.mjs` | Bad item (4 prior attempts) quarantined on attempt 5; good item behind it syncs; active queue empties | Pass |
| SQ-2 | Deterministic without cloud credentials | Run with no `.env` present | Same result as a configured machine | Pass |
| SQ-3 | No regression | `npm test` | 420/420 | Pass |

The run now exercises the path the assertion was written for, which it previously never
entered:

```
[sync] 🔄 Processing 2 queued cloud sync item(s)...
[sync] 🚨 Item q_bad_123 (Ticket #999) reached max retries (5). Quarantining to prevent head-of-line blocking.
[sync] 🎉 Successfully synced 1 item(s) to cloud. 0 remaining.
```

## NOT DONE / LIMITS

- Other tests may carry the same shape of environment dependence; only this one was
  failing, so only this one was audited.
- CI was inferred to be red from `ci.yml` having no Supabase secrets plus the sentinel
  short-circuit. **This was not confirmed against an actual GitHub Actions run.**

## STATUS

✅ VERIFIED & COMMITTED — 420/420 at the time of commit.
