// Who may reach the admin API and what it says back (Phase 1, P1-3): an optional address allowlist, a limit on wrong tries, the headers every
// response carries, and which web origin may read an answer.

import crypto from 'node:crypto';
import net from 'node:net';

/** What every response carries. No script of any kind runs from the API, nothing is cached, and nothing may frame it. */
export const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Resource-Policy': 'same-site',
  'X-Robots-Tag': 'noindex, nofollow'
});

// --- addresses -------------------------------------------------------------------------------------------------------------------

/** An address in one canonical form: IPv4-mapped IPv6 as IPv4, IPv6 in its shortest lower-case form, or null if it is neither. */
function canonical(ip) {
  if (typeof ip !== 'string') return null;
  let text = ip.trim().toLowerCase();
  if (text.startsWith('::ffff:') && net.isIPv4(text.slice(7))) text = text.slice(7);
  if (net.isIPv4(text)) return text;
  if (net.isIPv6(text)) {
    try { return new URL(`http://[${text}]`).hostname.slice(1, -1); } catch { return null; }
  }
  return null;
}

const v4 = text => text.split('.').reduce((n, part) => (n * 256) + Number(part), 0);

/** Whether `ip` is on the list. An empty list allows everyone (the API is still behind a token); a list allows only what it names. */
export function ipAllowed(ip, list) {
  if (!list || list.length === 0) return true;
  const who = canonical(ip);
  if (who === null) return false;
  for (const entry of list) {
    const [addr, bits] = entry.split('/');
    const base = canonical(addr);
    if (base === null) continue;
    if (bits === undefined) { if (base === who) return true; continue; }
    if (!net.isIPv4(who) || !net.isIPv4(base)) continue;
    const width = Number(bits);
    const mask = width === 0 ? 0 : (0xFFFFFFFF << (32 - width)) >>> 0;
    if (((v4(who) & mask) >>> 0) === ((v4(base) & mask) >>> 0)) return true;
  }
  return false;
}

// --- guessing --------------------------------------------------------------------------------------------------------------------

/** Counts wrong tries per key (an address) inside a window. Bounded: the oldest keys are dropped past `maxKeys`. */
export function createLimiter({ max, windowMs, now = Date.now, maxKeys = 10000 }) {
  const tries = new Map();
  const live = key => {
    const cutoff = now() - windowMs;
    const kept = (tries.get(key) || []).filter(t => t > cutoff);
    if (kept.length) tries.set(key, kept); else tries.delete(key);
    return kept;
  };
  return {
    hit(key) {
      const kept = live(key);
      kept.push(now());
      tries.delete(key);
      tries.set(key, kept);
      while (tries.size > maxKeys) tries.delete(tries.keys().next().value);
    },
    blocked: key => live(key).length >= max,
    size: () => tries.size
  };
}

// --- requests --------------------------------------------------------------------------------------------------------------------

/** A caller's request id if it is short and plain, otherwise a fresh one: it ends up in the audit log, so it is not taken on trust. */
export function requestIdFrom(header) {
  return typeof header === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(header) ? header : crypto.randomUUID();
}

/** Which web origin may read an answer. Never cookies: the token is in a header. */
export function corsHeaders(origin, allowed) {
  const headers = { Vary: 'Origin' };
  if (typeof origin === 'string' && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'authorization, content-type, x-request-id';
    headers['Access-Control-Expose-Headers'] = 'x-request-id';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}
