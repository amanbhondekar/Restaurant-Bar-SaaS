// What the admin API will start with (Phase 1, P1-3). Every setting is checked, and the API refuses to start rather than run with one it cannot
// vouch for: a database login that is not the dedicated role, no way to check a token, a web origin of "*", a service key anywhere in its
// environment. A problem names the variable, never its value.

import net from 'node:net';

const SERVICE_KEY_NAME = /SERVICE[_-]?(ROLE)?[_-]?KEY|SERVICE_ROLE/i;
const DEDICATED_USER = /^kullina_admin(\..+)?$/;   // the pooler writes "user.projectref"
const MIN_SECRET = 32;

/** The names (never the values) of environment variables that hold a Supabase service key: by what they are called, or by what the value is. */
export function serviceKeysIn(env) {
  const found = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    if (SERVICE_KEY_NAME.test(name)) { found.push(name); continue; }
    const parts = value.split('.');
    if (parts.length === 3) {
      try {
        if (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.role === 'service_role') found.push(name);
      } catch { /* not a token */ }
    }
  }
  return found;
}

function databaseProblem(value) {
  if (!value) return 'ADMIN_DATABASE_URL is not set.';
  let url;
  try { url = new URL(value); } catch { return 'ADMIN_DATABASE_URL is not a database address.'; }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return 'ADMIN_DATABASE_URL is not a postgres:// address.';
  let user = '';
  try { user = decodeURIComponent(url.username); } catch { /* left empty */ }
  if (!DEDICATED_USER.test(user)) return 'ADMIN_DATABASE_URL must log in as kullina_admin, the dedicated role (never the owner or the service role).';
  return null;
}

function originsOf(value) {
  const list = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return { problem: 'ADMIN_WEB_ORIGIN is not set: the API must know which web origin may call it.' };
  const origins = [];
  for (const entry of list) {
    let url;
    try { url = new URL(entry); } catch { return { problem: `ADMIN_WEB_ORIGIN has an entry that is not an origin (${JSON.stringify(entry)}).` }; }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const plain = url.protocol === 'https:' || (url.protocol === 'http:' && local);
    if (!plain || url.origin !== entry) return { problem: `ADMIN_WEB_ORIGIN entries must be an https origin with no path (or http on localhost): ${JSON.stringify(entry)}.` };
    origins.push(entry);
  }
  return { origins };
}

function cidrOk(entry) {
  const [addr, bits, extra] = entry.split('/');
  if (extra !== undefined) return false;
  if (bits === undefined) return net.isIP(addr) !== 0;
  return net.isIPv4(addr) && /^\d{1,2}$/.test(bits) && Number(bits) <= 32;
}

/** Reads the environment. `ok` is false when anything is wrong; `problems` says what, and `config` is only there when it is ok. */
export function loadConfig(env = process.env) {
  const problems = [];

  const database = databaseProblem((env.ADMIN_DATABASE_URL || '').trim());
  if (database) problems.push(database);

  const secret = (env.ADMIN_JWT_SECRET || '').trim();
  const jwksUrl = (env.ADMIN_JWKS_URL || '').trim();
  if (secret && secret.length < MIN_SECRET) problems.push(`ADMIN_JWT_SECRET is too short to be a secret (at least ${MIN_SECRET} characters).`);
  if (jwksUrl && !/^https:\/\//i.test(jwksUrl)) problems.push('ADMIN_JWKS_URL must be an https address.');
  if (!(secret.length >= MIN_SECRET) && !(jwksUrl && /^https:\/\//i.test(jwksUrl))) {
    problems.push('The API has no way to check a token: set ADMIN_JWT_SECRET or ADMIN_JWKS_URL.');
  }

  const web = originsOf(env.ADMIN_WEB_ORIGIN);
  if (web.problem) problems.push(web.problem);

  const allowlist = String(env.ADMIN_IP_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const entry of allowlist) if (!cidrOk(entry)) problems.push(`ADMIN_IP_ALLOWLIST has an entry that is not an address or a range (${JSON.stringify(entry)}).`);

  const portText = String(env.PORT ?? '4600').trim();
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 1 && port <= 65535)) problems.push('PORT is not a port number.');

  const proxyText = String(env.ADMIN_TRUST_PROXY ?? '0').trim();
  const trustProxy = /^\d$/.test(proxyText) ? Number(proxyText) : NaN;
  if (!(trustProxy >= 0 && trustProxy <= 3)) problems.push('ADMIN_TRUST_PROXY is the number of proxies in front of the API, from 0 to 3.');

  // Invariant I2: the service key never leaves the operator service.
  for (const name of serviceKeysIn(env)) problems.push(`${name} holds a Supabase service key. This service must never hold one (invariant I2); remove it.`);

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    problems: [],
    config: {
      databaseUrl: env.ADMIN_DATABASE_URL.trim(),
      jwtSecret: secret.length >= MIN_SECRET ? secret : null,
      jwksUrl: jwksUrl || null,
      issuer: (env.ADMIN_JWT_ISSUER || '').trim() || undefined,
      audience: (env.ADMIN_JWT_AUDIENCE || '').trim() || 'authenticated',
      webOrigins: web.origins,
      ipAllowlist: allowlist,
      trustProxy,
      port
    }
  };
}
