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
 * The restaurant's staff, and the PINs they sign in with.
 *
 * A row is `{ id, name, role, pin_hash, pin_salt, active, created_at }`. The 4-digit PIN is never
 * stored in cleartext and never leaves the hub; `listActive()` returns only what a name picker
 * needs, so the PWA never sees a hash.
 *
 * PIN check uses scrypt (Node stdlib) with a per-person random salt. That is deliberately slow,
 * because a 4-digit PIN has only 10,000 possibilities and a leaked hash would otherwise fall in
 * seconds.
 *
 * Invites (§4.4). Reception used to have to type someone else's PIN for them, which means a PIN
 * the owner knows and the staff member cannot really change. Instead reception creates the person
 * with a ROLE and a short-lived invite code, and they set their own PIN on a handset. Until they
 * do, the row has no hash at all and cannot sign in -- an invited person is not yet a credential.
 *
 * Roles are carried here and shown to reception. What a role may DO is §4.7's job (role-scoped
 * UIs and tokens); today every signed-in person can do what the handset allows, and the honest
 * thing is that this stores the answer rather than pretending to enforce it.
 */

// Fresh hubs need someone to log in as. Seeded once, editable via the
// (future) reception UI or by hand in waiters.json.
const SEED_WAITERS = [
  { name: 'Vikram', pin: '1111' },
  { name: 'Sanjay', pin: '2222' },
  { name: 'Priya',  pin: '3333' }
];

/** What a person is. `waiter` is the default and what every pre-existing row becomes. */
export const ROLES = ['waiter', 'manager', 'kitchen'];
export const ROLE_LABEL = { waiter: 'Waiter', manager: 'Manager', kitchen: 'Kitchen' };
const normalizeRole = role => (ROLES.includes(String(role)) ? String(role) : 'waiter');

// Long enough not to be guessed in the window it lives for, short enough to read down a phone.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_LENGTH = 6;

const newInviteCode = () =>
  Array.from(crypto.randomBytes(INVITE_LENGTH), b => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

const isPin = pin => /^\d{4}$/.test(String(pin ?? ''));

/** A PIN anyone could guess in a few tries is not worth the scrypt that protects it. */
const WEAK_PINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '1212', '2580']);

function makeWaiter(name, pin, role = 'waiter') {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: 'w_' + crypto.randomBytes(4).toString('hex'),
    name: String(name).slice(0, 60),
    role: normalizeRole(role),
    pin_salt: salt,
    pin_hash: hashPin(pin, salt),
    pin_set_at: new Date().toISOString(),
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

  /** Public shape the PWA and reception UI can safely see. Never the hash, never the invite code. */
  publicShape(w) {
    return { id: w.id, name: w.name, role: normalizeRole(w.role), active: w.active };
  }

  /** Whether this person can sign in at all: invited but never set up cannot. */
  hasPin(w) {
    return Boolean(w && w.pin_hash && w.pin_salt);
  }

  /** The name picker on a handset: only people who can actually sign in. */
  listActive() {
    return this.waiters.filter(w => w.active !== false && this.hasPin(w)).map(w => this.publicShape(w));
  }

  /**
   * Everyone, for reception: including people who are invited and have not set a PIN yet, and
   * whether their invite is still good. The code itself is returned only when it is created, so
   * leaving this screen open does not leave a credential on it.
   */
  listAll(now = new Date()) {
    return this.waiters.map(w => ({
      ...this.publicShape(w),
      pin_set: this.hasPin(w),
      created_at: w.created_at ?? null,
      pin_set_at: w.pin_set_at ?? null,
      ...(w.invite_expires_at
        ? { invite_expires_at: w.invite_expires_at, invite_expired: new Date(w.invite_expires_at).getTime() <= now.getTime() }
        : {})
    }));
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

  /**
   * Create someone who sets their own PIN. Returns the code ONCE: it is stored only as a hash, so
   * a reception screen left open, or a hub_config leak, cannot be replayed into an account.
   */
  invite({ name, role }, now = new Date()) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) return { ok: false, error: 'Name is required.', code: 'INVALID_NAME' };
    if (this.waiters.some(w => w.active !== false && w.name.toLowerCase() === cleanName.toLowerCase())) {
      return { ok: false, error: `${cleanName} is already on the staff list.`, code: 'DUPLICATE_NAME' };
    }
    const code = newInviteCode();
    const created = {
      id: 'w_' + crypto.randomBytes(4).toString('hex'),
      name: cleanName.slice(0, 60),
      role: normalizeRole(role),
      invite_hash: crypto.createHash('sha256').update(code).digest('hex'),
      invite_expires_at: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      active: true,
      created_at: now.toISOString()
    };
    this.waiters = [created, ...this.waiters];
    this.save();
    return { ok: true, waiter: this.publicShape(created), invite_code: code, expires_at: created.invite_expires_at };
  }

  /**
   * A staff member redeems their invite by choosing a PIN. Every failure answers the same way, so
   * the response cannot be used to learn which codes exist.
   */
  redeemInvite(code, pin, now = new Date()) {
    const rejection = { ok: false, error: 'That invite code is not valid, or it has expired.', code: 'INVALID_INVITE' };
    const supplied = String(code ?? '').trim().toUpperCase();
    if (!supplied) return rejection;
    if (!isPin(pin)) return { ok: false, error: 'Choose a PIN of exactly 4 digits.', code: 'INVALID_PIN' };
    if (WEAK_PINS.has(String(pin))) return { ok: false, error: 'That PIN is too easy to guess. Choose another.', code: 'WEAK_PIN' };

    const hash = crypto.createHash('sha256').update(supplied).digest('hex');
    const person = this.waiters.find(w => w.invite_hash && w.invite_hash === hash);
    if (!person || person.active === false) return rejection;
    if (new Date(person.invite_expires_at).getTime() <= now.getTime()) return rejection;

    const salt = crypto.randomBytes(16).toString('hex');
    this.waiters = this.waiters.map(w => {
      if (w.id !== person.id) return w;
      const { invite_hash: _h, invite_expires_at: _e, ...rest } = w;
      return { ...rest, pin_salt: salt, pin_hash: hashPin(pin, salt), pin_set_at: now.toISOString() };
    });
    this.save();
    return { ok: true, waiter: this.publicShape(person) };
  }

  /**
   * Set a new PIN for someone. Reception does this when a PIN has been shared around or someone
   * has forgotten theirs; it takes effect at once, so the old PIN stops working immediately.
   */
  rotatePin(id, pin, now = new Date()) {
    const person = this.waiters.find(w => w.id === id);
    if (!person) return { ok: false, error: 'That person is not on the staff list.', code: 'NOT_FOUND' };
    if (!isPin(pin)) return { ok: false, error: 'A PIN must be exactly 4 digits.', code: 'INVALID_PIN' };
    if (WEAK_PINS.has(String(pin))) return { ok: false, error: 'That PIN is too easy to guess. Choose another.', code: 'WEAK_PIN' };

    const salt = crypto.randomBytes(16).toString('hex');
    this.waiters = this.waiters.map(w => (w.id === id
      // A rotation also cancels any outstanding invite: the account is set up now.
      ? (({ invite_hash: _h, invite_expires_at: _e, ...rest }) => ({ ...rest, pin_salt: salt, pin_hash: hashPin(pin, salt), pin_set_at: now.toISOString() }))(w)
      : w));
    this.save();
    return { ok: true, waiter: this.publicShape(person) };
  }

  /** Re-issue an invite for someone who never redeemed the first one, or let it expire. */
  reinvite(id, now = new Date()) {
    const person = this.waiters.find(w => w.id === id);
    if (!person) return { ok: false, error: 'That person is not on the staff list.', code: 'NOT_FOUND' };
    if (this.hasPin(person)) return { ok: false, error: `${person.name} has already set a PIN. Reset it instead.`, code: 'ALREADY_SET_UP' };

    const code = newInviteCode();
    const expires = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    this.waiters = this.waiters.map(w => (w.id === id
      ? { ...w, invite_hash: crypto.createHash('sha256').update(code).digest('hex'), invite_expires_at: expires }
      : w));
    this.save();
    return { ok: true, waiter: this.publicShape(person), invite_code: code, expires_at: expires };
  }

  setRole(id, role) {
    const person = this.waiters.find(w => w.id === id);
    if (!person) return { ok: false, error: 'That person is not on the staff list.', code: 'NOT_FOUND' };
    if (!ROLES.includes(String(role))) return { ok: false, error: `A role must be one of ${ROLES.join(', ')}.`, code: 'INVALID_ROLE' };
    this.waiters = this.waiters.map(w => (w.id === id ? { ...w, role: String(role) } : w));
    this.save();
    return { ok: true, waiter: { ...this.publicShape(person), role: String(role) } };
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
    // An invited person who has not chosen a PIN has no hash to compare against, and must not be
    // able to sign in with anything at all.
    if (!waiter || waiter.active === false || !this.hasPin(waiter)) return rejection;

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
