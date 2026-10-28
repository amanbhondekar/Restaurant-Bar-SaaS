# Stitch Redesign — Design Spec

**Date:** 2026-10-02
**Status:** Approved in chat (sections 1 and 2), pending written-spec review
**Source design:** Google Stitch project `projects/8522582396662203279` — "Restaurant SaaS Glassmorphism Dashboard" (theme "Luminous Culinary OS", 10 desktop screens)

## Goal

Apply the Stitch visual language, layouts and Framer Motion to the existing Kullina surfaces so the product feels like a polished SaaS, **without changing behavior, data, or the LAN-first offline architecture**.

## Decisions (user-approved)

| Topic | Decision |
|---|---|
| Scope | Restyle what exists. No new modules (Wine Vault, Sommelier, Inventory, Staff Roster are out). No mock data. |
| Waiter layout | Responsive. Phone-first flow kept; at >=768px adopt Stitch floor-plan + side order drawer. |
| Fonts / brand | Stitch fonts (Syne headlines, Plus Jakarta Sans body/labels), self-hosted via `@fontsource`. Kullina name/logo kept; "Gusteau" branding not used. |
| Primary color | `#ff5722`, unchanged everywhere. |
| Approach | Tokens first, then one surface at a time. |

## Non-goals

- `hub_server/`, `src/context/PosContext.jsx`, sync/WebSocket/auth services, PWA service worker: **untouched**.
- No drag-to-column KDS gesture unless the current KDS already has one.
- No stock food photography; only images present in menu data.
- Runtime data files `hub_server/data/*.json` are never staged.

## 1. Foundation

**Colors.** `--color-primary: #ff5722` stays. Add `--color-primary-ink: #b02f00` for orange text/icons on light surfaces (white-on-`#ff5722` is ~3:1, too weak for small text). Stitch surface ladder (`#f7f9ff`, `#edf4ff`, `#e7eefa`, `#e1e9f5`, `#dbe3ef`) becomes the light surface tokens with a matching dark set. Existing `.dark` / `data-theme` / `kullina_theme` toggle keeps working. KDS defaults to dark.

**Fonts.** Add `@fontsource` Syne and Plus Jakarta Sans (no CDN, offline-safe). Remove Cabinet Grotesk / Instrument Sans `@font-face` blocks and `public/fonts` files only once nothing references them.

**Glass & depth tokens.** Translucent surface, backdrop blur, hairline border, orange-tinted shadows, radii aligned to Stitch (`0.5rem` default, `1rem`/`1.5rem` for cards/sheets).

**Motion module `src/motion/`.** Shared presets: spring configs, staggered page entrance, card hover/tap, slide-over/sheet, shared-`layoutId` nav indicator, KPI count-up, list `AnimatePresence`. Rules: respect `prefers-reduced-motion` (`useReducedMotion`), animate only `transform`/`opacity`, durations 150–350ms. Pure preset logic is covered by `node --test`.

**SaaS UX baseline on every screen.** Loading skeletons, empty states, error banners with retry, visible offline/sync status, >=48px touch targets, keyboard focus rings.

## 2. Order of work (each step ships and is verified independently)

1. **Foundation** — tokens, fonts, `src/motion/`, base `components.css`. Nothing breaks; surfaces inherit the palette.
2. **Owner dashboard** (`src/dashboard/HubDashboardView.jsx`) — sidebar, KPI row with count-up, revenue chart, live-orders panel, top-dishes cards; only data the hub already provides.
3. **Waiter** (`src/waiter_mobile/*`) — phone: restyle floor grid, rapid order builder, modifier sheet, draft drawer. >=768px: Stitch zone tabs + 4-state table grid + side drawer; use Stitch's pressed/selected frames.
4. **KDS** (`src/kitchen_main.jsx`) — **split first** (header/status bar, column, ticket card, pairing screen; inline styles -> classes) with behavior parity, **then** apply Stitch dark Kanban (New / Preparing / Ready, elapsed-time urgency colors, "just arrived" glow). Keep old KDS reachable via `?legacy=1` for one release.
5. **Menu/ordering polish** — immersive menu + dish-detail sheet applied to `RapidOrderBuilder` / `ModifierSheet` using existing menu images only.

## 3. Verification

No UI test runner exists; none is claimed. Per step:

- `npm run build` and `npm test` pass.
- Each surface checked in the browser pane at phone / tablet / desktop widths, light and dark; console clean.
- Reduced-motion verified; offline and hub-disconnected states still render.
- KDS: behavior-parity check against pre-split behavior (ticket arrival, status transitions, pairing, sync indicator).

## 4. Housekeeping

- Per `.agents/rules/darshil_documentation_rule.md`: a report in `Darshil_docs/reports/report_YYYY-MM-DD_<feature>.md` and an updated `Darshil_docs/README.md` index per step.
- Small commits per step.

## 5. Risks

| Risk | Mitigation |
|---|---|
| KDS regression during live service | Split-first/restyle-second, parity check, `?legacy=1` fallback |
| Inline styles fight new CSS (192 in KDS, 65 in dashboard) | Migrate to classes as each surface is touched |
| Stitch shows data the hub lacks | Omit it; never fabricate |
| Font swap shifts layouts | Verify at all three widths before merging each step |

## Reference assets

Stitch HTML and screenshots were fetched to the session scratchpad for reference only; they are not copied into the repo. Stitch screens used: Owner Overview & Executive Dashboard, Service Live Grid, Revenue & Sommelier Intelligence (layout reference only), Waiter Terminal (Floor Grid Overview / Table Pressed State / Order Detail Drawer Open), Floor & Seating, Kitchen Display Screen (KDS Kanban), Kitchen Expediter (KDS), Immersive Menu Browsing & Dish Detail Sheet.
