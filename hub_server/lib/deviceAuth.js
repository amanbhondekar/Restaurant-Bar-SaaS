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
 * Enrollment: the KDS on the reception laptop shows a short enrollment code, and a
 * QR carrying that same code. A handset either scans the QR (seamless) or types
 * the code once; either way it exchanges the code for exactly one bearer token
 * via /auth/device, and holds it until the code is rotated.
 *
 * The enrollment code is deliberately never returned by any API -- it is only
 * displayed on the physical KDS screen. Serving it would defeat the purpose.
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ENROLL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
const MAX_ATTEMPTS = 5;
const MAX_DEVICES = 50;
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

  /** Exchange the KDS-displayed enrollment code for a bearer token. */
  enroll(code, deviceLabel, ip) {
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
    return { ok: true, ...this.issueToken(deviceLabel) };
  }

  issueToken(deviceLabel = 'Handset') {
    const token = crypto.randomBytes(32).toString('hex');
    const cfg = hubConfig.getPairingInfo();

    const device = {
      // Only a hash is persisted, so a leaked hub_config.json cannot be replayed.
      token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      label: deviceLabel,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString()
    };

    hubConfig.saveConfig({ ...cfg, devices: [...this.prunedDevices(cfg), device] });
    return { device_token: token, expires_at: device.expires_at };
  }

  /**
   * Drops expired grants and keeps the roster bounded. A restaurant runs a
   * handful of handsets; an unbounded list would grow hub_config.json forever
   * and keep stale 30-day credentials valid.
   */
  prunedDevices(cfg) {
    const now = Date.now();
    return (cfg.devices || [])
      .filter(d => new Date(d.expires_at).getTime() > now)
      .slice(-(MAX_DEVICES - 1));
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

// The hostname a Host header value ("host[:port]") or an Origin value ("scheme://host[:port]")
// names, lower-cased and with IPv6 brackets removed; '' when it is not a host at all (a missing
// header, "null"). Parsed as a URL so that tricks like "127.0.0.1@evil.example" resolve to the
// host a browser would really contact.
function hostnameOf(value, { withScheme }) {
  try {
    return new URL(withScheme ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

// Is this a name the reception laptop itself is reached by?
function isLocalHostname(hostname) {
  return hostname === 'localhost' || (hostname !== '' && localAddresses.has(hostname));
}

/**
 * Is this request from the reception laptop itself? Menu and table editing is limited to it. Enrolled waiter
 * handsets hold a 30-day token, so a token is deliberately NOT enough here.
 *
 * Arriving from loopback is not enough either: any web page open in a browser on that same
 * laptop can make the browser call the hub, either by rebinding its own hostname to 127.0.0.1
 * (the request then carries that foreign Host) or by being served from another LAN device (the
 * request then carries that device's Origin). So the request must also be addressed to this
 * machine: its Host header, and its Origin header when the browser sends one, must name
 * localhost, 127.0.0.1, [::1] or an address added through trustLocalAddress (the hub's own LAN
 * IP). The port is ignored, so a dev server on localhost:5173 works.
 *
 * Consequence for the admin page: open it through localhost or the hub's LAN IP
 * (http://localhost:4000, http://<LAN-IP>:4000). A machine-name URL such as
 * http://reception-pc:4000 is refused, as is any page served by another host.
 */
export function isReceptionRequest(req) {
  const host = hostnameOf(req.headers?.host ?? '', { withScheme: false });
  const origin = req.headers?.origin;
  const addressedToThisMachine = isLocalHostname(host) &&
    (origin === undefined || isLocalHostname(hostnameOf(origin, { withScheme: true })));

  return isLoopback(req) && addressedToThisMachine;
}

/**
 * Same decision as requireReception, with a message that names the action. Used for money and
 * hardware screens (cash reconciliation, printer setup), which any enrolled handset must not reach.
 */
export function requireReceptionFor(what) {
  return (req, res, next) => {
    if (isReceptionRequest(req)) return next();
    return res.status(403).json({
      success: false,
      error: `${what} is only available on the reception laptop.`,
      code: 'RECEPTION_ONLY'
    });
  };
}

/** Express guard for the /admin JSON API: the same decision as isReceptionRequest, answered as 403 RECEPTION_ONLY. */
export function requireReception(req, res, next) {
  if (isReceptionRequest(req)) return next();

  return res.status(403).json({
    success: false,
    error: 'Menu and table editing is only available on the reception laptop.',
    code: 'RECEPTION_ONLY'
  });
}
