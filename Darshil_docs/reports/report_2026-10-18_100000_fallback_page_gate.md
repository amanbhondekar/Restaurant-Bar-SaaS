# Security — the fallback page is reception's to see

**Date:** 2026-10-18T10:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** Hardening — closes the finding left open by `report_2026-10-17_233000_fallback_page_escaping.md`

---

## WHY

The previous report fixed the escaping in the page `GET /` renders for itself when there is no
frontend build, and recorded a second finding it deliberately did not fix: **an unauthenticated
caller gets the pairing code and every live kitchen ticket from that page**, while `/pairing-info`
withholds the pairing code from anyone but reception on purpose, with a comment saying it is
"reachable by anything on the LAN".

That is a decision the hub had already made once, about the same data, and an older code path was
quietly contradicting it. Left open it was small — the page only exists before the first build, and
the pairing code alone does not let a stranger pair, since `POST /pair` needs a device token — but
the fix is two lines, so leaving it was hard to justify once the escaping work had the route open.

## WHAT

In `GET /`, after the branch that serves a built `index.html` and before the code that renders the
page itself:

```js
if (!isReceptionRequest(req)) return refuseNonReception(res);
```

Same guard, same refusal as `/admin`. The placement is the point worth reviewing:

- **Only the self-rendered page is gated.** The built KDS is a static bundle that fetches through
  authenticated routes, so serving it to anyone is fine and has always been the behaviour. A gate
  placed one branch earlier would have quietly locked handsets out of the real app, which is why
  there is a test for exactly that.
- It uses `isReceptionRequest`, which honours `HUB_TRUST_LOOPBACK` — the same check `/qr/diner`
  and `/admin` already use — rather than a new notion of who counts as reception.

### What the tests had been relying on

The previous slice's escaping tests fetched the page *as a stranger*. When the gate went in, all
eight failed — not on an assertion but in setup, because the stranger was refused. They had only
ever been passing because of the leak. They now fetch as reception, who is who the page is for, and
the stranger case is tested on its own.

### Files

| File | Change |
|---|---|
| `hub_server/server.js` | One guard line, with the reasoning at the call site |
| `hub_server/test/fallbackPage.test.mjs` | Fixture moved to reception; two new tests |
| `docs/ROADMAP.md` | Gate recorded under Security; the open §3 item removed |

## TEST CASES (2 new, 8 reworked)

| ID | Title | Expected | Actual |
|---|---|---|---|
| FG-1 | **A stranger is refused** | 403; no pairing code, no item, no ticket in the body | Pass |
| FG-2 | There was something to protect | An authorised handset can see the live ticket, so the refusal withheld something real | Pass |
| FG-3 | Consistent with `/pairing-info` | That endpoint still withholds the code for the same caller | Pass |
| FG-4 | **A built frontend stays public** | With an `index.html`, a stranger still gets 200 | Pass |
| — | The eight escaping tests | Now fetch as reception and still pass | Pass |

FG-2 matters more than it looks. A refusal test that never checked anything was there to refuse
would pass on an empty hub.

**Checked that the new test can fail.** With the guard line removed, exactly the stranger test
failed (9 passed, 1 failed); the file was then restored from a backup and confirmed byte-identical.

```bash
npm test       # 587 + 2 = 589, green under TZ=UTC as CI runs it
npm run build  # clean
```

## NOT DONE / LIMITS

- **The page is still unvalidated input on the way in.** Escaping on output is the right fix for
  this page, but a 5,000-character table name is still accepted and stored. Unchanged.
- **Only this route was audited for the disclosure.** I probed the fallback page because I was in
  it; I did not sweep every route for whether it prints data that `/pairing-info` deliberately
  withholds.
- **A reception laptop addressed by an unusual hostname is refused.** `isReceptionRequest`
  requires the request to be addressed to the machine itself, the same as `/admin`, whose own error
  text already warns about opening it by computer name. Anyone seeing "Reception only" on the
  laptop itself should try `localhost`.
- The fallback page is itself a stopgap for a missing build; the cleaner fix is to ensure a build
  exists, which this does not do.

## STATUS

✅ VERIFIED — 589/589 under TZ=UTC, build clean; the stranger test shown to fail without the guard.
