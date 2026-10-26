// What the admin console's page asks the admin API, and what it makes of the answer. It reads; the one write is recording that a person signed in. The
// token goes in a header and nowhere else (never an address, never stored), and every way an answer can go wrong becomes one of a few kinds the
// screens know how to word.

export class AdminApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AdminApiError';
    this.kind = kind;
  }
}

const WORDS = {
  denied: 'Your session is not accepted any more. Sign in again.',
  mfa: 'Sign in with your second factor to continue.',
  not_admin: 'This account is not an administrator.',
  locked: 'Too many wrong tries from here. Wait a few minutes and try again.',
  missing: 'That is not there any more.',
  down: 'The admin service could not read that. Try again in a moment.',
  offline: 'Could not reach the admin service. Check your connection and try again.',
  bad: 'That request was not understood.'
};
const failure = (kind, message) => new AdminApiError(kind, message ?? WORDS[kind]);

/** The kind of a failed answer. A server's own words are never passed on, except for a 400, which the API writes for a person. */
function failureOf(status, body) {
  if (status === 401) return failure('denied');
  if (status === 403 && body?.code === 'MFA_REQUIRED') return failure('mfa');
  if (status === 403 && body?.code === 'ADMIN_ONLY') return failure('not_admin');
  if (status === 429) return failure('locked');
  if (status === 404 && body?.code === 'NOT_FOUND') return failure('missing');
  if (status === 400 && typeof body?.error === 'string' && body.error.length <= 200) return failure('bad', body.error);
  return failure('down');
}

const requestId = () => (globalThis.crypto?.randomUUID?.() ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

const QUERY_KEYS = [['restaurant', 'restaurant_id'], ['type', 'type'], ['source', 'source'], ['from', 'from'], ['to', 'to'], ['before', 'before'], ['limit', 'limit']];
function queryOf(filters = {}) {
  const parts = [];
  for (const [key, name] of QUERY_KEYS) {
    const value = filters[key];
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${name}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const fileNameOf = response => {
  const given = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1];
  return given && SAFE_NAME.test(given) ? given : 'kullina-audit.csv';
};

export function createAdminApi({ baseUrl, getToken, fetchImpl = (...args) => fetch(...args) }) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function send(path, { method = 'GET' } = {}) {
    let token;
    try { token = await getToken(); } catch { throw failure('denied'); }
    if (!token) throw failure('denied');
    try {
      return await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Request-Id': requestId() },
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        mode: 'cors'
      });
    } catch {
      throw failure('offline');
    }
  }

  async function json(path, options) {
    const response = await send(path, options);
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.ok && body?.success === true) return body;
    throw failureOf(response.status, body);
  }

  return {
    me: () => json('/api/me'),
    recordSession: () => json('/api/session', { method: 'POST' }),
    fleet: () => json('/api/fleet'),
    tenant: id => json(`/api/tenants/${encodeURIComponent(id)}`),
    audit: filters => json(`/api/audit${queryOf(filters)}`),
    verify: restaurant => json(`/api/audit/verify${restaurant ? `?restaurant_id=${encodeURIComponent(restaurant)}` : ''}`),
    async auditCsv(filters) {
      const response = await send(`/api/audit.csv${queryOf(filters)}`);
      if (!response.ok) {
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        throw failureOf(response.status, body);
      }
      return { blob: await response.blob(), filename: fileNameOf(response) };
    }
  };
}
