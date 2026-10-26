# Fix: the design system's button reset no longer beats Tailwind's utilities

**Date:** 2026-10-26T19:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** Design system (found while building the admin console's page, §4.9a)

---

## WHAT WAS WRONG

`design-system/css/components.css` had a base reset for buttons:

```css
button { font-family: inherit; cursor: pointer; border: none; background: transparent; user-select: none; }
```

It sat **outside any cascade layer**. CSS gives unlayered rules priority over every layered rule, and Tailwind v4 puts its utilities in a layer, so this reset beat every Tailwind utility on a button: `bg-primary`, `border`, `border-border` and the rest never applied. The default `Button` (white text, `bg-primary`) rendered as white text on nothing; an `outline` button had no border.

It went unnoticed because the frontend tests run without CSS (`css: false`), so no test can see it, and because most screens spell their colours out some other way. It was found by looking at the admin console's sign-in page in a real browser: the "Sign in" button had no fill. The product's existing operator console had the same fault ("Open console": computed background `rgba(0, 0, 0, 0)`, white text; invisible in the light theme).

## WHAT CHANGED

The same rule, moved inside `@layer base`, which is where the file already kept its `* { box-sizing }` reset and where Tailwind's own preflight keeps its identical `button` reset. A reset is supposed to be the thing a utility overrides. `cursor: pointer`, the inherited font and `user-select: none` still apply to buttons that carry no utility of their own.

`hub_server/test/designSystemCss.test.mjs` pins it. It reads the stylesheet's structure (a component test cannot) and fails if the `button` rule is not inside `@layer base`. **It fails on the original file and passes on the fixed one.**

## CHECKED

In a real browser, on a production build, before and after: the admin console's sign-in button `rgba(0, 0, 0, 0)` → `rgb(255, 87, 34)`, and the operator console's "Open console" the same. The frontend suite (1112 tests of the product's own screens) is unchanged by it, as it runs without CSS.

## FOLLOW-UP: THE REST OF THE PRODUCT WAS LOOKED AT (2026-10-26, same day)

Two production builds, one with the old `components.css` and one with the fix, were served by two scratch hubs and driven in a real browser (dark theme). For every page that loads `index.css`, each visible button's computed background, border, colour and size were compared. Nothing was changed in the product for this review.

**What differs after the fix**

- **Operator console (`/ops`):** "Open console" is now filled orange. It was white text on nothing. The intended effect.
- **Kitchen station screen (`/station/hot`):** the sound toggle gains a faint grey outline (`border border-border` was being cancelled). Small, visible.
- **Kitchen display, dashboard, waiter:** the shared theme toggle gains a 1px *transparent* border. Fixed size, invisible.

**What does not differ**

- **Reception (`/admin`), all 11 tabs, and owner:** identical (228 of 258 buttons the same; the other 30 were sampling noise, checked in a stable state). `src/admin/admin.css` already carried `body button { border: revert-layer; background: revert-layer }`, a local workaround for this exact bug. It is now redundant for buttons and harmless.
- **Diner and reserve:** their stylesheets are byte-identical in both builds and do not include `components.css`, so they cannot differ.
- **Kitchen display:** same layout in before/after screenshots.

**A sibling fault the fix did not touch**

`:focus-visible { outline: ...; border-radius: var(--radius-xs); }` in `components.css` is still outside any layer. On the station screen, keyboard-focusing a button turned its 14px corners into 4px. It affects the kitchen display, station, waiter and ops; reception already works around it. Not fixed: the decision was to leave it for now.

**Not reached:** kitchen ticket cards and the bill modal (the display stayed on "Loading active KOTs" against the scratch hub), the waiter order flow beyond the table list (that page talks to a hub on :4000), and the light theme.

Status: ✅ fixed and pinned by a test; ✅ looked at across the product's screens, with the gaps above; 🟡 the `:focus-visible` sibling is open.
