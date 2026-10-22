import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  emptyState, normalizeState, addIngredient, updateIngredient, deleteIngredient, adjustStock, setRecipe,
  shortagesFor, consume, restock, stockOutKeys, overlayMenuItems, summarize, levelOf
} from './inventory.js';

// The hub's stock and recipes on disk (hub_server/data/inventory.json), around the pure rules in
// lib/inventory.js. The hub is the single writer: stock changes with every order, so this has to
// work with the internet down, and the cloud copy (migration 009) is a snapshot pushed from here.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'inventory.json');

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

export class InventoryStore {
  constructor(file = FILE) {
    this.file = file;
    this.listeners = [];
    this.menuItems = () => [];
    // Writes are chained, not fired and forgotten: stock changes on every order, and two unordered
    // writes could leave the file holding an older snapshot than memory (as the sync queue's did).
    this.writeChain = Promise.resolve();
    this.state = this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('❌ Could not read inventory.json:', err.message);
      return emptyState(null);
    }
    try {
      return normalizeState(JSON.parse(raw), null);
    } catch (err) {
      // Stock counts took someone hours to enter. An unreadable file is set aside, not overwritten.
      const kept = `${this.file.replace(/\.json$/, '')}.corrupt-${Date.now()}.json`;
      try { fs.writeFileSync(kept, raw); } catch { /* nothing more can be done */ }
      console.error(`🚨 inventory.json is unreadable (${err.message}). Starting empty; the damaged file was kept as ${path.basename(kept)}.`);
      return emptyState(null);
    }
  }

  save() {
    const body = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.promises.writeFile(this.file, body, 'utf-8'))
      .catch(err => console.error('❌ Async save inventory error:', err));
    return this.writeChain;
  }

  /** Resolves once everything queued so far has been written. For tests and orderly shutdown. */
  flush() { return this.writeChain; }

  /** The dishes stock is judged against; set by the server so the store need not know the menu. */
  setMenuProvider(fn) { this.menuItems = typeof fn === 'function' ? fn : () => []; }

  onChange(cb) {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter(l => l !== cb); };
  }

  /**
   * Make sure the state belongs to this restaurant before writing to it. A hub re-paired to a
   * different tenant must not carry the old one's stock into the new one's kitchen, so the old file
   * is kept under its own name and the new tenant starts empty.
   */
  ensureTenant(restaurantId) {
    const current = this.state.restaurant_id;
    if (!restaurantId || current === restaurantId) return;
    if (current) {
      const archive = `${this.file.replace(/\.json$/, '')}.${String(current).replace(/[^\w-]/g, '_')}.json`;
      try { fs.writeFileSync(archive, JSON.stringify(this.state, null, 2)); } catch { /* best effort */ }
      console.warn(`📦 Inventory belonged to another restaurant (${current}); kept as ${path.basename(archive)} and starting empty.`);
      this.state = emptyState(restaurantId);
    } else {
      this.state = { ...this.state, restaurant_id: restaurantId };
    }
  }

  /** The state for a tenant, or an empty one if the stored state is someone else's. Read-only. */
  stateFor(restaurantId) {
    const current = this.state.restaurant_id;
    return !restaurantId || !current || current === restaurantId ? this.state : emptyState(restaurantId);
  }

  /** Run a rule from lib/inventory.js, and on success persist it and tell the listeners. */
  commit(restaurantId, op) {
    this.ensureTenant(restaurantId);
    const before = stockOutKeys(this.state, this.menuItems());
    const result = op(this.state);
    if (!result.ok) return result;

    const changed = result.data !== this.state;
    this.state = result.data;
    const availabilityChanged = !sameSet(before, stockOutKeys(this.state, this.menuItems()));
    if (changed) {
      this.save();
      for (const cb of this.listeners) {
        try { cb({ revision: this.state.revision, availability_changed: availabilityChanged }); }
        catch (err) { console.error('inventory listener failed:', err); }
      }
    }
    return { ...result, availability_changed: availabilityChanged };
  }

  addIngredient(rid, input, ctx) { return this.commit(rid, s => addIngredient(s, input, ctx)); }
  updateIngredient(rid, id, input) { return this.commit(rid, s => updateIngredient(s, id, input)); }
  deleteIngredient(rid, id) { return this.commit(rid, s => deleteIngredient(s, id)); }
  adjust(rid, id, input, ctx) { return this.commit(rid, s => adjustStock(s, id, input, ctx)); }
  setRecipe(rid, input, menu) { return this.commit(rid, s => setRecipe(s, input, menu)); }

  /** Ingredients an order cannot be made from. Empty means the order may go ahead. */
  check(rid, lines) { return shortagesFor(this.stateFor(rid), lines); }

  /** Take an order's ingredients out of stock. Call it only after `check` came back empty. */
  consume(rid, lines, ctx) { return this.commit(rid, s => consume(s, lines, ctx)); }

  /** Put back what a cancelled, uncooked order took out. See lib/inventory.js. */
  restock(rid, uses, ctx) { return this.commit(rid, s => restock(s, uses, ctx)); }

  /** The menu with `stock_out` flags on what cannot be made. Identity when nothing is tracked. */
  overlay(rid, items) { return overlayMenuItems(this.stateFor(rid), items); }

  /** What the admin console shows: every ingredient with its level, the recipes, and counts. */
  snapshot(rid) {
    const s = this.stateFor(rid);
    return {
      restaurant_id: s.restaurant_id,
      revision: s.revision,
      items: s.items.map(i => ({ ...i, level: levelOf(i) })),
      recipes: s.recipes,
      summary: summarize(s)
    };
  }

  /** Most recent movements first, optionally for one ingredient. */
  movements(rid, { itemId, limit = 50 } = {}) {
    const s = this.stateFor(rid);
    const n = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 500);
    return s.movements.filter(m => !itemId || m.inventory_item_id === itemId).slice(-n).reverse();
  }

  /**
   * Replace the whole state, for restoring a replacement laptop from the cloud. Only ever called on a
   * store that holds nothing; the caller checks.
   */
  replaceAll(restaurantId, state) {
    this.state = normalizeState({ ...state, restaurant_id: restaurantId }, restaurantId);
    this.save();
    return this.state;
  }

  isEmpty() { return this.state.items.length === 0 && this.state.recipes.length === 0; }
}

export const inventoryStore = new InventoryStore();
