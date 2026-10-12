import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, checkSupabaseConnection } from './supabaseClient.js';
import { normalizeCloudMenuItem } from './menuNormalize.js';
import { tablesFromCloud } from './catalogSync.js';
import { applyPlanToMenuItems } from './plans.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');

const MENU_CACHE_FILE = path.join(DATA_DIR, 'menu_cache.json');
const TABLES_CACHE_FILE = path.join(DATA_DIR, 'tables_cache.json');
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

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Fallback seed data if Supabase tables don't exist or DB is unpopulated on first online boot
const DEFAULT_CATEGORIES = ['Starters', 'Main Course', 'Breads & Rice', 'Desserts', 'Beverages'];
const DEFAULT_MENU_ITEMS = [
  // Items with variants ship a `variants: [{ id, label, price }]` array. When
  // a variant array is present, the handset MUST pick one — the top-level
  // `price` acts as a display fallback only and is ignored by lib/pricing.js.
  //
  // Items with `modifier_groups: [{ id, label, min, max, options: [{ id,
  // label, price_delta }] }]` compose on the same shape (M2 · PR 12). Each
  // group with min>=1 is required; picks over `max` are rejected server-side.
  // price_delta applies per unit and is added to the variant/base price.
  // Modifier groups and variants stack: Chicken Tikka Masala (Full) + Extra
  // Cheese = 340 + 40 = ₹380/unit.
  {
    id: 'm1', name: 'Paneer Butter Masala', category: 'Main Course', isVeg: true, available: true, course: 2,
    price: 280,
    variants: [
      { id: 'v_half', label: 'Half', price: 180 },
      { id: 'v_full', label: 'Full', price: 280 }
    ]
  },
  { id: 'm2', name: 'Dal Tadka', price: 190, category: 'Main Course', isVeg: true, available: true, course: 2 },
  {
    id: 'm3', name: 'Chicken Tikka Masala', category: 'Main Course', isVeg: false, available: true, course: 2,
    price: 340,
    variants: [
      { id: 'v_half', label: 'Half', price: 220 },
      { id: 'v_full', label: 'Full', price: 340 }
    ],
    modifier_groups: [
      {
        id: 'mg_spice', label: 'Spice level', min: 1, max: 1,
        options: [
          { id: 'mild',   label: 'Mild',   price_delta: 0 },
          { id: 'medium', label: 'Medium', price_delta: 0 },
          { id: 'hot',    label: 'Hot',    price_delta: 0 }
        ]
      },
      {
        id: 'mg_extras', label: 'Extras', min: 0, max: 3,
        options: [
          { id: 'extra_cheese', label: 'Extra cheese',  price_delta: 40 },
          // Extra gravy is 86'd for the demo — sheet renders it disabled
          // with an "86'd" tag; hub rejects any stale attempt.
          { id: 'extra_gravy',  label: 'Extra gravy',   price_delta: 30, available: false },
          { id: 'no_onion',     label: 'No onion',      price_delta: 0 },
          { id: 'no_cream',     label: 'No cream',      price_delta: 0 }
        ]
      }
    ]
  },
  {
    id: 'm4', name: 'Butter Naan', price: 45, category: 'Breads & Rice', isVeg: true, available: true, course: 2,
    // Day-part pricing (M2 · PR 13): breakfast promotion drops naan to ₹35
    // between 07:00 and 11:00 every day. Legacy items with no `day_parts`
    // behave exactly as before — the pricer just resolves to the base price.
    day_parts: [
      {
        id: 'dp_breakfast', label: 'Breakfast',
        starts_at: '07:00', ends_at: '11:00',
        price: 35
      }
    ]
  },
  {
    id: 'm5', name: 'Jeera Rice', category: 'Breads & Rice', isVeg: true, available: true, course: 2,
    price: 140,
    variants: [
      { id: 'v_half', label: 'Half', price: 90 },
      { id: 'v_full', label: 'Full', price: 140 }
    ]
  },
  { id: 'm6', name: 'Veg Crispy', price: 220, category: 'Starters', isVeg: true, available: true, course: 1 },
  {
    id: 'm7', name: 'Chicken 65', category: 'Starters', isVeg: false, available: true, course: 1,
    price: 290,
    variants: [
      // Boneless is temporarily 86'd (M2 · PR 14 demo). Reception sees the
      // row disabled with an "86'D" chip; the row can't be tapped and the
      // hub rejects any stale-menu attempt with VARIANT_UNAVAILABLE.
      { id: 'v_boneless', label: 'Boneless', price: 320, available: false },
      { id: 'v_bone_in',  label: 'Bone-in',  price: 290 }
    ]
  },
  // Cold-line item: desserts fire to a separate KOT so the pastry
  // station doesn't share a printer queue with the hot line (M2 · PR 15).
  { id: 'm8', name: 'Gulab Jamun (2 pcs)', price: 90, category: 'Desserts', isVeg: true, available: true, course: 3, station: 'cold' },
  {
    // Bar-line item: beverages fire to the bar station's KOT/KDS view.
    id: 'm9', name: 'Masala Chaas', price: 50, category: 'Beverages', isVeg: true, available: true, course: 1, station: 'bar',
    modifier_groups: [
      {
        id: 'mg_sweet', label: 'Sweetness', min: 1, max: 1,
        options: [
          { id: 'regular',    label: 'Regular',    price_delta: 0 },
          { id: 'less_sweet', label: 'Less sweet', price_delta: 0 },
          { id: 'no_sugar',   label: 'No sugar',   price_delta: 0 }
        ]
      }
    ],
    // Weekday happy hour 4-6 PM: ₹40 instead of ₹50. Sunday/Saturday keep
    // full price. Modifier deltas still apply on top — the pricer resolves
    // the effective base first, then folds modifiers.
    day_parts: [
      {
        id: 'dp_happy_hour', label: 'Happy hour',
        starts_at: '16:00', ends_at: '18:00',
        days: [1, 2, 3, 4, 5],
        price: 40
      }
    ]
  },
];

const DEFAULT_TABLES = [
  { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
  { id: 2, name: 'T2', section: 'Main Hall', capacity: 2 },
  { id: 3, name: 'T3', section: 'Main Hall', capacity: 4 },
  { id: 4, name: 'T4', section: 'Main Hall', capacity: 4 },
  { id: 5, name: 'T5', section: 'Main Hall', capacity: 6 },
  { id: 6, name: 'T6', section: 'Main Hall', capacity: 6 },
  { id: 7, name: 'T7', section: 'AC Room', capacity: 4 },
  { id: 8, name: 'T8', section: 'AC Room', capacity: 4 },
  { id: 9, name: 'T9', section: 'AC Room', capacity: 6 },
  { id: 10, name: 'T10', section: 'Family Room', capacity: 8 },
  { id: 11, name: 'T11', section: 'Family Room', capacity: 8 },
  { id: 12, name: 'T12', section: 'Family Room', capacity: 10 },
];

class RestaurantCache {
  constructor() {
    this.menuCache = null;
    this.tablesCache = null;
    this.isUninitialized = false;
    this.realtimeChannel = null;
    this._writeChain = Promise.resolve();
    this._backupSeq = 0;
    // Returns the effective plan's feature flags (see lib/plans.js). Wired by
    // server.js; the default grants everything so unit tests and tools that
    // use the cache standalone see the full menu.
    this.featureProvider = () => null;
  }

  setFeatureProvider(fn) {
    this.featureProvider = typeof fn === 'function' ? fn : () => null;
  }

  loadFromDisk() {
    // A catalog edited on the hub (revision > 0) is real even when the owner has emptied it;
    // only legacy cloud-written caches (no revision) are judged by whether they hold rows.
    let hasMenu = false;
    let hasTables = false;

    try {
      if (fs.existsSync(MENU_CACHE_FILE)) {
        const rawMenu = fs.readFileSync(MENU_CACHE_FILE, 'utf-8');
        this.menuCache = JSON.parse(rawMenu);
        hasMenu = Boolean(this.menuCache && ((this.menuCache.revision || 0) > 0 || this.menuCache.items?.length > 0 || this.menuCache.categories?.length > 0));
      }
    } catch (err) {
      console.warn('⚠️ Could not load menu_cache.json from disk:', err.message);
    }

    try {
      if (fs.existsSync(TABLES_CACHE_FILE)) {
        const rawTables = fs.readFileSync(TABLES_CACHE_FILE, 'utf-8');
        this.tablesCache = JSON.parse(rawTables);
        hasTables = Boolean(this.tablesCache && ((this.tablesCache.revision || 0) > 0 || this.tablesCache.tables?.length > 0));
      }
    } catch (err) {
      console.warn('⚠️ Could not load tables_cache.json from disk:', err.message);
    }

    return { hasMenu, hasTables };
  }

  async saveMenuToDisk(menuData) {
    this.menuCache = menuData;
    try {
      await fs.promises.writeFile(MENU_CACHE_FILE, JSON.stringify(menuData, null, 2), 'utf-8');
      console.log(`💾 Saved menu_cache.json to disk (${menuData.items?.length || 0} items)`);
      return true;
    } catch (err) {
      console.error('❌ Failed to save menu_cache.json:', err);
      return false;
    }
  }

  async saveTablesToDisk(tablesData) {
    this.tablesCache = tablesData;
    try {
      await fs.promises.writeFile(TABLES_CACHE_FILE, JSON.stringify(tablesData, null, 2), 'utf-8');
      console.log(`💾 Saved tables_cache.json to disk (${tablesData.tables?.length || 0} tables)`);
      return true;
    } catch (err) {
      console.error('❌ Failed to save tables_cache.json:', err);
      return false;
    }
  }

  /**
   * Once a catalog has been edited on the hub (revision > 0) it is authoritative:
   * boot sync, reconnect and realtime events must not overwrite it. That holds only for
   * the restaurant it was edited for. A catalog recording a different restaurant_id than
   * the one being pulled belongs to an earlier pairing (POST /pair), and keeping it would
   * serve that restaurant's menu and prices to this one. A catalog with no restaurant_id
   * (legacy) counts as this restaurant's, and so does any pull whose restaurant is unknown:
   * an edit is only ever replaced when the pulled data positively belongs to someone else.
   */
  isHubAuthoritative(kind, restaurantId) {
    const cache = kind === 'menu' ? this.menuCache : this.tablesCache;
    if ((cache?.revision || 0) <= 0) return false;
    const owner = cache.restaurant_id;
    return !owner || !restaurantId || String(owner) === String(restaurantId);
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

    // Do not trust what the mutator handed back. The chain is shared by every edit and every
    // cloud pull, so a promise that never settles must not be returned from here (it would
    // wedge them all), and a result without the right shape must not be written.
    const malformed = () => failure(500, 'MUTATION_FAILED', 'The edit could not be applied. Nothing was changed.');
    if (typeof result?.then === 'function') {
      Promise.resolve(result).catch(() => {}); // nobody will await it: swallow a later rejection
      return malformed();
    }
    if (result === null || typeof result !== 'object') return malformed();
    if (result.ok !== true) {
      return Number.isInteger(result.status) && typeof result.code === 'string' ? result : malformed();
    }
    const arrays = kind === 'menu' ? ['items', 'categories'] : ['tables'];
    if (!result.data || typeof result.data !== 'object' || !arrays.every(k => Array.isArray(result.data[k]))) {
      return malformed();
    }

    const next = { ...result.data, revision: current.revision + 1, source: 'hub', uninitialized: false };
    const file = CATALOG_FILES[kind];
    try {
      await this._backupFile(file);
      const tmp = `${file}.tmp`;
      // Flush the temp file to disk before it replaces the real one. Renaming an unsynced file
      // can leave an empty cache after a power cut, and an empty cache silently gives up hub
      // authority on the next online boot.
      const fh = await fs.promises.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(next, null, 2), 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
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

  /**
   * The only way cloud data may enter the cache. It runs in the same write chain as
   * updateCatalog and re-checks authority at the moment of writing, so a pull that was
   * already in flight when a hub edit committed loses instead of overwriting it.
   * Resolves true if the data was applied; callers broadcast only then.
   */
  applyPulledCatalog(kind, fresh) {
    const run = this._writeChain.then(async () => {
      if (this.isHubAuthoritative(kind, fresh?.restaurant_id)) return false;

      // Past the check above, a catalog that was edited on the hub is about to be replaced
      // because it belongs to another restaurant. Keep a copy first; if that is not possible,
      // leave it alone rather than destroy the only copy of someone's edits.
      const cache = kind === 'menu' ? this.menuCache : this.tablesCache;
      if ((cache?.revision || 0) > 0) {
        try {
          await this._backupFile(CATALOG_FILES[kind]);
        } catch (err) {
          console.warn(`⚠️ Not replacing the ${kind} catalog edited on this hub for another restaurant: its backup failed (${err.message}).`);
          return false;
        }
      }

      if (kind === 'menu') await this.saveMenuToDisk(fresh);
      else await this.saveTablesToDisk(fresh);
      return true;
    });
    this._writeChain = run.catch(() => {});
    return run;
  }

  async fetchMenuFromSupabase(restaurantId) {
    try {
      let catData = null;
      let itemData = null;

      try {
        const catRes = await supabase
          .from('menu_categories')
          .select('*')
          .eq('restaurant_id', restaurantId)
          .order('display_order', { ascending: true });
        catData = catRes.data;
      } catch (e) {}

      try {
        const itemRes = await supabase
          .from('menu_items')
          .select('*')
          .eq('restaurant_id', restaurantId);
        itemData = itemRes.data;
      } catch (e) {}

      let categories = (catData && catData.length) ? catData.map(c => c.name || c) : [];
      // hub_ref is the id the hub gave the item; rows written before it existed fall back to the cloud id.
      let items = (itemData && itemData.length)
        ? itemData.map(row => normalizeCloudMenuItem({ ...row, id: row.hub_ref || row.id }))
        : [];

      // Fallback to default seed if Supabase table returns empty
      if (!categories.length && !items.length) {
        categories = DEFAULT_CATEGORIES;
        items = DEFAULT_MENU_ITEMS;
      } else if (!categories.length && items.length) {
        categories = Array.from(new Set(items.map(i => i.category)));
      }

      return {
        restaurant_id: restaurantId,
        categories,
        items,
        last_synced_at: new Date().toISOString(),
        uninitialized: false
      };
    } catch (err) {
      console.warn('⚠️ Supabase menu fetch exception:', err.message);
      return null;
    }
  }

  async fetchTablesFromSupabase(restaurantId) {
    try {
      let tablesData = null;
      try {
        const res = await supabase
          .from('tables')
          .select('*')
          .eq('restaurant_id', restaurantId)
          // The hub writes display_order from its layout order on every push; id breaks ties for rows
          // that never had one.
          .order('display_order', { ascending: true })
          .order('id', { ascending: true });
        tablesData = res.data;
      } catch (e) {}

      let tables = (tablesData && tablesData.length) ? tablesFromCloud(tablesData) : DEFAULT_TABLES;

      return {
        restaurant_id: restaurantId,
        count: tables.length,
        tables,
        last_synced_at: new Date().toISOString(),
        uninitialized: false
      };
    } catch (err) {
      console.warn('⚠️ Supabase tables fetch exception:', err.message);
      return null;
    }
  }

  async initCache(restaurantId, broadcastFn) {
    console.log(`📦 Initializing Hub Local Menu & Table Layout Cache for restaurant '${restaurantId}'...`);
    const { hasMenu, hasTables } = this.loadFromDisk();

    // Check internet connectivity
    const conn = await checkSupabaseConnection();
    const isOnline = conn.online;

    if (isOnline) {
      console.log('🌐 Hub is ONLINE at boot. Synchronizing menu & table layout snapshot from Supabase...');
      const freshMenu = this.isHubAuthoritative('menu', restaurantId) ? null : await this.fetchMenuFromSupabase(restaurantId);
      const freshTables = this.isHubAuthoritative('tables', restaurantId) ? null : await this.fetchTablesFromSupabase(restaurantId);

      if (freshMenu) {
        const applied = await this.applyPulledCatalog('menu', freshMenu);
        if (applied && broadcastFn) broadcastFn('menu_updated', freshMenu);
      }

      if (freshTables) {
        const applied = await this.applyPulledCatalog('tables', freshTables);
        if (applied && broadcastFn) broadcastFn('tables_updated', freshTables);
      }

      this.isUninitialized = false;
      this.subscribeRealtime(restaurantId, broadcastFn);
    } else {
      console.warn('⚡ Hub is OFFLINE at boot. Checking local cache files...');
      if (hasMenu && hasTables) {
        console.log(`✅ Loaded existing menu & tables cache from disk. (Menu items: ${this.menuCache?.items?.length}, Tables: ${this.tablesCache?.tables?.length})`);
        this.isUninitialized = false;
      } else {
        console.error('🚨 UNINITIALIZED HUB FAILURE STATE: No local cache files and no internet connection at boot!');
        this.isUninitialized = true;
      }
    }
  }

  subscribeRealtime(restaurantId, broadcastFn) {
    if (this.realtimeChannel) {
      try { supabase.removeChannel(this.realtimeChannel); } catch (e) {}
    }

    try {
      this.realtimeChannel = supabase.channel(`hub-cache-${restaurantId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items' }, async () => {
          if (this.isHubAuthoritative('menu', restaurantId)) return;
          console.log('🔔 Supabase Realtime: menu_items change detected! Refreshing local cache & broadcasting live...');
          const fresh = await this.fetchMenuFromSupabase(restaurantId);
          if (fresh) {
            const applied = await this.applyPulledCatalog('menu', fresh);
            if (applied && broadcastFn) broadcastFn('menu_updated', fresh);
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_categories' }, async () => {
          if (this.isHubAuthoritative('menu', restaurantId)) return;
          console.log('🔔 Supabase Realtime: menu_categories change detected! Refreshing local cache & broadcasting live...');
          const fresh = await this.fetchMenuFromSupabase(restaurantId);
          if (fresh) {
            const applied = await this.applyPulledCatalog('menu', fresh);
            if (applied && broadcastFn) broadcastFn('menu_updated', fresh);
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, async () => {
          if (this.isHubAuthoritative('tables', restaurantId)) return;
          console.log('🔔 Supabase Realtime: tables change detected! Refreshing local cache & broadcasting live...');
          const fresh = await this.fetchTablesFromSupabase(restaurantId);
          if (fresh) {
            const applied = await this.applyPulledCatalog('tables', fresh);
            if (applied && broadcastFn) broadcastFn('tables_updated', fresh);
          }
        })
        .subscribe((status) => {
          console.log(`📡 Supabase Realtime subscription status for menu/tables: ${status}`);
        });
    } catch (err) {
      console.warn('⚠️ Realtime subscription setup failed:', err.message);
    }
  }

  async handleReconnection(restaurantId, broadcastFn) {
    console.log(`🌐 Hub reconnected online! Fetching latest menu & table snapshot from Supabase...`);
    try {
      const freshMenu = this.isHubAuthoritative('menu', restaurantId) ? null : await this.fetchMenuFromSupabase(restaurantId);
      const freshTables = this.isHubAuthoritative('tables', restaurantId) ? null : await this.fetchTablesFromSupabase(restaurantId);

      if (freshMenu) {
        const applied = await this.applyPulledCatalog('menu', freshMenu);
        if (applied && broadcastFn) broadcastFn('menu_updated', freshMenu);
      }

      if (freshTables) {
        const applied = await this.applyPulledCatalog('tables', freshTables);
        if (applied && broadcastFn) broadcastFn('tables_updated', freshTables);
      }

      this.isUninitialized = false;
      this.subscribeRealtime(restaurantId, broadcastFn);
      console.log(`✅ Hub cache successfully synchronized with cloud upon reconnection.`);
    } catch (err) {
      console.error(`❌ Error during reconnection cache sync:`, err.message);
    }
  }

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
    // Plan gating (M3 · PR 16): fields the tenant's plan doesn't include are
    // stripped here, at the single read point shared by GET /menu and the
    // order pricer, so handsets and billing always agree on what's sellable.
    const features = this.featureProvider();
    const items = features
      ? applyPlanToMenuItems(this.menuCache.items, features)
      : this.menuCache.items;
    return {
      ...this.menuCache,
      revision: this.menuCache.revision || 0,
      ...(items !== this.menuCache.items ? { items } : {}),
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
}

export const restaurantCache = new RestaurantCache();
