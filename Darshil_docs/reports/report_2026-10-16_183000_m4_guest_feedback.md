# M4 · Guest feedback at bill-close

**Date:** 2026-10-16T18:30:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M4 — Customer surfaces (§4.5)

---

## WHY

The second customer-facing slice, and the other §4.5 item that needs no payment provider. A guest
rates their meal on the phone they already have open from the code on their table, and reception
reads it on the laptop.

## WHAT

### The design decision worth reviewing: how feedback finds its bill

Feedback is worth much more attached to a meal — which table, which bill, what they paid — than
floating free. The obvious way to get that is to let the guest tell the hub which invoice they are
rating.

**That would be a mistake.** `POST /public/feedback` is the hub's only unauthenticated *write*.
Accepting an invoice id from an unauthenticated caller hands them a way to probe the ledger: send
ids, watch which are accepted, learn what bills exist. The guest has no legitimate way to know an
invoice id, so asking for one is asking for trouble.

Instead the hub resolves it. The request carries only a rating, an optional comment, and the table
label from the QR. The hub looks up *that table's* most recently settled bill within a two-hour
window and stamps it on the entry, server side. **Reception sees which meal a comment is about;
the guest learns nothing** — the response is literally `{ "success": true }`, with no record id to
enumerate.

A table with no recent settled bill still gets heard: the entry is stored with a null invoice.
Someone who could not get a table has something worth saying.

### The rest

- **Validation lives in the store, not the route.** The guest has no token, so there is no client
  to trust: 1–5 whole-number ratings, comments trimmed then measured against 500 characters.
- **Comments are stored verbatim**, including angle brackets. Escaping belongs where text is
  rendered, not where it is kept, and React escapes on the way out. A test asserts
  `<script>alert(1)</script>` is accepted *and* stored unchanged.
- **One piece of feedback per table per two minutes.** Not security — it stops a bored guest
  filing forty ratings while they wait for a taxi. A second attempt gets `ALREADY_SUBMITTED`,
  which the form treats as a thank-you rather than an error, because it is not the guest's fault.
- **`GET /feedback` is reception-only.** A guest may write; they must not read what other guests
  wrote.
- The form sits **after** the menu — a guest reading the menu has not eaten yet. 44px star
  targets, 16px textarea so iOS does not zoom the page on focus.

### Files

| File | Change |
|---|---|
| `hub_server/lib/feedbackStore.js` | New — validation, storage, cooldown, summary |
| `hub_server/server.js` | `POST /public/feedback`, `GET /feedback` |
| `src/diner/Feedback.jsx`, `diner.css` | New — the form |
| `src/diner/DinerMenu.jsx` | Renders it after the menu |
| `.gitignore` | `feedback.json` is per-hub runtime data |
| `hub_server/test/feedback.test.mjs` | New — 14 tests |

## TEST CASES (14 new)

| ID | Title | Expected | Actual |
|---|---|---|---|
| FB-1 | Rating shape | 1–5 whole numbers only; `4.5`, `0`, `6`, `'good'`, `NaN`, `[]` refused | Pass |
| FB-2 | Optional comment | Whitespace is not a comment | Pass |
| FB-3 | Length | Measured after trimming, so 600 spaces plus "ok" is fine | Pass |
| FB-4 | **Markup in a comment** | Accepted and stored verbatim | Pass |
| FB-5 | Listing | Newest first, with count and average | Pass |
| FB-6 | Tenant isolation | Another restaurant's feedback never listed or counted | Pass |
| FB-7 | Empty | No average rather than a zero | Pass |
| FB-8 | Cooldown | Same table blocked, other tables unaffected, expires | Pass |
| FB-9 | **No token needed** | 201 from a bare POST; reception sees it | Pass |
| FB-10 | Bad rating | 400, nothing stored | Pass |
| FB-11 | Repeat | 429 `ALREADY_SUBMITTED` | Pass |
| FB-12 | **Reading is reception-only** | Guest may write, 403 to read | Pass |
| FB-13 | **Bill stamped server-side** | Real order → clear → pay → feedback carries the invoice; response does not | Pass |
| FB-14 | No recent bill | Still stored, invoice null | Pass |

```bash
npm test       # 553 + 14 = 567, green under TZ=UTC as CI runs it
npm run build  # clean
```

Driven end to end on a 375×812 phone viewport against the pilot hub: four stars tapped, submitted,
"Thank you" shown; `GET /feedback` then reported `count: 1, average: 4, table: T5`; a second
submission from the same table returned 429.

## NOT DONE / LIMITS

- **Reception has no UI for it.** `GET /feedback` returns the entries and a summary, but nothing
  in the admin console or KDS displays them — someone has to call the endpoint. A Feedback tab is
  the obvious next piece and is not built.
- **Feedback is hub-local and not replicated.** Unlike invoices and cash-ups, there is no
  migration and no sync op, so it dies with the laptop and cannot be reported on centrally. That
  is the same gap billing had before migration 005 and the fix would look the same.
- **The bill match is by table label and time, not identity.** If two parties use one table inside
  two hours, feedback from the second can attach to the first party's bill. Narrowing the window
  trades that against losing the attachment entirely for a guest who types slowly on the pavement.
- **The cooldown is per table, not per person**, so one guest can prevent their companion leaving
  separate feedback for two minutes.
- **Nothing is plan-gated**, consistent with the diner menu and for the same reason: it is a
  pricing decision rather than a technical one.
- **No moderation and no deletion.** A guest can write anything within 500 characters and nothing
  can remove it; reception can only read.
- The guest must be on the restaurant's wifi, inherent to serving this from the hub.

## STATUS

✅ VERIFIED — 567/567 under TZ=UTC, build clean, driven end to end on a phone viewport.
