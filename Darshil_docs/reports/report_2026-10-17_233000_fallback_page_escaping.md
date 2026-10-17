# Security — the hub's fallback page escapes what people typed

**Date:** 2026-10-17T23:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** Hardening (found while adding the printable table-code sheet)

---

## WHY

While building the diner QR sheet I added an `escapeHtml` helper, because that was the first place
this hub put restaurant-typed text into server-rendered HTML — and noticed an older template did the
same thing without it. I wrote that down as "`/dashboard` interpolates the restaurant name into HTML
unescaped."

**That was wrong about the route, and this report corrects it.** `/dashboard` serves the built
`dashboard.html` and renders nothing itself. The unescaped template is inside **`GET /`**, and it
runs only as the **fallback when `dist/index.html` does not exist** — before the first build, or if
`dist/` has been deleted. A normal deployment never reaches it, so the exposure is narrower than I
first claimed. It was still real, and still worth fixing, but a reader of the earlier note would
have looked in the wrong place.

The template interpolated four kinds of text a person typed:

| Printed | Typed by | Route into the page |
|---|---|---|
| Restaurant name (twice: `<title>` and the paired-tenant line) | An operator, or the cloud | `hub_config.json` |
| Pairing code | Generated, but still text | `hub_config.json` |
| Table name | **An enrolled handset** | Order body → ticket → page |
| Item names | The menu editor | Menu cache → ticket → page |

The table name is what makes this more than an admin typo. The order handler stores
`orderData.table_name || orderData.tableName || 'Table'` with no sanitising, so any enrolled waiter
handset chooses what appears on the reception screen. And a `</title>` in the restaurant name is the
classic way out of a title element.

## WHAT

`escapeHtml` was already in `server.js` for the print sheet. It is now applied to the four things
above — the restaurant name in both places, the pairing code, the table name, and the item line.
Counts, booleans, the hub's own address and ticket numbers are computed by the hub rather than
typed, and are left alone, so the diff stays honest about what is actually untrusted.

### A seam to test the real route

Testing this properly needs `GET /` to render its fallback, which needs `dist/index.html` to be
absent — and the real `dist/` must not be deleted to prove it. So:

- `server.js` reads `HUB_DIST_DIR` for the build directory, defaulting to the same `../dist` as
  before. Nothing changes unless it is set.
- `startHub` gains an `env` passthrough, and a `nameSuffix` that is *appended* to the per-start
  nonce rather than replacing it. The readiness probe matches on the full name, so the guard that
  stops a stale hub passing for a fresh one is intact while a test can still give the restaurant a
  hostile name.

### Written to fail first

The tests were run against the unfixed code before the fix: **exactly the five escaping tests
failed and the three sanity tests passed**, which proves the problem was real, that the order path
genuinely reaches the page, and that the tests could tell the difference.

### Files

| File | Change |
|---|---|
| `hub_server/server.js` | Four interpolations escaped; `HUB_DIST_DIR` seam |
| `hub_server/test/helpers/spawnHub.mjs` | `env` and `nameSuffix` options |
| `hub_server/test/fallbackPage.test.mjs` | New — 8 tests |
| `docs/ROADMAP.md` | Security bullet, new §3 item, two stale claims corrected |

## TEST CASES (8 new)

Each hostile value is a real payload rather than a plain apostrophe: `</title><script>…`,
`<img src=x onerror=…>`, `<script>…` as a table name, and `<b onmouseover=…>Dal</b> & "Co"` as an
item name.

| ID | Title | Expected | Actual |
|---|---|---|---|
| FP-1 | Guard | It really is the server-rendered fallback (not a built index) | Pass |
| FP-2 | **Title breakout** | No `</title><script>`, exactly one `</title>`, payload not inside a script element | Pass |
| FP-3 | Paired-tenant line | Name shown escaped | Pass |
| FP-4 | Pairing code | Shown as text, no injected `<img>` | Pass |
| FP-5 | **Table name from a handset** | No injected `<script>`; escaped text present | Pass |
| FP-6 | Item name | No injected element or handler; `&` and `"` escaped too | Pass |
| FP-7 | Not mangled | Real markup intact; nothing escaped twice | Pass |
| FP-8 | Untouched values | Hub address and sync status still read normally | Pass |

One assertion needed correcting along the way. FP-2's third check originally asserted the payload
text appeared nowhere on the page — but escaped, it *should* appear as inert words. It now asserts
the thing that actually matters, that no executable `<script>` carries it, and was checked against
both the vulnerable and the escaped form so that relaxing it did not leave it vacuous.

```bash
npm test       # 579 + 8 = 587, green under TZ=UTC as CI runs it
npm run build  # clean
```

## NOT DONE / LIMITS

### A related finding, deliberately not fixed

While proving this I probed what an **unauthenticated** caller receives from that fallback page.
With the hub treating the caller as a stranger on the wifi and no token supplied, `GET /` returned
200 and printed **the pairing code and the live kitchen tickets** — table names and the items on
them. `GET /pairing-info`, queried the same way, omits the pairing code on purpose, with a comment
that it is reachable by anything on the LAN. The fallback page contradicts that decision.

Two things keep this modest: it is reachable only when there is no build, and the pairing code alone
does not let a stranger pair — `POST /pair` requires a device token. But it is a deliberate design
rule being quietly broken by an older code path.

It is **not fixed here** because it is a behaviour change — gating the fallback to reception — rather
than the escaping that was asked for. It is recorded in the roadmap's §3. The fix is two lines and a
test.

### Other limits

- **Only the fallback page was audited.** Other server-rendered output (the print sheet, written
  with escaping from the start) was checked as I went; I did not do a full sweep of every route for
  untrusted text in a response body.
- **Printed output is a separate surface.** Table names also reach the thermal printer and
  invoices; those go through `sanitiseForPrinter` and were not part of this.
- **The table name is still unvalidated on the way in.** Escaping on output is the correct fix for
  this page, but a 5,000-character or control-character table name is still accepted and stored.
- The `HUB_DIST_DIR` seam is a production configuration knob that exists mainly for tests.

## STATUS

✅ VERIFIED — 587/587 under TZ=UTC, build clean; five failing tests written first, then passing.
