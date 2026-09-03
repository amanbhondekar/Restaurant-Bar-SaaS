// ─── Kullina Design System — Single Source of Truth ─────────────
// All design tokens live here. CSS custom properties and component
// styles are derived from these values. Change here, change everywhere.

// ─── Colors ─────────────────────────────────────────────────────

export const colors = {
  // Brand & Accent
  primary: '#ff5722',
  primaryActive: '#303841',
  primaryDisabled: '#f5f5f5',
  luxe: '#76abae',
  plus: '#303841',

  // Text
  ink: '#222222',
  body: '#3f3f3f',
  muted: '#6a6a6a',
  mutedSoft: '#929292',
  onPrimary: '#ffffff',
  onDark: '#ffffff',
  starRating: '#222222',
  legalLink: '#428bff',

  // Surfaces
  canvas: '#ffffff',
  surfaceSoft: '#f7f7f7',
  surfaceCard: '#ffffff',
  surfaceStrong: '#f2f2f2',

  // Hairlines & Borders
  hairline: '#dddddd',
  hairlineSoft: '#ebebeb',
  borderStrong: '#c1c1c1',

  // Semantic — Error
  errorText: '#c13515',
  errorTextHover: '#b32505',
  errorBg: '#fff0f0',
  errorBorder: '#ff3b3b',

  // Semantic — Success
  successText: '#1a7a3a',
  successBg: '#f0fff4',
  successBorder: '#2ecc5f',

  // Semantic — Warning
  warningText: '#a06800',
  warningBg: '#fff8e1',
  warningBorder: '#f0a500',

  // Semantic — Info
  infoText: '#1a5fc2',
  infoBg: '#f0f6ff',
  infoBorder: '#3b9eff',

  // Semantic — Status Groups
  statusGreenBg: '#f0fff4',
  statusGreenText: '#1a7a3a',
  statusGreenBorder: '#2ecc5f',
  statusAmberBg: '#fff8e1',
  statusAmberText: '#a06800',
  statusAmberBorder: '#f0a500',
  statusBlueBg: '#f0f6ff',
  statusBlueText: '#1a5fc2',
  statusBlueBorder: '#3b9eff',
  statusRustBg: '#fff0f0',
  statusRustText: '#c13515',
  statusRustBorder: '#ff3b3b',

  // Semantic — Primary tint (for status badges using brand color)
  primaryBg: '#fff5f2',
  primaryErrorText: '#c13515',
  primaryErrorTextHover: '#b32505',

  // Scrim
  scrim: '#000000',
} as const;

// ─── Spacing ────────────────────────────────────────────────────

export const spacing = {
  xxs: '2px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  base: '16px',
  lg: '24px',
  xl: '32px',
  xxl: '48px',
  section: '64px',
} as const;

// ─── Border Radius ──────────────────────────────────────────────

export const radii = {
  none: '0px',
  xs: '4px',
  sm: '8px',
  md: '14px',
  lg: '20px',
  xl: '32px',
  full: '9999px',
} as const;

// ─── Elevation ──────────────────────────────────────────────────

export const shadows = {
  flat: 'none',
  card: 'rgba(0,0,0,0.02) 0 0 0 1px, rgba(0,0,0,0.04) 0 2px 6px 0, rgba(0,0,0,0.10) 0 4px 8px 0',
  cardFloat: 'rgba(0,0,0,0.02) 0 0 0 1px, rgba(0,0,0,0.04) 0 2px 6px 0, rgba(0,0,0,0.10) 0 4px 8px 0',
} as const;

// ─── Typography ─────────────────────────────────────────────────

export const fonts = {
  display: "'Cabinet Grotesk', sans-serif",
  body: "'Instrument Sans', sans-serif",
  mono: "'JetBrains Mono', monospace",
} as const;

export const typography = {
  ratingDisplay:  { family: 'display', size: '64px', weight: 700, lineHeight: 1.1,  letterSpacing: '-1px'   },
  displayXl:      { family: 'display', size: '28px', weight: 700, lineHeight: 1.43, letterSpacing: '0'      },
  displayLg:      { family: 'display', size: '22px', weight: 500, lineHeight: 1.18, letterSpacing: '-0.44px'},
  displayMd:      { family: 'display', size: '21px', weight: 700, lineHeight: 1.43, letterSpacing: '0'      },
  displaySm:      { family: 'display', size: '20px', weight: 600, lineHeight: 1.20, letterSpacing: '-0.18px'},
  titleMd:        { family: 'display', size: '16px', weight: 600, lineHeight: 1.25, letterSpacing: '0'      },
  titleSm:        { family: 'display', size: '16px', weight: 500, lineHeight: 1.25, letterSpacing: '0'      },
  bodyMd:         { family: 'body',    size: '16px', weight: 400, lineHeight: 1.5,  letterSpacing: '0'      },
  bodySm:         { family: 'body',    size: '14px', weight: 400, lineHeight: 1.43, letterSpacing: '0'      },
  caption:        { family: 'body',    size: '14px', weight: 500, lineHeight: 1.29, letterSpacing: '0'      },
  captionSm:      { family: 'body',    size: '13px', weight: 400, lineHeight: 1.23, letterSpacing: '0'      },
  badge:          { family: 'body',    size: '11px', weight: 600, lineHeight: 1.18, letterSpacing: '0'      },
  microLabel:     { family: 'body',    size: '12px', weight: 700, lineHeight: 1.33, letterSpacing: '0'      },
  uppercaseTag:   { family: 'body',    size: '8px',  weight: 700, lineHeight: 1.25, letterSpacing: '0.32px' },
  buttonMd:       { family: 'body',    size: '16px', weight: 500, lineHeight: 1.25, letterSpacing: '0'      },
  buttonSm:       { family: 'body',    size: '14px', weight: 500, lineHeight: 1.29, letterSpacing: '0'      },
  link:           { family: 'body',    size: '14px', weight: 400, lineHeight: 1.43, letterSpacing: '0'      },
  navLink:        { family: 'body',    size: '16px', weight: 600, lineHeight: 1.25, letterSpacing: '0'      },
} as const;

// ─── Breakpoints ────────────────────────────────────────────────

export const breakpoints = {
  mobile: '480px',
  tablet: '768px',
  desktop: '1024px',
  wide: '1280px',
  maxContent: '1280px',
  maxDetail: '1080px',
} as const;

// ─── Sizing Reference ───────────────────────────────────────────

export const sizing = {
  navHeight: '80px',
  searchBarHeight: '64px',
  searchOrb: '48px',
  buttonHeight: '48px',
  datePickerCell: '40px',
  iconButtonSm: '32px',
  iconButtonMd: '40px',
  inputHeight: '56px',
  minTouchTarget: '44px',
} as const;

// ─── Status Config Maps ────────────────────────────────────────

export const TABLE_STATUS_CONFIG = {
  available: {
    label: 'Available',
    color: colors.successText,
    bg: colors.successBg,
    border: colors.successBorder,
  },
  occupied: {
    label: 'Occupied',
    color: colors.infoText,
    bg: colors.infoBg,
    border: colors.infoBorder,
  },
  kot_pending: {
    label: 'KOT Pending',
    color: colors.warningText,
    bg: colors.warningBg,
    border: colors.warningBorder,
  },
  ready_billed: {
    label: 'Ready / Billed',
    color: colors.primary,
    bg: colors.primaryBg,
    border: colors.primary,
  },
} as const;

export const ORDER_STATUS_CONFIG = {
  pending: { label: 'Pending', color: colors.warningText, bg: colors.warningBg },
  preparing: { label: 'Preparing', color: colors.infoText, bg: colors.infoBg },
  ready: { label: 'Ready', color: colors.successText, bg: colors.successBg },
  served: { label: 'Served', color: colors.muted, bg: colors.surfaceSoft },
  billed: { label: 'Billed', color: colors.plus, bg: colors.surfaceStrong },
  cancelled: { label: 'Cancelled', color: colors.errorText, bg: colors.errorBg },
} as const;

// ─── CSS Generator ──────────────────────────────────────────────
// Generates CSS custom properties string from tokens.
// Used by build scripts or can be pasted into globals.css.

export function generateCSSTokens(): string {
  return `:root {
  /* Brand & Accent */
  --color-primary: ${colors.primary};
  --color-primary-active: ${colors.primaryActive};
  --color-primary-disabled: ${colors.primaryDisabled};
  --color-luxe: ${colors.luxe};
  --color-plus: ${colors.plus};

  /* Text */
  --ink: ${colors.ink};
  --body: ${colors.body};
  --muted: ${colors.muted};
  --muted-soft: ${colors.mutedSoft};
  --on-primary: ${colors.onPrimary};
  --on-dark: ${colors.onDark};
  --star-rating: ${colors.starRating};
  --legal-link: ${colors.legalLink};

  /* Surfaces */
  --canvas: ${colors.canvas};
  --surface-soft: ${colors.surfaceSoft};
  --surface-card: ${colors.surfaceCard};
  --surface-strong: ${colors.surfaceStrong};

  /* Hairlines & Borders */
  --hairline: ${colors.hairline};
  --hairline-soft: ${colors.hairlineSoft};
  --border-strong: ${colors.borderStrong};

  /* Semantic — Error */
  --error-text: ${colors.errorText};
  --error-text-hover: ${colors.errorTextHover};
  --error-bg: ${colors.errorBg};
  --error-border: ${colors.errorBorder};

  /* Semantic — Success */
  --success-text: ${colors.successText};
  --success-bg: ${colors.successBg};
  --success-border: ${colors.successBorder};

  /* Semantic — Warning */
  --warning-text: ${colors.warningText};
  --warning-bg: ${colors.warningBg};
  --warning-border: ${colors.warningBorder};

  /* Semantic — Info */
  --info-text: ${colors.infoText};
  --info-bg: ${colors.infoBg};
  --info-border: ${colors.infoBorder};

  /* Semantic — Primary tint */
  --primary-bg: ${colors.primaryBg};

  /* Scrim */
  --scrim: ${colors.scrim};

  /* Spacing */
  --space-xxs: ${spacing.xxs};
  --space-xs: ${spacing.xs};
  --space-sm: ${spacing.sm};
  --space-md: ${spacing.md};
  --space-base: ${spacing.base};
  --space-lg: ${spacing.lg};
  --space-xl: ${spacing.xl};
  --space-xxl: ${spacing.xxl};
  --space-section: ${spacing.section};

  /* Border Radius */
  --rounded-none: ${radii.none};
  --rounded-xs: ${radii.xs};
  --rounded-sm: ${radii.sm};
  --rounded-md: ${radii.md};
  --rounded-lg: ${radii.lg};
  --rounded-xl: ${radii.xl};
  --rounded-full: ${radii.full};

  /* Elevation */
  --shadow-flat: ${shadows.flat};
  --shadow-card: ${shadows.card};

  /* Breakpoints (for reference — use in @media queries) */
  --bp-mobile: ${breakpoints.mobile};
  --bp-tablet: ${breakpoints.tablet};
  --bp-desktop: ${breakpoints.desktop};
  --bp-wide: ${breakpoints.wide};
}`;
}
