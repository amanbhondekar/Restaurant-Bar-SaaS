import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, authenticateHubStaff } from './supabaseClient.js';

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
    city: 'Nagpur'
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Spice Garden Bistro',
    pairing_code: 'SPG-3108',
    slug: 'spice-garden',
    city: 'Bengaluru'
  }
];

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
    if (!role) return cleaned;
    return cleaned.filter(p => p.role === role);
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
