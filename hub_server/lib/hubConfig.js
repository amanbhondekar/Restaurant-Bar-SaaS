import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase, authenticateHubStaff } from './supabaseClient.js';
import { isValidSystemPrinterName, isValidDevicePath } from './usbPrinter.js';
import { STATION_LABELS } from './kotRouting.js';
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
    // Seam for tests, the same one syncQueue exposes: the cloud client.
    this.cloud = supabase;
  }

  /**
   * Whether this hub has a cloud to ask at all. supabaseClient falls back to a placeholder
   * project when nothing is configured, and "the cloud does not know this code" means something
   * very different from "there is no cloud" -- see pairWithCode.
   */
  cloudConfigured() {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
    return Boolean(url) && !url.includes('example.supabase.co');
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
    const cleaned = raw.map(p => parsePrinter(p)).filter(r => r.ok).map(r => r.printer);
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
      const { data, error } = await this.cloud
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
    // A cloud that answered is the authority on which codes exist. Only a hub with no cloud
    // configured at all may fall back to the built-in demo tenants -- see below.
    let cloudAnswered = false;

    // 1. Try querying Supabase restaurants table first
    try {
      const { data, error } = await this.cloud
        .from('restaurants')
        .select('*')
        .ilike('pairing_code', cleanCode)
        .maybeSingle();

      cloudAnswered = !error;

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
        const eff = this.getEffectivePlan();
        return {
          success: true,
          restaurant: newConfig,
          // What the reception laptop should be told: a tenant provisioned on a trial is normal,
          // but the operator needs to know it is one and when it runs out.
          plan: { plan: eff.plan, status: eff.status, trial_ends_at: newConfig.trial_ends_at || null }
        };
      }
    } catch (err) {
      console.warn('ℹ️ Supabase lookup failed during pairing:', err.message);
      cloudAnswered = false;
    }

    // 2. The built-in demo tenants, for a hub with no cloud configured.
    //
    // This used to run whenever the cloud lookup produced nothing, which is wrong for a
    // self-serve product in two ways: a real restaurant pairing while its internet was down
    // could be bound to a demo tenant instead of its own, and a cloud that positively answered
    // "no such code" was overruled by a hardcoded list. A configured cloud is now the authority
    // on which codes exist.
    if (this.cloudConfigured() || cloudAnswered) {
      return {
        success: false,
        error: cloudAnswered
          ? `No restaurant found matching pairing code '${cleanCode}'`
          : 'Could not reach the cloud to check that pairing code. Connect this laptop to the internet and try again.',
        code: cloudAnswered ? 'UNKNOWN_PAIRING_CODE' : 'CLOUD_UNREACHABLE'
      };
    }

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

    return {
      success: false,
      error: `No restaurant found matching pairing code '${cleanCode}'`,
      code: 'UNKNOWN_PAIRING_CODE'
    };
  }
}

export const hubConfig = new HubConfig();
