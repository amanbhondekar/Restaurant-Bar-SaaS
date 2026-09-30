import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, checkSupabaseConnection } from './supabaseClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');

const MENU_CACHE_FILE = path.join(DATA_DIR, 'menu_cache.json');
const TABLES_CACHE_FILE = path.join(DATA_DIR, 'tables_cache.json');

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
    id: 'm1', name: 'Paneer Butter Masala', category: 'Main Course', isVeg: true, available: true,
    price: 280,
    variants: [
      { id: 'v_half', label: 'Half', price: 180 },
      { id: 'v_full', label: 'Full', price: 280 }
    ]
  },
  { id: 'm2', name: 'Dal Tadka', price: 190, category: 'Main Course', isVeg: true, available: true },
  {
    id: 'm3', name: 'Chicken Tikka Masala', category: 'Main Course', isVeg: false, available: true,
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
    id: 'm4', name: 'Butter Naan', price: 45, category: 'Breads & Rice', isVeg: true, available: true,
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
    id: 'm5', name: 'Jeera Rice', category: 'Breads & Rice', isVeg: true, available: true,
    price: 140,
    variants: [
      { id: 'v_half', label: 'Half', price: 90 },
      { id: 'v_full', label: 'Full', price: 140 }
    ]
  },
  { id: 'm6', name: 'Veg Crispy', price: 220, category: 'Starters', isVeg: true, available: true },
  {
    id: 'm7', name: 'Chicken 65', category: 'Starters', isVeg: false, available: true,
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
  { id: 'm8', name: 'Gulab Jamun (2 pcs)', price: 90, category: 'Desserts', isVeg: true, available: true, station: 'cold' },
  {
    // Bar-line item: beverages fire to the bar station's KOT/KDS view.
    id: 'm9', name: 'Masala Chaas', price: 50, category: 'Beverages', isVeg: true, available: true, station: 'bar',
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
  }

  loadFromDisk() {
    let hasMenu = false;
    let hasTables = false;

    try {
      if (fs.existsSync(MENU_CACHE_FILE)) {
        const rawMenu = fs.readFileSync(MENU_CACHE_FILE, 'utf-8');
        this.menuCache = JSON.parse(rawMenu);
        hasMenu = Boolean(this.menuCache && (this.menuCache.items?.length > 0 || this.menuCache.categories?.length > 0));
      }
    } catch (err) {
      console.warn('⚠️ Could not load menu_cache.json from disk:', err.message);
    }

    try {
      if (fs.existsSync(TABLES_CACHE_FILE)) {
        const rawTables = fs.readFileSync(TABLES_CACHE_FILE, 'utf-8');
        this.tablesCache = JSON.parse(rawTables);
        hasTables = Boolean(this.tablesCache && this.tablesCache.tables?.length > 0);
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
      let items = (itemData && itemData.length) ? itemData.map(i => {
        // Variants ship as JSONB from Supabase (`variants: [{ id, label, price }]`).
        // Fall back to the top-level price if nothing valid comes through.
        const rawVariants = Array.isArray(i.variants) ? i.variants : [];
        const variants = rawVariants
          .filter(v => v && v.id && v.label && Number.isFinite(Number(v.price)))
          .map(v => ({
            id: String(v.id),
            label: String(v.label).slice(0, 40),
            price: Number(v.price),
            // Per-variant availability (M2 · PR 14). Legacy variants without
            // the field default to true; only an explicit `false` marks 86'd.
            available: v.available !== false
          }));
        // Modifier groups ship as JSONB (`modifier_groups: [{ id, label, min,
        // max, options: [{ id, label, price_delta }] }]`). Every level is
        // defensively normalised so a partial row never crashes the pricer;
        // an option missing a numeric price_delta is dropped, a group missing
        // an id or label is dropped, and the group is only kept when it has
        // at least one valid option.
        const rawGroups = Array.isArray(i.modifier_groups) ? i.modifier_groups : [];
        const modifier_groups = rawGroups
          .map(g => {
            if (!g || !g.id || !g.label) return null;
            const options = (Array.isArray(g.options) ? g.options : [])
              .filter(o => o && o.id && o.label && Number.isFinite(Number(o.price_delta)))
              .map(o => ({
                id: String(o.id),
                label: String(o.label).slice(0, 40),
                price_delta: Number(o.price_delta),
                // Per-option availability (M2 · PR 14). Same default-true
                // discipline as variants — only explicit `false` marks 86'd.
                available: o.available !== false
              }));
            if (options.length === 0) return null;
            const min = Number.isFinite(Number(g.min)) ? Math.max(0, Math.floor(Number(g.min))) : 0;
            const max = Number.isFinite(Number(g.max)) ? Math.max(min, Math.floor(Number(g.max))) : options.length;
            return { id: String(g.id), label: String(g.label).slice(0, 40), min, max, options };
          })
          .filter(Boolean);
        // Day-parts ship as JSONB (`day_parts: [{ id, label, starts_at,
        // ends_at, days?, price?, variant_prices? }]`). Same defensive
        // normalisation as modifier_groups — a window missing a valid
        // HH:MM range is dropped so lib/dayParts.js never has to guard.
        const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
        const rawDayParts = Array.isArray(i.day_parts) ? i.day_parts : [];
        const day_parts = rawDayParts
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
            // A window with neither `price` nor `variant_prices` is useless
            // — drop it rather than let the pricer silently fall back.
            if (out.price === undefined && !out.variant_prices) return null;
            return out;
          })
          .filter(Boolean);
        // Station routing (M2 · PR 15): 'hot' | 'cold' | 'bar' | (default
        // 'hot' when the column is missing / unknown). Whitelist happens
        // in lib/kotRouting.js at read time, so a mistagged row still
        // fires to the main kitchen rather than into an unlabeled queue.
        const station = i.station ? String(i.station).toLowerCase() : undefined;
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
      }) : [];

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
          .order('id', { ascending: true });
        tablesData = res.data;
      } catch (e) {}

      let tables = (tablesData && tablesData.length) ? tablesData.map((t, idx) => ({
        id: t.id || (idx + 1),
        name: t.name || `T${idx + 1}`,
        section: t.section || 'Main Dining',
        capacity: Number(t.capacity) || 4
      })) : DEFAULT_TABLES;

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
      const freshMenu = await this.fetchMenuFromSupabase(restaurantId);
      const freshTables = await this.fetchTablesFromSupabase(restaurantId);

      if (freshMenu) {
        await this.saveMenuToDisk(freshMenu);
        if (broadcastFn) broadcastFn('menu_updated', freshMenu);
      }

      if (freshTables) {
        await this.saveTablesToDisk(freshTables);
        if (broadcastFn) broadcastFn('tables_updated', freshTables);
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
          console.log('🔔 Supabase Realtime: menu_items change detected! Refreshing local cache & broadcasting live...');
          const fresh = await this.fetchMenuFromSupabase(restaurantId);
          if (fresh) {
            await this.saveMenuToDisk(fresh);
            if (broadcastFn) broadcastFn('menu_updated', fresh);
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_categories' }, async () => {
          console.log('🔔 Supabase Realtime: menu_categories change detected! Refreshing local cache & broadcasting live...');
          const fresh = await this.fetchMenuFromSupabase(restaurantId);
          if (fresh) {
            await this.saveMenuToDisk(fresh);
            if (broadcastFn) broadcastFn('menu_updated', fresh);
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, async () => {
          console.log('🔔 Supabase Realtime: tables change detected! Refreshing local cache & broadcasting live...');
          const fresh = await this.fetchTablesFromSupabase(restaurantId);
          if (fresh) {
            await this.saveTablesToDisk(fresh);
            if (broadcastFn) broadcastFn('tables_updated', fresh);
          }
        })
        .subscribe((status) => {
          console.log(`📡 Supabase Realtime subscription status for menu/tables: ${status}`);
        });
    } catch (err) {
      console.warn('⚠️ Realtime subscription setup failed:', err.message);
    }
  }

  getMenuCache(restaurantId) {
    if (this.isUninitialized || !this.menuCache) {
      return {
        uninitialized: true,
        error: 'NO_CACHE_AND_OFFLINE',
        message: 'No menu data available — connect this hub to the internet once to complete setup.',
        restaurant_id: restaurantId,
        categories: [],
        items: []
      };
    }
    return {
      ...this.menuCache,
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
        count: 0,
        tables: []
      };
    }
    return {
      ...this.tablesCache,
      uninitialized: false
    };
  }
}

export const restaurantCache = new RestaurantCache();
