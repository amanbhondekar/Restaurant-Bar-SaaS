# Stitch Redesign — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retarget the Kullina design tokens, fonts, glass/elevation styles and a shared Framer Motion module to the Stitch "Luminous Culinary OS" look, with no visible breakage and `#ff5722` unchanged everywhere.

**Architecture:** Existing token *names* are kept; only their *values* change, so every current surface inherits the new palette without edits. New tokens (`--color-primary-ink`, glass, glow, CTA shadow) and a new pure-logic `src/motion/` module are added for later surface plans. Behavior is guarded by `node --test` suites over the CSS/TS token files and the motion presets, because the repo has no UI test runner.

**Tech Stack:** Vite 6, React 19, Tailwind v4, `framer-motion` 13.1, `@fontsource-variable/*`, `node --test` (Node 25).

**Spec:** `docs/superpowers/specs/2026-10-02-stitch-redesign-design.md` (section 1 + section 3). Later plans (separate files, one per surface): Dashboard, Waiter, KDS, Menu.

## Global Constraints

- Primary color is `#ff5722` in **light, dark, OS-dark (`prefers-color-scheme`) and shadcn `--primary`/`--ring`**. The old dark value `#ff7043` is removed.
- Fonts: Syne (display) + Plus Jakarta Sans (body/labels), self-hosted via `@fontsource-variable/*`. **No CDN.** JetBrains Mono stays as is. Cabinet Grotesk / Instrument Sans are removed only once nothing references them (Task 6).
- Untouched: `hub_server/`, `src/context/PosContext.jsx`, `src/services/*`, `public/sw.js`, `public/manifest.json`.
- Motion rules: respect `prefers-reduced-motion`; animate only `transform`/`opacity`; tween durations 150–350 ms.
- Text contrast >= 4.5:1 for ink/body/muted/primary-ink on canvas and card surfaces, light and dark.
- Never stage `hub_server/data/*.json` (runtime data with the user's uncommitted changes). Always `git add` explicit paths.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Per `.agents/rules/darshil_documentation_rule.md`, Task 6 adds a report in `Darshil_docs/reports/` and updates `Darshil_docs/README.md`.
- Shell is Git Bash on Windows; run commands from `D:/project/SAAS RESTRO`. CSS files may have CRLF line endings, so tests must not depend on `\n`.

## File Structure

| File | Responsibility |
|---|---|
| `design-system/test/tokens.test.mjs` (create) | Guards token invariants: primary, dark-theme sync, fonts, contrast, glass tokens, shadcn/TS parity |
| `design-system/css/tokens.css` (modify) | Light + both dark blocks: values, `--color-primary-ink`, glass/glow/shadow tokens, radii, fonts |
| `design-system/css/typography.css` (modify) | Add `.type-label-caps` |
| `design-system/css/components.css` (modify) | Append `.glass`, `.glass-soft`, `.glass-float`, `.ambient-glow` |
| `design-system/ts/tokens.ts` (modify) | Keep TS mirror in sync (colors, radii, shadows, fonts) |
| `design-system/README.md` (modify) | Document new tokens/fonts |
| `src/index.css` (modify) | Font imports, `@theme` fonts, shadcn variable mapping |
| `src/motion/presets.js` (create) | Pure presets: springs, durations, variants, `reduceVariants`, count helpers |
| `src/motion/presets.test.mjs` (create) | Unit tests for presets |
| `src/motion/useMotionPresets.js` (create) | Hook returning reduced-motion-aware presets |
| `src/motion/CountUp.jsx` (create) | Animated number component |
| `src/motion/CountUp.test.mjs` (create) | Renders `CountUp` through Vite SSR |
| `src/motion/index.js` (create) | Barrel export |
| `package.json` (modify) | Font deps; `test` script includes new suites |
| `.claude/launch.json` (create, Task 6) | Dev server config for browser verification |

---

### Task 1: Self-hosted Stitch fonts + token test harness

**Files:**
- Create: `design-system/test/tokens.test.mjs`
- Modify: `package.json` (deps, `test` script)
- Modify: `src/index.css` (imports, remove Cabinet/Instrument `@font-face`, `@theme` fonts)
- Modify: `design-system/css/tokens.css` (`--font-display`, `--font-body`)
- Modify: `design-system/ts/tokens.ts` (`fonts`)

**Interfaces:**
- Produces: `tokens.test.mjs` helpers `read`, `stripComments`, `blockBody(css, headerRegex)`, `vars(body)` which Tasks 2–3 extend; font family names `'Syne Variable'` and `'Plus Jakarta Sans Variable'`.

- [ ] **Step 1: Install the font packages**

```bash
cd "D:/project/SAAS RESTRO" && npm install @fontsource-variable/syne @fontsource-variable/plus-jakarta-sans
ls node_modules/@fontsource-variable/syne/*.css node_modules/@fontsource-variable/plus-jakarta-sans/*.css
```
Expected: install succeeds; the `ls` lists `index.css` and `wght.css` for both, and `wght-italic.css` for Plus Jakarta Sans. (If `wght-italic.css` is absent, skip the italic import in Step 5.)

- [ ] **Step 2: Write the failing test harness + font test**

Create `design-system/test/tokens.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const tokensCss = stripComments(read('design-system/css/tokens.css'));
const indexCss = stripComments(read('src/index.css'));
const tokensTs = read('design-system/ts/tokens.ts');

/** Text between the braces of the first block whose header matches `header`. */
function blockBody(css, header) {
  const m = css.match(header);
  assert.ok(m, `block not found: ${header}`);
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated block: ${header}`);
}

/** `--name: value;` declarations of a block body as an object. */
function vars(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const LIGHT = /^:root\s*\{/m;
const DARK = /\.dark,\s*:root\[data-theme="dark"\]\s*\{/;
const OS_DARK_MEDIA = /@media \(prefers-color-scheme: dark\)\s*\{/;
const OS_DARK_ROOT = /:root:not\(\[data-theme="light"\]\):not\(\.light\)\s*\{/;

const light = () => vars(blockBody(tokensCss, LIGHT));
const dark = () => vars(blockBody(tokensCss, DARK));
const osDark = () => vars(blockBody(blockBody(tokensCss, OS_DARK_MEDIA), OS_DARK_ROOT));

test('dark theme blocks (.dark and OS prefers-color-scheme) stay in sync', () => {
  assert.deepEqual(osDark(), dark());
});

test('fonts: Syne display + Plus Jakarta Sans body, self-hosted, no legacy faces', () => {
  assert.match(light()['--font-display'], /^'Syne Variable',/);
  assert.match(light()['--font-body'], /^'Plus Jakarta Sans Variable',/);

  const theme = vars(blockBody(indexCss, /@theme inline\s*\{/));
  assert.match(theme['--font-heading'], /^'Syne Variable',/);
  assert.match(theme['--font-sans'], /^'Plus Jakarta Sans Variable',/);

  assert.match(indexCss, /@import "@fontsource-variable\/syne/);
  assert.match(indexCss, /@import "@fontsource-variable\/plus-jakarta-sans/);
  assert.match(tokensTs, /display:\s*"'Syne Variable', sans-serif"/);
  assert.match(tokensTs, /body:\s*"'Plus Jakarta Sans Variable', sans-serif"/);

  for (const [name, text] of [['tokens.css', tokensCss], ['index.css', indexCss], ['tokens.ts', tokensTs]]) {
    assert.doesNotMatch(text, /Cabinet Grotesk|Instrument Sans/, `${name} still references a legacy font`);
  }
});
```

- [ ] **Step 3: Add the new suites to the `test` script**

In `package.json` replace the `test` script with:

```json
"test": "node --test \"hub_server/test/**/*.test.mjs\" \"design-system/test/**/*.test.mjs\" \"src/motion/**/*.test.mjs\""
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test design-system/test/tokens.test.mjs`
Expected: the dark-sync test PASSES (guard); the fonts test FAILS (`Cabinet Grotesk` still referenced / values don't match).

- [ ] **Step 5: Implement — `src/index.css`**

Add directly after `@import "shadcn/tailwind.css";`:

```css
@import "@fontsource-variable/syne";
@import "@fontsource-variable/plus-jakarta-sans";
@import "@fontsource-variable/plus-jakarta-sans/wght-italic.css";
```

Then delete the three `@font-face` blocks for `'Cabinet Grotesk'` and the two for `'Instrument Sans'` (the section under the comment `Font Loading (local files only — no CDN)`), and change that comment to `/* ── Font Loading (self-hosted — no CDN) ── */`. Keep every `JetBrains Mono` block.

In the `@theme inline { ... }` block replace the two font lines with:

```css
  --font-sans: 'Plus Jakarta Sans Variable', system-ui, -apple-system, sans-serif;
  --font-heading: 'Syne Variable', system-ui, -apple-system, sans-serif;
```

- [ ] **Step 6: Implement — `design-system/css/tokens.css`**

In the first `:root` block replace the two family lines:

```css
  --font-display: 'Syne Variable', system-ui, -apple-system, sans-serif;
  --font-body: 'Plus Jakarta Sans Variable', system-ui, -apple-system, sans-serif;
```

- [ ] **Step 7: Implement — `design-system/ts/tokens.ts`**

In `export const fonts = { ... }` replace:

```ts
  display: "'Syne Variable', sans-serif",
  body: "'Plus Jakarta Sans Variable', sans-serif",
```

- [ ] **Step 8: Run tests + build**

Run: `node --test design-system/test/tokens.test.mjs`
Expected: 2 tests pass.

Run: `npm run build`
Expected: build succeeds; then `ls dist/assets | grep -i -E "syne|jakarta"` lists `.woff2` files for both families. If the CSS `@import` of a font package fails to resolve, import the same packages as side-effect imports at the top of `src/main.jsx`, `src/waiter_main.jsx`, `src/dashboard_main.jsx`, `src/kitchen_main.jsx` instead (`import '@fontsource-variable/syne';` etc.) and re-run the test with the regex adjusted to match.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/index.css design-system/css/tokens.css design-system/ts/tokens.ts design-system/test/tokens.test.mjs
git commit -m "$(cat <<'EOF'
feat(design-system): self-host Syne + Plus Jakarta Sans, add token tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Stitch palette, glass and elevation tokens

**Files:**
- Modify: `design-system/test/tokens.test.mjs` (append tests)
- Modify: `design-system/css/tokens.css` (light values, radii, shadows, new tokens; **replace both dark blocks**)
- Modify: `src/index.css` (shadcn `:root` and `.dark` variable blocks)
- Modify: `design-system/ts/tokens.ts` (`colors`, `radii`, `shadows`)

**Interfaces:**
- Consumes: Task 1 helpers `read`, `vars`, `blockBody`, `light()`, `dark()`, `LIGHT`, `DARK`, `indexCss`, `tokensTs`.
- Produces: tokens used by later plans and by Task 3's CSS — `--color-primary-ink`, `--glass-bg`, `--glass-bg-soft`, `--glass-blur`, `--glass-border`, `--glow-ambient`, `--shadow-card`, `--shadow-card-float`, `--shadow-cta`.

- [ ] **Step 1: Append the failing tests**

Add to the end of `design-system/test/tokens.test.mjs`:

```js
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('primary stays #ff5722 in every theme, including shadcn variables', () => {
  assert.equal(light()['--color-primary'], '#ff5722');
  assert.equal(dark()['--color-primary'], '#ff5722');
  assert.equal(osDark()['--color-primary'], '#ff5722');
  const shadcnLight = vars(blockBody(indexCss, /^:root\s*\{/m));
  const shadcnDark = vars(blockBody(indexCss, /^\.dark\s*\{/m));
  for (const set of [shadcnLight, shadcnDark]) {
    assert.equal(set['--primary'], '#ff5722');
    assert.equal(set['--ring'], '#ff5722');
  }
});

test('text tokens meet WCAG AA (4.5:1) on every surface, light and dark', () => {
  const text = ['--color-ink', '--color-body', '--color-muted', '--color-primary-ink'];
  const grounds = ['--color-canvas', '--color-surface-card', '--color-surface-soft', '--color-surface-strong'];
  for (const [theme, set] of [['light', light()], ['dark', dark()]]) {
    for (const t of text) for (const g of grounds) {
      const ratio = contrast(set[t], set[g]);
      assert.ok(ratio >= 4.5, `${theme}: ${t} on ${g} is ${ratio.toFixed(2)}:1`);
    }
  }
  // brand fill must stay legible as a UI component on the dark canvas (3:1)
  assert.ok(contrast(dark()['--color-primary'], dark()['--color-canvas']) >= 3);
});

test('glass and elevation tokens exist in both themes', () => {
  const required = ['--glass-bg', '--glass-bg-soft', '--glass-border', '--glow-ambient',
    '--shadow-card', '--shadow-card-float', '--shadow-cta'];
  for (const [theme, set] of [['light', light()], ['dark', dark()]]) {
    for (const key of required) assert.ok(set[key], `${theme} is missing ${key}`);
  }
  assert.ok(light()['--glass-blur'], 'light is missing --glass-blur');
});

test('shadcn variables mirror the design tokens in light and dark', () => {
  const pairs = [['--background', '--color-canvas'], ['--foreground', '--color-ink'],
    ['--card', '--color-surface-card'], ['--border', '--color-hairline'],
    ['--muted-foreground', '--color-muted']];
  const shadcn = { light: vars(blockBody(indexCss, /^:root\s*\{/m)), dark: vars(blockBody(indexCss, /^\.dark\s*\{/m)) };
  const tokens = { light: light(), dark: dark() };
  for (const theme of ['light', 'dark']) {
    for (const [s, t] of pairs) {
      assert.equal(shadcn[theme][s].toLowerCase(), tokens[theme][t].toLowerCase(), `${theme}: ${s} != ${t}`);
    }
  }
});

test('tokens.ts mirrors the light tokens', () => {
  const map = { primary: '--color-primary', primaryInk: '--color-primary-ink', ink: '--color-ink',
    body: '--color-body', muted: '--color-muted', canvas: '--color-canvas',
    surfaceSoft: '--color-surface-soft', surfaceCard: '--color-surface-card',
    surfaceStrong: '--color-surface-strong', hairline: '--color-hairline',
    hairlineSoft: '--color-hairline-soft', borderStrong: '--color-border-strong' };
  for (const [tsKey, cssKey] of Object.entries(map)) {
    const m = tokensTs.match(new RegExp(`^\\s*${tsKey}:\\s*'(#[0-9a-fA-F]{6})'`, 'm'));
    assert.ok(m, `tokens.ts is missing ${tsKey}`);
    assert.equal(m[1].toLowerCase(), light()[cssKey].toLowerCase(), `${tsKey} != ${cssKey}`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test design-system/test/tokens.test.mjs`
Expected: the 4 new tests FAIL (dark primary is `#ff7043`; no `--color-primary-ink`; no glass tokens; shadcn/TS values differ). The two Task 1 tests still pass.

- [ ] **Step 3: Implement — light values in `tokens.css`**

In the first `:root` block make these edits (keep every other line):

```css
  --color-primary-ink: #b02f00;   /* add under --color-plus: orange TEXT/ICON on light surfaces (6.1:1) */

  --color-ink: #141c25;
  --color-body: #4b4644;
  --color-muted: #635d5b;

  --color-canvas: #f7f9ff;
  --color-surface-soft: #edf4ff;
  --color-surface-card: #ffffff;
  --color-surface-strong: #e7eefa;

  --color-hairline: #dbe3ef;
  --color-hairline-soft: #e7eefa;
  --color-border-strong: #c4ceda;

  --radius-md: 16px;
  --radius-lg: 24px;
```

Replace the `--shadow-card` and `--shadow-card-float` lines and add the new tokens after them:

```css
  --shadow-card: 0 1px 2px rgba(20, 28, 37, 0.04), 0 12px 32px rgba(255, 87, 34, 0.08);
  --shadow-card-float: 0 20px 40px -15px rgba(255, 87, 34, 0.18), 0 0 0 1px var(--glass-border);
  --shadow-cta: 0 12px 24px -8px rgba(255, 87, 34, 0.35);

  /* ── Glass surfaces & ambient glow (Stitch) ── */
  --glass-bg: rgba(255, 255, 255, 0.85);
  --glass-bg-soft: rgba(237, 244, 255, 0.8);
  --glass-blur: 20px;
  --glass-border: rgba(48, 56, 65, 0.08);
  --glow-ambient: radial-gradient(circle at center, rgba(255, 87, 34, 0.12), transparent 70%);
```

(`--color-primary` stays `#ff5722`.)

- [ ] **Step 4: Implement — replace BOTH dark blocks in `tokens.css`**

Delete everything from the comment `Dark Theme Overrides` to the end of the file and replace it with the following. The two bodies are intentionally identical (the sync test enforces it):

```css
/* ─── Dark Theme Overrides ─────────────────────────────────────
   Activated by adding `.dark` class to <html> or <body>, or by
   setting data-theme="dark" on :root. The theme toggle button
   in the app manages this. `.dark` wins even when the OS is set
   to light (and vice-versa via `data-theme="light"`).
   Surfaces follow the Stitch KDS ramp (#191f26 → #28323c).
   KEEP THE TWO BLOCKS BELOW IDENTICAL — tokens.test.mjs checks it.
   ─────────────────────────────────────────────────────────────── */

.dark,
:root[data-theme="dark"] {
  /* Brand & accent — primary stays #ff5722 on dark ground (5.2:1 on canvas) */
  --color-primary: #ff5722;
  --color-primary-active: #ffab91;
  --color-primary-disabled: #2a2a2a;
  --color-primary-ink: #ffb5a0;
  --color-luxe: #8ec5c8;
  --color-plus: #f5f5f5;

  /* Text */
  --color-ink: #e9f1fd;
  --color-body: #cdd5e0;
  --color-muted: #9aa5b1;
  --color-muted-soft: #6a6a6a;
  --color-on-primary: #ffffff;
  --color-on-dark: #ffffff;
  --color-star-rating: #f5f5f5;
  --color-legal-link: #6ba3ff;

  /* Surfaces */
  --color-canvas: #191f26;
  --color-surface-soft: #1b2229;
  --color-surface-card: #20272f;
  --color-surface-strong: #28323c;

  /* Hairlines */
  --color-hairline: #35404d;
  --color-hairline-soft: #28323c;
  --color-border-strong: #3e4a57;

  /* Semantic — error / success / warning / info tuned for dark ground */
  --color-error-text: #ff6b52;
  --color-error-text-hover: #ff8571;
  --color-error-bg: #3a1a15;
  --color-error-border: #b32a1e;

  --color-success-text: #4ade80;
  --color-success-bg: #14311e;
  --color-success-border: #1f7a3a;

  --color-warning-text: #f5b74a;
  --color-warning-bg: #3a2a10;
  --color-warning-border: #a06800;

  --color-info-text: #7cb7ff;
  --color-info-bg: #142838;
  --color-info-border: #1a5fc2;

  /* Primary tint on dark ground */
  --color-primary-bg: #3a2018;

  /* Glass & elevation */
  --glass-bg: rgba(32, 39, 47, 0.78);
  --glass-bg-soft: rgba(40, 50, 60, 0.7);
  --glass-border: rgba(255, 255, 255, 0.08);
  --glow-ambient: radial-gradient(circle at center, rgba(255, 87, 34, 0.18), transparent 70%);
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px rgba(255, 87, 34, 0.1);
  --shadow-card-float: 0 20px 40px -15px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--glass-border);
  --shadow-cta: 0 12px 24px -8px rgba(255, 87, 34, 0.45);
}

/* Follow the OS when nothing has been explicitly chosen. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not(.light) {
    /* Brand & accent — primary stays #ff5722 on dark ground (5.2:1 on canvas) */
    --color-primary: #ff5722;
    --color-primary-active: #ffab91;
    --color-primary-disabled: #2a2a2a;
    --color-primary-ink: #ffb5a0;
    --color-luxe: #8ec5c8;
    --color-plus: #f5f5f5;

    /* Text */
    --color-ink: #e9f1fd;
    --color-body: #cdd5e0;
    --color-muted: #9aa5b1;
    --color-muted-soft: #6a6a6a;
    --color-on-primary: #ffffff;
    --color-on-dark: #ffffff;
    --color-star-rating: #f5f5f5;
    --color-legal-link: #6ba3ff;

    /* Surfaces */
    --color-canvas: #191f26;
    --color-surface-soft: #1b2229;
    --color-surface-card: #20272f;
    --color-surface-strong: #28323c;

    /* Hairlines */
    --color-hairline: #35404d;
    --color-hairline-soft: #28323c;
    --color-border-strong: #3e4a57;

    /* Semantic — error / success / warning / info tuned for dark ground */
    --color-error-text: #ff6b52;
    --color-error-text-hover: #ff8571;
    --color-error-bg: #3a1a15;
    --color-error-border: #b32a1e;

    --color-success-text: #4ade80;
    --color-success-bg: #14311e;
    --color-success-border: #1f7a3a;

    --color-warning-text: #f5b74a;
    --color-warning-bg: #3a2a10;
    --color-warning-border: #a06800;

    --color-info-text: #7cb7ff;
    --color-info-bg: #142838;
    --color-info-border: #1a5fc2;

    /* Primary tint on dark ground */
    --color-primary-bg: #3a2018;

    /* Glass & elevation */
    --glass-bg: rgba(32, 39, 47, 0.78);
    --glass-bg-soft: rgba(40, 50, 60, 0.7);
    --glass-border: rgba(255, 255, 255, 0.08);
    --glow-ambient: radial-gradient(circle at center, rgba(255, 87, 34, 0.18), transparent 70%);
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px rgba(255, 87, 34, 0.1);
    --shadow-card-float: 0 20px 40px -15px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--glass-border);
    --shadow-cta: 0 12px 24px -8px rgba(255, 87, 34, 0.45);
  }
}
```

- [ ] **Step 5: Implement — shadcn variables in `src/index.css`**

Replace the `:root { --background: ... }` block (the one holding shadcn variables) with:

```css
:root {
  --background: #f7f9ff;
  --foreground: #141c25;
  --card: #ffffff;
  --card-foreground: #141c25;
  --popover: #ffffff;
  --popover-foreground: #141c25;
  --primary: #ff5722;
  --primary-foreground: #ffffff;
  --secondary: #edf4ff;
  --secondary-foreground: #141c25;
  --muted: #edf4ff;
  --muted-foreground: #635d5b;
  --accent: #fff5f2;
  --accent-foreground: #b02f00;
  --destructive: #c13515;
  --border: #dbe3ef;
  --input: #dbe3ef;
  --ring: #ff5722;
  --chart-1: #ff5722;
  --chart-2: #76abae;
  --chart-3: #303841;
  --chart-4: #1a7a3a;
  --chart-5: #a06800;
  --radius: 1rem;
  --sidebar: #edf4ff;
  --sidebar-foreground: #141c25;
  --sidebar-primary: #ff5722;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #fff5f2;
  --sidebar-accent-foreground: #b02f00;
  --sidebar-border: #dbe3ef;
  --sidebar-ring: #ff5722;
}
```

Replace the `.dark { --background: ... }` block with:

```css
.dark {
  --background: #191f26;
  --foreground: #e9f1fd;
  --card: #20272f;
  --card-foreground: #e9f1fd;
  --popover: #20272f;
  --popover-foreground: #e9f1fd;
  --primary: #ff5722;
  --primary-foreground: #ffffff;
  --secondary: #28323c;
  --secondary-foreground: #e9f1fd;
  --muted: #28323c;
  --muted-foreground: #9aa5b1;
  --accent: #3d2218;
  --accent-foreground: #ffb5a0;
  --destructive: #e5533b;
  --border: #35404d;
  --input: #35404d;
  --ring: #ff5722;
  --chart-1: #ff5722;
  --chart-2: #8ec5c8;
  --chart-3: #5a6a75;
  --chart-4: #2ecc5f;
  --chart-5: #f0a500;
  --sidebar: #1b2229;
  --sidebar-foreground: #e9f1fd;
  --sidebar-primary: #ff5722;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #3d2218;
  --sidebar-accent-foreground: #ffb5a0;
  --sidebar-border: #35404d;
  --sidebar-ring: #ff5722;
}
```

- [ ] **Step 6: Implement — `design-system/ts/tokens.ts`**

In `colors` set: `ink: '#141c25'`, `body: '#4b4644'`, `muted: '#635d5b'`, `canvas: '#f7f9ff'`, `surfaceSoft: '#edf4ff'`, `surfaceCard: '#ffffff'`, `surfaceStrong: '#e7eefa'`, `hairline: '#dbe3ef'`, `hairlineSoft: '#e7eefa'`, `borderStrong: '#c4ceda'`, and add `primaryInk: '#b02f00',` under `plus`. In `radii` set `md: '16px'`, `lg: '24px'`. Replace `shadows.card` and `shadows.cardFloat`:

```ts
  card: '0 1px 2px rgba(20, 28, 37, 0.04), 0 12px 32px rgba(255, 87, 34, 0.08)',
  cardFloat: '0 20px 40px -15px rgba(255, 87, 34, 0.18), 0 0 0 1px rgba(48, 56, 65, 0.08)',
```

- [ ] **Step 7: Run to verify pass**

Run: `node --test design-system/test/tokens.test.mjs`
Expected: all 6 tests pass. If a contrast assertion fails, the message names the token pair and ratio; fix that token value (do not loosen the 4.5 threshold).

- [ ] **Step 8: Build and commit**

Run: `npm run build` — Expected: succeeds.

```bash
git add design-system/css/tokens.css design-system/ts/tokens.ts design-system/test/tokens.test.mjs src/index.css
git commit -m "$(cat <<'EOF'
feat(design-system): Stitch palette, glass and elevation tokens

Primary stays #ff5722 in all themes (dark was #ff7043). Adds
--color-primary-ink for AA-legible orange text, glass/glow/CTA
tokens, and syncs shadcn variables and tokens.ts.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Glass utilities and label-caps type style

**Files:**
- Modify: `design-system/test/tokens.test.mjs` (append test)
- Modify: `design-system/css/components.css` (append section)
- Modify: `design-system/css/typography.css` (append class)
- Modify: `design-system/README.md`

**Interfaces:**
- Consumes: Task 2 tokens `--glass-bg`, `--glass-bg-soft`, `--glass-blur`, `--glass-border`, `--shadow-card`, `--shadow-card-float`, `--glow-ambient`, `--color-surface-card`.
- Produces: classes `.glass`, `.glass-soft`, `.glass-float`, `.ambient-glow`, `.type-label-caps` (alias `.typography-label-caps`).

- [ ] **Step 1: Append the failing test**

```js
test('component CSS exposes glass utilities built only from tokens', () => {
  const components = stripComments(read('design-system/css/components.css'));
  const typography = stripComments(read('design-system/css/typography.css'));
  for (const cls of ['.glass', '.glass-soft', '.glass-float', '.ambient-glow']) {
    assert.ok(components.includes(`${cls} {`) || components.includes(`${cls},`), `missing ${cls}`);
  }
  const glass = blockBody(components, /^\.glass\s*\{/m);
  for (const token of ['--glass-bg', '--glass-blur', '--glass-border', '--shadow-card']) {
    assert.ok(glass.includes(`var(${token})`), `.glass should use ${token}`);
  }
  assert.match(components, /prefers-reduced-transparency/);
  assert.match(components, /@supports not/);
  assert.match(typography, /\.type-label-caps,\s*\.typography-label-caps\s*\{/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test design-system/test/tokens.test.mjs`
Expected: the new test FAILS (`missing .glass`).

- [ ] **Step 3: Append to `design-system/css/components.css`**

```css
/* ═══════════════════════════════════════════════════════════════
   GLASS SURFACES (Stitch "Luminous Culinary OS")
   Use sparingly — app chrome, KPI/hero cards, sheets. backdrop-filter
   is costly on low-end handsets/KDS tablets, so never nest glass or
   put it on long scrolling lists. Falls back to a solid card.
   ═══════════════════════════════════════════════════════════════ */

.glass {
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur));
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-card);
}

.glass-soft {
  background: var(--glass-bg-soft);
  -webkit-backdrop-filter: blur(var(--glass-blur));
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
}

.glass-float {
  box-shadow: var(--shadow-card-float);
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass,
  .glass-soft {
    background: var(--color-surface-card);
  }
}

@media (prefers-reduced-transparency: reduce) {
  .glass,
  .glass-soft {
    background: var(--color-surface-card);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

/* Warm radial glow behind a hero area. Put on a `position: relative`
   container; content above it needs `position: relative; z-index: 1`. */
.ambient-glow {
  position: relative;
  isolation: isolate;
}

.ambient-glow::before {
  content: '';
  position: absolute;
  top: -64px;
  right: 0;
  width: 550px;
  height: 550px;
  border-radius: 50%;
  background: var(--glow-ambient);
  filter: blur(48px);
  pointer-events: none;
  z-index: -1;
}
```

- [ ] **Step 4: Append to `design-system/css/typography.css`**

```css
.type-label-caps,
.typography-label-caps {
  font-family: var(--font-body);
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
```

- [ ] **Step 5: Update `design-system/README.md`**

Add this row to the Colors table: `| \`--color-primary-ink\` | \`#b02f00\` (dark: \`#ffb5a0\`) | Orange text/icons on surfaces — 6:1 contrast; use instead of \`--color-primary\` for small text |`.
Add this section before `## Component Library`:

```markdown
### Typography Families

`--font-display` = Syne Variable · `--font-body` = Plus Jakarta Sans Variable · `--font-mono` = JetBrains Mono. All self-hosted (`@fontsource-variable/*`, no CDN).

### Glass & Glow

`.glass` / `.glass-soft` / `.glass-float` / `.ambient-glow` (tokens: `--glass-bg`, `--glass-bg-soft`, `--glass-blur`, `--glass-border`, `--glow-ambient`, `--shadow-card`, `--shadow-card-float`, `--shadow-cta`). Use on app chrome and hero cards only — never nested, never on long lists. `.type-label-caps` is the 11px tracked uppercase label.
```

- [ ] **Step 6: Run to verify pass, build, commit**

Run: `node --test design-system/test/tokens.test.mjs` — Expected: 7 tests pass.
Run: `npm run build` — Expected: succeeds.

```bash
git add design-system/css/components.css design-system/css/typography.css design-system/README.md design-system/test/tokens.test.mjs
git commit -m "$(cat <<'EOF'
feat(design-system): add glass utilities and label-caps type style

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Motion presets (pure logic)

**Files:**
- Create: `src/motion/presets.js`
- Create: `src/motion/presets.test.mjs`

**Interfaces:**
- Produces (all named exports of `src/motion/presets.js`):
  - `DURATION = { fast: 0.15, base: 0.25, slow: 0.35 }`, `EASE = { out, inOut }` (cubic-bezier arrays)
  - `SPRING = { snappy, gentle, sheet }` (framer-motion spring transitions)
  - variants (states `hidden` / `show` / `exit`): `fadeRise`, `fadeIn`, `scaleIn`, `slideInRight`, `slideUp`, `backdrop`
  - `staggerContainer(gap = 0.06, delay = 0)` → variants `{ hidden, show }`
  - `cardInteraction = { whileHover: { y: -4 }, whileTap: { scale: 0.98 }, transition: SPRING.snappy }`
  - `reduceVariants(variants)` → new variants with movement replaced by a `DURATION.fast` fade and stagger zeroed
  - `motionVariants(variants, reduce: boolean)` → `reduce ? reduceVariants(variants) : variants`
  - `countAt(from, to, progress)` → number (progress clamped to 0..1)
  - `formatCount(value, { decimals = 0, prefix = '', suffix = '', locale = 'en-IN' } = {})` → string

- [ ] **Step 1: Write the failing tests**

Create `src/motion/presets.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from './presets.js';

const VARIANTS = { fadeRise: P.fadeRise, fadeIn: P.fadeIn, scaleIn: P.scaleIn,
  slideInRight: P.slideInRight, slideUp: P.slideUp, backdrop: P.backdrop };
const ALLOWED = new Set(['opacity', 'x', 'y', 'scale', 'transition']);
const MOVEMENT = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate'];

test('variants animate only transform/opacity properties', () => {
  for (const [name, variants] of Object.entries(VARIANTS)) {
    for (const [state, def] of Object.entries(variants)) {
      for (const key of Object.keys(def)) {
        assert.ok(ALLOWED.has(key), `${name}.${state} animates "${key}"`);
      }
    }
  }
});

test('tween durations stay within 150–350 ms', () => {
  for (const [name, variants] of Object.entries(VARIANTS)) {
    for (const [state, def] of Object.entries(variants)) {
      const d = def.transition?.duration;
      if (d !== undefined) assert.ok(d >= 0.15 && d <= 0.35, `${name}.${state} duration ${d}`);
    }
  }
});

test('springs are finite and not wobbly (damping ratio 0.6–1.2)', () => {
  for (const [name, s] of Object.entries(P.SPRING)) {
    assert.equal(s.type, 'spring');
    const ratio = s.damping / (2 * Math.sqrt(s.stiffness * (s.mass ?? 1)));
    assert.ok(ratio >= 0.6 && ratio <= 1.2, `${name} damping ratio ${ratio.toFixed(2)}`);
  }
});

test('every list/sheet variant defines hidden and show; sheets also define exit', () => {
  for (const v of Object.values(VARIANTS)) assert.ok(v.hidden && v.show);
  assert.ok(P.slideInRight.exit && P.slideUp.exit && P.backdrop.exit);
});

test('staggerContainer defaults to 0.06s and honours arguments', () => {
  assert.equal(P.staggerContainer().show.transition.staggerChildren, 0.06);
  const c = P.staggerContainer(0.1, 0.2);
  assert.equal(c.show.transition.staggerChildren, 0.1);
  assert.equal(c.show.transition.delayChildren, 0.2);
});

test('reduceVariants removes all movement and keeps a short fade', () => {
  for (const [name, variants] of Object.entries(VARIANTS)) {
    const reduced = P.reduceVariants(variants);
    for (const [state, def] of Object.entries(reduced)) {
      for (const key of MOVEMENT) assert.ok(!(key in def), `${name}.${state} still has ${key}`);
      assert.equal(def.transition.duration, P.DURATION.fast);
    }
  }
  const sheet = P.reduceVariants(P.slideInRight);
  assert.equal(sheet.hidden.opacity, 0);
  assert.equal(sheet.show.opacity, 1);
  assert.equal(sheet.exit.opacity, 0);
});

test('reduceVariants zeroes stagger so lists appear together', () => {
  const reduced = P.reduceVariants(P.staggerContainer(0.06, 0.2));
  assert.deepEqual(reduced.show.transition, { staggerChildren: 0, delayChildren: 0 });
});

test('motionVariants passes variants through unless reduce is true', () => {
  assert.equal(P.motionVariants(P.fadeRise, false), P.fadeRise);
  assert.deepEqual(P.motionVariants(P.fadeRise, true), P.reduceVariants(P.fadeRise));
});

test('countAt interpolates and clamps progress', () => {
  assert.equal(P.countAt(0, 100, 0.5), 50);
  assert.equal(P.countAt(10, 20, -1), 10);
  assert.equal(P.countAt(10, 20, 2), 20);
  assert.equal(P.countAt(100, 0, 0.25), 75);
});

test('formatCount groups digits, rounds, and adds prefix/suffix', () => {
  assert.equal(P.formatCount(1234567, { locale: 'en-US' }), '1,234,567');
  assert.equal(P.formatCount(1234567), '12,34,567'); // default en-IN lakh grouping
  assert.equal(P.formatCount(98.44, { decimals: 1, suffix: '%' }), '98.4%');
  assert.equal(P.formatCount(5, { decimals: 1 }), '5.0');
  assert.equal(P.formatCount(28420, { prefix: '₹', locale: 'en-US' }), '₹28,420');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/motion/presets.test.mjs`
Expected: FAIL — `Cannot find module './presets.js'`.

- [ ] **Step 3: Implement `src/motion/presets.js`**

```js
// Pure motion presets — deliberately free of React/framer-motion imports so the
// rules below can be unit-tested with `node --test`.
//
// Rules (docs/superpowers/specs/2026-10-02-stitch-redesign-design.md §1):
//   - animate only transform (x, y, scale) and opacity
//   - tween durations 150–350 ms
//   - honour prefers-reduced-motion via reduceVariants / motionVariants

export const DURATION = Object.freeze({ fast: 0.15, base: 0.25, slow: 0.35 });

export const EASE = Object.freeze({
  out: [0.22, 1, 0.36, 1],
  inOut: [0.65, 0, 0.35, 1],
});

export const SPRING = Object.freeze({
  snappy: { type: 'spring', stiffness: 380, damping: 30, mass: 0.8 },
  gentle: { type: 'spring', stiffness: 260, damping: 24 },
  sheet: { type: 'spring', stiffness: 320, damping: 34 },
});

const tween = (duration = DURATION.base, ease = EASE.out) => ({ duration, ease });

export const fadeRise = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: SPRING.gentle },
};

export const fadeIn = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: tween() },
};

export const scaleIn = {
  hidden: { opacity: 0, scale: 0.96 },
  show: { opacity: 1, scale: 1, transition: SPRING.snappy },
};

export const slideInRight = {
  hidden: { x: '100%' },
  show: { x: 0, transition: SPRING.sheet },
  exit: { x: '100%', transition: tween(DURATION.base, EASE.inOut) },
};

export const slideUp = {
  hidden: { y: '100%' },
  show: { y: 0, transition: SPRING.sheet },
  exit: { y: '100%', transition: tween(DURATION.base, EASE.inOut) },
};

export const backdrop = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: tween(DURATION.base) },
  exit: { opacity: 0, transition: tween(DURATION.fast) },
};

export const staggerContainer = (gap = 0.06, delay = 0) => ({
  hidden: {},
  show: { transition: { staggerChildren: gap, delayChildren: delay } },
});

export const cardInteraction = {
  whileHover: { y: -4 },
  whileTap: { scale: 0.98 },
  transition: SPRING.snappy,
};

const MOVEMENT_KEYS = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate']);

/**
 * Replace movement with a short opacity fade (and zero any stagger) for users
 * who prefer reduced motion. States are the convention hidden | show | exit.
 */
export function reduceVariants(variants) {
  const reduced = {};
  for (const [state, def] of Object.entries(variants)) {
    const { transition = {}, ...props } = def;
    const kept = {};
    let hadMovement = false;
    for (const [key, value] of Object.entries(props)) {
      if (MOVEMENT_KEYS.has(key)) hadMovement = true;
      else kept[key] = value;
    }
    if (hadMovement && !('opacity' in kept)) kept.opacity = state === 'show' ? 1 : 0;
    const isStagger = 'staggerChildren' in transition || 'delayChildren' in transition;
    reduced[state] = {
      ...kept,
      transition: isStagger
        ? { staggerChildren: 0, delayChildren: 0 }
        : { duration: DURATION.fast, ease: EASE.out },
    };
  }
  return reduced;
}

export const motionVariants = (variants, reduce) => (reduce ? reduceVariants(variants) : variants);

export function countAt(from, to, progress) {
  const p = Math.min(1, Math.max(0, progress));
  return from + (to - from) * p;
}

export function formatCount(value, { decimals = 0, prefix = '', suffix = '', locale = 'en-IN' } = {}) {
  const number = value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${prefix}${number}${suffix}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/motion/presets.test.mjs`
Expected: 9 tests pass. If the en-IN assertion fails, run `node -e "console.log((1234567).toLocaleString('en-IN'))"` — it must print `12,34,567`; if not, Node lacks full ICU and the default locale test must be dropped (keep `en-US`).

- [ ] **Step 5: Commit**

```bash
git add src/motion/presets.js src/motion/presets.test.mjs
git commit -m "$(cat <<'EOF'
feat(motion): add pure Framer Motion presets with reduced-motion handling

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Motion React layer (`useMotionPresets`, `CountUp`)

**Files:**
- Create: `src/motion/useMotionPresets.js`
- Create: `src/motion/CountUp.jsx`
- Create: `src/motion/index.js`
- Create: `src/motion/CountUp.test.mjs`

**Interfaces:**
- Consumes: everything exported by `presets.js` (Task 4).
- Produces:
  - `useMotionPresets()` → `{ reduce: boolean, fadeRise, fadeIn, scaleIn, slideInRight, slideUp, backdrop, stagger(gap?, delay?), card }` where each variant set is already reduced-motion-aware and `card` is `{}` when `reduce`.
  - `<CountUp value from? duration? decimals? prefix? suffix? locale? className? style? />` — renders the animated number in an `aria-hidden` span plus an `sr-only` span with the final formatted value.
  - `src/motion/index.js` re-exports `* from './presets.js'`, `useMotionPresets`, `CountUp`.

- [ ] **Step 1: Write the failing test**

Create `src/motion/CountUp.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../..', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  plugins: [react()],
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, watch: null },
});
after(() => server.close());

test('CountUp starts from `from` visually and exposes the final value to screen readers', async () => {
  const { CountUp } = await server.ssrLoadModule('/src/motion/index.js');
  const html = renderToString(createElement(CountUp, { value: 98.4, decimals: 1, suffix: '%' }));
  assert.match(html, /<span class="sr-only">98\.4%<\/span>/);
  assert.match(html, /aria-hidden="true"[^>]*>0\.0%<\/span>/);
});

test('motion barrel exports presets and the hook', async () => {
  const m = await server.ssrLoadModule('/src/motion/index.js');
  for (const name of ['fadeRise', 'slideInRight', 'staggerContainer', 'reduceVariants',
    'useMotionPresets', 'CountUp']) {
    assert.ok(name in m, `index.js should export ${name}`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/motion/CountUp.test.mjs`
Expected: FAIL — module `/src/motion/index.js` not found.

- [ ] **Step 3: Implement `src/motion/useMotionPresets.js`**

```js
import { useMemo } from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  backdrop, cardInteraction, fadeIn, fadeRise, motionVariants, scaleIn,
  slideInRight, slideUp, staggerContainer,
} from './presets.js';

/** Presets already adjusted for the user's prefers-reduced-motion setting. */
export function useMotionPresets() {
  const reduce = !!useReducedMotion();
  return useMemo(() => ({
    reduce,
    fadeRise: motionVariants(fadeRise, reduce),
    fadeIn: motionVariants(fadeIn, reduce),
    scaleIn: motionVariants(scaleIn, reduce),
    slideInRight: motionVariants(slideInRight, reduce),
    slideUp: motionVariants(slideUp, reduce),
    backdrop: motionVariants(backdrop, reduce),
    stagger: (gap, delay) => motionVariants(staggerContainer(gap, delay), reduce),
    card: reduce ? {} : cardInteraction,
  }), [reduce]);
}
```

- [ ] **Step 4: Implement `src/motion/CountUp.jsx`**

```jsx
import React, { useEffect, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';
import { EASE, countAt, formatCount } from './presets.js';

/**
 * Animated number. Counts from the previously shown value to `value`
 * (so live KPI updates glide instead of restarting from 0). With reduced
 * motion it jumps straight to the value. Screen readers get the final
 * value only, never the intermediate counts.
 */
export function CountUp({
  value,
  from = 0,
  duration = 0.9,
  decimals = 0,
  prefix = '',
  suffix = '',
  locale = 'en-IN',
  className,
  style,
}) {
  const reduce = !!useReducedMotion();
  const format = { decimals, prefix, suffix, locale };
  const shown = useRef(reduce ? value : from);
  const [text, setText] = useState(() => formatCount(shown.current, format));

  useEffect(() => {
    if (reduce) {
      shown.current = value;
      setText(formatCount(value, { decimals, prefix, suffix, locale }));
      return undefined;
    }
    const start = shown.current;
    const controls = animate(0, 1, {
      duration,
      ease: EASE.out,
      onUpdate: (progress) => {
        shown.current = countAt(start, value, progress);
        setText(formatCount(shown.current, { decimals, prefix, suffix, locale }));
      },
    });
    return () => controls.stop();
  }, [value, reduce, duration, decimals, prefix, suffix, locale]);

  return (
    <>
      <span
        className={className}
        style={{ fontVariantNumeric: 'tabular-nums', ...style }}
        aria-hidden="true"
      >
        {text}
      </span>
      <span className="sr-only">{formatCount(value, format)}</span>
    </>
  );
}
```

- [ ] **Step 5: Implement `src/motion/index.js`**

```js
export * from './presets.js';
export { useMotionPresets } from './useMotionPresets.js';
export { CountUp } from './CountUp.jsx';
```

- [ ] **Step 6: Run to verify pass**

Run: `node --test src/motion/CountUp.test.mjs`
Expected: 2 tests pass (the process exits cleanly — if it hangs, the Vite server was not closed; confirm `after(() => server.close())` is present).

Run: `npm test`
Expected: hub tests, design-system tests and motion tests all pass.

- [ ] **Step 7: Commit**

```bash
git add src/motion/useMotionPresets.js src/motion/CountUp.jsx src/motion/index.js src/motion/CountUp.test.mjs
git commit -m "$(cat <<'EOF'
feat(motion): add useMotionPresets hook and CountUp component

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Remove legacy fonts, verify in browser, document

**Files:**
- Delete (only if the check in Step 1 is clean): `public/fonts/CabinetGrotesk/`, `public/fonts/InstrumentSans/`, `public/fonts/CabinetGrotesk-Variable.{ttf,woff,woff2}`, `public/fonts/InstrumentSans-Variable.ttf`, `public/fonts/InstrumentSans-Italic-Variable.ttf`
- Create: `.claude/launch.json`
- Create: `Darshil_docs/reports/report_2026-10-02_stitch-foundation.md`
- Modify: `Darshil_docs/README.md`

- [ ] **Step 1: Confirm nothing references the legacy fonts**

Use the Grep tool (not a repo-wide shell grep — `node_modules` makes that time out) over `src`, `design-system`, `public/sw.js`, `public/manifest.json`, `*.html` for the pattern `Cabinet|Instrument`.
Expected: matches only inside `design-system/test/tokens.test.mjs` (the "no legacy font" assertion) and `docs/`/`misc/` reference material. Any match in `src/`, `design-system/css|ts`, or `public/` blocks deletion — fix it first.

- [ ] **Step 2: Delete the unused font files**

```bash
git rm -r -q public/fonts/CabinetGrotesk public/fonts/InstrumentSans public/fonts/CabinetGrotesk-Variable.ttf public/fonts/CabinetGrotesk-Variable.woff public/fonts/CabinetGrotesk-Variable.woff2 public/fonts/InstrumentSans-Variable.ttf public/fonts/InstrumentSans-Italic-Variable.ttf
ls public/fonts
```
Expected: only `JetBrainsMono-*.woff2` remain.

- [ ] **Step 3: Full automated verification**

Run: `npm test` — Expected: all suites pass (hub, design-system, motion).
Run: `npm run build` — Expected: succeeds, and `ls dist/assets | grep -i -E "syne|jakarta"` lists woff2 files.

- [ ] **Step 4: Create `.claude/launch.json` and start the dev server**

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "vite-dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 }
  ]
}
```
Start it with `preview_start` (name `vite-dev`).

- [ ] **Step 5: Browser verification (light, dark, three widths)**

For each of `/index.html`, `/waiter.html`, `/dashboard.html`:
1. Open at desktop width, then `resize_window` to tablet (768×1024) and mobile (375×812).
2. Run in the page: `document.fonts.check('16px "Syne Variable"') && document.fonts.check('16px "Plus Jakarta Sans Variable"')` — Expected `true`.
3. Run `getComputedStyle(document.documentElement).getPropertyValue('--color-primary')` — Expected `#ff5722`.
4. Set `localStorage.kullina_theme = 'dark'`, reload, repeat (3) — Expected `#ff5722` — and confirm `--color-canvas` is `#191f26`.
5. Take a screenshot per theme/width; check for clipped or overflowing text (Syne is wider than Cabinet Grotesk), unreadable contrast, and unstyled fallbacks. Read the console — Expected: no errors (a failed `/dashboard-data` fetch on the dashboard without a hub running is acceptable and unrelated).
6. Reset: `localStorage.removeItem('kullina_theme')`, `resize_window` preset `desktop`.

Record any layout regression found; fix it in the owning CSS (tokens/components), not per-screen, and re-run Steps 3 and 5.

- [ ] **Step 6: Write the report and update the index**

Create `Darshil_docs/reports/report_2026-10-02_stitch-foundation.md` following the structure in `.agents/rules/darshil_documentation_rule.md`: ISO timestamp (`date -Iseconds`), the hash of the Task 5 commit (`git log --format=%h -n 1 -- src/motion/CountUp.jsx`), **What Changed** (the files in this plan's File Structure table), **Why** (spec link + the dark-primary `#ff7043`→`#ff5722` decision, the AA `--color-primary-ink` rationale, the dual dark-block sync guard), and **Test Cases** with the real results of Steps 3 and 5 (pre-conditions, steps, expected vs actual, pass/fail). Include one honest note: white text on `#ff5722` is 3.16:1 (brand pairing; AA only for large/bold text) and is intentionally unchanged.
Add a row for the report to the master index table in `Darshil_docs/README.md`.

- [ ] **Step 7: Commit**

```bash
git add .claude/launch.json Darshil_docs/reports/report_2026-10-02_stitch-foundation.md Darshil_docs/README.md
git commit -m "$(cat <<'EOF'
chore(design-system): remove legacy fonts, add foundation report

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
(The `git rm` from Step 2 is already staged and is included in this commit.)

---

## Self-Review Notes

- **Spec coverage (§1 Foundation):** colors + `--color-primary-ink` → Task 2; fonts → Task 1 (+ removal Task 6); glass & depth tokens + radii → Tasks 2–3; motion module (presets, reduced-motion, count-up, `node --test` for pure logic) → Tasks 4–5; SaaS UX baseline (skeletons, empty/error states, 48px targets) is applied per surface in Plans 2–5, not here. §3 verification → Task 6. §4 housekeeping → Task 6. Shared-`layoutId` nav indicator is a per-surface usage of framer-motion's `layoutId` and needs no shared code beyond the presets.
- **Type consistency:** `reduceVariants`, `motionVariants`, `staggerContainer`, `countAt`, `formatCount`, `EASE`, `DURATION`, `SPRING` are defined in Task 4 and used with the same signatures in Task 5.
- **Known limitation, intentionally unchanged:** white-on-`#ff5722` contrast (3.16:1).
