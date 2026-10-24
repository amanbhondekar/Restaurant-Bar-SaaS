# M4 · Feedback tab for reception

**Date:** 2026-10-17T21:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M4 — Customer surfaces (§4.5), closing a gap the guest-feedback report left open

---

## WHY

The guest-feedback slice let a guest leave a rating and let `GET /feedback` return it, but nothing in
the product displayed it: reception had to call the endpoint by hand. Feedback nobody can see is a
write-only drawer. This is the screen for it.

## WHAT

### A Feedback tab in the admin console

A summary header (average, count, and how the ratings split), three filters, and the entries newest
first, each showing its stars, the table, which bill it was matched to, and when. Read-only — the hub
owns the feedback and this only shows it. Mounted on demand like the other read-only tabs.

Two things worth reviewing:

**The split is counted on the hub, not in the browser.** The endpoint caps its list (100 by default)
while its summary covers everything. A distribution worked out from the list would quietly stop adding
up the day a restaurant passes a hundred ratings — 130 ratings of five stars would draw a split of
100. `feedbackStore.summary()` now returns a `distribution`, and the page says plainly "Showing the
latest 100 of 130. The average and split above cover all of them" when the list is truncated. A test
reproduces exactly that 130-entry case.

**A guest's comment is rendered as text, never markup.** Every comment was typed by a stranger on a
phone. React escapes it on the way out, and the data layer deliberately does not pre-escape it, which
would show reception `&lt;b&gt;` instead of what was typed. Verified on screen: a comment of
`<b>Cold</b> food & rude service!` appears literally, with no bold.

### The rest

- **"Needs attention" is two stars or below**, flagged with a red edge and counted on the filter
  button, because the point of reading feedback is to find the ones that want a person.
- **An unknown filter shows everything** rather than hiding feedback behind a typo.
- **A hub too old to send a split draws no chart** rather than a chart of zeroes, which would look
  like data.
- Wording and arithmetic live in `src/admin/lib/feedback.js`, following the console's convention of
  keeping logic out of the component.

### Files

| File | Change |
|---|---|
| `hub_server/lib/feedbackStore.js` | `summary()` also returns the rating `distribution` |
| `src/admin/lib/feedback.js` | New — filters, split rows, labels |
| `src/admin/FeedbackTab.jsx` | New — the tab |
| `src/admin/AdminApp.jsx` | Seventh tab, mounted on demand |
| `hub_server/test/adminFeedback.test.mjs` | New — 12 tests |
| `hub_server/test/feedback.test.mjs` | Summary assertions updated for the new field |

## TEST CASES (12 new)

Driven through the hub's real `feedbackStore`, so the console is tested against what the hub actually
sends rather than hand-written fixtures.

| ID | Title | Expected | Actual |
|---|---|---|---|
| FT-1 | Stars | `★★★★☆`, with an accessible "4 out of 5" | Pass |
| FT-2 | Nonsense ratings | `undefined`, `NaN`, `99`, `-3` draw empty or clamped, never throw | Pass |
| FT-3 | Labels | Table, bill, and "No bill matched" / "No table" fallbacks | Pass |
| FT-4 | Attention threshold | 1–2 flagged, 3+ not, nothing-to-flag is not an alarm | Pass |
| FT-5 | **Filters** | Order untouched; whitespace-only is not a comment; unknown filter hides nothing | Pass |
| FT-6 | Malformed list | `null`, `'nope'`, `42` → empty list | Pass |
| FT-7 | Drift guard | Every offered filter is one `filterEntries` understands | Pass |
| FT-8 | Split | Best first, with correct percentages | Pass |
| FT-9 | **Split past the cap** | 130 ratings: list holds 100, split still counts all 130 | Pass |
| FT-10 | No chart | Empty, or an old hub with no split, draws nothing | Pass |
| FT-11 | Summary line | "4 average from 1 rating" / "4.5 average from 2 ratings" | Pass |
| FT-12 | Comment untouched | `<b>cold</b> & slow` carried verbatim | Pass |

```bash
npm test       # 567 + 12 = 579, green under TZ=UTC as CI runs it
npm run build  # clean
```

Driven in the browser against the pilot hub with six temporary entries (a mix of ratings, a
no-table entry, and the hostile comment above): the average read 3.4 from 7, the split bars matched
what was posted, "Needs attention (2)" was correct, clicking it left exactly the two low entries, and
there were no console errors. **The pilot's `feedback.json` was backed up first and restored
afterwards**, so it is back to its original single entry.

## NOT DONE / LIMITS

- **Read-only.** Reception can read feedback but cannot reply, mark it handled, or delete it. A
  genuinely abusive comment sits there until the file is edited by hand.
- **Not replicated to the cloud.** Still hub-local like before; this adds a screen, not a sync op.
- **No paging.** The list shows the latest 100. The summary covers everything, but there is no way to
  read entry 101.
- **No live update.** The tab loads on mount and on Refresh; a new rating does not appear until then.
  The hub already broadcasts `FEEDBACK_RECEIVED`, but the admin console does not subscribe to it.
- **Timestamps use the browser's locale**, so the rendered string is machine-dependent.
- Verified on a desktop viewport only, not a tablet or the reception laptop's real resolution.

## STATUS

✅ VERIFIED — 579/579 under TZ=UTC, build clean, driven in the browser against the pilot hub.
