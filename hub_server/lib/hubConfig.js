import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, authenticateHubStaff } from './supabaseClient.js';
import { resolveEffectivePlan, getLimits, getFeatures } from './plans.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'hub_config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Fallback demo restaurant definitions for offline pairing fallback
const DEMO_RESTAURANTS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Hotel Mejwani',
    pairing_code: 'MJW-7492',
    slug: 'hotel-mejwani',
    city: 'Nagpur',
    plan: 'pro'
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Spice Garden Bistro',
    pairing_code: 'SPG-3108',
    slug: 'spice-garden',
    city: 'Bengaluru',
    plan: 'starter'
  }
];

// The slice of a restaurants row that drives entitlements (see lib/plans.js).
function planFieldsFrom(row) {
  return {
    plan: row?.plan,
    plan_status: row?.plan_status || 'active',
    trial_ends_at: row?.trial_ends_at || null,
    current_period_end: row?.current_period_end || null
  };
}

class HubConfig {
  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('⚠️ Could not read hub_config.json, using defaults:', err.message);
    }

    // Default auto-paired fallback for Hotel Mejwani demo
    const defaultConfig = {
      paired: true,
      restaurant_id: '11111111-1111-1111-1111-111111111111',
      name: 'Hotel Mejwani',
      pairing_code: 'MJW-7492',
      slug: 'hotel-mejwani',
      city: 'Nagpur',
      plan: 'pro',
      plan_status: 'active',
      paired_at: new Date().toISOString()
    };
    this.saveConfig(defaultConfig);
    return defaultConfig;
  }

  saveConfig(newConfig) {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf-8');
      this.config = newConfig;
      return true;
    } catch (err) {
      console.error('❌ Failed to save hub_config.json:', err);
      return false;
    }
  }

  getPairingInfo() {
    return { ...this.config };
  }

  /**
   * Return the tenant's configured printers. Optional `role` filter picks
   * only 'kot' or 'receipt' printers. When no printers are configured for
   * a role, the printer routes fall back to preview mode so the flow works
   * end-to-end without hardware.
   *
   * Config shape on hub_config.json:
   *   "printers": [
   *     { "id": "kitchen-1", "role": "kot",     "host": "192.168.1.60", "port": 9100 },
   *     { "id": "front-1",   "role": "receipt", "host": "192.168.1.61", "port": 9100 }
   *   ]
   */
  getPrinters(role) {
    const raw = Array.isArray(this.config?.printers) ? this.config.printers : [];
    const cleaned = raw
      .filter(p => p && typeof p === 'object' && p.host)
      .map(p => ({
        id: String(p.id || `${p.role || 'printer'}-${p.host}`),
        role: p.role === 'kot' ? 'kot' : 'receipt',
        host: String(p.host),
        port: Number(p.port) || 9100,
        name: p.name ? String(p.name).slice(0, 40) : null
      }));
    // Plan cap (M3 · PR 16): only the first N configured printers are used.
    // Extra entries stay in hub_config.json untouched, so upgrading the plan
    // brings them back without reconfiguration.
    const cap = getLimits(this.getEffectivePlan().plan).printers;
    const allowed = cap === null ? cleaned : cleaned.slice(0, cap);
    if (!role) return allowed;
    return allowed.filter(p => p.role === role);
  }

  /** Entitlements right now: plan, status, degradation, limits and features. */
  getEffectivePlan(now = new Date()) {
    const eff = resolveEffectivePlan(this.config, now);
    return { ...eff, limits: getLimits(eff.plan), features: getFeatures(eff.plan) };
  }

  /**
   * Refresh plan/status from the cloud. Fail-soft by design: offline or
   * erroring Supabase leaves the last known plan in place, so a LAN-only
   * restaurant keeps the entitlements it last synced.
   */
  async syncPlanFromCloud() {
    const id = this.config?.restaurant_id;
    if (!id) return { ok: false, reason: 'NOT_PAIRED' };
    try {
      const { data, error } = await supabase
        .from('restaurants')
        .select('plan, plan_status, trial_ends_at, current_period_end')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return { ok: false, reason: error ? 'CLOUD_ERROR' : 'NOT_FOUND' };
      const next = { ...this.config, ...planFieldsFrom(data), plan_synced_at: new Date().toISOString() };
      const changed = ['plan', 'plan_status', 'trial_ends_at', 'current_period_end']
        .some(k => (this.config?.[k] ?? null) !== (next[k] ?? null));
      this.saveConfig(next);
      return { ok: true, changed, effective: this.getEffectivePlan() };
    } catch (err) {
      return { ok: false, reason: 'OFFLINE', detail: err.message };
    }
  }

  async pairWithCode(code) {
    if (!code || typeof code !== 'string') {
      return { success: false, error: 'Pairing code is required' };
    }

    const cleanCode = code.trim().toUpperCase();

    // 1. Try querying Supabase restaurants table first
    try {
      const { data, error } = await supabase
        .from('restaurants')
        .select('*')
        .ilike('pairing_code', cleanCode)
        .maybeSingle();

      if (!error && data) {
        const newConfig = {
          paired: true,
          restaurant_id: data.id,
          name: data.name,
          pairing_code: data.pairing_code,
          slug: data.slug,
          city: data.city || 'Local',
          ...planFieldsFrom(data),
          plan_synced_at: new Date().toISOString(),
          paired_at: new Date().toISOString()
        };
        this.saveConfig(newConfig);
        authenticateHubStaff(newConfig.restaurant_id);
        return { success: true, restaurant: newConfig };
      }
    } catch (err) {
      console.warn('ℹ️ Supabase lookup failed during pairing, falling back to local database:', err.message);
    }

    // 2. Fallback check against local demo restaurants list
    const foundDemo = DEMO_RESTAURANTS.find(r => r.pairing_code.toUpperCase() === cleanCode);
    if (foundDemo) {
      const newConfig = {
        paired: true,
        restaurant_id: foundDemo.id,
        name: foundDemo.name,
        pairing_code: foundDemo.pairing_code,
        slug: foundDemo.slug,
        city: foundDemo.city,
        plan: foundDemo.plan,
        plan_status: 'active',
        paired_at: new Date().toISOString()
      };
      this.saveConfig(newConfig);
      authenticateHubStaff(newConfig.restaurant_id);
      return { success: true, restaurant: newConfig };
    }

    return { success: false, error: `No restaurant found matching pairing code '${cleanCode}'` };
  }
}

export const hubConfig = new HubConfig();
