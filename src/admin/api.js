// How the admin page talks to the hub. The page is normally served by the hub itself, so requests go
// to the page's own origin. The Vite dev server is a different origin: there,
// localStorage.mejwani_hub_url (for example http://localhost:4585) points the page at a hub.

const TIMEOUT_MS = 30000;

export function hubBase() {
  try {
    const override = window.localStorage.getItem('mejwani_hub_url');
    if (override && override.trim()) return override.trim().replace(/\/+$/, '');
  } catch {
    // storage blocked: fall through to the page's own origin
  }
  return window.location.origin;
}

/** What every non-2xx answer (and every failure to get one) turns into. */
export class HubError extends Error {
  constructor({ status = 0, code = 'ERROR', error = 'The request failed.', errors, details, current_revision, body } = {}) {
    super(error);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.error = error;
    this.errors = errors;
    this.details = details;
    this.current_revision = current_revision;
    // The whole answer, for routes that refuse with something of their own -- a booking clash comes
    // back with what IS free, and a caller that has to re-ask the question needs it. Named fields
    // above stay, so nothing has to reach through `body` for the common ones.
    this.body = body ?? null;
  }
}

const timeoutSignal = ms =>
  (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);

/**
 * JSON in, JSON out. Resolves with the parsed body of a 2xx answer; rejects with a HubError carrying
 * { status, code, error, errors, details, current_revision } for anything else.
 */
export async function hubFetch(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${hubBase()}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: timeoutSignal(TIMEOUT_MS)
    });
  } catch (cause) {
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    throw new HubError({
      status: 0,
      code: timedOut ? 'TIMEOUT' : 'NETWORK',
      error: timedOut ? 'The hub took too long to answer.' : 'The hub could not be reached.'
    });
  }

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // not JSON (a proxy error page, say): handled below
  }
  if (!response.ok) {
    throw new HubError({
      status: response.status,
      code: data?.code ?? (response.status === 413 ? 'PAYLOAD_TOO_LARGE' : `HTTP_${response.status}`),
      error: data?.error ?? `The hub answered ${response.status}.`,
      errors: data?.errors,
      details: data?.details,
      current_revision: data?.current_revision,
      body: data
    });
  }
  return data;
}

export const hubGet = path => hubFetch(path);
export const hubSend = (method, path, body) => hubFetch(path, { method, body });

/** A plain-words sentence for an error the page has no special handling for. */
export function explainError(error) {
  switch (error?.code) {
    case 'NETWORK':
      return 'The hub could not be reached. Check that it is running and that this laptop is connected to it, then try again.';
    case 'TIMEOUT':
      return 'The hub took too long to answer. Try again in a moment.';
    case 'RECEPTION_ONLY':
    case 'DEVICE_UNAUTHORISED':
      return 'Menu and table editing only works on the reception laptop. Open this page there as http://localhost:4000/admin, or with the hub\'s IP address, not with the computer\'s name.';
    case 'HUB_UNINITIALIZED':
      return 'This hub has no menu or tables yet. Connect it to the internet once so it can download them, then reload this page.';
    case 'PAYLOAD_TOO_LARGE':
      return 'That is too large for the hub to accept.';
    case 'BASE_REVISION_REQUIRED':
      return 'The page lost track of which version it was editing. Reload and try again.';
    default:
      return error?.error || 'Something went wrong. Try again.';
  }
}
