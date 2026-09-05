# Kullina Design System

Single source of truth for all design tokens, typography scale, and component styles.

## Quick Start

```css
@import '../design-system/css/tokens.css';
@import '../design-system/css/typography.css';
@import '../design-system/css/components.css';
```

### TypeScript (monorepo / new apps)

```typescript
import { colors, spacing, radii, shadows, typography, breakpoints } from './design-system/ts/tokens';
```

## File Structure

```
design-system/
├── css/
│   ├── tokens.css        ← Color, spacing, radius, shadow, breakpoint tokens
│   ├── typography.css     ← 17 type scale classes from style guide
│   └── components.css     ← Full UI component library (40+ components)
├── ts/
│   └── tokens.ts          ← TypeScript token exports
└── README.md
```

## Token Reference

### Colors

| Token | Hex | Role |
|---|---|---|
| `--color-primary` | `#ff5722` | Brand Red — CTAs, accent |
| `--color-primary-active` | `#303841` | Brand Dark — press state |
| `--color-primary-disabled` | `#f5f5f5` | Disabled fill |
| `--color-luxe` | `#76abae` | Brand Teal |
| `--color-ink` | `#222222` | Primary text (never pure black) |
| `--color-body` | `#3f3f3f` | Secondary text |
| `--color-muted` | `#6a6a6a` | Tertiary text |
| `--color-canvas` | `#ffffff` | Page background |

### Status Aliases (Restaurant Domain)

| Alias | Maps To | Usage |
|---|---|---|
| `--status-green-*` | `--color-success-*` | Available / Open tables |
| `--status-amber-*` | `--color-warning-*` | In Kitchen / Waiting |
| `--status-rust-*` | `--color-error-*` | Occupied / Urgent |
| `--status-blue-*` | `--color-info-*` | Bill Ready / Info |

### Spacing (4px base)

`--spacing-xxs` (2px) → `--spacing-xs` (4px) → `--spacing-sm` (8px) → `--spacing-md` (12px) → `--spacing-base` (16px) → `--spacing-lg` (24px) → `--spacing-xl` (32px) → `--spacing-xxl` (48px) → `--spacing-section` (64px)

### Border Radius

`--radius-xs` (4px) → `--radius-sm` (8px, buttons) → `--radius-md` (14px, cards) → `--radius-lg` (20px) → `--radius-full` (9999px, pills)

### Elevation

| Token | Usage |
|---|---|
| `--shadow-flat` | Default (no shadow) |
| `--shadow-card` | Interactive card hover state |
| `--shadow-card-float` | Floating panels, modals |

## Component Library

### Buttons
`.btn` `.btn-primary` `.btn-ghost` `.btn-danger` `.btn-sm` `.btn-icon`

### Cards
`.card` `.card-header` `.card-body` `.card-static` `.card-elevated`

### Table Cards (Floor Grid)
`.table-card` `.table-card.selected` `.floor-grid` `.floor-grid-lg`

### KDS Tickets
`.kds-ticket` `.ticket-inner` `.ticket-header` `.ticket-item` `.ticket-note` `.ticket-footer` `.ticket-rail`

### Badges & Status
`.badge` `.badge-success` `.badge-error` `.badge-warning` `.badge-info` `.status-tag` `.status-tag-available` `.status-tag-kitchen` `.status-tag-occupied` `.status-tag-ready` `.badge-count`

### Inputs & Forms
`.input` `.input-error` `.form-label` `.form-error-helper` `.search-box`

### Pill Groups & Chips
`.pill-group` `.pill-btn` `.chip` `.chip-group`

### KPI / Stat Tiles
`.kpi-grid` `.kpi-card` `.kpi-label` `.kpi-value` `.kpi-sublabel` `.stat-tile`

### Menu Items
`.menu-item` `.menu-item.in-cart` `.qty-stepper` `.qty-btn` `.qty-count` `.add-btn` `.veg-dot`

### Order Draft Panel
`.draft-panel` `.draft-header` `.draft-body` `.draft-item-row` `.draft-total`

### App Shell
`.app-header` `.top-bar` `.bottom-nav` `.bottom-nav-item` `.nav-badge` `.tab-bar` `.tab-btn`

### Avatar
`.avatar` `.avatar-sm` `.avatar-md` `.avatar-lg` `.avatar-primary` `.avatar-info`

### Banners
`.banner` `.banner-error` `.banner-warning` `.banner-success` `.banner-connect-btn`

### Empty States
`.empty-state` `.empty-state-icon` `.empty-state-title` `.empty-state-lg`

### Modals
`.modal-overlay` `.modal-content` `.modal-dark`

### Connection Status
`.conn-pill` `.conn-pill-ok` `.conn-pill-connecting` `.conn-pill-off` `.status-dot-inline`

### Misc
`.plan-gate` `.role-switcher` `.role-btn` `.live-clock` `.success-toast` `.divider` `.divider-dashed` `.divider-vertical` `.price` `.price-sm` `.price-md` `.price-lg` `.price-hero` `.truncate` `.scroll-x` `.scroll-y`

### Skeleton Loaders
`.skeleton` `.skeleton-card` `.skeleton-badge` `.skeleton-input` `.skeleton-ticket` `.skeleton-text` `.skeleton-avatar`

### Animations
`.spin` `.anim-print-in` `.anim-slide-up` `.anim-fade-in`

## Design Rules

1. **No hover color changes.** Use elevation, transform, or cursor changes for hover state.
2. **No pure black.** Text uses `#222222` (`--color-ink`).
3. **No hard corners on interactive elements.** Everything gets a radius.
4. **Single shadow tier.** `--shadow-card-float` for floating elements only.
5. **44px minimum touch targets.** All tappable elements meet WCAG compliance.
6. **Status via domain aliases.** Use `--status-green/amber/rust/blue` for operational states.
