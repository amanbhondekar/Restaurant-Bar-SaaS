# Durability — an unreadable sync queue is recovered, not discarded

**Date:** 2026-10-14T16:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M1 carry-over (§4.1), closing the gap deferred on 2026-10-14

---

## WHY

The 2026-10-14 cash-up report left one item open and said it needed its own slice rather than a
drive-by. This is that slice.

`hub_server/data/sync_queue.json` holds orders and, since migration 005/006, bills and cash-ups
that have not reached the cloud. Its write is not atomic, so a crash inside it leaves a truncated
file. What made that catastrophic was not the torn file but the response to it:

```js
} catch (err) {
  console.warn('⚠️ Could not load sync_queue.json:', err.message);
}
return [];
```

A parse failure was answered with an **empty queue**, and the next `saveQueue` overwrote the file.
One torn write silently and irrecoverably destroyed a restaurant's unsent takings, announced with
a `console.warn` nobody reads on a reception laptop. The hub then carried on looking healthy: zero
queued, nothing pending, nothing failed.

The previous slice tried to remove the torn write itself (temp file + rename) and reverted it after
measuring the cost — `fsync` added seconds of latency to a path that runs on every order, and the
rename contended with readers on Windows. **This takes the other side of the problem.** A torn
write is rare; losing everything when one happens is not acceptable, and that part can be fixed
without touching the hot path at all.

## WHAT

### `salvageQueue(raw)` — exported, pure

The file is written with `JSON.stringify(queue, null, 2)`, so every top-level entry ends on a line
that is exactly two spaces and a closing brace. Walking those boundaries from the end and closing
the array at the last one that parses recovers **everything except the partial tail** — which is
precisely the shape a crash mid-write leaves.

It also rejects a candidate whose entries are not objects, so a file cut short inside the first
entry yields `null` rather than a half-built record that downstream code would treat as a real
order.

### `recoverQueue(raw, err)` — the new answer to an unreadable file

1. **Salvage** whatever complete entries survive.
2. **Preserve** the file exactly as found at `sync_queue.corrupt-<timestamp>.json`, so the lost
   tail can still be read by a human. Nothing overwrites the evidence.
3. **Say so loudly** — `console.error`, naming how many items came back, what was lost, and where
   the copy is.

`loadQueue` now also rejects valid JSON of the wrong shape (an object rather than a list), which
the old code returned happily for every consumer to misbehave on.

### `.gitignore`

`sync_queue.corrupt-*.json` added. While there, `hub_server/data/waiters.json` was finally added
too — it holds waiter names and scrypt PIN hashes, is seeded on first boot, and has been sitting
untracked-but-not-ignored since the first run of this hub.

### Files

| File | Change |
|---|---|
| `hub_server/lib/syncQueue.js` | `salvageQueue()`, `recoverQueue()`, stricter `loadQueue()` |
| `.gitignore` | corrupt-queue copies; `waiters.json` |
| `hub_server/test/queueRecovery.test.mjs` | New — 11 tests |

No change to the write path, so none of the latency or Windows-rename problems that forced the
previous revert apply here.

## TEST CASES (`hub_server/test/queueRecovery.test.mjs`, 11 new)

Every case builds its input the way `saveQueue` writes it, then truncates, rather than hand-rolling
"corrupt-looking" strings.

| ID | Title | Expected | Actual |
|---|---|---|---|
| QR-1 | Cut mid-entry | Both complete orders recovered, intact — not merely counted | Pass |
| QR-2 | Cut before the first entry closes | `null` — nothing invented | Pass |
| QR-3 | Cut exactly on a boundary | Loses nothing | Pass |
| QR-4 | One complete entry | Recovered | Pass |
| QR-5 | Nonsense input | `''`, prose, `null`, `undefined`, an object → `null` | Pass |
| QR-6 | Healthy file | Read as always; nothing set aside | Pass |
| QR-7 | Missing file | Empty queue, not a recovery | Pass |
| QR-8 | **Torn file** | Salvaged **and** the original kept byte for byte | Pass |
| QR-9 | Unsalvageable | Empty queue, but the evidence preserved | Pass |
| QR-10 | Valid JSON, wrong shape | Treated as corrupt rather than trusted | Pass |
| QR-11 | Repeat recovery | Earlier copies not overwritten | Pass |
| QR-12 | **Writer/salvager coupling** | The boundary salvage relies on is the one `saveQueue` really writes | Pass |

```bash
npm test       # 489 + 12 = 501
npm run build  # clean
```

The live pilot hub was restarted on this code: `/`, `/admin` and `/dashboard` all serve, the queue
loaded normally, and no recovery file was produced — the new path stays out of the way when the
file is healthy.

## NOT DONE / LIMITS

- **The write is still not atomic.** This makes a torn write survivable; it does not prevent one.
  The tail entry at the moment of a crash is still lost, and that is inherent to recovering from
  the file rather than writing it transactionally.
- **Recovery is never automatic beyond the salvage.** The preserved copy is for a human; nothing
  parses it further or re-queues from it. For a lost bill the practical route is still the hub's
  own `invoices.json` plus the boot backfill, which will re-queue anything the cloud has not
  confirmed — the two mechanisms cover each other, which is worth knowing but is not the same as
  a designed recovery procedure.
- **The quarantine file has the same exposure** and was left alone. It holds items that already
  exhausted their retries, so the stakes are lower, but the asymmetry is now deliberate rather
  than accidental.
- **Salvage depends on the two-space formatting** `saveQueue` uses; compact JSON would silently
  revert it to total loss. QR-12 ties the two together so that change fails a test rather than
  passing quietly, but the coupling itself remains — the salvager parses the writer's output
  format rather than sharing a definition with it.
- Torn files were produced by truncating a correctly written file, which is the common case but not
  the only one. A partial-sector write that corrupts the middle rather than the end would not be
  salvaged.

## STATUS

✅ VERIFIED — 501/501, build clean, hub boots and serves.
