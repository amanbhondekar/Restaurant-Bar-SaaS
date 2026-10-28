# Menu & Tables — Phase 1: Hub Write Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hub validated, revision-guarded, reception-only write routes for the menu (items, categories, CSV-row import) and the table layout (sections, order, rename, seats), with live broadcast and a guard that stops cloud pulls from overwriting hub edits.

**Architecture:** `restaurantCache` stays the read facade and gains one serialised, atomic write path (`updateCatalog`) plus an authority guard keyed on a per-catalog `revision`. Pure modules (`menuNormalize`, `menuAdmin`, `menuImport`, `tablesAdmin`) hold all validation and mutation logic and are unit-tested without I/O; `server.js` only wires routes, the reception guard, body limits and broadcasts. The waiter floor grid stops hardcoding section chips.

**Tech Stack:** Node 20/22 ES modules, Express 5, `node --test`, React 19 (one small waiter change). **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-02-menu-tables-module-design.md` (§1 Hub write layer, §4 Failure handling, §5 Testing). This is Phase 1 of 3; Phase 2 (`/admin` page + import UI) and Phase 3 (cloud write-through) get their own plans.

## Global Constraints

Copied from the spec; every task's requirements include these.

- Limits (editor and importer share them): item name 1–120 chars, category 1–60, variant label ≤ 40, price and variant prices > 0 with at most 2 decimals, at most 2000 rows per import, `station` ∈ `hot | cold | bar`.
- Table rules: names unique case-insensitive; a table with an open bill cannot be renamed or deleted (409 `TABLE_HAS_OPEN_BILL`); moving between sections and changing seats are always allowed; new table ids come from a persisted `next_id` counter that is never reused.
- Authority: each cache file carries an integer `revision` bumped on every local write; while `revision > 0` boot sync, reconnect and realtime events must not overwrite that catalog; every write carries `base_revision` and a stale value returns 409 `STALE_REVISION`.
- Backups: rolling last 10 per catalog in `hub_server/data/backups/`, which must be git-ignored.
- Access: new `requireReception` guard — loopback / trusted local address only; enrolled handsets get 403 `RECEPTION_ONLY`.
- Body limit: the import routes get their own 2 MB JSON parser mounted **ahead of** the global 256 KB parser.
- Errors use the existing `{ success:false, error, code }` shape: `RECEPTION_ONLY` (403), `STALE_REVISION` (409), `TABLE_HAS_OPEN_BILL` (409), `INVALID_ROWS` (400, with row details), oversize bodies 413. Admin writes go to a temp file then rename; the in-memory cache is swapped only after the rename succeeds; failure returns 500 `WRITE_FAILED` and leaves state unchanged. All catalog writes are serialised through one promise chain.
- Live update: after each commit broadcast `menu_updated` / `tables_updated`. `/tables` and `/tables/layout` gain `sections`.
- Fixes included: waiter `FloorGrid` derives section chips from `sections`; the `MASTER_TABLES` fallback in `server.js` applies only to an uninitialised hub.
- Housekeeping: per `.agents/rules/darshil_documentation_rule.md` add a `Darshil_docs/reports/` report and a `Darshil_docs/README.md` index row. Small commits with explicit `git add <path>`; **never `git add -A` and never stage `hub_server/data/*.json`**. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

**Known limitations (intentional, from the spec):** a hub that has never loaded a catalog (offline first boot) refuses edits with 409 `HUB_UNINITIALIZED`; `PUT /admin/menu/items/:id` merges the keys you send and preserves the rest (send `[]` to clear variants/modifier groups/day-parts).

## File Structure

| File | Responsibility |
|---|---|
| `hub_server/lib/menuNormalize.js` (new) | Defensive normalisation of menu data shared by cloud pull, editor and importer. Extracted verbatim from `restaurantCache`. |
| `hub_server/lib/restaurantCache.js` (modify) | Read facade + `updateCatalog` (serialised, atomic, backups, revision check) + authority guard + `revision`/`sections` in getters. |
| `hub_server/lib/menuAdmin.js` (new) | Pure item CRUD + category operations + shared helpers (`norm`, `LIMITS`, …). |
| `hub_server/lib/menuImport.js` (new) | Pure import row parsing, `previewImport`, `applyImport`. |
| `hub_server/lib/tablesAdmin.js` (new) | Pure whole-layout validation/apply with open-bill lock. |
| `hub_server/lib/deviceAuth.js` (modify) | `requireReception` guard. |
| `hub_server/server.js` (modify) | Body-limit mount, `/admin/*` routes, `sections` on `/tables`, `MASTER_TABLES` fix. |
| `src/waiter_mobile/FloorGrid.jsx`, `WaiterApp.jsx` (modify) | Dynamic section chips. |
| `hub_server/test/*.test.mjs`, `hub_server/test/helpers/spawnHub.mjs` (new) | Unit + integration tests. |
| `.gitignore` (modify) | Ignore `hub_server/data/backups/`. |
| `Darshil_docs/…`, spec (modify) | Report, README row, spec route-table patch. |

Run a single test file with `node --test hub_server/test/<file>`; the full suite with `npm test`.

---

### Task 1: Extract the shared menu normaliser

**Files:**
- Create: `hub_server/lib/menuNormalize.js`
- Create: `hub_server/test/menuNormalize.test.mjs`
- Modify: `hub_server/lib/restaurantCache.js` (import + replace the inline item mapper)

**Interfaces:**
- Produces (`menuNormalize.js`): `normalizeVariants(raw) → Variant[]`, `normalizeModifierGroups(raw) → Group[]`, `normalizeDayParts(raw) → DayPart[]`, `normalizeStation(raw) → string|undefined`, `normalizeCloudMenuItem(row) → MenuItem` (cache shape: `{ id, name, price, category, isVeg, available, variants?, modifier_groups?, day_parts?, station? }`). Behaviour is byte-for-byte the current inline logic.

- [ ] **Step 0: Record the baseline**

Run: `npm test`
Expected: all existing tests pass. Note the pass count (the last report says 112). If anything already fails, stop and tell the user before changing code.

- [ ] **Step 1: Write the golden test (pins today's behaviour)**

Create `hub_server/test/menuNormalize.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCloudMenuItem, normalizeStation } from '../lib/menuNormalize.js';

const LONG = 'Half-with-a-really-long-label-that-exceeds-forty-chars';

const FULL_ROW = {
  id: 'abc', name: 'Test Dish', price: '250.5', category_name: 'Mains', is_veg: false, available: false,
  variants: [
    { id: 'v1', label: LONG, price: '100' },
    { id: 'v2', label: 'No price', price: 'abc' },
    { label: 'No id', price: 5 },
    { id: 'v3', label: 'Full', price: 200, available: false }
  ],
  modifier_groups: [
    { id: 'g1', label: 'Spice', min: '1', max: '1', options: [
      { id: 'o1', label: 'Mild', price_delta: 0 },
      { id: 'o2', label: 'Bad', price_delta: 'x' },
      { id: 'o3', label: 'Hot', price_delta: '10', available: false }
    ] },
    { id: 'g2', label: 'Empty', options: [{ id: 'x', label: 'x', price_delta: 'nope' }] },
    { label: 'No id', options: [] }
  ],
  day_parts: [
    { id: 'dp1', label: 'Lunch', starts_at: '11:00', ends_at: '15:00', days: [1, 2, '3', 9, -1, 1.5], price: 180 },
    { id: 'dp2', label: 'Bad time', starts_at: '25:00', ends_at: '15:00', price: 1 },
    { id: 'dp3', label: 'No price', starts_at: '11:00', ends_at: '12:00' },
    { id: 'dp4', label: 'Per variant', starts_at: '18:00', ends_at: '20:00', variant_prices: { v1: 90, v3: '-5', v9: 'x' } }
  ],
  station: 'BAR'
};

test('normalizeCloudMenuItem keeps valid nested data and drops malformed entries', () => {
  assert.deepEqual(normalizeCloudMenuItem(FULL_ROW), {
    id: 'abc', name: 'Test Dish', price: 250.5, category: 'Mains', isVeg: false, available: false,
    variants: [
      { id: 'v1', label: LONG.slice(0, 40), price: 100, available: true },
      { id: 'v3', label: 'Full', price: 200, available: false }
    ],
    modifier_groups: [
      { id: 'g1', label: 'Spice', min: 1, max: 1, options: [
        { id: 'o1', label: 'Mild', price_delta: 0, available: true },
        { id: 'o3', label: 'Hot', price_delta: 10, available: false }
      ] }
    ],
    day_parts: [
      { id: 'dp1', label: 'Lunch', starts_at: '11:00', ends_at: '15:00', days: [1, 2, 3], price: 180 },
      { id: 'dp4', label: 'Per variant', starts_at: '18:00', ends_at: '20:00', variant_prices: { v1: 90 } }
    ],
    station: 'bar'
  });
});

test('normalizeCloudMenuItem applies the legacy defaults and adds no optional keys', () => {
  assert.deepEqual(normalizeCloudMenuItem({ id: 'm', name: 'Plain', price: 90 }), {
    id: 'm', name: 'Plain', price: 90, category: 'General', isVeg: true, available: true
  });
});

test('normalizeCloudMenuItem accepts camelCase rows and coerces a bad price to 0', () => {
  assert.deepEqual(normalizeCloudMenuItem({ id: 'm', name: 'X', price: 'abc', category: 'Starters', isVeg: false }), {
    id: 'm', name: 'X', price: 0, category: 'Starters', isVeg: false, available: true
  });
});

test('normalizeStation lowercases and leaves blanks undefined', () => {
  assert.equal(normalizeStation('COLD'), 'cold');
  assert.equal(normalizeStation(''), undefined);
  assert.equal(normalizeStation(undefined), undefined);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test hub_server/test/menuNormalize.test.mjs`
Expected: FAIL — `Cannot find module '../lib/menuNormalize.js'`.

- [ ] **Step 3: Create the module (verbatim move of the existing logic)**

Create `hub_server/lib/menuNormalize.js`:

```js
// Shared defensive normalisation for menu data. Everything that can put a menu
// item into the hub (cloud pull, editor routes, CSV importer) goes through here
// so a malformed row can never reach lib/pricing.js.

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// Variants ship as JSONB (`variants: [{ id, label, price }]`). Entries without a
// usable id/label/numeric price are dropped. Per-variant availability (M2 · PR 14):
// only an explicit `false` marks a variant 86'd.
export function normalizeVariants(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter(v => v && v.id && v.label && Number.isFinite(Number(v.price)))
    .map(v => ({
      id: String(v.id),
      label: String(v.label).slice(0, 40),
      price: Number(v.price),
      available: v.available !== false
    }));
}

// Modifier groups ship as JSONB (`[{ id, label, min, max, options: [{ id, label,
// price_delta }] }]`). An option missing a numeric price_delta is dropped, a group
// missing an id or label is dropped, and a group is only kept when it has at least
// one valid option.
export function normalizeModifierGroups(raw) {
  const rawGroups = Array.isArray(raw) ? raw : [];
  return rawGroups
    .map(g => {
      if (!g || !g.id || !g.label) return null;
      const options = (Array.isArray(g.options) ? g.options : [])
        .filter(o => o && o.id && o.label && Number.isFinite(Number(o.price_delta)))
        .map(o => ({
          id: String(o.id),
          label: String(o.label).slice(0, 40),
          price_delta: Number(o.price_delta),
          available: o.available !== false
        }));
      if (options.length === 0) return null;
      const min = Number.isFinite(Number(g.min)) ? Math.max(0, Math.floor(Number(g.min))) : 0;
      const max = Number.isFinite(Number(g.max)) ? Math.max(min, Math.floor(Number(g.max))) : options.length;
      return { id: String(g.id), label: String(g.label).slice(0, 40), min, max, options };
    })
    .filter(Boolean);
}

// Day-parts ship as JSONB (`[{ id, label, starts_at, ends_at, days?, price?,
// variant_prices? }]`). A window without a valid HH:MM range, or with neither
// `price` nor `variant_prices`, is dropped so lib/dayParts.js never has to guard.
export function normalizeDayParts(raw) {
  const rawDayParts = Array.isArray(raw) ? raw : [];
  return rawDayParts
    .map(dp => {
      if (!dp || !dp.id || !dp.label) return null;
      if (!HHMM.test(String(dp.starts_at)) || !HHMM.test(String(dp.ends_at))) return null;
      const out = {
        id: String(dp.id),
        label: String(dp.label).slice(0, 40),
        starts_at: String(dp.starts_at),
        ends_at: String(dp.ends_at)
      };
      if (Array.isArray(dp.days) && dp.days.length > 0) {
        out.days = dp.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
      }
      if (Number.isFinite(Number(dp.price)) && Number(dp.price) >= 0) {
        out.price = Number(dp.price);
      }
      if (dp.variant_prices && typeof dp.variant_prices === 'object') {
        const vp = {};
        for (const [k, v] of Object.entries(dp.variant_prices)) {
          if (Number.isFinite(Number(v)) && Number(v) >= 0) vp[String(k)] = Number(v);
        }
        if (Object.keys(vp).length > 0) out.variant_prices = vp;
      }
      if (out.price === undefined && !out.variant_prices) return null;
      return out;
    })
    .filter(Boolean);
}

// Station routing (M2 · PR 15): lowercased here, whitelisted at read time in
// lib/kotRouting.js so a mistagged row still fires to the main kitchen.
export function normalizeStation(raw) {
  return raw ? String(raw).toLowerCase() : undefined;
}

// Maps a Supabase `menu_items` row (or an already cache-shaped row) to the hub's
// cache shape.
export function normalizeCloudMenuItem(i) {
  const variants = normalizeVariants(i.variants);
  const modifier_groups = normalizeModifierGroups(i.modifier_groups);
  const day_parts = normalizeDayParts(i.day_parts);
  const station = normalizeStation(i.station);
  return {
    id: i.id,
    name: i.name,
    price: Number(i.price) || 0,
    category: i.category || i.category_name || 'General',
    isVeg: i.is_veg !== undefined ? Boolean(i.is_veg) : Boolean(i.isVeg ?? true),
    available: i.available !== undefined ? Boolean(i.available) : true,
    ...(variants.length > 0 ? { variants } : {}),
    ...(modifier_groups.length > 0 ? { modifier_groups } : {}),
    ...(day_parts.length > 0 ? { day_parts } : {}),
    ...(station ? { station } : {})
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test hub_server/test/menuNormalize.test.mjs`
Expected: 4 tests PASS.

- [ ] **Step 5: Make `restaurantCache` use it**

In `hub_server/lib/restaurantCache.js` add to the imports (directly after the `supabaseClient.js` import at the top of the file):

```js
import { normalizeCloudMenuItem } from './menuNormalize.js';
```

Then in `fetchMenuFromSupabase`, replace the whole `let items = (itemData && itemData.length) ? itemData.map(i => { … }) : [];` statement — it starts at `let items = (itemData && itemData.length) ? itemData.map(i => {` (line 228) and ends with the `}) : [];` that follows the `return { id: i.id, … ...(station ? { station } : {}) };` block (line 320) — with exactly:

```js
      let items = (itemData && itemData.length) ? itemData.map(normalizeCloudMenuItem) : [];
```

Leave the `let categories = …` line above it and the "Fallback to default seed" block below it untouched.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: same pass count as the Step 0 baseline plus 4 new tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add hub_server/lib/menuNormalize.js hub_server/test/menuNormalize.test.mjs hub_server/lib/restaurantCache.js
git commit -m "refactor(hub): extract menu normaliser into lib/menuNormalize.js

Verbatim move with golden tests so the cloud pull, editor and importer
share one defensive path.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Authority layer in `restaurantCache`

**Files:**
- Modify: `hub_server/lib/restaurantCache.js`
- Create: `hub_server/test/catalogStore.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: none from earlier tasks (only the file already modified in Task 1).
- Produces (on the `restaurantCache` singleton):
  - `getMenuCache(restaurantId?)` / `getTablesCache(restaurantId?)` now always include `revision` (integer, `0` for legacy files); tables also include `sections: string[]` (stored list, else distinct sections in first-seen order). Uninitialised results include `revision: 0` (and `sections: []`).
  - `updateCatalog(kind: 'menu'|'tables', baseRevision: number, mutator) → Promise<Result>` where `mutator(currentCopy) → { ok:true, data, meta? } | { ok:false, status, code, error, errors?, details? }` and `Result` is `{ ok:true, data, meta? }` or the failure object. Built-in failures: `{ status:409, code:'HUB_UNINITIALIZED' }`, `{ status:400, code:'BASE_REVISION_REQUIRED' }`, `{ status:409, code:'STALE_REVISION', current_revision }`, `{ status:500, code:'WRITE_FAILED' }`.
  - `isHubAuthoritative(kind) → boolean` (`revision > 0`).

- [ ] **Step 1: Write the failing tests**

Create `hub_server/test/catalogStore.test.mjs`:

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RID = '11111111-1111-1111-1111-111111111111';
let dir;
let cache;

const MENU = () => ({
  restaurant_id: RID, categories: ['Starters'], uninitialized: false,
  items: [{ id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true }]
});
const TABLES = () => ({
  restaurant_id: RID, count: 2, uninitialized: false,
  tables: [
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 4 },
    { id: 2, name: 'T2', section: 'AC Room', capacity: 4 }
  ]
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  process.env.HUB_DATA_DIR = dir;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  ({ restaurantCache: cache } = await import('../lib/restaurantCache.js'));
});

after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function reset() {
  fs.rmSync(path.join(dir, 'backups'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'menu_cache.json'), JSON.stringify(MENU()));
  fs.writeFileSync(path.join(dir, 'tables_cache.json'), JSON.stringify(TABLES()));
  cache.isUninitialized = false;
  cache.loadFromDisk();
}
const readJson = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
const addDish = name => menu => ({
  ok: true,
  data: { ...menu, items: [...menu.items, { id: `x_${name}`, name, price: 1, category: 'Starters', isVeg: true, available: true }] }
});

test('legacy caches report revision 0 and derive sections in first-seen order', () => {
  reset();
  assert.equal(cache.getMenuCache().revision, 0);
  const t = cache.getTablesCache();
  assert.equal(t.revision, 0);
  assert.deepEqual(t.sections, ['Main Hall', 'AC Room']);
});

test('updateCatalog bumps the revision, persists atomically and keeps a backup', async () => {
  reset();
  const res = await cache.updateCatalog('menu', 0, addDish('Chaas'));
  assert.equal(res.ok, true);
  assert.equal(res.data.revision, 1);

  const onDisk = readJson('menu_cache.json');
  assert.equal(onDisk.revision, 1);
  assert.equal(onDisk.source, 'hub');
  assert.equal(onDisk.items.length, 2);
  assert.equal(fs.existsSync(path.join(dir, 'menu_cache.json.tmp')), false, 'temp file must be renamed away');

  const backups = fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('menu_cache.'));
  assert.equal(backups.length, 1);
  const backup = JSON.parse(fs.readFileSync(path.join(dir, 'backups', backups[0]), 'utf-8'));
  assert.equal(backup.items.length, 1, 'backup holds the pre-edit menu');
  assert.equal(cache.getMenuCache().revision, 1);
});

test('stale or missing base_revision is refused and nothing is written', async () => {
  reset();
  await cache.updateCatalog('menu', 0, addDish('A'));

  const stale = await cache.updateCatalog('menu', 0, addDish('B'));
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'STALE_REVISION');
  assert.equal(stale.current_revision, 1);

  const missing = await cache.updateCatalog('menu', undefined, addDish('C'));
  assert.equal(missing.status, 400);
  assert.equal(missing.code, 'BASE_REVISION_REQUIRED');

  assert.equal(readJson('menu_cache.json').items.length, 2);
});

test('a mutator failure passes through and writes nothing', async () => {
  reset();
  const res = await cache.updateCatalog('menu', 0, () => ({ ok: false, status: 400, code: 'NOPE', error: 'nope' }));
  assert.deepEqual([res.ok, res.status, res.code], [false, 400, 'NOPE']);
  assert.equal(cache.getMenuCache().revision, 0);
  assert.equal(readJson('menu_cache.json').revision, undefined);
});

test('concurrent edits on the same revision serialise: one wins, one gets 409', async () => {
  reset();
  const [a, b] = await Promise.all([
    cache.updateCatalog('menu', 0, addDish('A')),
    cache.updateCatalog('menu', 0, addDish('B'))
  ]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(readJson('menu_cache.json').items.length, 2);
});

test('only the last 10 backups are kept', async () => {
  reset();
  for (let i = 0; i < 13; i++) {
    const r = await cache.updateCatalog('menu', i, addDish(`D${i}`));
    assert.equal(r.ok, true);
  }
  const backups = fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('menu_cache.'));
  assert.equal(backups.length, 10);
});

test('an uninitialised hub refuses edits', async () => {
  reset();
  cache.isUninitialized = true;
  const res = await cache.updateCatalog('menu', 0, addDish('A'));
  assert.equal(res.status, 409);
  assert.equal(res.code, 'HUB_UNINITIALIZED');
  cache.isUninitialized = false;
});

test('once a catalog has been edited, a cloud pull no longer overwrites it', async () => {
  reset();
  await cache.updateCatalog('menu', 0, addDish('Local'));
  let menuPulls = 0;
  let tablePulls = 0;
  cache.fetchMenuFromSupabase = async () => { menuPulls++; return { restaurant_id: RID, categories: [], items: [], uninitialized: false }; };
  cache.fetchTablesFromSupabase = async () => {
    tablePulls++;
    return { ...TABLES(), count: 1, tables: [{ id: 9, name: 'Cloud', section: 'X', capacity: 2 }] };
  };
  cache.subscribeRealtime = () => {};

  await cache.handleReconnection(RID, () => {});

  assert.equal(menuPulls, 0, 'an edited menu must not be pulled');
  assert.equal(tablePulls, 1, 'an untouched catalog still follows the cloud');
  assert.equal(cache.getMenuCache().items.length, 2);
  assert.equal(cache.getTablesCache().tables[0].name, 'Cloud');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test hub_server/test/catalogStore.test.mjs`
Expected: FAIL — `cache.getMenuCache().revision` is `undefined` / `cache.updateCatalog is not a function`.

- [ ] **Step 3: Add constants and the `deriveSections` helper**

In `hub_server/lib/restaurantCache.js`, directly after the `const TABLES_CACHE_FILE = …` line add:

```js
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 10;
const CATALOG_FILES = { menu: MENU_CACHE_FILE, tables: TABLES_CACHE_FILE };

const failure = (status, code, error, extra = {}) => ({ ok: false, status, code, error, ...extra });

// Section order is the order of first appearance when no explicit list is stored
// (legacy caches written by the cloud pull).
function deriveSections(tables) {
  const seen = [];
  for (const t of tables || []) {
    if (t.section && !seen.includes(t.section)) seen.push(t.section);
  }
  return seen;
}
```

- [ ] **Step 4: Add the write chain to the constructor**

Replace the constructor body so it reads:

```js
  constructor() {
    this.menuCache = null;
    this.tablesCache = null;
    this.isUninitialized = false;
    this.realtimeChannel = null;
    this._writeChain = Promise.resolve();
    this._backupSeq = 0;
  }
```

- [ ] **Step 5: Add the authority guard, `updateCatalog`, and backup helper**

Insert these methods into the class directly before `async fetchMenuFromSupabase(restaurantId) {`:

```js
  /**
   * Once a catalog has been edited on the hub (revision > 0) it is authoritative:
   * boot sync, reconnect and realtime events must not overwrite it.
   */
  isHubAuthoritative(kind) {
    const cache = kind === 'menu' ? this.menuCache : this.tablesCache;
    return (cache?.revision || 0) > 0;
  }

  /**
   * The only supported way to change the menu or tables from the hub. Calls are
   * serialised through one promise chain so read-modify-write cannot interleave.
   * `mutator` receives a deep copy of the current catalog and returns
   * `{ ok:true, data, meta? }` or `{ ok:false, status, code, error, … }`.
   */
  updateCatalog(kind, baseRevision, mutator) {
    const run = this._writeChain.then(() => this._applyCatalogUpdate(kind, baseRevision, mutator));
    this._writeChain = run.catch(() => {});
    return run;
  }

  async _applyCatalogUpdate(kind, baseRevision, mutator) {
    const current = kind === 'menu' ? this.getMenuCache() : this.getTablesCache();
    if (current.uninitialized) {
      return failure(409, 'HUB_UNINITIALIZED', 'No catalog yet — connect this hub to the internet once to complete setup.');
    }
    if (!Number.isInteger(baseRevision)) {
      return failure(400, 'BASE_REVISION_REQUIRED', 'base_revision (the revision you loaded) is required.');
    }
    if (baseRevision !== current.revision) {
      return failure(409, 'STALE_REVISION', 'This changed since you loaded it. Reload and try again.', { current_revision: current.revision });
    }

    let result;
    try {
      result = mutator(structuredClone(current));
    } catch (err) {
      return failure(500, 'MUTATION_FAILED', err.message);
    }
    if (!result.ok) return result;

    const next = { ...result.data, revision: current.revision + 1, source: 'hub', uninitialized: false };
    const file = CATALOG_FILES[kind];
    try {
      await this._backupFile(file);
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
      await fs.promises.rename(tmp, file);
    } catch (err) {
      console.error(`❌ Failed to write ${path.basename(file)}:`, err);
      return failure(500, 'WRITE_FAILED', 'Could not save to disk. Nothing was changed.');
    }

    // Swap the in-memory copy only after the file is safely on disk.
    if (kind === 'menu') this.menuCache = next; else this.tablesCache = next;
    return { ok: true, data: next, ...(result.meta ? { meta: result.meta } : {}) };
  }

  async _backupFile(file) {
    if (!fs.existsSync(file)) return;
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const seq = String(++this._backupSeq).padStart(4, '0');
    const prefix = path.basename(file, '.json');
    await fs.promises.copyFile(file, path.join(BACKUP_DIR, `${prefix}.${stamp}-${seq}.json`));

    const mine = (await fs.promises.readdir(BACKUP_DIR)).filter(f => f.startsWith(`${prefix}.`)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) {
      await fs.promises.unlink(path.join(BACKUP_DIR, old));
    }
  }

```

- [ ] **Step 6: Make the cloud pulls respect the guard**

In `initCache`, replace the two lines

```js
      const freshMenu = await this.fetchMenuFromSupabase(restaurantId);
      const freshTables = await this.fetchTablesFromSupabase(restaurantId);
```

(the first pair, inside `if (isOnline) {`) with:

```js
      const freshMenu = this.isHubAuthoritative('menu') ? null : await this.fetchMenuFromSupabase(restaurantId);
      const freshTables = this.isHubAuthoritative('tables') ? null : await this.fetchTablesFromSupabase(restaurantId);
```

In `handleReconnection`, make the identical replacement of its two `fresh…` lines (inside `try {`).

In `subscribeRealtime`, add `if (this.isHubAuthoritative('menu')) return;` as the first statement of both the `menu_items` and `menu_categories` handlers, and `if (this.isHubAuthoritative('tables')) return;` as the first statement of the `tables` handler. For example the menu_items handler becomes:

```js
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items' }, async () => {
          if (this.isHubAuthoritative('menu')) return;
          console.log('🔔 Supabase Realtime: menu_items change detected! Refreshing local cache & broadcasting live...');
```

- [ ] **Step 7: Expose `revision` and `sections` from the getters**

Replace `getMenuCache` and `getTablesCache` with:

```js
  getMenuCache(restaurantId) {
    if (this.isUninitialized || !this.menuCache) {
      return {
        uninitialized: true,
        error: 'NO_CACHE_AND_OFFLINE',
        message: 'No menu data available — connect this hub to the internet once to complete setup.',
        restaurant_id: restaurantId,
        revision: 0,
        categories: [],
        items: []
      };
    }
    return {
      ...this.menuCache,
      revision: this.menuCache.revision || 0,
      uninitialized: false
    };
  }

  getTablesCache(restaurantId) {
    if (this.isUninitialized || !this.tablesCache) {
      return {
        uninitialized: true,
        error: 'NO_CACHE_AND_OFFLINE',
        message: 'No menu data available — connect this hub to the internet once to complete setup.',
        restaurant_id: restaurantId,
        revision: 0,
        count: 0,
        sections: [],
        tables: []
      };
    }
    return {
      ...this.tablesCache,
      revision: this.tablesCache.revision || 0,
      sections: this.tablesCache.sections || deriveSections(this.tablesCache.tables),
      uninitialized: false
    };
  }
```

- [ ] **Step 8: Git-ignore the backups**

Run (appends; does not touch other lines):

```bash
printf '\n# Rolling safety backups the hub writes before every menu/table edit\nhub_server/data/backups/\n' >> .gitignore
```

- [ ] **Step 9: Run the tests**

Run: `node --test hub_server/test/catalogStore.test.mjs`
Expected: 8 tests PASS.

Run: `npm test`
Expected: all green (the existing hub suite still passes — the getters only added fields).

- [ ] **Step 10: Commit**

```bash
git add hub_server/lib/restaurantCache.js hub_server/test/catalogStore.test.mjs .gitignore
git commit -m "feat(hub): revision-guarded atomic catalog writes with backups

restaurantCache.updateCatalog serialises edits, checks base_revision,
writes temp-then-rename with rolling backups, and cloud pulls skip a
catalog once it has been edited on the hub.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Menu item and category operations (`menuAdmin.js`)

**Files:**
- Create: `hub_server/lib/menuAdmin.js`
- Create: `hub_server/test/menuAdmin.test.mjs`

**Interfaces:**
- Consumes: `normalizeVariants`, `normalizeModifierGroups`, `normalizeDayParts` from Task 1.
- Produces (all pure; `menu` is the cache object `{ categories: string[], items: Item[], … }`; every operation returns a mutator-shaped result `{ ok:true, data: nextMenu, meta? }` or `{ ok:false, status, code, error, errors? }` suitable for `restaurantCache.updateCatalog`):
  - helpers: `STATIONS`, `LIMITS`, `norm(s)`, `newItemId()`, `isMoney(n)`, `canonicalCategory(categories, name)`, `sameKey(a, b)`
  - `validateItemInput(input, { partial }) → { ok:true, item } | { ok:false, status:400, code:'INVALID_ITEM', errors:[{field,message}] }`
  - `addItem(menu, input)` → `meta.item`; codes `INVALID_ITEM`, `DUPLICATE_ITEM`(409)
  - `updateItem(menu, id, input)` (merge) → `meta.item`; codes `ITEM_NOT_FOUND`(404), `DUPLICATE_ITEM`
  - `deleteItem(menu, id)` → `meta.deleted`; `ITEM_NOT_FOUND`
  - `addCategory(menu, name)`, `renameCategory(menu, from, to)`, `reorderCategories(menu, names)`, `deleteCategory(menu, name)`; codes `INVALID_CATEGORY`, `CATEGORY_EXISTS`(409), `CATEGORY_NOT_FOUND`(404), `INVALID_ORDER`(400), `CATEGORY_NOT_EMPTY`(409)

- [ ] **Step 1: Write the failing tests**

Create `hub_server/test/menuAdmin.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addItem, updateItem, deleteItem,
  addCategory, renameCategory, reorderCategories, deleteCategory
} from '../lib/menuAdmin.js';

const menu = () => ({
  restaurant_id: 'r', revision: 3,
  categories: ['Starters', 'Mains'],
  items: [
    { id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true },
    {
      id: 'm2', name: 'Dal Tadka', price: 190, category: 'Mains', isVeg: true, available: true,
      variants: [{ id: 'v_half', label: 'Half', price: 120, available: true }],
      modifier_groups: [{ id: 'g1', label: 'Spice', min: 1, max: 1, options: [{ id: 'o1', label: 'Mild', price_delta: 0, available: true }] }]
    }
  ]
});

test('addItem creates an item with a generated id and registers its category', () => {
  const r = addItem(menu(), { name: ' Masala Chaas ', category: 'Beverages', price: 50, isVeg: true, station: 'BAR' });
  assert.equal(r.ok, true);
  assert.match(r.meta.item.id, /^m_[0-9a-f]{8}$/);
  assert.equal(r.meta.item.name, 'Masala Chaas');
  assert.equal(r.meta.item.station, 'bar');
  assert.equal(r.meta.item.available, true);
  assert.deepEqual(r.data.categories, ['Starters', 'Mains', 'Beverages']);
  assert.equal(r.data.items.length, 3);
});

test('addItem reuses the existing spelling of a category', () => {
  const r = addItem(menu(), { name: 'Soup', category: 'starters', price: 80, isVeg: true });
  assert.equal(r.meta.item.category, 'Starters');
  assert.deepEqual(r.data.categories, ['Starters', 'Mains']);
});

test('addItem defaults the price to the first variant when none is given', () => {
  const r = addItem(menu(), {
    name: 'Chai', category: 'Mains', isVeg: true,
    variants: [{ id: 'v_c', label: 'Cutting', price: 20 }, { id: 'v_f', label: 'Full', price: 40 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.meta.item.price, 20);
});

test('addItem requires a price when there are no variants', () => {
  const r = addItem(menu(), { name: 'Chai', category: 'Mains', isVeg: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].field, 'price');
});

test('addItem rejects bad input with field-level errors', () => {
  const r = addItem(menu(), { name: '', category: 'Starters', price: 0, isVeg: 'yes' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'INVALID_ITEM');
  assert.deepEqual(r.errors.map(e => e.field).sort(), ['isVeg', 'name', 'price']);
});

test('addItem rejects prices with more than 2 decimals and unknown stations', () => {
  const r = addItem(menu(), { name: 'X', category: 'Starters', price: 10.555, isVeg: true, station: 'grill' });
  assert.deepEqual(r.errors.map(e => e.field).sort(), ['price', 'station']);
});

test('addItem rejects duplicates (same name + category, case-insensitive)', () => {
  const r = addItem(menu(), { name: 'paneer tikka', category: 'STARTERS', price: 10, isVeg: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'DUPLICATE_ITEM');
});

test('addItem rejects malformed variants, modifier groups and day-parts', () => {
  const base = { name: 'X', category: 'Starters', price: 10, isVeg: true };
  const bad = (extra) => addItem(menu(), { ...base, ...extra });

  assert.equal(bad({ variants: [{ id: 'v', label: 'Half', price: 0 }] }).errors[0].field, 'variants');
  assert.equal(bad({ variants: [{ id: 'v', label: 'A', price: 1 }, { id: 'v', label: 'B', price: 2 }] }).errors[0].field, 'variants');
  assert.equal(bad({ variants: [{ label: 'No id', price: 1 }] }).errors[0].field, 'variants');
  assert.equal(
    bad({ modifier_groups: [{ id: 'g', label: 'Pick', min: 2, max: 2, options: [{ id: 'o', label: 'A', price_delta: 0 }] }] }).errors[0].field,
    'modifier_groups',
    'a minimum above the option count can never be satisfied'
  );
  assert.equal(
    bad({ modifier_groups: [{ id: 'g', label: 'Pick', options: [{ id: 'o', label: 'A', price_delta: 'x' }] }] }).errors[0].field,
    'modifier_groups'
  );
  assert.equal(bad({ day_parts: [{ id: 'd', label: 'Lunch', starts_at: '25:00', ends_at: '15:00', price: 1 }] }).errors[0].field, 'day_parts');
});

test('addItem accepts valid variants, modifier groups and day-parts', () => {
  const r = addItem(menu(), {
    name: 'Biryani', category: 'Mains', isVeg: false, price: 300,
    variants: [{ id: 'v_h', label: 'Half', price: 180 }],
    modifier_groups: [{ id: 'g', label: 'Spice', min: 1, max: 1, options: [{ id: 'o', label: 'Hot', price_delta: 0 }] }],
    day_parts: [{ id: 'd', label: 'Lunch', starts_at: '11:00', ends_at: '15:00', price: 250 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.meta.item.variants[0].available, true);
  assert.equal(r.meta.item.day_parts[0].price, 250);
});

test('updateItem merges only the provided keys', () => {
  const r = updateItem(menu(), 'm2', { price: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.meta.item.price, 200);
  assert.equal(r.meta.item.variants.length, 1, 'variants preserved');
  assert.equal(r.meta.item.modifier_groups.length, 1, 'modifier groups preserved');
});

test('updateItem clears variants / modifier groups when sent an empty array', () => {
  const r = updateItem(menu(), 'm2', { variants: [], modifier_groups: [] });
  assert.equal(r.ok, true);
  assert.equal('variants' in r.meta.item, false);
  assert.equal('modifier_groups' in r.meta.item, false);
});

test('updateItem can 86 an item and move it to another category', () => {
  const r = updateItem(menu(), 'm1', { available: false, category: 'mains' });
  assert.equal(r.meta.item.available, false);
  assert.equal(r.meta.item.category, 'Mains');
});

test('updateItem 404s on an unknown id and blocks renames that collide', () => {
  assert.equal(updateItem(menu(), 'nope', { price: 1 }).code, 'ITEM_NOT_FOUND');
  const clash = updateItem(menu(), 'm1', { name: 'Dal Tadka', category: 'Mains' });
  assert.equal(clash.status, 409);
  assert.equal(clash.code, 'DUPLICATE_ITEM');
});

test('deleteItem removes the item; unknown id 404s', () => {
  const r = deleteItem(menu(), 'm1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.items.map(i => i.id), ['m2']);
  assert.equal(deleteItem(menu(), 'nope').status, 404);
});

test('categories: add, rename (relabels items), reorder, delete-only-when-empty', () => {
  const added = addCategory(menu(), ' Desserts ');
  assert.deepEqual(added.data.categories, ['Starters', 'Mains', 'Desserts']);
  assert.equal(addCategory(menu(), 'starters').code, 'CATEGORY_EXISTS');
  assert.equal(addCategory(menu(), '   ').code, 'INVALID_CATEGORY');

  const renamed = renameCategory(menu(), 'Starters', 'Appetisers');
  assert.deepEqual(renamed.data.categories, ['Appetisers', 'Mains']);
  assert.equal(renamed.data.items.find(i => i.id === 'm1').category, 'Appetisers');
  assert.equal(renameCategory(menu(), 'Starters', 'mains').code, 'CATEGORY_EXISTS');
  assert.equal(renameCategory(menu(), 'Nope', 'X').code, 'CATEGORY_NOT_FOUND');
  assert.equal(renameCategory(menu(), 'Starters', 'starters').ok, true, 'a case-only rename of itself is allowed');

  assert.deepEqual(reorderCategories(menu(), ['Mains', 'Starters']).data.categories, ['Mains', 'Starters']);
  assert.equal(reorderCategories(menu(), ['Mains']).code, 'INVALID_ORDER');
  assert.equal(reorderCategories(menu(), ['Mains', 'Mains']).code, 'INVALID_ORDER');

  assert.equal(deleteCategory(menu(), 'Starters').code, 'CATEGORY_NOT_EMPTY');
  const withEmpty = addCategory(menu(), 'Desserts').data;
  assert.deepEqual(deleteCategory(withEmpty, 'Desserts').data.categories, ['Starters', 'Mains']);
  assert.equal(deleteCategory(menu(), 'Nope').status, 404);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test hub_server/test/menuAdmin.test.mjs`
Expected: FAIL — `Cannot find module '../lib/menuAdmin.js'`.

- [ ] **Step 3: Implement `menuAdmin.js`**

Create `hub_server/lib/menuAdmin.js`:

```js
import crypto from 'crypto';
import { normalizeVariants, normalizeModifierGroups, normalizeDayParts } from './menuNormalize.js';

// Pure menu editing. Nothing here touches disk: every operation takes the current
// menu object and returns { ok:true, data, meta? } or { ok:false, status, code,
// error, errors? }, the shape restaurantCache.updateCatalog expects from a mutator.

export const STATIONS = ['hot', 'cold', 'bar'];
export const LIMITS = { name: 120, category: 60, variantLabel: 40, importRows: 2000 };

export const norm = s => String(s ?? '').trim().toLowerCase();
export const newItemId = () => 'm_' + crypto.randomBytes(4).toString('hex');
export const isMoney = n => typeof n === 'number' && Number.isFinite(n) && n > 0 && Math.round(n * 100) / 100 === n;

export const sameKey = (a, b) => norm(a.name) === norm(b.name) && norm(a.category) === norm(b.category);

/** The spelling a category already has in the menu, else the trimmed input. */
export function canonicalCategory(categories, name) {
  return categories.find(c => norm(c) === norm(name)) ?? String(name).trim();
}

const withCategory = (categories, name) =>
  categories.some(c => norm(c) === norm(name)) ? categories : [...categories, name];

const invalid = (errors, code = 'INVALID_ITEM') => ({ ok: false, status: 400, code, error: errors[0].message, errors });
const notFound = (code, error) => ({ ok: false, status: 404, code, error });
const conflict = (code, error) => ({ ok: false, status: 409, code, error });

/**
 * Strict validation of editor input. Unlike the lenient cloud normaliser (which
 * silently drops bad nested rows), anything malformed is rejected so the user
 * hears about it. With `partial`, only the keys present are checked.
 */
export function validateItemInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid([{ field: 'item', message: 'item must be an object' }]);
  }
  const errors = [];
  const out = {};
  const has = k => input[k] !== undefined;

  if (has('name') || !partial) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > LIMITS.name) errors.push({ field: 'name', message: `name is required (1–${LIMITS.name} characters)` });
    else out.name = name;
  }
  if (has('category') || !partial) {
    const category = typeof input.category === 'string' ? input.category.trim() : '';
    if (!category || category.length > LIMITS.category) errors.push({ field: 'category', message: `category is required (1–${LIMITS.category} characters)` });
    else out.category = category;
  }
  if (has('isVeg') || !partial) {
    if (typeof input.isVeg !== 'boolean') errors.push({ field: 'isVeg', message: 'isVeg must be true or false' });
    else out.isVeg = input.isVeg;
  }
  if (has('available')) {
    if (typeof input.available !== 'boolean') errors.push({ field: 'available', message: 'available must be true or false' });
    else out.available = input.available;
  }
  if (has('station')) {
    const s = String(input.station).toLowerCase();
    if (!STATIONS.includes(s)) errors.push({ field: 'station', message: `station must be one of ${STATIONS.join(', ')}` });
    else out.station = s;
  }
  if (has('price')) {
    const price = typeof input.price === 'string' ? Number(input.price) : input.price;
    if (!isMoney(price)) errors.push({ field: 'price', message: 'price must be a number above 0 with at most 2 decimals' });
    else out.price = price;
  }
  if (has('variants')) {
    const raw = input.variants;
    const clean = Array.isArray(raw) ? normalizeVariants(raw) : null;
    const ok = clean
      && clean.length === raw.length
      && new Set(clean.map(v => v.id)).size === clean.length
      && clean.every(v => isMoney(v.price));
    if (!ok) errors.push({ field: 'variants', message: 'every variant needs a unique id, a label and a price above 0' });
    else out.variants = clean;
  }
  if (has('modifier_groups')) {
    const raw = input.modifier_groups;
    const clean = Array.isArray(raw) ? normalizeModifierGroups(raw) : null;
    const ok = clean
      && clean.length === raw.length
      && new Set(clean.map(g => g.id)).size === clean.length
      && clean.every((g, i) =>
        g.options.length === raw[i].options.length
        && new Set(g.options.map(o => o.id)).size === g.options.length
        && g.min <= g.options.length);
    if (!ok) {
      errors.push({
        field: 'modifier_groups',
        message: 'every group needs a unique id, a label, at least as many options as its minimum, and every option a unique id, a label and a numeric price_delta'
      });
    } else out.modifier_groups = clean;
  }
  if (has('day_parts')) {
    const raw = input.day_parts;
    const clean = Array.isArray(raw) ? normalizeDayParts(raw) : null;
    if (!clean || clean.length !== raw.length || new Set(clean.map(d => d.id)).size !== clean.length) {
      errors.push({ field: 'day_parts', message: 'every day-part needs a unique id, a label, HH:MM start/end times and a price or variant_prices' });
    } else out.day_parts = clean;
  }

  return errors.length ? invalid(errors) : { ok: true, item: out };
}

export function addItem(menu, input) {
  const v = validateItemInput(input);
  if (!v.ok) return v;

  const item = { id: newItemId(), available: true, ...v.item };
  item.category = canonicalCategory(menu.categories, item.category);
  if (item.price === undefined) {
    if (!item.variants?.length) return invalid([{ field: 'price', message: 'price is required when the item has no variants' }]);
    item.price = item.variants[0].price;
  }
  if (menu.items.some(i => sameKey(i, item))) {
    return conflict('DUPLICATE_ITEM', `"${item.name}" already exists in ${item.category}.`);
  }
  return {
    ok: true,
    data: { ...menu, categories: withCategory(menu.categories, item.category), items: [...menu.items, item] },
    meta: { item }
  };
}

const EMPTYABLE = ['variants', 'modifier_groups', 'day_parts'];

/** Merge semantics: keys you omit are preserved; send `[]` to clear variants/groups/day-parts. */
export function updateItem(menu, id, input) {
  const idx = menu.items.findIndex(i => i.id === id);
  if (idx === -1) return notFound('ITEM_NOT_FOUND', `No menu item with id ${id}.`);

  const v = validateItemInput(input, { partial: true });
  if (!v.ok) return v;

  const item = { ...menu.items[idx], ...v.item };
  if (v.item.category) item.category = canonicalCategory(menu.categories, v.item.category);
  for (const k of EMPTYABLE) {
    if (Array.isArray(item[k]) && item[k].length === 0) delete item[k];
  }
  if (menu.items.some((i, n) => n !== idx && sameKey(i, item))) {
    return conflict('DUPLICATE_ITEM', `"${item.name}" already exists in ${item.category}.`);
  }
  return {
    ok: true,
    data: {
      ...menu,
      categories: withCategory(menu.categories, item.category),
      items: menu.items.map((i, n) => (n === idx ? item : i))
    },
    meta: { item }
  };
}

export function deleteItem(menu, id) {
  if (!menu.items.some(i => i.id === id)) return notFound('ITEM_NOT_FOUND', `No menu item with id ${id}.`);
  return { ok: true, data: { ...menu, items: menu.items.filter(i => i.id !== id) }, meta: { deleted: id } };
}

const cleanCategoryName = name => {
  const clean = typeof name === 'string' ? name.trim() : '';
  return clean && clean.length <= LIMITS.category ? clean : null;
};
const badCategoryName = () =>
  invalid([{ field: 'name', message: `category name is required (1–${LIMITS.category} characters)` }], 'INVALID_CATEGORY');

export function addCategory(menu, name) {
  const clean = cleanCategoryName(name);
  if (!clean) return badCategoryName();
  if (menu.categories.some(c => norm(c) === norm(clean))) return conflict('CATEGORY_EXISTS', `Category "${clean}" already exists.`);
  return { ok: true, data: { ...menu, categories: [...menu.categories, clean] }, meta: { name: clean } };
}

export function renameCategory(menu, from, to) {
  const current = menu.categories.find(c => c === from) ?? menu.categories.find(c => norm(c) === norm(from));
  if (!current) return notFound('CATEGORY_NOT_FOUND', `No category named "${from}".`);
  const clean = cleanCategoryName(to);
  if (!clean) return badCategoryName();
  if (menu.categories.some(c => c !== current && norm(c) === norm(clean))) {
    return conflict('CATEGORY_EXISTS', `Category "${clean}" already exists.`);
  }
  return {
    ok: true,
    data: {
      ...menu,
      categories: menu.categories.map(c => (c === current ? clean : c)),
      items: menu.items.map(i => (i.category === current ? { ...i, category: clean } : i))
    },
    meta: { name: clean }
  };
}

export function reorderCategories(menu, names) {
  const ok = Array.isArray(names)
    && names.length === menu.categories.length
    && new Set(names).size === names.length
    && names.every(n => menu.categories.includes(n));
  if (!ok) return invalid([{ field: 'names', message: 'names must list every existing category exactly once' }], 'INVALID_ORDER');
  return { ok: true, data: { ...menu, categories: [...names] } };
}

export function deleteCategory(menu, name) {
  if (!menu.categories.includes(name)) return notFound('CATEGORY_NOT_FOUND', `No category named "${name}".`);
  const count = menu.items.filter(i => i.category === name).length;
  if (count > 0) return conflict('CATEGORY_NOT_EMPTY', `"${name}" still has ${count} item(s). Move or delete them first.`);
  return { ok: true, data: { ...menu, categories: menu.categories.filter(c => c !== name) } };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test hub_server/test/menuAdmin.test.mjs`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hub_server/lib/menuAdmin.js hub_server/test/menuAdmin.test.mjs
git commit -m "feat(hub): pure menu item and category operations

Strict validation with field-level errors, merge-style updates that
preserve variants/modifiers/day-parts, and category rules.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Menu import (`menuImport.js`)

**Files:**
- Create: `hub_server/lib/menuImport.js`
- Create: `hub_server/test/menuImport.test.mjs`

**Interfaces:**
- Consumes (from Task 3 `menuAdmin.js`): `STATIONS`, `LIMITS`, `norm`, `newItemId`, `canonicalCategory`.
- Produces:
  - `previewImport(menu, rows, { mode }) → { ok:true, rows: RowResult[], counts } | { ok:false, status:400, code:'NO_ROWS'|'TOO_MANY_ROWS', error }` where `RowResult = { row:number, status:'new'|'updated'|'unchanged'|'error', name, category, errors:string[], changes:[{field,from,to}], item?, matched_id }` and `counts = { new, updated, unchanged, error, removed }` (`removed` is only non-zero in `replace` mode).
  - `applyImport(menu, rows, { mode, skipInvalid }) → { ok:true, data, meta:{ counts, skipped } } | { ok:false, status:400, code:'INVALID_ROWS', error, details: RowResult[] } | preview failures`.
  - Input rows are plain objects of strings keyed by lower-case column names (`id, name, category, price, veg, available, station, variants`); optional `__row` integer overrides the reported row number (default `index + 2`, i.e. spreadsheet row with header = row 1).

- [ ] **Step 1: Write the failing tests**

Create `hub_server/test/menuImport.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewImport, applyImport } from '../lib/menuImport.js';

const menu = () => ({
  restaurant_id: 'r', revision: 2,
  categories: ['Starters', 'Mains', 'Desserts'],
  items: [
    { id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true },
    {
      id: 'm2', name: 'Dal Tadka', price: 190, category: 'Mains', isVeg: true, available: true,
      variants: [{ id: 'v_half', label: 'Half', price: 120 }, { id: 'v_full', label: 'Full', price: 190, available: false }],
      modifier_groups: [{ id: 'g1', label: 'Spice', min: 1, max: 1, options: [{ id: 'o1', label: 'Mild', price_delta: 0, available: true }] }]
    },
    { id: 'm3', name: 'Gulab Jamun', price: 90, category: 'Desserts', isVeg: true, available: true, station: 'cold' }
  ]
});

test('merge updates a matched item (name + category, case-insensitive) and shows the field diff', () => {
  const p = previewImport(menu(), [{ name: 'paneer tikka', category: 'STARTERS', price: '250' }]);
  assert.equal(p.ok, true);
  assert.equal(p.rows[0].status, 'updated');
  assert.equal(p.rows[0].matched_id, 'm1');
  assert.deepEqual(p.rows[0].changes, [{ field: 'price', from: 230, to: 250 }]);
  assert.deepEqual(p.counts, { new: 0, updated: 1, unchanged: 0, error: 0, removed: 0 });

  const a = applyImport(menu(), [{ name: 'paneer tikka', category: 'STARTERS', price: '250' }]);
  assert.equal(a.data.items.find(i => i.id === 'm1').price, 250);
  assert.equal(a.data.items.length, 3);
});

test('blank cells and absent columns never overwrite; modifiers and variants survive', () => {
  const rows = [{ name: 'Dal Tadka', category: 'Mains', price: '200', veg: '', available: '', station: '' }];
  const p = previewImport(menu(), rows);
  assert.deepEqual(p.rows[0].changes.map(c => c.field), ['price']);
  const item = applyImport(menu(), rows).data.items.find(i => i.id === 'm2');
  assert.equal(item.price, 200);
  assert.equal(item.modifier_groups.length, 1);
  assert.equal(item.variants.length, 2);
});

test('an id that matches takes precedence; an unknown id falls back to name + category', () => {
  const byId = previewImport(menu(), [{ id: 'm3', name: 'Gulab Jamun (2 pcs)', category: 'Desserts' }]);
  assert.equal(byId.rows[0].matched_id, 'm3');
  assert.equal(byId.rows[0].status, 'updated');

  const unknown = previewImport(menu(), [{ id: 'zzz', name: 'Paneer Tikka', category: 'Starters' }]);
  assert.equal(unknown.rows[0].matched_id, 'm1');
});

test('a new item needs veg; the reported row number follows the spreadsheet (header = row 1)', () => {
  const p = previewImport(menu(), [{ name: 'Chaas', category: 'Beverages', price: '50' }]);
  assert.equal(p.rows[0].status, 'error');
  assert.equal(p.rows[0].row, 2);
  assert.ok(p.rows[0].errors.some(e => e.startsWith('veg is required')));

  const hinted = previewImport(menu(), [{ __row: 7, name: 'Chaas', category: 'Beverages', price: '50' }]);
  assert.equal(hinted.rows[0].row, 7);
});

test('a new item gets a generated id (never the supplied unknown one) and a new category', () => {
  const rows = [{ id: 'zzz', name: 'Masala Chaas', category: 'Beverages', price: '50', veg: 'yes', station: 'bar' }];
  const p = previewImport(menu(), rows);
  assert.equal(p.rows[0].status, 'new');
  const a = applyImport(menu(), rows);
  const added = a.data.items.at(-1);
  assert.match(added.id, /^m_[0-9a-f]{8}$/);
  assert.equal(added.station, 'bar');
  assert.equal(added.isVeg, true);
  assert.equal(added.available, true);
  assert.deepEqual(a.data.categories, ['Starters', 'Mains', 'Desserts', 'Beverages']);
});

test('veg accepts yes/no/true/false/1/0/veg/non-veg and rejects anything else', () => {
  const ok = ['yes', 'No', 'TRUE', 'false', '1', '0', 'veg', 'Non-Veg'].map(v => ({ name: `D${v}`, category: 'Starters', price: '10', veg: v }));
  assert.equal(previewImport(menu(), ok).counts.error, 0);
  const bad = previewImport(menu(), [{ name: 'X', category: 'Starters', price: '10', veg: 'maybe' }]);
  assert.ok(bad.rows[0].errors.includes('veg must be yes or no'));
});

test('prices are strict: above 0, at most 2 decimals, digits only', () => {
  const run = price => previewImport(menu(), [{ name: 'X', category: 'Starters', price, veg: 'yes' }]).rows[0].status;
  assert.equal(run('50'), 'new');
  assert.equal(run('50.5'), 'new');
  assert.equal(run('12.345'), 'error');
  assert.equal(run('-5'), 'error');
  assert.equal(run('0'), 'error');
  assert.equal(run('₹50'), 'error');
});

test('variants: matched labels keep id and 86\'d state, new labels get slug ids, omitted labels are removed', () => {
  const rows = [{ name: 'Dal Tadka', category: 'Mains', variants: 'Half:130|Large:260' }];
  const item = applyImport(menu(), rows).data.items.find(i => i.id === 'm2');
  assert.deepEqual(item.variants, [
    { id: 'v_half', label: 'Half', price: 130, available: true },
    { id: 'v_large', label: 'Large', price: 260, available: true }
  ]);

  const same = previewImport(menu(), [{ name: 'Dal Tadka', category: 'Mains', variants: 'Half:120|Full:190' }]);
  assert.equal(same.rows[0].status, 'unchanged', 'identical variants (86\'d Full included) are not a change');
  const kept = applyImport(menu(), [{ name: 'Dal Tadka', category: 'Mains', variants: 'Half:120|Full:190' }]);
  assert.equal(kept.data.items.find(i => i.id === 'm2').variants[1].available, false);
});

test('variants: bad syntax, repeated labels and non-positive prices are errors; slug collisions are suffixed', () => {
  const run = variants => previewImport(menu(), [{ name: 'X', category: 'Starters', veg: 'yes', variants }]).rows[0];
  assert.equal(run('Half-180').status, 'error');
  assert.equal(run('Half:180|half:200').status, 'error');
  assert.equal(run('Half:0').status, 'error');

  const a = applyImport(menu(), [{ name: 'X', category: 'Starters', veg: 'yes', variants: 'Half Plate:100|Half-Plate!:120' }]);
  assert.deepEqual(a.data.items.at(-1).variants.map(v => v.id), ['v_half_plate', 'v_half_plate_2']);
});

test('a new item with variants and no price takes the first variant price', () => {
  const a = applyImport(menu(), [{ name: 'Chai', category: 'Beverages', veg: 'yes', variants: 'Cutting:20|Full:40' }]);
  assert.equal(a.data.items.at(-1).price, 20);
});

test('duplicate rows in one file are flagged on the second occurrence', () => {
  const p = previewImport(menu(), [
    { name: 'Paneer Tikka', category: 'Starters', price: '240' },
    { name: 'paneer tikka', category: 'starters', price: '250' }
  ]);
  assert.equal(p.rows[0].status, 'updated');
  assert.equal(p.rows[1].status, 'error');
  assert.equal(p.rows[1].errors[0], 'duplicate of row 2');
});

test('replace removes unmatched items but keeps non-importable fields on matched ones', () => {
  const rows = [{ name: 'Dal Tadka', category: 'Mains', price: '200' }];
  const p = previewImport(menu(), rows, { mode: 'replace' });
  assert.equal(p.counts.removed, 2);

  const a = applyImport(menu(), rows, { mode: 'replace' });
  assert.deepEqual(a.data.items.map(i => i.id), ['m2']);
  assert.equal(a.data.items[0].modifier_groups.length, 1);
  assert.deepEqual(a.data.categories, ['Mains'], 'categories no longer used are dropped');
});

test('replace never deletes an item whose row had an error', () => {
  const rows = [
    { name: 'Paneer Tikka', category: 'Starters', price: '230' },
    { name: 'Dal Tadka', category: 'Mains', price: 'abc' }
  ];
  const p = previewImport(menu(), rows, { mode: 'replace' });
  assert.equal(p.counts.removed, 1, 'only Gulab Jamun is unmatched');
  const a = applyImport(menu(), rows, { mode: 'replace', skipInvalid: true });
  assert.deepEqual(a.data.items.map(i => i.id).sort(), ['m1', 'm2']);
  assert.equal(a.data.items.find(i => i.id === 'm2').price, 190, 'the bad row left the item untouched');
});

test('applyImport blocks on row errors unless skipInvalid is set', () => {
  const rows = [
    { name: 'Paneer Tikka', category: 'Starters', price: '240' },
    { name: 'Bad', category: 'Starters', price: 'abc', veg: 'yes' }
  ];
  const blocked = applyImport(menu(), rows);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.code, 'INVALID_ROWS');
  assert.equal(blocked.details.length, 1);
  assert.equal(blocked.details[0].row, 3);

  const skipped = applyImport(menu(), rows, { skipInvalid: true });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.meta.skipped, 1);
  assert.equal(skipped.data.items.find(i => i.id === 'm1').price, 240);
  assert.equal(skipped.data.items.length, 3);
});

test('row limits: empty and over-2000 files are refused', () => {
  assert.equal(previewImport(menu(), []).code, 'NO_ROWS');
  const many = Array.from({ length: 2001 }, (_, i) => ({ name: `D${i}`, category: 'Bulk', price: '1', veg: 'yes' }));
  assert.equal(previewImport(menu(), many).code, 'TOO_MANY_ROWS');
  assert.equal(previewImport(menu(), many.slice(0, 2000)).ok, true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test hub_server/test/menuImport.test.mjs`
Expected: FAIL — `Cannot find module '../lib/menuImport.js'`.

- [ ] **Step 3: Implement `menuImport.js`**

Create `hub_server/lib/menuImport.js`:

```js
import { STATIONS, LIMITS, norm, newItemId } from './menuAdmin.js';

// Menu import: rows arrive already parsed (the browser reads the CSV/xlsx; the hub
// never sees the file) as plain objects of strings keyed by lower-case column name.
// Rules (spec §2): a column that is absent, or a cell that is blank, never
// overwrites an existing value; modifiers and day-parts are not importable and
// survive re-imports; `veg` is required for new items.

const YES = new Set(['yes', 'y', 'true', '1', 'veg', 'available']);
const NO = new Set(['no', 'n', 'false', '0', 'non-veg', 'nonveg', 'non veg', 'unavailable']);
const MONEY = /^\d+(\.\d{1,2})?$/;

const parseBool = v => {
  const s = String(v).trim().toLowerCase();
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  return null;
};
const parseMoney = v => {
  const s = String(v).trim();
  if (!MONEY.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
};
const slug = label => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

// What counts as "changed" for the review table. Legacy variants have no
// `available` key, so compare it as `!== false`.
const VIEW = {
  name: i => i.name,
  category: i => i.category,
  price: i => i.price,
  isVeg: i => i.isVeg,
  available: i => i.available !== false,
  station: i => i.station,
  variants: i => (i.variants || []).map(v => [v.id, v.label, v.price, v.available !== false])
};

function parseVariants(cell, existing) {
  const parts = cell.split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { error: 'variants must look like Half:180|Full:280' };

  const taken = new Set(existing.map(v => v.id));
  const seen = new Set();
  const variants = [];
  for (const part of parts) {
    const at = part.lastIndexOf(':');
    const label = at > 0 ? part.slice(0, at).trim() : '';
    if (!label || label.length > LIMITS.variantLabel) {
      return { error: `variant "${part}" must look like Label:price (label up to ${LIMITS.variantLabel} characters)` };
    }
    const price = parseMoney(part.slice(at + 1));
    if (price === null) return { error: `variant "${label}" needs a price above 0 with at most 2 decimals` };
    if (seen.has(norm(label))) return { error: `variant "${label}" is listed twice` };
    seen.add(norm(label));

    const prior = existing.find(v => norm(v.label) === norm(label));
    if (prior) {
      variants.push({ id: prior.id, label, price, available: prior.available !== false });
      continue;
    }
    const base = 'v_' + slug(label);
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}_${n++}`;
    taken.add(id);
    variants.push({ id, label, price, available: true });
  }
  return { variants };
}

function processRow(raw, idx, menu, catMap, seen) {
  const row = Number.isInteger(raw?.__row) ? raw.__row : idx + 2;
  const cell = k => (raw?.[k] === undefined || raw?.[k] === null ? '' : String(raw[k]).trim());
  const errors = [];
  const id = cell('id');
  const name = cell('name');
  const category = cell('category');

  let existing = id ? menu.items.find(i => i.id === id) : undefined;
  const matchedById = Boolean(existing);
  if (!existing && name) {
    const byName = menu.items.filter(i => norm(i.name) === norm(name));
    existing = category
      ? byName.find(i => norm(i.category) === norm(category))
      : (byName.length === 1 ? byName[0] : undefined);
  }
  const isNew = !existing;
  const before = existing ? structuredClone(existing) : null;
  const item = existing ? structuredClone(existing) : { id: newItemId(), available: true };

  if (name) {
    if (name.length > LIMITS.name) errors.push(`name must be at most ${LIMITS.name} characters`);
    // A match by name keeps the stored spelling ("paneer tikka" must not rename
    // "Paneer Tikka"); only a match by id may rename the item.
    else if (!existing || matchedById) item.name = name;
  } else if (isNew) {
    errors.push('name is required');
  }

  if (category) {
    if (category.length > LIMITS.category) {
      errors.push(`category must be at most ${LIMITS.category} characters`);
    } else {
      const key = norm(category);
      if (!catMap.has(key)) catMap.set(key, category);
      item.category = catMap.get(key);
    }
  } else if (isNew) {
    errors.push('category is required');
  }

  const priceCell = cell('price');
  if (priceCell) {
    const p = parseMoney(priceCell);
    if (p === null) errors.push('price must be a number above 0 with at most 2 decimals');
    else item.price = p;
  }

  const variantsCell = cell('variants');
  if (variantsCell) {
    const r = parseVariants(variantsCell, existing?.variants || []);
    if (r.error) {
      errors.push(r.error);
    } else {
      item.variants = r.variants;
      if (isNew && item.price === undefined) item.price = r.variants[0].price;
    }
  }
  if (isNew && item.price === undefined && !priceCell && !variantsCell) {
    errors.push('price is required (or provide variants)');
  }

  const vegCell = cell('veg');
  if (vegCell) {
    const b = parseBool(vegCell);
    if (b === null) errors.push('veg must be yes or no');
    else item.isVeg = b;
  } else if (isNew) {
    errors.push('veg is required for new items (yes or no)');
  }

  const availCell = cell('available');
  if (availCell) {
    const b = parseBool(availCell);
    if (b === null) errors.push('available must be yes or no');
    else item.available = b;
  }

  const stationCell = cell('station').toLowerCase();
  if (stationCell) {
    if (!STATIONS.includes(stationCell)) errors.push(`station must be one of ${STATIONS.join(', ')}`);
    else item.station = stationCell;
  }

  if (name || existing) {
    const key = existing ? `id:${existing.id}` : `new:${norm(item.name ?? name)}|${norm(item.category ?? category)}`;
    if (seen.has(key)) errors.push(`duplicate of row ${seen.get(key)}`);
    else seen.set(key, row);
  }

  const matched_id = existing?.id ?? null;
  if (errors.length) return { row, status: 'error', name, category, errors, changes: [], matched_id };

  const changes = before
    ? Object.keys(VIEW)
        .filter(f => JSON.stringify(VIEW[f](before)) !== JSON.stringify(VIEW[f](item)))
        .map(f => ({ field: f, from: VIEW[f](before), to: VIEW[f](item) }))
    : [];
  const status = isNew ? 'new' : changes.length ? 'updated' : 'unchanged';
  return { row, status, name: item.name, category: item.category, errors: [], changes, item, matched_id };
}

export function previewImport(menu, rows, { mode = 'merge' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, status: 400, code: 'NO_ROWS', error: 'The file has no rows to import.' };
  }
  if (rows.length > LIMITS.importRows) {
    return { ok: false, status: 400, code: 'TOO_MANY_ROWS', error: `Imports are limited to ${LIMITS.importRows} rows.` };
  }

  const catMap = new Map(menu.categories.map(c => [norm(c), c]));
  const seen = new Map();
  const results = rows.map((raw, idx) => processRow(raw, idx, menu, catMap, seen));

  const counts = { new: 0, updated: 0, unchanged: 0, error: 0, removed: 0 };
  for (const r of results) counts[r.status]++;
  if (mode === 'replace') {
    // A row with an error still "claims" the item it matched, so a bad row never deletes data.
    const claimed = new Set(results.map(r => r.matched_id).filter(Boolean));
    counts.removed = menu.items.filter(i => !claimed.has(i.id)).length;
  }
  return { ok: true, rows: results, counts };
}

export function applyImport(menu, rows, { mode = 'merge', skipInvalid = false } = {}) {
  const preview = previewImport(menu, rows, { mode });
  if (!preview.ok) return preview;

  if (preview.counts.error > 0 && !skipInvalid) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_ROWS',
      error: `${preview.counts.error} row(s) have errors. Fix them or import the valid rows only.`,
      details: preview.rows.filter(r => r.status === 'error')
    };
  }

  const good = preview.rows.filter(r => r.status !== 'error');
  const updatedById = new Map(good.filter(r => r.matched_id).map(r => [r.matched_id, r.item]));
  const fresh = good.filter(r => !r.matched_id).map(r => r.item);

  let items;
  if (mode === 'replace') {
    const claimed = new Set(preview.rows.map(r => r.matched_id).filter(Boolean));
    items = [...menu.items.filter(i => claimed.has(i.id)).map(i => updatedById.get(i.id) || i), ...fresh];
  } else {
    items = [...menu.items.map(i => updatedById.get(i.id) || i), ...fresh];
  }

  const used = new Set(items.map(i => i.category));
  const categories = mode === 'replace' ? menu.categories.filter(c => used.has(c)) : [...menu.categories];
  for (const it of items) {
    if (!categories.includes(it.category)) categories.push(it.category);
  }

  return {
    ok: true,
    data: { ...menu, categories, items },
    meta: { counts: preview.counts, skipped: preview.counts.error }
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test hub_server/test/menuImport.test.mjs`
Expected: all tests PASS. If the `unchanged` variants test fails, check that `VIEW.variants` compares `available !== false` (legacy variants have no `available` key). If the first test reports an extra `name` change, the name-by-match guard (`!existing || matchedById`) is missing.

- [ ] **Step 5: Commit**

```bash
git add hub_server/lib/menuImport.js hub_server/test/menuImport.test.mjs
git commit -m "feat(hub): menu import preview and apply

Row parsing with merge/replace modes, blank-cell preservation, variant id
retention and required veg for new items. Pure; the route layer comes next.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Table layout operations (`tablesAdmin.js`)

**Files:**
- Create: `hub_server/lib/tablesAdmin.js`
- Create: `hub_server/test/tablesAdmin.test.mjs`

**Interfaces:**
- Consumes: `norm` from `menuAdmin.js` (Task 3).
- Produces: `TABLE_LIMITS = { name:50, section:60, capacity:50 }` and `applyLayout(current, input, openTableIds?: Set<string>) → { ok:true, data } | { ok:false, status:400, code:'INVALID_LAYOUT', errors:[{field,message}] } | { ok:false, status:409, code:'TABLE_HAS_OPEN_BILL', error, details:[{id,name,action:'rename'|'delete'}] }`. `current` is the tables cache (`{ tables, sections?, next_id?, … }`); `input` is `{ sections: string[], tables: [{ id?, name, section, capacity }] }`. `data` is `{ …current, tables, sections, count, next_id }` with tables in input order (= display order).

- [ ] **Step 1: Write the failing tests**

Create `hub_server/test/tablesAdmin.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLayout } from '../lib/tablesAdmin.js';

const current = () => ({
  restaurant_id: 'r', revision: 1, count: 3, next_id: 4,
  sections: ['Main Hall', 'AC Room'],
  tables: [
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
    { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 },
    { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }
  ]
});

test('rename, move, reorder, add and delete in one save', () => {
  const r = applyLayout(current(), {
    sections: ['AC Room', 'Main Hall', 'Patio'],
    tables: [
      { id: 3, name: 'Window 1', section: 'AC Room', capacity: 6 },
      { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
      { name: 'P1', section: 'Patio', capacity: 4 }
    ]
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.sections, ['AC Room', 'Main Hall', 'Patio']);
  assert.deepEqual(r.data.tables, [
    { id: 3, name: 'Window 1', section: 'AC Room', capacity: 6 },
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
    { id: 4, name: 'P1', section: 'Patio', capacity: 4 }
  ]);
  assert.equal(r.data.count, 3);
  assert.equal(r.data.next_id, 5);
  assert.equal(r.data.revision, 1, 'revision is bumped by the store, not here');
});

test('ids are never reused, even after deleting the highest table', () => {
  const r = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 2 }, { name: 'New', section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r.data.tables[1].id, 4, 'T3 (id 3) was deleted but 4 is next, not 3');

  const noCounter = current();
  delete noCounter.next_id;
  const r2 = applyLayout(noCounter, {
    sections: ['Main Hall'],
    tables: [{ name: 'New', section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r2.data.tables[0].id, 4, 'falls back to max(existing ids) + 1');
});

test('section and table names are trimmed and matched case-insensitively to the section list', () => {
  const r = applyLayout(current(), {
    sections: [' Main Hall '],
    tables: [{ id: 1, name: ' T1 ', section: 'main hall', capacity: 2 }]
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.tables[0], { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 });
});

test('duplicate table names (case-insensitive) are rejected', () => {
  const r = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 2 }, { id: 2, name: 't1', section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'INVALID_LAYOUT');
  assert.equal(r.errors[0].field, 'tables[1].name');
});

test('invalid sections, ids and capacities are rejected with field paths', () => {
  const run = (sections, tables) => applyLayout(current(), { sections, tables });
  assert.equal(run(['A', 'a'], []).errors[0].field, 'sections[1]');
  assert.equal(run([''], []).errors[0].field, 'sections[0]');
  assert.equal(run(['A'], [{ name: 'X', section: 'B', capacity: 2 }]).errors[0].field, 'tables[0].section');
  assert.equal(run(['A'], [{ id: 99, name: 'X', section: 'A', capacity: 2 }]).errors[0].field, 'tables[0].id');
  assert.equal(run(['A'], [{ id: 1, name: 'X', section: 'A', capacity: 2 }, { id: 1, name: 'Y', section: 'A', capacity: 2 }]).errors[0].field, 'tables[1].id');
  assert.equal(run(['A'], [{ name: 'X', section: 'A', capacity: 0 }]).errors[0].field, 'tables[0].capacity');
  assert.equal(run(['A'], [{ name: 'X', section: 'A', capacity: 2.5 }]).errors[0].field, 'tables[0].capacity');
  assert.equal(run(['A'], [{ name: 'X', section: 'A', capacity: 51 }]).errors[0].field, 'tables[0].capacity');
  assert.equal(applyLayout(current(), { sections: 'nope', tables: [] }).code, 'INVALID_LAYOUT');
  assert.equal(applyLayout(current(), null).code, 'INVALID_LAYOUT');
});

test('a table with an open bill cannot be renamed or deleted, but can change seats and section', () => {
  const open = new Set(['1']);

  const renamed = applyLayout(current(), {
    sections: ['Main Hall', 'AC Room'],
    tables: [
      { id: 1, name: 'Window', section: 'Main Hall', capacity: 2 },
      { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 },
      { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }
    ]
  }, open);
  assert.equal(renamed.ok, false);
  assert.equal(renamed.status, 409);
  assert.equal(renamed.code, 'TABLE_HAS_OPEN_BILL');
  assert.deepEqual(renamed.details, [{ id: 1, name: 'T1', action: 'rename' }]);
  assert.match(renamed.error, /T1 \(rename\)/);

  const deleted = applyLayout(current(), {
    sections: ['Main Hall', 'AC Room'],
    tables: [{ id: 2, name: 'T2', section: 'Main Hall', capacity: 4 }, { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }]
  }, open);
  assert.deepEqual(deleted.details, [{ id: 1, name: 'T1', action: 'delete' }]);

  const moved = applyLayout(current(), {
    sections: ['Main Hall', 'AC Room'],
    tables: [
      { id: 1, name: 'T1', section: 'AC Room', capacity: 8 },
      { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 },
      { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }
    ]
  }, open);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.data.tables[0], { id: 1, name: 'T1', section: 'AC Room', capacity: 8 });
});

test('a layout with no tables is valid', () => {
  const r = applyLayout(current(), { sections: ['Main Hall'], tables: [] });
  assert.equal(r.ok, true);
  assert.equal(r.data.count, 0);
  assert.deepEqual(r.data.tables, []);
  assert.equal(r.data.next_id, 4);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test hub_server/test/tablesAdmin.test.mjs`
Expected: FAIL — `Cannot find module '../lib/tablesAdmin.js'`.

- [ ] **Step 3: Implement `tablesAdmin.js`**

Create `hub_server/lib/tablesAdmin.js`:

```js
import { norm } from './menuAdmin.js';

// Whole-layout save for the floor: the editor keeps a local draft (many drags and
// renames) and commits once. Pure; restaurantCache.updateCatalog persists it.

export const TABLE_LIMITS = { name: 50, section: 60, capacity: 50 };

const bad = errors => ({ ok: false, status: 400, code: 'INVALID_LAYOUT', error: errors[0].message, errors });

/**
 * @param current        tables cache `{ tables, sections?, next_id?, … }`
 * @param input          `{ sections: string[], tables: [{ id?, name, section, capacity }] }`
 * @param openTableIds   Set of table ids (as strings) that currently have an open bill
 */
export function applyLayout(current, input, openTableIds = new Set()) {
  if (!input || !Array.isArray(input.sections) || !Array.isArray(input.tables)) {
    return bad([{ field: 'layout', message: 'sections and tables must both be arrays' }]);
  }
  const errors = [];

  const sections = [];
  input.sections.forEach((s, i) => {
    const name = typeof s === 'string' ? s.trim() : '';
    if (!name || name.length > TABLE_LIMITS.section) {
      errors.push({ field: `sections[${i}]`, message: `section name is required (1–${TABLE_LIMITS.section} characters)` });
    } else if (sections.some(x => norm(x) === norm(name))) {
      errors.push({ field: `sections[${i}]`, message: `section "${name}" is listed twice` });
    } else {
      sections.push(name);
    }
  });

  const existingById = new Map(current.tables.map(t => [String(t.id), t]));
  const maxId = Math.max(0, ...current.tables.map(t => Number(t.id) || 0));
  // The counter only ever moves forward, so an id can never alias a deleted
  // table's history.
  let nextId = Math.max(Number(current.next_id) || 1, maxId + 1);

  const usedNames = new Set();
  const usedIds = new Set();
  const rows = input.tables.map((t, i) => {
    const at = k => `tables[${i}].${k}`;
    const name = typeof t?.name === 'string' ? t.name.trim() : '';
    const sectionRaw = typeof t?.section === 'string' ? t.section.trim() : '';
    const section = sections.find(s => norm(s) === norm(sectionRaw));

    if (!name || name.length > TABLE_LIMITS.name) {
      errors.push({ field: at('name'), message: `table name is required (1–${TABLE_LIMITS.name} characters)` });
    } else if (usedNames.has(norm(name))) {
      errors.push({ field: at('name'), message: `table name "${name}" is used twice` });
    } else {
      usedNames.add(norm(name));
    }
    if (!section) {
      errors.push({ field: at('section'), message: `section "${sectionRaw}" is not in the sections list` });
    }
    if (!Number.isInteger(t?.capacity) || t.capacity < 1 || t.capacity > TABLE_LIMITS.capacity) {
      errors.push({ field: at('capacity'), message: `seats must be a whole number from 1 to ${TABLE_LIMITS.capacity}` });
    }

    let id;
    if (t?.id !== undefined && t?.id !== null) {
      const existing = existingById.get(String(t.id));
      if (!existing) errors.push({ field: at('id'), message: `unknown table id ${t.id}` });
      else if (usedIds.has(String(existing.id))) errors.push({ field: at('id'), message: `table id ${t.id} appears twice` });
      else {
        id = existing.id;
        usedIds.add(String(existing.id));
      }
    }
    return { id, name, section, capacity: t?.capacity };
  });
  if (errors.length) return bad(errors);

  // Open-bill lock: tickets are matched to tables by id *or* name, so renaming or
  // deleting a table mid-service would orphan or misattribute its bill.
  const blocked = [];
  for (const t of current.tables) {
    if (!openTableIds.has(String(t.id))) continue;
    const next = rows.find(r => r.id !== undefined && String(r.id) === String(t.id));
    if (!next) blocked.push({ id: t.id, name: t.name, action: 'delete' });
    else if (next.name !== t.name) blocked.push({ id: t.id, name: t.name, action: 'rename' });
  }
  if (blocked.length) {
    const names = blocked.map(b => `${b.name} (${b.action})`).join(', ');
    return { ok: false, status: 409, code: 'TABLE_HAS_OPEN_BILL', error: `Clear the open bill first: ${names}.`, details: blocked };
  }

  const tables = rows.map(r => ({ id: r.id ?? nextId++, name: r.name, section: r.section, capacity: r.capacity }));
  return { ok: true, data: { ...current, tables, sections, count: tables.length, next_id: nextId } };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test hub_server/test/tablesAdmin.test.mjs`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hub_server/lib/tablesAdmin.js hub_server/test/tablesAdmin.test.mjs
git commit -m "feat(hub): pure table layout validation with open-bill lock

Whole-layout save: unique names, section list, never-reused ids, and no
rename/delete of a table that has an open bill.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Routes, reception guard, broadcasts, and the server fixes

**Files:**
- Modify: `hub_server/lib/deviceAuth.js` (append `requireReception`)
- Modify: `hub_server/server.js` (imports, body-limit mount, `MASTER_TABLES` fix, `/tables` sections, `/admin/*` routes)
- Create: `hub_server/test/helpers/spawnHub.mjs`
- Create: `hub_server/test/catalogRoutes.test.mjs`

**Interfaces:**
- Consumes: `restaurantCache.updateCatalog` / `getMenuCache` / `getTablesCache` (Task 2); `addItem, updateItem, deleteItem, addCategory, renameCategory, reorderCategories, deleteCategory` (Task 3); `previewImport, applyImport` (Task 4); `applyLayout` (Task 5).
- Produces — HTTP API (all `/admin/*` need `requireReception`; all writes need `base_revision` in the JSON body, or in the query string for DELETE):

| Route | Success | Notes |
|---|---|---|
| `POST /admin/menu/items` `{ base_revision, item }` | 201 `{ success, revision, item }` | |
| `PUT /admin/menu/items/:id` `{ base_revision, item }` | 200 `{ success, revision, item }` | merge semantics |
| `DELETE /admin/menu/items/:id?base_revision=N` | 200 `{ success, revision, deleted }` | |
| `POST /admin/menu/categories` `{ base_revision, name }` | 201 `{ success, revision, name }` | |
| `PUT /admin/menu/categories` `{ base_revision, from, to }` | 200 | rename |
| `PUT /admin/menu/categories/order` `{ base_revision, names }` | 200 | |
| `DELETE /admin/menu/categories?name=X&base_revision=N` | 200 | only when empty |
| `POST /admin/menu/import/preview` `{ rows, mode? }` | 200 `{ success, revision, counts, rows }` | no write; rows omit `item` |
| `POST /admin/menu/import/commit` `{ base_revision, rows, mode?, skip_invalid?, confirm_replace? }` | 200 `{ success, revision, counts, skipped }` | `replace` needs `confirm_replace: true` else 400 `CONFIRM_REQUIRED` |
| `PUT /admin/tables/layout` `{ base_revision, sections, tables }` | 200 `{ success, revision, tables, sections }` | |

  Also: `GET /tables` and `GET /tables/layout` include `sections`; `GET /menu` and `/tables/layout` include `revision`. After each successful commit the hub broadcasts `menu_updated` / `tables_updated`.

- [ ] **Step 1: Write the test helper**

Create `hub_server/test/helpers/spawnHub.mjs`:

```js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js');
export const RESTAURANT_ID = '11111111-1111-1111-1111-111111111111';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Boots a real hub against a throwaway data directory. `trustLoopback: true`
 * makes requests from 127.0.0.1 act as the reception laptop; `false` makes them
 * act as a remote handset that must present a token.
 */
export async function startHub({ port, trustLoopback, menu, tables, enrollmentCode = 'TESTCODE' }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-catalog-'));
  fs.writeFileSync(path.join(dataDir, 'menu_cache.json'), JSON.stringify(menu));
  fs.writeFileSync(path.join(dataDir, 'tables_cache.json'), JSON.stringify(tables));
  fs.writeFileSync(path.join(dataDir, 'tickets.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'sync_queue.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
    paired: true,
    restaurant_id: RESTAURANT_ID,
    name: 'Test Kitchen',
    pairing_code: 'TST-0001',
    city: 'Nagpur',
    enrollment_code: enrollmentCode,
    devices: []
  }));

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HUB_DATA_DIR: dataDir,
      HUB_TRUST_LOOPBACK: trustLoopback ? 'true' : 'false',
      SUPABASE_URL: 'https://example.supabase.co'
    },
    stdio: 'ignore'
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await fetch(`${base}/pairing-info`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('hub server did not start');
      await sleep(200);
    }
  }

  return {
    base,
    port,
    dataDir,
    stop() {
      child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

/** JSON fetch helper: `call(hub, '/path', { method, body, token })`. */
export function call(hub, pathname, { method = 'GET', body, token } = {}) {
  return fetch(`${hub.base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
```

- [ ] **Step 2: Write the failing integration tests**

Create `hub_server/test/catalogRoutes.test.mjs`:

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

const MENU = {
  restaurant_id: RESTAURANT_ID,
  categories: ['Starters'],
  items: [{ id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true }]
};
const TABLES = {
  restaurant_id: RESTAURANT_ID,
  tables: [
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 4 },
    { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 }
  ]
};

let rec;      // reception: loopback is trusted
let handset;  // remote handset: loopback is NOT trusted, needs a token
let token;

before(async () => {
  rec = await startHub({ port: 4598, trustLoopback: true, menu: MENU, tables: TABLES });
  handset = await startHub({ port: 4597, trustLoopback: false, menu: MENU, tables: TABLES });
  const enrol = await call(handset, '/auth/device', { method: 'POST', body: { enrollment_code: 'TESTCODE', device_label: 'test' } });
  token = (await enrol.json()).device_token;
});

after(() => {
  rec?.stop();
  handset?.stop();
});

const json = async res => res.json();
const menuRev = async () => (await json(await call(rec, '/menu'))).revision;
const tablesRev = async () => (await json(await call(rec, '/tables/layout'))).revision;
const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
};

// ---------------------------------------------------------------- reads

test('GET /menu and /tables/layout expose revision, and layout exposes sections', async () => {
  const menu = await json(await call(rec, '/menu'));
  assert.equal(menu.revision, 0);
  const layout = await json(await call(rec, '/tables/layout'));
  assert.equal(layout.revision, 0);
  assert.deepEqual(layout.sections, ['Main Hall']);
});

// ---------------------------------------------------------------- menu items

test('POST /admin/menu/items adds an item, bumps the revision and refuses a stale base', async () => {
  const res = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { base_revision: 0, item: { name: 'Masala Chaas', category: 'Beverages', price: 50, isVeg: true, station: 'bar' } }
  });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.equal(body.success, true);
  assert.equal(body.revision, 1);
  assert.equal(body.item.name, 'Masala Chaas');

  const menu = await json(await call(rec, '/menu'));
  assert.equal(menu.revision, 1);
  assert.ok(menu.items.some(i => i.name === 'Masala Chaas'));
  assert.ok(menu.categories.includes('Beverages'));

  const stale = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { base_revision: 0, item: { name: 'Other', category: 'Beverages', price: 5, isVeg: true } }
  });
  assert.equal(stale.status, 409);
  const staleBody = await json(stale);
  assert.equal(staleBody.code, 'STALE_REVISION');
  assert.equal(staleBody.current_revision, 1);

  const missing = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { item: { name: 'Other', category: 'Beverages', price: 5, isVeg: true } }
  });
  assert.equal(missing.status, 400);
  assert.equal((await json(missing)).code, 'BASE_REVISION_REQUIRED');

  const invalid = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { base_revision: 1, item: { name: '', category: 'Beverages', price: 0, isVeg: true } }
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await json(invalid);
  assert.equal(invalidBody.code, 'INVALID_ITEM');
  assert.ok(invalidBody.errors.length >= 2);
});

test('PUT merges the provided keys and DELETE removes the item', async () => {
  const menu = await json(await call(rec, '/menu'));
  const chaas = menu.items.find(i => i.name === 'Masala Chaas');

  const put = await call(rec, `/admin/menu/items/${chaas.id}`, {
    method: 'PUT',
    body: { base_revision: menu.revision, item: { price: 60 } }
  });
  assert.equal(put.status, 200);
  const updated = (await json(await call(rec, '/menu'))).items.find(i => i.id === chaas.id);
  assert.equal(updated.price, 60);
  assert.equal(updated.station, 'bar', 'omitted keys are preserved');

  const rev = await menuRev();
  const del = await call(rec, `/admin/menu/items/${chaas.id}?base_revision=${rev}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.ok(!(await json(await call(rec, '/menu'))).items.some(i => i.id === chaas.id));

  const gone = await call(rec, `/admin/menu/items/${chaas.id}?base_revision=${await menuRev()}`, { method: 'DELETE' });
  assert.equal(gone.status, 404);
});

// ---------------------------------------------------------------- categories

test('category add, rename, reorder and delete', async () => {
  let r = await call(rec, '/admin/menu/categories', { method: 'POST', body: { base_revision: await menuRev(), name: 'Drinks' } });
  assert.equal(r.status, 201);

  r = await call(rec, '/admin/menu/categories', { method: 'PUT', body: { base_revision: await menuRev(), from: 'Drinks', to: 'Cold Drinks' } });
  assert.equal(r.status, 200);

  r = await call(rec, '/admin/menu/categories/order', { method: 'PUT', body: { base_revision: await menuRev(), names: ['Cold Drinks', 'Starters', 'Beverages'] } });
  assert.equal(r.status, 200);
  const menu = await json(await call(rec, '/menu'));
  assert.deepEqual(menu.categories, ['Cold Drinks', 'Starters', 'Beverages']);

  r = await call(rec, `/admin/menu/categories?name=${encodeURIComponent('Cold Drinks')}&base_revision=${await menuRev()}`, { method: 'DELETE' });
  assert.equal(r.status, 200);

  r = await call(rec, `/admin/menu/categories?name=Starters&base_revision=${await menuRev()}`, { method: 'DELETE' });
  assert.equal(r.status, 409);
  assert.equal((await json(r)).code, 'CATEGORY_NOT_EMPTY');
});

// ---------------------------------------------------------------- import

test('import preview does not write; commit applies; replace needs confirmation', async () => {
  const rows = [
    { name: 'Paneer Tikka', category: 'Starters', price: '240' },
    { name: 'New Dish', category: 'Starters', price: '100', veg: 'yes' }
  ];
  const before = await menuRev();

  const preview = await call(rec, '/admin/menu/import/preview', { method: 'POST', body: { rows } });
  assert.equal(preview.status, 200);
  const p = await json(preview);
  assert.deepEqual(p.counts, { new: 1, updated: 1, unchanged: 0, error: 0, removed: 0 });
  assert.equal(p.rows[0].item, undefined, 'preview rows omit the full item');
  assert.equal(await menuRev(), before, 'preview must not write');

  const commit = await call(rec, '/admin/menu/import/commit', { method: 'POST', body: { base_revision: before, rows } });
  assert.equal(commit.status, 200);
  const c = await json(commit);
  assert.equal(c.revision, before + 1);
  assert.equal(c.counts.new, 1);
  const menu = await json(await call(rec, '/menu'));
  assert.equal(menu.items.find(i => i.name === 'Paneer Tikka').price, 240);
  assert.ok(menu.items.some(i => i.name === 'New Dish'));

  const unconfirmed = await call(rec, '/admin/menu/import/commit', {
    method: 'POST', body: { base_revision: await menuRev(), rows, mode: 'replace' }
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await json(unconfirmed)).code, 'CONFIRM_REQUIRED');

  const blocked = await call(rec, '/admin/menu/import/commit', {
    method: 'POST', body: { base_revision: await menuRev(), rows: [{ name: 'Bad', category: 'Starters', price: 'x', veg: 'yes' }] }
  });
  assert.equal(blocked.status, 400);
  const blockedBody = await json(blocked);
  assert.equal(blockedBody.code, 'INVALID_ROWS');
  assert.equal(blockedBody.details[0].row, 2);
});

test('import bodies above the global 256 KB limit are accepted; more than 2000 rows are refused', async () => {
  const pad = 'x'.repeat(100);
  const big = Array.from({ length: 2000 }, (_, i) => ({ name: `Dish ${i} ${pad}`, category: 'Bulk', price: '10', veg: 'yes' }));
  assert.ok(JSON.stringify({ rows: big }).length > 256 * 1024, 'fixture must exceed the global limit');

  const ok = await call(rec, '/admin/menu/import/preview', { method: 'POST', body: { rows: big } });
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).counts.new, 2000);

  const tooMany = await call(rec, '/admin/menu/import/preview', {
    method: 'POST', body: { rows: [...big, { name: 'One too many', category: 'Bulk', price: '10', veg: 'yes' }] }
  });
  assert.equal(tooMany.status, 400);
  assert.equal((await json(tooMany)).code, 'TOO_MANY_ROWS');
});

// ---------------------------------------------------------------- tables

test('PUT /admin/tables/layout saves sections, order, rename and a new table; stale base is refused', async () => {
  const layout = {
    base_revision: 0,
    sections: ['Main Hall', 'Patio'],
    tables: [
      { id: 1, name: 'T1', section: 'Main Hall', capacity: 4 },
      { id: 2, name: 'Window', section: 'Main Hall', capacity: 4 },
      { name: 'P1', section: 'Patio', capacity: 6 }
    ]
  };
  const res = await call(rec, '/admin/tables/layout', { method: 'PUT', body: layout });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.revision, 1);
  assert.equal(body.tables[2].id, 3, 'a new table gets the next id');

  const live = await json(await call(rec, '/tables'));
  assert.deepEqual(live.sections, ['Main Hall', 'Patio']);
  assert.deepEqual(live.tables.map(t => t.name), ['T1', 'Window', 'P1']);

  const stale = await call(rec, '/admin/tables/layout', { method: 'PUT', body: layout });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'STALE_REVISION');

  const dup = await call(rec, '/admin/tables/layout', {
    method: 'PUT',
    body: { ...layout, base_revision: 1, tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 4 }, { id: 2, name: 't1', section: 'Main Hall', capacity: 4 }] }
  });
  assert.equal(dup.status, 400);
  assert.equal((await json(dup)).code, 'INVALID_LAYOUT');
});

test('a table with an open bill cannot be renamed or deleted, but can be moved', async () => {
  const order = await call(rec, '/orders', { method: 'POST', body: { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 1 }] } });
  assert.ok(order.ok, 'fixture order must be accepted');

  const base = await tablesRev();
  const rename = await call(rec, '/admin/tables/layout', {
    method: 'PUT',
    body: {
      base_revision: base,
      sections: ['Main Hall', 'Patio'],
      tables: [
        { id: 1, name: 'Renamed', section: 'Main Hall', capacity: 4 },
        { id: 2, name: 'Window', section: 'Main Hall', capacity: 4 },
        { id: 3, name: 'P1', section: 'Patio', capacity: 6 }
      ]
    }
  });
  assert.equal(rename.status, 409);
  const renameBody = await json(rename);
  assert.equal(renameBody.code, 'TABLE_HAS_OPEN_BILL');
  assert.deepEqual(renameBody.details, [{ id: 1, name: 'T1', action: 'rename' }]);

  const move = await call(rec, '/admin/tables/layout', {
    method: 'PUT',
    body: {
      base_revision: base,
      sections: ['Main Hall', 'Patio'],
      tables: [
        { id: 1, name: 'T1', section: 'Patio', capacity: 8 },
        { id: 2, name: 'Window', section: 'Main Hall', capacity: 4 },
        { id: 3, name: 'P1', section: 'Patio', capacity: 6 }
      ]
    }
  });
  assert.equal(move.status, 200);

  const cleared = await call(rec, '/tables/1/clear', { method: 'POST' });
  assert.ok(cleared.ok);
});

test('menu and layout commits are broadcast over the live socket', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${rec.port}/live`);
  const seen = [];
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', m => seen.push(JSON.parse(m.toString()).type));

  const t = await call(rec, '/admin/tables/layout', {
    method: 'PUT',
    body: {
      base_revision: await tablesRev(),
      sections: ['Main Hall', 'Patio'],
      tables: [
        { id: 1, name: 'T1', section: 'Patio', capacity: 8 },
        { id: 2, name: 'Window', section: 'Main Hall', capacity: 4 },
        { id: 3, name: 'P1', section: 'Patio', capacity: 6 }
      ]
    }
  });
  assert.equal(t.status, 200);
  assert.ok(await waitFor(() => seen.includes('tables_updated')), 'tables_updated must be broadcast');

  const m = await call(rec, '/admin/menu/categories', { method: 'POST', body: { base_revision: await menuRev(), name: 'Specials' } });
  assert.equal(m.status, 201);
  assert.ok(await waitFor(() => seen.includes('menu_updated')), 'menu_updated must be broadcast');
  ws.close();
});

test('deleting every table leaves the floor empty instead of resurrecting the demo tables', async () => {
  const res = await call(rec, '/admin/tables/layout', {
    method: 'PUT', body: { base_revision: await tablesRev(), sections: ['Main Hall'], tables: [] }
  });
  assert.equal(res.status, 200);
  const live = await json(await call(rec, '/tables'));
  assert.equal(live.count, 0);
  assert.deepEqual(live.tables, []);
});

test('replace import (confirmed) leaves only the file contents', async () => {
  const rows = [{ name: 'Only Dish', category: 'Mains', price: '99', veg: 'yes' }];
  const res = await call(rec, '/admin/menu/import/commit', {
    method: 'POST', body: { base_revision: await menuRev(), rows, mode: 'replace', confirm_replace: true }
  });
  assert.equal(res.status, 200);
  const menu = await json(await call(rec, '/menu'));
  assert.deepEqual(menu.items.map(i => i.name), ['Only Dish']);
  assert.deepEqual(menu.categories, ['Mains']);
});

// ---------------------------------------------------------------- access control

test('enrolled handsets can read the menu but get 403 RECEPTION_ONLY on every admin route', async () => {
  const read = await call(handset, '/menu', { token });
  assert.equal(read.status, 200);

  const attempts = [
    ['POST', '/admin/menu/items', { base_revision: 0, item: { name: 'X', category: 'Starters', price: 1, isVeg: true } }],
    ['PUT', '/admin/menu/items/m1', { base_revision: 0, item: { price: 1 } }],
    ['DELETE', '/admin/menu/items/m1?base_revision=0', undefined],
    ['POST', '/admin/menu/categories', { base_revision: 0, name: 'X' }],
    ['PUT', '/admin/menu/categories/order', { base_revision: 0, names: [] }],
    ['POST', '/admin/menu/import/preview', { rows: [] }],
    ['POST', '/admin/menu/import/commit', { base_revision: 0, rows: [] }],
    ['PUT', '/admin/tables/layout', { base_revision: 0, sections: [], tables: [] }]
  ];
  for (const [method, p, body] of attempts) {
    const res = await call(handset, p, { method, body, token });
    assert.equal(res.status, 403, `${method} ${p} must be reception-only`);
    assert.equal((await json(res)).code, 'RECEPTION_ONLY');
  }

  const anonymous = await call(handset, '/admin/tables/layout', { method: 'PUT', body: { base_revision: 0, sections: [], tables: [] } });
  assert.equal(anonymous.status, 403);

  const unchanged = await json(await call(handset, '/menu', { token }));
  assert.equal(unchanged.revision, 0, 'a refused edit must not change anything');
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test hub_server/test/catalogRoutes.test.mjs`
Expected: FAIL — `/admin/*` routes return 404 HTML, so `res.json()` throws / statuses don't match.

- [ ] **Step 4: Add `requireReception`**

Append to `hub_server/lib/deviceAuth.js`:

```js

/**
 * Menu and table editing is limited to the reception laptop. Enrolled waiter
 * handsets hold a 30-day token, so a token is deliberately NOT enough here.
 */
export function requireReception(req, res, next) {
  if (isLoopback(req)) return next();

  return res.status(403).json({
    success: false,
    error: 'Menu and table editing is only available on the reception laptop.',
    code: 'RECEPTION_ONLY'
  });
}
```

- [ ] **Step 5: Wire imports and the body-limit mount in `server.js`**

Change the `deviceAuth` import (line 27) to also import the guard:

```js
import { deviceAuth, requireDevice, requireReception, extractToken, isLoopback, trustLocalAddress } from './lib/deviceAuth.js';
```

Add these imports directly below the `waiterStore` import (line 23):

```js
import { addItem, updateItem, deleteItem, addCategory, renameCategory, reorderCategories, deleteCategory } from './lib/menuAdmin.js';
import { previewImport, applyImport } from './lib/menuImport.js';
import { applyLayout } from './lib/tablesAdmin.js';
```

Replace line 53 (`app.use(express.json({ limit: '256kb' }));`) with:

```js
// Menu imports can carry up to 2000 rows with modifiers. Give just those routes a
// bigger body limit. This MUST be mounted before the global parser: the global one
// would reject anything over 256 KB first, and a body that is already parsed is
// skipped by the later parser.
app.use('/admin/menu/import', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '256kb' }));
```

- [ ] **Step 6: Apply the `MASTER_TABLES` fix and expose `sections` on `/tables`**

In `getLiveTables`, replace

```js
  const baseTables = (layoutData && layoutData.tables && layoutData.tables.length > 0) ? layoutData.tables : MASTER_TABLES;
```

with

```js
  // MASTER_TABLES is only the demo fallback for a hub that has never loaded a
  // layout. An initialised hub with zero tables (the restaurant deleted them all)
  // must stay empty rather than resurrect the demo floor.
  const baseTables = layoutData.uninitialized ? MASTER_TABLES : (layoutData.tables || []);
```

In the `GET /tables` handler, add `sections` to the response so it reads:

```js
  res.json({
    restaurant_id: pairing.restaurant_id,
    uninitialized: layout.uninitialized || false,
    count: liveTables.length,
    sections: layout.sections || [],
    tables: liveTables
  });
```

- [ ] **Step 7: Add the admin routes**

Insert this block in `server.js` immediately after the `GET /tables` handler (before `function buildPreviewForTable`):

```js
// -------------------------------------------------------------
// Admin catalog editing — reception laptop only (requireReception).
// Every write carries `base_revision` (JSON body, or query string for DELETE).
// -------------------------------------------------------------
function readBaseRevision(req) {
  const raw = req.body?.base_revision ?? req.query?.base_revision;
  return raw === undefined || raw === '' ? NaN : Number(raw);
}

function sendCatalogFailure(res, result) {
  return res.status(result.status).json({
    success: false,
    error: result.error,
    code: result.code,
    ...(result.errors ? { errors: result.errors } : {}),
    ...(result.details ? { details: result.details } : {}),
    ...(result.current_revision !== undefined ? { current_revision: result.current_revision } : {})
  });
}

async function commitMenu(req, res, mutator, { status = 200 } = {}) {
  const result = await restaurantCache.updateCatalog('menu', readBaseRevision(req), mutator);
  if (!result.ok) return sendCatalogFailure(res, result);

  const pairing = hubConfig.getPairingInfo();
  broadcast('menu_updated', restaurantCache.getMenuCache(pairing.restaurant_id));
  return res.status(status).json({ success: true, revision: result.data.revision, ...(result.meta || {}) });
}

app.post('/admin/menu/items', requireReception, (req, res) =>
  commitMenu(req, res, menu => addItem(menu, req.body?.item), { status: 201 }));

app.put('/admin/menu/items/:id', requireReception, (req, res) =>
  commitMenu(req, res, menu => updateItem(menu, req.params.id, req.body?.item)));

app.delete('/admin/menu/items/:id', requireReception, (req, res) =>
  commitMenu(req, res, menu => deleteItem(menu, req.params.id)));

app.post('/admin/menu/categories', requireReception, (req, res) =>
  commitMenu(req, res, menu => addCategory(menu, req.body?.name), { status: 201 }));

// Registered before any `/:name` style route would be: "order" is a path, not a category.
app.put('/admin/menu/categories/order', requireReception, (req, res) =>
  commitMenu(req, res, menu => reorderCategories(menu, req.body?.names)));

app.put('/admin/menu/categories', requireReception, (req, res) =>
  commitMenu(req, res, menu => renameCategory(menu, req.body?.from, req.body?.to)));

app.delete('/admin/menu/categories', requireReception, (req, res) =>
  commitMenu(req, res, menu => deleteCategory(menu, req.query?.name)));

app.post('/admin/menu/import/preview', requireReception, (req, res) => {
  const menu = restaurantCache.getMenuCache();
  if (menu.uninitialized) {
    return res.status(409).json({ success: false, error: menu.message, code: 'HUB_UNINITIALIZED' });
  }
  const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
  const result = previewImport(menu, req.body?.rows, { mode });
  if (!result.ok) return sendCatalogFailure(res, result);

  res.json({
    success: true,
    revision: menu.revision,
    counts: result.counts,
    rows: result.rows.map(({ item, ...row }) => row)
  });
});

app.post('/admin/menu/import/commit', requireReception, (req, res) => {
  const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace' && req.body?.confirm_replace !== true) {
    return res.status(400).json({
      success: false,
      error: 'Replacing the whole menu requires confirm_replace: true.',
      code: 'CONFIRM_REQUIRED'
    });
  }
  return commitMenu(req, res, menu =>
    applyImport(menu, req.body?.rows, { mode, skipInvalid: req.body?.skip_invalid === true }));
});

app.put('/admin/tables/layout', requireReception, async (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  // Tables with an open bill (matched the same loose way the floor grid does).
  const openTableIds = new Set(
    getLiveTables(pairing.restaurant_id).filter(t => t.status !== 'available').map(t => String(t.id))
  );

  const result = await restaurantCache.updateCatalog('tables', readBaseRevision(req),
    layout => applyLayout(layout, req.body, openTableIds));
  if (!result.ok) return sendCatalogFailure(res, result);

  broadcast('tables_updated', restaurantCache.getTablesCache(pairing.restaurant_id));
  res.json({ success: true, revision: result.data.revision, tables: result.data.tables, sections: result.data.sections });
});

```

- [ ] **Step 8: Run the integration tests**

Run: `node --test hub_server/test/catalogRoutes.test.mjs`
Expected: all 12 tests PASS. If the 2000-row test returns 413, the `/admin/menu/import` parser mount is below the global parser — move it above. If the WebSocket test times out, confirm the hub was started with `trustLoopback: true` (the `/live` upgrade needs a loopback or a token).

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: every file green. The existing `hub.test.mjs` fixtures have tables, so the `MASTER_TABLES` change must not affect them.

- [ ] **Step 10: Commit**

```bash
git add hub_server/lib/deviceAuth.js hub_server/server.js hub_server/test/helpers/spawnHub.mjs hub_server/test/catalogRoutes.test.mjs
git commit -m "feat(hub): reception-only admin routes for menu and table editing

Item, category, import and layout routes with base_revision checks, 2 MB
import parser ahead of the global limit, live broadcasts, sections on
/tables, and no demo-table resurrection on an initialised hub.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Waiter section chips follow the hub

**Files:**
- Modify: `src/waiter_mobile/FloorGrid.jsx:28-33`
- Modify: `src/waiter_mobile/WaiterApp.jsx` (state near line 81, `fetchLiveState` near line 110, `<FloorGrid>` near line 731)

**Interfaces:**
- Consumes: `sections: string[]` on the `GET /tables` response (Task 6).
- Produces: `FloorGrid` accepts an optional `sections` prop; chips are `['All', ...sections]`, falling back to the distinct sections of `tables` in first-seen order when the prop is empty or missing.

- [ ] **Step 1: Make `FloorGrid` derive its chips**

In `src/waiter_mobile/FloorGrid.jsx`, replace line 28 (the component signature) with:

```jsx
export const FloorGrid = ({ selectedTable, onSelectTable, tables: propTables, sections: propSections, onClearTableBill, isLoading = false, drafts = {}, onOpenPairing, hubConnected, connStatus, isEnrolled }) => {
```

Replace line 33 (`const sections = ['All', 'Main Hall', 'AC Room', 'Family Room'];`) with:

```jsx
  // Section chips follow what the hub reports (reception can add or rename
  // sections); fall back to the sections the tables themselves use.
  const sectionNames = propSections && propSections.length > 0
    ? propSections
    : Array.from(new Set(tables.map(t => t.section).filter(Boolean)));
  const sections = ['All', ...sectionNames];

  // A section renamed or removed while selected would leave an empty grid.
  React.useEffect(() => {
    if (selectedSection !== 'All' && !sectionNames.includes(selectedSection)) setSelectedSection('All');
  }, [sectionNames.join('|'), selectedSection]);
```

(The `useEffect` sits before the `if (isLoading) return …` early return, so hook order is unchanged.)

- [ ] **Step 2: Feed sections from the hub in `WaiterApp`**

In `src/waiter_mobile/WaiterApp.jsx`, directly after `const [liveTables, setLiveTables] = useState([]);` (line 81) add:

```jsx
  const [liveSections, setLiveSections] = useState([]);
```

In `fetchLiveState`, replace

```jsx
        if (data.tables && Array.isArray(data.tables)) setLiveTables(data.tables);
```

with

```jsx
        if (data.tables && Array.isArray(data.tables)) setLiveTables(data.tables);
        if (Array.isArray(data.sections)) setLiveSections(data.sections);
```

In the `<FloorGrid …>` element, replace

```jsx
                tables={liveTables} onClearTableBill={handleClearTableBill}
```

with

```jsx
                tables={liveTables} sections={liveSections} onClearTableBill={handleClearTableBill}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Vite build succeeds with no errors.

- [ ] **Step 4: Verify in the browser (manual; there is no UI test runner and none is claimed)**

Use a **throwaway copy of the hub data** so the developer's real, uncommitted `hub_server/data/*.json` is never touched (a layout save replaces the whole floor and rewrites `tables_cache.json`).

1. Start a hub on a temp data dir (needs the Step 3 build, which the hub serves at `/waiter`):

```bash
D=$(mktemp -d) && cp -r hub_server/data/. "$D" && HUB_DATA_DIR="$D" npm run hub
```

2. Open `http://localhost:4000/waiter` in the browser pane (localhost is the trusted loopback, so no enrolment is needed) and note the chips under the floor grid.
3. In a second terminal, add a section and a table while keeping every existing table:

```bash
node -e "const b='http://localhost:4000';(async()=>{const l=await (await fetch(b+'/tables/layout')).json();const body={base_revision:l.revision,sections:[...l.sections,'Patio'],tables:[...l.tables.map(({id,name,section,capacity})=>({id,name,section,capacity})),{name:'P1',section:'Patio',capacity:4}]};const r=await fetch(b+'/admin/tables/layout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});console.log(r.status,await r.text());})()"
```

   Expected output starts with `200`. (A `409 TABLE_HAS_OPEN_BILL` cannot happen here because no table is renamed or removed.)
4. Expected in the browser, without a reload: the chip row gains **Patio** after the existing sections and **P1** appears under it. Select **Patio**, then run the same command again with `'Patio'` removed from `sections` and `P1` removed from `tables` (change the script accordingly): the selection snaps back to **All**. Console is clean.
5. Stop the hub (Ctrl+C). Confirm `git status --short hub_server/data` shows only the files that were already modified before this task — the copy in `$D` took all the writes.

- [ ] **Step 5: Commit**

```bash
git add src/waiter_mobile/FloorGrid.jsx src/waiter_mobile/WaiterApp.jsx
git commit -m "feat(waiter): section chips follow the hub's sections

Replaces the hardcoded Main Hall/AC Room/Family Room chips so sections
added or renamed at reception show up live.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation and spec alignment

**Files:**
- Create: `Darshil_docs/reports/report_2026-10-02_150000_menu_tables_hub_write_layer.md`
- Modify: `Darshil_docs/README.md` (one index row)
- Modify: `docs/superpowers/specs/2026-10-02-menu-tables-module-design.md` (route table + notes)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Run the full verification and capture the output**

Run: `npm test` then `npm run build`.
Expected: all tests pass, build succeeds. Copy the final summary lines of each (the `# tests … # pass … # fail 0` block and Vite's "built in …" line) — you will paste them into the report in Step 2.

- [ ] **Step 2: Write the report**

Create `Darshil_docs/reports/report_2026-10-02_150000_menu_tables_hub_write_layer.md` with this structure, replacing the **Verification** block's contents with the real output captured in Step 1:

```markdown
# Menu & Tables · Phase 1 — Hub write layer

**Date:** 2026-10-02T15:00:00+05:30
**Branch:** `feat/menu-tables-admin`
**Spec:** `docs/superpowers/specs/2026-10-02-menu-tables-module-design.md`
**Plan:** `docs/superpowers/plans/2026-10-02-menu-tables-hub-write-layer.md`
**Scope:** Validated, revision-guarded, reception-only write routes for the menu and table layout. No UI (Phase 2) and no cloud push (Phase 3).

---

## WHY

Menu and tables were read-only on the hub: they were pulled from Supabase into `menu_cache.json` / `tables_cache.json`, and every online boot, reconnect and realtime event overwrote the cache. The old `SelfServeAdminView` editor was not in any built entry point and only edited React state, so no restaurant could actually change its menu or floor. A hub-side edit would also have been silently wiped by the next cloud pull. This phase adds the safe write path first, before any editing UI exists.

## WHAT

| File | Change |
|---|---|
| `hub_server/lib/menuNormalize.js` | **New.** Shared defensive normaliser, extracted verbatim from `restaurantCache` (golden-tested). |
| `hub_server/lib/restaurantCache.js` | `updateCatalog` (serialised, base-revision check, temp-then-rename write, rolling 10 backups), authority guard (`revision > 0` stops cloud pulls), `revision` and `sections` on the getters. |
| `hub_server/lib/menuAdmin.js` | **New.** Pure item CRUD (strict validation, merge-style update) and category add/rename/reorder/delete. |
| `hub_server/lib/menuImport.js` | **New.** Import preview/apply: merge and replace, blank-cell preservation, variant id retention, required `veg` for new items. |
| `hub_server/lib/tablesAdmin.js` | **New.** Whole-layout save: unique names, section list, never-reused ids, open-bill lock. |
| `hub_server/lib/deviceAuth.js` | `requireReception` guard (403 `RECEPTION_ONLY`). |
| `hub_server/server.js` | `/admin/*` routes, 2 MB import parser ahead of the 256 KB global one, `sections` on `/tables`, `MASTER_TABLES` fallback only for an uninitialised hub, `menu_updated` / `tables_updated` broadcasts. |
| `src/waiter_mobile/FloorGrid.jsx`, `WaiterApp.jsx` | Section chips follow the hub instead of a hardcoded list. |
| `.gitignore` | Ignore `hub_server/data/backups/`. |
| `hub_server/test/*.test.mjs` | New: `menuNormalize`, `catalogStore`, `menuAdmin`, `menuImport`, `tablesAdmin`, `catalogRoutes` (+ `helpers/spawnHub.mjs`). |

Known limitations: an offline first boot with no catalog returns 409 `HUB_UNINITIALIZED` for edits; `PUT /admin/menu/items/:id` merges the keys sent.

## TEST CASES

| ID | Title | Pre-conditions | Steps | Expected |
|---|---|---|---|---|
| MT1-01 | Normaliser golden | none | `node --test hub_server/test/menuNormalize.test.mjs` | Output identical to the previous inline mapper |
| MT1-02 | Authority guard | tables edited (revision 1) | `handleReconnection` with stubbed cloud fetch | Edited catalog not pulled; untouched one still follows the cloud |
| MT1-03 | Stale revision | menu at revision 1 | POST item with `base_revision: 0` | 409 `STALE_REVISION` with `current_revision: 1`, nothing written |
| MT1-04 | Concurrent edits | two writes on the same base | `Promise.all` of two `updateCatalog` calls | Exactly one succeeds |
| MT1-05 | Backups | 13 edits | Count `backups/menu_cache.*` | 10 kept |
| MT1-06 | Reception only | handset enrolled with a token | Call every `/admin/*` route | 403 `RECEPTION_ONLY`; menu unchanged |
| MT1-07 | Big import | 2000 rows over 256 KB | POST import preview | 200; 2001 rows → 400 `TOO_MANY_ROWS` |
| MT1-08 | Import rules | menu with variants/modifiers | merge, replace, blank cells, error rows | Matches the spec rules; bad rows never delete items |
| MT1-09 | Open-bill lock | open ticket on T1 | rename/delete T1 vs move/reseat T1 | 409 `TABLE_HAS_OPEN_BILL` vs 200 |
| MT1-10 | No demo resurrection | layout with zero tables | PUT empty layout, GET `/tables` | `count: 0` |
| MT1-11 | Live broadcast | WebSocket client on `/live` | commit a layout and a category | `tables_updated`, `menu_updated` received |
| MT1-12 | Waiter chips (manual) | hub + waiter app | add a "Patio" section via the API | Chip appears without reload; removing it resets selection to All |

## VERIFICATION

(Paste the real `npm test` and `npm run build` summary lines captured in Step 1 here.)
```

- [ ] **Step 3: Add the README index row**

In `Darshil_docs/README.md`, insert this row **between** the `2026-10-03T12:00:00+05:30` row and the `2026-10-02T12:00:00+05:30` row (the table is newest-first):

```markdown
| 2026-10-02T15:00:00+05:30 | [`report_2026-10-02_150000_menu_tables_hub_write_layer.md`](./reports/report_2026-10-02_150000_menu_tables_hub_write_layer.md) | Menu & Tables · Phase 1 Hub Write Layer: reception-only `/admin` routes for menu items, categories, CSV-row import and whole-floor layout saves; revision-guarded atomic writes with 10 rolling backups; cloud pulls no longer overwrite a catalog once edited on the hub; open-bill lock on table rename/delete; dynamic waiter section chips; shared menu normaliser | ✅ VERIFIED & COMMITTED |
```

- [ ] **Step 4: Align the spec with what was built**

In `docs/superpowers/specs/2026-10-02-menu-tables-module-design.md`, replace the line

```markdown
| `POST /admin/menu/categories`, `PUT /admin/menu/categories/order` | Add, rename (re-labels items), reorder, delete (only when empty) |
```

with

```markdown
| `POST /admin/menu/categories`, `PUT /admin/menu/categories` (`{from,to}`), `PUT /admin/menu/categories/order`, `DELETE /admin/menu/categories?name=` | Add, rename (re-labels items), reorder, delete (only when empty) |
```

and replace the sentence

```markdown
The import routes get their own 2 MB JSON parser mounted **ahead of** the global 256 KB parser (a body already parsed is skipped by the later one).
```

with

```markdown
The import routes get their own 2 MB JSON parser mounted **ahead of** the global 256 KB parser (a body already parsed is skipped by the later one).

Writes require `base_revision` (JSON body, or query string for DELETE); a missing value returns 400 `BASE_REVISION_REQUIRED`. `PUT /admin/menu/items/:id` merges the keys you send and preserves the rest (send `[]` to clear variants, modifier groups or day-parts). `import/commit` with mode `replace` additionally requires `confirm_replace: true` (else 400 `CONFIRM_REQUIRED`). A hub that has never loaded a catalog returns 409 `HUB_UNINITIALIZED` for edits until it has been online once.
```

- [ ] **Step 5: Commit**

```bash
git add Darshil_docs/reports/report_2026-10-02_150000_menu_tables_hub_write_layer.md Darshil_docs/README.md docs/superpowers/specs/2026-10-02-menu-tables-module-design.md
git commit -m "docs: Phase 1 report, README index row, spec route alignment

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Final check**

Run: `git status --short`
Expected: only the pre-existing unstaged `hub_server/data/*.json` changes remain; nothing from this plan is left uncommitted and no `hub_server/data` file was ever staged.
