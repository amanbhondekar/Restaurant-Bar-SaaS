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

## NOT CHECKED, AND WHY IT MATTERS

**This changes how default buttons look across the whole product**, and I looked at two pages only. Anywhere a button carries a utility class that was being overridden, the utility now applies. That is what its author wrote, so it should be an improvement (filled primary buttons, outline buttons with borders), but a screen that had quietly come to depend on a transparent, borderless button may now look different. **Someone should look through the reception, kitchen, waiter, owner and diner screens in a browser.** It is one commit, and reverting it is one line.

Status: ✅ fixed and pinned by a test; 🟡 not looked at across the rest of the product.
