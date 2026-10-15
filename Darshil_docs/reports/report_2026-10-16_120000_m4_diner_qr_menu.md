# M4 · Diner QR menu (view-only)

**Date:** 2026-10-16T12:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M4 — Customer surfaces (§4.5, first slice)

---

## WHY

The first customer-facing surface: a guest scans the code on their table and reads the menu on
their own phone. View-only on purpose — order-and-pay is the next slice and needs the payment
provider decided, the same decision blocking PR 19.

Served by the hub on the restaurant's own wifi, so it keeps working during an internet outage
like everything else here.

## WHAT

### `GET /public/menu` — the hub's first unauthenticated read

That is the part worth reviewing. A guest is not an enrolled device and must not have to be, so
this route has no token check. Three things make that safe:

1. **It is LAN-only in practice.** The hub binds the restaurant's wifi and CORS was already
   restricted to private hosts. This is not an internet-facing endpoint.
2. **`lib/dinerMenu.js` builds the answer from an allow-list**, not by deleting fields from a copy
   of the cache. That distinction is the whole point: the real risk is not the field someone
   forgets to strip today, it is the one added next year. There is a test that puts `cost_price`
   and `supplier_note` on an item and asserts the output keys are exactly
   `id, name, category, is_veg, price`.
3. **The input is the plan-gated cache**, so a tenant whose plan excludes modifiers does not leak
   them here either.

Verified against the live hub: `station`, `day_parts`, `available`, `course`, `enrollment` and
`pairing_code` all absent from the response.

### Decisions in the projection

- **Prices are the effective ones**, resolved through the same day-part logic an order is priced
  with. Showing the base price during happy hour would quote a guest a number the kitchen would
  not honour, which is worse than showing nothing.
- **An 86'd dish is hidden, not greyed out.** A guest cannot order from this screen, so showing
  something unavailable only invites them to ask for it. Same for a dish whose every size is 86'd,
  and for a group whose every option is gone.
- **Zero is handled two different ways on purpose.** A modifier delta of `0` is meaningful (a free
  choice such as spice level) and is kept; a *price* of `0` is bad data — the hub's own rules
  require above zero — and quoting a guest "₹0" is worse than not listing the dish, so it is
  hidden. The first draft used one rule for both and a test caught it.

### `GET /qr/diner?table=4` — reception-only

Reception-only **even though what it points at is public**: the code embeds this hub's LAN
address, and handing that to anything that asks would be telling a stranger where the hub lives.
The menu behind it is public; the directions to it are not advertised. The table label is carried
through for display only — nothing is decided by it — and anything that would not survive a URL
is dropped rather than escaped.

### The page

A separate Vite entry (`diner.html`, 2.7 kB of JS) rather than a route inside an existing app.
A guest's phone should load this and nothing else. Deliberately plainer than the staff surfaces:
no service worker (nothing to install, nothing to go stale between visits), no theme toggle, and
it follows the phone's own light/dark setting. Veg and non-veg marks are rendered because an
Indian menu is required to carry them.

### Files

| File | Change |
|---|---|
| `hub_server/lib/dinerMenu.js` | New — the allow-list projection |
| `hub_server/server.js` | `GET /public/menu`, `GET /qr/diner`, `GET /diner` |
| `diner.html`, `src/diner_main.jsx`, `src/diner/DinerMenu.jsx`, `src/diner/diner.css` | New — the page |
| `vite.config.js` | Fourth entry point |
| `hub_server/test/dinerMenu.test.mjs` | New — 16 tests |

## TEST CASES (16 new)

| ID | Title | Expected | Actual |
|---|---|---|---|
| DM-1 | Station never leaks | Not in the output | Pass |
| DM-2 | Day-part schedule never leaks | Price yes, schedule no | Pass |
| DM-3 | **Allow-list holds** | Invented cache fields do not appear | Pass |
| DM-4 | 86'd dish | Hidden | Pass |
| DM-5 | 86'd sizes | Dropped; all gone means hidden | Pass |
| DM-6 | Unusable price | `0`, missing, `'ask'` all hidden | Pass |
| DM-7 | **Effective price** | ₹150 during happy hour, ₹230 at noon | Pass |
| DM-8 | Day-part on sizes | Per-variant overrides applied | Pass |
| DM-9 | Options | Free choice kept, paid one shows what it adds | Pass |
| DM-10 | 86'd option | Dropped; empty group disappears | Pass |
| DM-11 | Category order | Restaurant's order, empty dropped | Pass |
| DM-12 | Undeclared category | Appended after the declared ones | Pass |
| DM-13 | Malformed cache | Empty menu, no crash | Pass |
| DM-14 | Everything 86'd | Empty menu | Pass |
| DM-15 | **Route, no token** | 200 for a guest; `/menu` still 401 | Pass |
| DM-16 | **Table QR** | 403 from a handset, 200 from reception; hostile label dropped | Pass |

DM-15 also asserts the authenticated `/menu` still returns 401 — making one route public should
not have opened another.

```bash
npm test       # 535 + 16 = 551
npm run build  # clean
```

Checked on a 375×812 phone viewport against the pilot hub, in both light and dark: categories in
the restaurant's order, veg/non-veg marks, prices right-aligned and tabular, no console errors.

## NOT DONE / LIMITS

- **No ordering, no payment.** The footer says to ask a member of staff. Order-and-pay is the next
  slice and is blocked on the same payment-provider decision as PR 19.
- **The diner menu is not plan-gated.** Every other customer-facing capability is a plan feature;
  this one is on for everybody because whether a diner QR menu is a Starter feature or a Pro one
  is a pricing decision, not a technical one. Adding the flag later is the same one-liner the
  other features use.
- **No printable sheet.** `/qr/diner` returns one code as a data URL; there is no "print a code
  for every table" page, so a restaurant with twelve tables currently fetches twelve codes by
  hand. That is the obvious next piece of UI and is not built.
- **Nothing links to it.** Neither the KDS nor the admin console shows the diner QR anywhere — the
  endpoint exists but a user has to know the URL. It belongs on the Tables tab.
- **The guest's phone must be on the restaurant's wifi.** Inherent to the LAN-first architecture,
  but worth saying plainly: a code on the table is useless to a guest on mobile data. A
  cloud-served menu would fix that and is a different design.
- **No allergen or nutrition information**, which some jurisdictions require of a published menu.
  The cache does not carry it, so this cannot show it.
- The 30-second `Cache-Control` means an 86'd dish can linger on a guest's screen for up to half a
  minute after the kitchen pulls it.

## STATUS

✅ VERIFIED — 551/551, build clean, checked on a phone viewport in both colour schemes.
