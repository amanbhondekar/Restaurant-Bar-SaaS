// Hub device credentials for the waiter handset.
//
// The hub now requires a bearer token from any device that is not the reception
// laptop itself. A handset gets one of two ways:
//   1. Scanning the QR on the Kitchen Display, which carries a token in the URL
//      fragment (#t=...) -- seamless, nothing to type.
//   2. Typing the short enrollment code shown on the Kitchen Display.
//
// The token is kept in localStorage so an installed PWA stays enrolled across
// launches. The KDS running on the hub machine needs none of this.

const TOKEN_KEY = 'mejwani_hub_device_token';

let cachedToken = null;

// An enrollment code picked up from the URL, awaiting exchange for a token.
let pendingEnrollmentCode = null;

/**
 * Consumes credentials handed over in the URL fragment by a scanned QR and strips
 * them from the address bar so they do not linger in history or get shared when
 * someone copies the URL.
 *
 * Two shapes are accepted:
 *   #t=<64-hex>  a device token directly (older QR codes still in circulation)
 *   #e=<code>    an enrollment code, exchanged for a token on first connect
 */
export function captureTokenFromUrl() {
  if (typeof window === 'undefined') return null;

  const hash = window.location.hash || '';
  const tokenMatch = hash.match(/[#&]t=([a-f0-9]{64})/i);
  const codeMatch = hash.match(/[#&]e=([A-Z0-9]{4,12})/i);

  if (!tokenMatch && !codeMatch) return null;

  let token = null;
  if (tokenMatch) {
    token = tokenMatch[1];
    setToken(token);
  } else if (codeMatch) {
    pendingEnrollmentCode = codeMatch[1].toUpperCase();
  }

  const cleanedHash = hash
    .replace(/[#&]t=[a-f0-9]{64}/i, '')
    .replace(/[#&]e=[A-Z0-9]{4,12}/i, '');
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search + (cleanedHash === '#' ? '' : cleanedHash)
  );

  return token;
}

/** Reads and clears an enrollment code captured from the URL. */
export function consumePendingEnrollmentCode() {
  const code = pendingEnrollmentCode;
  pendingEnrollmentCode = null;
  return code;
}

export function getToken() {
  if (cachedToken) return cachedToken;
  if (typeof window === 'undefined') return null;
  try {
    cachedToken = window.localStorage.getItem(TOKEN_KEY);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

export function setToken(token) {
  cachedToken = token;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode or blocked storage: the in-memory copy still lasts the session.
  }
}

export function clearToken() {
  cachedToken = null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to do */
  }
}

export function hasToken() {
  return Boolean(getToken());
}

/**
 * Exchange the code shown on the Kitchen Display for a device token.
 *
 * `scope: 'kitchen'` is for a screen at the pass: the token it gets can show tickets and mark them
 * done, and nothing else. Left out, the device is a full handset, as it always was.
 */
export async function enrollWithCode(hubUrl, enrollmentCode, deviceLabel = 'Waiter handset', { scope } = {}) {
  const base = (hubUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollment_code: enrollmentCode, device_label: deviceLabel, ...(scope ? { scope } : {}) })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: body.error || 'Enrollment failed.' };
  }

  setToken(body.device_token);
  return { ok: true, token: body.device_token };
}

/** fetch() that attaches the device token. Mirrors the fetch signature. */
export function authFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

/** Build a WebSocket URL carrying the device token (WS cannot set headers). */
export function authWsUrl(wsUrl) {
  const token = getToken();
  if (!token) return wsUrl;
  return `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
