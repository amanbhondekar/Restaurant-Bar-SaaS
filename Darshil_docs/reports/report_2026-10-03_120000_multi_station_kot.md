# M2 · PR 15 — Multi-station KOT routing (hot / cold / bar)

**Date:** 2026-10-03T12:00:00+05:30
**Branch:** `feat/multi-station-kot` (stacked on `feat/86-per-variant`)
**Milestone:** M2 — Menu depth (**final slice**)
**Scope:** Route each ticket line to the correct station's printer + KDS view.

---

## WHY

A restaurant with a bar or a cold-prep station has always had two KOT
problems on Kullina:

- **Wrong queue.** A cold-line pastry chef and a hot-line cook share
  one KOT roll, and each has to visually filter for their own lines.
- **Wrong printer.** A bar drink prints at the hot line, then someone
  has to walk it over. Or a paper-out on the bar printer takes down
  the whole kitchen because we only had one printer target.

PR 15 lifts an item-level `station` field into the pricer, splits the
ticket at print time, sends each split to printers filtered by station,
and tags each line on the KDS view. Legacy items without `station`
resolve to the default (`hot`) so nothing about a bar-less deployment
changes.

---

## WHAT

### Data shape

Menu item grows an optional `station: 'hot' | 'cold' | 'bar'` field.
Legacy items with no station resolve to `hot` at pricing time and print
in a single KOT as they did before this PR.

Adding a new station is one-line: add its id + human label to
`STATION_LABELS` in `lib/kotRouting.js`. `resolveStation` is
data-driven — no code path is hard-coded to a specific station id.

### Files changed

| File | Change |
|---|---|
| `hub_server/lib/kotRouting.js` | **New file.** Pure `resolveStation(raw)` (whitelist + lowercase, default `hot` for unknown), `groupTicketByStation(ticket)` (first-seen iteration order, preserves parent identity, keeps line order within each group). Adding a station means adding a row to `STATION_LABELS`. |
| `hub_server/lib/pricing.js` | Every priced line now carries a `station` field resolved from the menu item. Unknown / missing values collapse to the default so a mistagged row still fires to the main line — never disappears into an unlabeled queue. |
| `hub_server/lib/restaurantCache.js` | Supabase→cache normalisation passes `station` through (lowercased, unknowns kept for downstream whitelisting). Seed marks m8 Gulab Jamun → `cold` and m9 Masala Chaas → `bar`; every other seeded item stays at the default `hot`. |
| `hub_server/lib/printer.js` | `renderKot(ticket, tenant, opts)` grows an optional `opts.station_label`; when present, the ESC/POS and preview headers read `KITCHEN ORDER · BAR` (uppercased). When absent, header is `KITCHEN ORDER TICKET` exactly as before — every M1 test that asserts on the old header still passes. |
| `hub_server/server.js` | Auto-KOT + reprint now split via `groupTicketByStation`. Each split renders its own KOT and sends to printers whose `station` matches (or all printers when a printer has no station — single-printer deployments still work). Header suffix only appears when the ticket actually spans multiple stations, so single-station tickets look identical to pre-PR-15. |
| `hub_server/test/hub.test.mjs` | +4 tests: `resolveStation` whitelist + default, `groupTicketByStation` split + single-station passthrough + line-order preservation, priceOrder stamps `station` on every priced line (including legacy default + unknown collapse), `renderKot` header suffix only when label passed. 112/112 pass. |
| `src/kitchen_main.jsx` | KDS ticket card shows a small station tag next to non-hot items so the cook eyeballs which lines belong elsewhere. Hot-line items get no tag (they're the default; noise if tagged on every line). |
| `Darshil_docs/README.md` | Index entry for this report. |

Not touched: waiter PWA menu display. The waiter's job is to build a
cart; which station a line eventually prints to is a hub concern. The
KDS tag + printed KOT header are enough to route correctly on the
kitchen side. A "station chip on menu row" is queued as a small
follow-up when the demo shows it's needed.

---

## TEST CASES

### TC-PR15-01 — Unit: `resolveStation` whitelist + default

**File:** `hub_server/test/hub.test.mjs`

- Known lowercase (`'hot'`, `'cold'`, `'bar'`) → same id.
- Case-insensitive (`'BAR'` → `'bar'`).
- Unknown (`'garnish'`) → default `hot`.
- `undefined` / `null` / `''` → default `hot`.
- Every id in `STATION_LABELS` round-trips.

Rationale: `hot` is deliberately the fallback — a mistagged item fires
to the main kitchen where someone can spot and route it, rather than
sitting in an unlabeled queue nobody watches.

### TC-PR15-02 — Unit: `groupTicketByStation`

Ticket with items at `hot, bar, hot, cold` returns three groups (first-
seen order `hot, bar, cold`); hot group has the two hot items in
input order; each sub-ticket keeps `ticket_number`, `table_name`,
`created_at`. Single-station ticket (all default) returns one group
with every item.

### TC-PR15-03 — Unit: `priceOrder` stamps station on every priced line

Menu with a legacy no-station curry, a bar chaas, a cold jamun, and a
`station: 'garnish'` (unknown) weird. Priced lines report `hot, bar,
cold, hot` — legacy default + unknown collapse both work.

### TC-PR15-04 — Unit: `renderKot` header

- Legacy call (`renderKot(ticket)`): header is `KITCHEN ORDER TICKET`
  and does NOT contain `BAR` / `HOT LINE` / `COLD LINE`. This is the
  same guarantee every M1 test relies on.
- With opts: `renderKot(ticket, tenant, { station_label: 'Bar' })`:
  header is `KITCHEN ORDER · BAR` and does NOT contain the old text.

### TC-PR15-05 — Manual: mixed cart splits printed KOTs

**Steps:**

1. Boot the hub with the updated seed.
2. Configure two "printers" in the hub config: one with `station:
   'hot'` (main kitchen), one with `station: 'bar'`. Both can use
   preview mode if no real hardware.
3. Waiter PWA: cart 1 × Chicken Tikka + 2 × Masala Chaas + 1 × Gulab
   Jamun. Send.
4. Confirm the hub log shows three KOT prints, one per station, each
   going to the printer(s) whose station matches. Only the hot printer
   receives Chicken Tikka; only the bar printer receives Chaas; the
   Jamun cold line has no matching printer, so it prints only on a
   printer with no `station` (fallback), or falls silently to preview.

### TC-PR15-06 — Manual: legacy single-station cart stays unchanged

1. Cart 2 × Butter Naan + 1 × Dal Tadka.
2. Send. Confirm the hub prints ONE KOT with header `KITCHEN ORDER
   TICKET` (no station suffix), same as before PR 15.

### TC-PR15-07 — Manual: KDS station tag

1. On the Kitchen Display, confirm that a mixed ticket shows:
   - Chicken Tikka Masala with no tag (default hot line)
   - Masala Chaas with a primary-colour `BAR` chip
   - Gulab Jamun with a primary-colour `COLD` chip
2. Confirm the chip text is legible from a metre away (font 10px,
   uppercase, bold, amber background).

### TC-PR15-08 — Automated verification

```bash
cd /path/to/Restaurant-Bar-SaaS
npm test          # 112 tests, all pass — 4 M2·PR15 + 1 PR14 + 4 PR13 + 4 PR12 + 3 PR11 + 96 M1
npm run build     # vite build clean
```

Actual: 112/112 pass in ~1s; vite build clean in 2.4s.

---

## OUT OF SCOPE (queued for follow-up)

- **KDS station filter tabs** — "Show only BAR tickets". Small
  follow-up once the bar staff have their own screen.
- **Waiter menu station chip** — showing which station an item routes
  to on the waiter's menu row. Not needed for the demo; adds noise.
- **Per-variant station override** — a beer sold as Bottle vs Draft
  routing to different stations. Not seen yet; add when demand emerges.
- **Reception admin UI to author station assignments** — bundled with
  the variant/modifier/day-part admin UI.
- **Station-scoped 86 (auto-un-86 timer)** — already noted under PR 14.

---

## STATUS: ✅ Ready for review — M2 COMPLETE

- 112/112 hub tests pass
- vite build clean
- Feature branch `feat/multi-station-kot` pushed to fork, stacked on
  `feat/86-per-variant`.
- **M2 (Menu depth) complete**: variants (PR 11), modifiers (PR 12),
  day-part pricing (PR 13), per-variant availability (PR 14), multi-
  station KOT routing (PR 15). All five slices ship on the same "fail-
  loud, backwards-compatible, hub-authoritative" contract.
