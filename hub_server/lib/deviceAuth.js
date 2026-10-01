import crypto from 'crypto';
import { hubConfig } from './hubConfig.js';

/**
 * LAN device authentication for the hub.
 *
 * Threat model: everything on the restaurant's WiFi (including guest WiFi on the
 * same subnet, and any website a staff phone happens to open) can reach the hub.
 * Before this existed, any of them could place orders, wipe bills and read the
 * day's revenue.
 *
 * Enrollment: the KDS on the reception laptop shows a short enrollment code and a
 * QR that already carries a token. A handset either scans the QR (seamless) or
 * types the code once. It then holds a bearer token until the code is rotated.
 *
 * The enrollment code is deliberately never returned by any API -- it is only
 * displayed on the physical KDS screen. Serving it would defeat the purpose.
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ENROLL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60 * 1000;

function generateEnrollmentCode() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, b => ENROLL_ALPHABET[b % ENROLL_ALPHABET.length]).join('');
}

/** Constant-time compare that tolerates length differences without leaking them. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class DeviceAuth {
  constructor() {
    this.failedAttempts = new Map(); // ip -> { count, firstAt }
  }

  getEnrollmentCode() {
    const cfg = hubConfig.getPairingInfo();
    if (cfg.enrollment_code) return cfg.enrollment_code;

    const code = generateEnrollmentCode();
    hubConfig.saveConfig({ ...cfg, enrollment_code: code });
    return code;
  }

  rotateEnrollmentCode() {
    const cfg = hubConfig.getPairingInfo();
    const code = generateEnrollmentCode();
    // Rotating the code also revokes every token issued under the old one.
    hubConfig.saveConfig({ ...cfg, enrollment_code: code, devices: [] });
    return code;
  }

  listDevices() {
    return hubConfig.getPairingInfo().devices || [];
  }

  isRateLimited(ip) {
    const rec = this.failedAttempts.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.firstAt > ATTEMPT_WINDOW_MS) {
      this.failedAttempts.delete(ip);
      return false;
    }
    return rec.count >= MAX_ATTEMPTS;
  }

  recordFailure(ip) {
    const rec = this.failedAttempts.get(ip);
    if (!rec || Date.now() - rec.firstAt > ATTEMPT_WINDOW_MS) {
      this.failedAttempts.set(ip, { count: 1, firstAt: Date.now() });
    } else {
      rec.count += 1;
    }
  }

  /** Devices whose token is still valid (expired tokens don't count toward plan limits). */
  activeDeviceCount() {
    const now = Date.now();
    return this.listDevices().filter(d => new Date(d.expires_at).getTime() > now).length;
  }

  /**
   * Exchange the KDS-displayed enrollment code for a bearer token.
   *
   * `guard` (optional) runs only AFTER the code has been verified and returns
   * `{ ok: true }` or a refusal `{ ok: false, status, error, ...extra }`. It is
   * used for plan limits: checking before the code would let an unauthenticated
   * caller probe the tenant's plan.
   */
  enroll(code, deviceLabel, ip, guard) {
    if (this.isRateLimited(ip)) {
      return { ok: false, status: 429, error: 'Too many failed attempts. Wait a minute and try again.' };
    }

    const expected = this.getEnrollmentCode();
    const supplied = String(code || '').trim().toUpperCase();

    if (!supplied || !safeEqual(supplied, expected)) {
      this.recordFailure(ip);
      return { ok: false, status: 401, error: 'Invalid enrollment code.' };
    }

    this.failedAttempts.delete(ip);
    if (typeof guard === 'function') {
      const verdict = guard();
      if (verdict && verdict.ok === false) return verdict;
    }
    return { ok: true, ...this.issueToken(deviceLabel) };
  }

  issueToken(deviceLabel = 'Handset') {
    const token = crypto.randomBytes(32).toString('hex');
    const cfg = hubConfig.getPairingInfo();
    const devices = cfg.devices || [];

    const device = {
      // Only a hash is persisted, so a leaked hub_config.json cannot be replayed.
      token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      label: deviceLabel,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString()
    };

    hubConfig.saveConfig({ ...cfg, devices: [...devices, device] });
    return { device_token: token, expires_at: device.expires_at };
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const devices = hubConfig.getPairingInfo().devices || [];
    const now = Date.now();

    return devices.some(d =>
      d.token_hash === hash && new Date(d.expires_at).getTime() > now
    );
  }
}

export const deviceAuth = new DeviceAuth();

// Addresses that resolve to the reception laptop itself. The hub's own LAN IP is
// included because the KDS is commonly opened as http://<LAN-IP>:4000 on that same
// machine -- those requests are not loopback, but they are the same computer.
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function trustLocalAddress(ip) {
  if (!ip) return;
  localAddresses.add(ip);
  localAddresses.add(`::ffff:${ip}`);
}

/**
 * The reception laptop serves the KDS from this same process; treat it as trusted.
 * Set HUB_TRUST_LOOPBACK=false to require a token even locally (hardened
 * deployments, and the test suite, which must be able to act as a remote handset).
 */
export function isLoopback(req) {
  if (process.env.HUB_TRUST_LOOPBACK === 'false') return false;
  return localAddresses.has(req.socket?.remoteAddress || '');
}

export function extractToken(req) {
  const header = req.headers?.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.query?.token) return String(req.query.token);
  return null;
}

/** Express middleware: allow the local KDS, otherwise require a valid bearer token. */
export function requireDevice(req, res, next) {
  if (isLoopback(req)) return next();
  if (deviceAuth.verifyToken(extractToken(req))) return next();

  return res.status(401).json({
    error: 'Device not authorised. Scan the QR code on the Kitchen Display, or enter the enrollment code shown there.',
    code: 'DEVICE_UNAUTHORISED'
  });
}
