import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, authenticateHubStaff } from './supabaseClient.js';
import { isValidSystemPrinterName, isValidDevicePath } from './usbPrinter.js';
import { STATION_LABELS } from './kotRouting.js';

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

const PRINTER_ROLES = new Set(['kot', 'receipt']);

/**
 * Validate and normalise one printer entry. Used for reading hub_config.json
 * (bad entries are skipped, never fatal) and for the admin "add printer" call
 * (bad entries are refused with a reason).
 *
 * `transport`: 'tcp' (default, `host` + `port`), 'usb' (`system_name`, an OS print
 * queue), or 'device' (`device_path`, e.g. /dev/usb/lp0).
 *
 * `station` ('hot' | 'cold' | 'bar') restricts a KOT printer to that station's
 * tickets; omit it and the printer takes every station's tickets.
 */
export function parsePrinter(p) {
  const bad = (error, code = 'INVALID_PRINTER') => ({ ok: false, error, code });
  if (!p || typeof p !== 'object') return bad('Printer must be an object.');

  const transport = p.transport === 'usb' ? 'usb' : p.transport === 'device' ? 'device' : 'tcp';
  const role = PRINTER_ROLES.has(p.role) ? p.role : 'receipt';
  const printer = { id: '', role, transport, name: p.name ? String(p.name).slice(0, 40) : null };
  // A USB printer already has a meaningful name (its OS queue name); show that when no label was given.
  if (!printer.name && transport === 'usb' && typeof p.system_name === 'string') printer.name = p.system_name.trim().slice(0, 40);

  if (transport === 'tcp') {
    const host = typeof p.host === 'string' ? p.host.trim() : '';
    if (!host || host.length > 253 || /[\s/\\]/.test(host)) return bad('A network printer needs a valid host or IP address.', 'INVALID_HOST');
    const port = Number(p.port) || 9100;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return bad('Port must be between 1 and 65535.', 'INVALID_PORT');
    printer.host = host;
    printer.port = port;
  } else if (transport === 'usb') {
    if (!isValidSystemPrinterName(p.system_name)) return bad('Choose the printer as it is named in your operating system.', 'INVALID_PRINTER_NAME');
    printer.system_name = p.system_name.trim();
  } else {
    if (!isValidDevicePath(p.device_path)) return bad('Device path must be a printer device such as /dev/usb/lp0.', 'INVALID_DEVICE_PATH');
    printer.device_path = p.device_path;
  }

  if (p.station !== undefined && p.station !== null && p.station !== '') {
    const station = String(p.station).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(STATION_LABELS, station)) {
      return bad(`Station must be one of ${Object.keys(STATION_LABELS).join(', ')}.`, 'INVALID_STATION');
    }
    printer.station = station;
  }

  const fallbackTarget = printer.host || printer.system_name || printer.device_path;
  printer.id = String(p.id || `${role}-${fallbackTarget}`).slice(0, 60);
  return { ok: true, printer };
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
    const cleaned = raw.map(p => parsePrinter(p)).filter(r => r.ok).map(r => r.printer);
    if (!role) return cleaned;
    return cleaned.filter(p => p.role === role);
  }

  /**
   * Add a printer (admin screen). Validates by transport, refuses a duplicate id,
   * and persists to hub_config.json. Returns `{ ok, printer }` or `{ ok: false, error, code }`.
   */
  addPrinter(input) {
    const parsed = parsePrinter(input);
    if (!parsed.ok) return parsed;
    const existing = Array.isArray(this.config?.printers) ? this.config.printers : [];
    if (existing.some(p => p && String(p.id) === parsed.printer.id)) {
      return { ok: false, code: 'DUPLICATE_PRINTER', error: `A printer with id "${parsed.printer.id}" already exists.` };
    }
    this.saveConfig({ ...this.config, printers: [...existing, parsed.printer] });
    return { ok: true, printer: parsed.printer };
  }

  removePrinter(id) {
    const existing = Array.isArray(this.config?.printers) ? this.config.printers : [];
    if (!existing.some(p => p && String(p.id) === String(id))) {
      return { ok: false, code: 'NOT_FOUND', error: 'Printer not found.' };
    }
    this.saveConfig({ ...this.config, printers: existing.filter(p => !(p && String(p.id) === String(id))) });
    return { ok: true };
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
