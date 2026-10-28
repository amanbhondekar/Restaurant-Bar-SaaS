# Sales analytics: the Sales tab, comparisons, cohorts and scheduled summaries

**Date:** 2026-10-22T20:15:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHAT WAS BUILT
- **`hub_server/lib/analytics.js`** (pure): reporting windows for today, this week (Monday start), this month and a
  custom range, each with the window it is compared with, in the restaurant's local time. "Today so far" is set against
  yesterday **up to the same time**; a month clips to the shorter month. Takings come from the cash screen's own
  functions (`paymentEvents` and `summarize`), so there is one definition of takings, not two. Bills raised, average bill,
  voided bills, best sellers (revenue, then portions, then name), busy hours, new vs returning guests, how many of the
  previous period's new guests came back, and monthly cohorts.
- **`hub_server/lib/reportStore.js`**: a daily summary the morning after and a weekly one on Mondays, kept in
  `reports.json`, **frozen** when written (a later refund does not rewrite last week's record), only for days that had
  business, a 14-day / 8-week catch-up so a hub switched on after a quiet spell does not write months, and the owner's
  number.
- **Routes** (reception only): `GET /admin/sales`, `GET /admin/reports`, `PUT /admin/reports/contact`,
  `POST /admin/reports/:id/sent`, plus a timer that prepares summaries so they are already there in the morning.
- **The Sales tab**: period buttons, takings/bills/average with how each compares, how the money was taken, best sellers,
  busy hours, guests and cohorts, and the summaries with a Send on WhatsApp link per summary and the owner's number.

## WHAT "SCHEDULED" HONESTLY MEANS
The hub **prepares** summaries on a schedule; it cannot **send** them. A WhatsApp message is something a phone sends
(the same click-to-chat decision as bookings and the shopping list: no provider, no per-message fee). Tapping Send opens
WhatsApp with the message written, to the owner if a number is saved. The screen says "Not sent yet" / "Opened in
WhatsApp", not "Sent", because opening the chat does not prove it was sent.

## FOUND IN A REAL BROWSER, NOT BY A TEST
With a scratch hub on seeded bills the screen read **"Today so far, set against ."** and every change had no
"on …". The preset table called the wording `previous`, the report read `previous_label`, and the real comparison
window then overwrote the text. A summary made from any preset would have said "up 5% on undefined". The 34 pure tests
all used custom windows or an override, so they missed it. Fixed (`previous_label`, in full words); two tests written
first and shown failing on the old code, plus a route test that every preset says what it is set against.

A second look at the same page: about twenty summaries in one unbroken list. It now shows the newest six with "Show N
older".

Also found while testing the store: the "where to stop looking back" scan read `refunded_at`, the field name that was
fixed in the previous report; the ledger's name is `refund_at`. The field turned out not to matter (a refund follows its
sale, so it can never be the earliest date), so the dead dates were removed rather than renamed.

## TESTS
- `analytics.test.mjs`: 36 (pure rules; each passes under UTC, Asia/Kolkata, America/Los_Angeles and Pacific/Auckland).
- `analyticsRoutes.test.mjs`: 17 (the store on its own data directory, then a real hub: shapes, a custom range, bad
  ranges refused with the reason, preparing is idempotent, frozen summaries, catch-up limit, contact normalised and
  persisted, sent stamped once, a damaged file starts empty, and a handset, a screen at the pass and a stranger are all
  refused on every route).
- `salesLib.test.js` 23 and `SalesTab.test.jsx` 24 (the wording, the stale-answer race, custom ranges, summary text shown
  as text and never markup, the owner's number, the older-summaries button).
- **Mutations:** 10 on the store and routes, 8 caught and 2 equivalent (other restaurants' dates and refund dates in the
  look-back scan, which cannot change what is written; the dead dates were removed). 16 on the tab and its wording,
  15 caught and 1 survived (a stale "not a mobile number" message after typing again), now covered by a test and caught.
- Full suites: **1103 hub, 562 frontend, build clean.**

## NOT DONE
- A hub cannot send a message by itself. A provider (and its cost) would be needed for that.
- Guests are counted only where a phone number was given (seated bookings and walk-ins), so "new vs returning" is of
  known guests, not of every diner.
- No per-waiter or per-table view, and no CSV export of sales.
- The older `SalesAnalyticsView` in the server-laptop shell adds up every ticket in the browser's storage with no period
  and no regard for voids or refunds. It is still there and misleading; recorded in the roadmap for deletion.
- The browser check was a scratch hub on seeded bills, in dark theme at a narrow width; light theme and a phone were not
  looked at.
