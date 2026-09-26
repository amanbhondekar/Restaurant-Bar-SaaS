import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const WAITERS_FILE = path.join(DATA_DIR, 'waiters.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Waiter PIN store.
 *
 * Each waiter row is `{ id, name, pin_hash, pin_salt, active, created_at }`.
 * The 4-digit PIN is never stored in cleartext, and never leaves the hub;
 * `listActive()` returns only `{ id, name }` so the PWA can render a name
 * picker without ever seeing the hash.
 *
 * PIN check uses scrypt (Node stdlib) with a per-waiter random salt. That's
 * intentionally slow so a leaked hash can't be brute-forced offline in
 * seconds — 4-digit PINs have only 10,000 possibilities.
 */

// Fresh hubs need someone to log in as. Seeded once, editable via the
// (future) reception UI or by hand in waiters.json.
const SEED_WAITERS = [
  { name: 'Vikram', pin: '1111' },
  { name: 'Sanjay', pin: '2222' },
  { name: 'Priya',  pin: '3333' }
];

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function makeWaiter(name, pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: 'w_' + crypto.randomBytes(4).toString('hex'),
    name: String(name).slice(0, 60),
    pin_salt: salt,
    pin_hash: hashPin(pin, salt),
    active: true,
    created_at: new Date().toISOString()
  };
}

class WaiterStore {
  constructor() {
    this.waiters = this.load();
    if (this.waiters.length === 0) {
      // Seed the fresh-hub case so a demo works out of the box.
      this.waiters = SEED_WAITERS.map(w => makeWaiter(w.name, w.pin));
      this.save();
    }
  }

  load() {
    try {
      if (fs.existsSync(WAITERS_FILE)) {
        return JSON.parse(fs.readFileSync(WAITERS_FILE, 'utf-8'));
      }
    } catch (err) {
      console.warn('⚠️ Could not load waiters.json:', err.message);
    }
    return [];
  }

  save() {
    fs.promises
      .writeFile(WAITERS_FILE, JSON.stringify(this.waiters, null, 2), 'utf-8')
      .catch(err => console.error('❌ Async save waiters error:', err));
  }

  /** Public shape the PWA and reception UI can safely see. */
  publicShape(w) {
    return { id: w.id, name: w.name, active: w.active };
  }

  listActive() {
    return this.waiters.filter(w => w.active !== false).map(w => this.publicShape(w));
  }

  addWaiter({ name, pin }) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) return { ok: false, error: 'Name is required.', code: 'INVALID_NAME' };
    if (!/^\d{4}$/.test(String(pin || ''))) {
      return { ok: false, error: 'PIN must be exactly 4 digits.', code: 'INVALID_PIN' };
    }
    if (this.waiters.some(w => w.active !== false && w.name.toLowerCase() === cleanName.toLowerCase())) {
      return { ok: false, error: 'A waiter with that name already exists.', code: 'DUPLICATE_NAME' };
    }
    const created = makeWaiter(cleanName, pin);
    this.waiters = [created, ...this.waiters];
    this.save();
    return { ok: true, waiter: this.publicShape(created) };
  }

  deactivate(id) {
    let hit = false;
    this.waiters = this.waiters.map(w => {
      if (w.id !== id) return w;
      hit = true;
      return { ...w, active: false, deactivated_at: new Date().toISOString() };
    });
    if (!hit) return { ok: false, error: 'Waiter not found.', code: 'NOT_FOUND' };
    this.save();
    return { ok: true };
  }

  /**
   * Verify a PIN against a specific waiter. Returns the public shape on
   * success, `{ ok: false, code: 'INVALID_CREDENTIALS' }` for every failure
   * (wrong id, wrong pin, deactivated waiter) so the response never tells
   * an attacker which one it was.
   */
  verify(id, pin) {
    const rejection = { ok: false, error: 'Wrong name or PIN.', code: 'INVALID_CREDENTIALS' };
    if (!id || !pin) return rejection;
    const waiter = this.waiters.find(w => w.id === id);
    if (!waiter || waiter.active === false) return rejection;

    // Constant-time compare on the hex hash so an attacker cannot time the
    // match to leak information about the correct PIN.
    let attempt;
    try {
      attempt = hashPin(String(pin), waiter.pin_salt);
    } catch {
      return rejection;
    }
    const a = Buffer.from(attempt, 'hex');
    const b = Buffer.from(waiter.pin_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return rejection;

    return { ok: true, waiter: this.publicShape(waiter) };
  }

  getById(id) {
    const w = this.waiters.find(x => x.id === id);
    return w ? this.publicShape(w) : null;
  }
}

export const waiterStore = new WaiterStore();
