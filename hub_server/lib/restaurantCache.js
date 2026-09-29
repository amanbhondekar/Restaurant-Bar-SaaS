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
    ]
  },
  { id: 'm4', name: 'Butter Naan', price: 45, category: 'Breads & Rice', isVeg: true, available: true },
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
      { id: 'v_boneless', label: 'Boneless', price: 320 },
      { id: 'v_bone_in',  label: 'Bone-in',  price: 290 }
    ]
  },
  { id: 'm8', name: 'Gulab Jamun (2 pcs)', price: 90, category: 'Desserts', isVeg: true, available: true },
  { id: 'm9', name: 'Masala Chaas', price: 50, category: 'Beverages', isVeg: true, available: true },
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
          .map(v => ({ id: String(v.id), label: String(v.label).slice(0, 40), price: Number(v.price) }));
        return {
          id: i.id,
          name: i.name,
          price: Number(i.price) || 0,
          category: i.category || i.category_name || 'General',
          isVeg: i.is_veg !== undefined ? Boolean(i.is_veg) : Boolean(i.isVeg ?? true),
          available: i.available !== undefined ? Boolean(i.available) : true,
          ...(variants.length > 0 ? { variants } : {})
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
