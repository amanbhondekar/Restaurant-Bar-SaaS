// How a hub asks the operator service about its own restaurant's subscription (§4.4).
//
// The hub never holds a Razorpay key and never decides anything about money. It forwards a request to the operator service,
// proves which restaurant it is with its own cloud session, and reports what came back. The service decides; Razorpay is called
// from there.
//
// Every way this can fail is an answer the screen can word, not an exception: no address configured, no cloud sign-in yet (the
// hub needs the internet once to get one), no internet, a service that is down, a reply that is not JSON, and the service
// refusing. And the hub's sign-in token is never in an answer.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TIMEOUT_MS = 20000;

/**
 * The operator service's address, or null. It must be https, because the hub's cloud sign-in travels with every request to it; the
 * one exception is a local address, for trying the service out on the same machine. No credentials in the address, and nothing but
 * the origin and a path prefix is kept.
 */
export function normalizeOperatorUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.username || url.password) return null;
  const secure = url.protocol === 'https:';
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !local) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const fail = (status, code, error) => ({ ok: false, status, code, error });

export function createBillingClient({ baseUrl, getToken, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const base = normalizeOperatorUrl(baseUrl);
  const configured = () => Boolean(base);

  async function request(method, path, body) {
    if (!base) return fail(503, 'BILLING_NOT_CONFIGURED', 'Online billing is not connected on this hub.');

    let token = null;
    try { token = await getToken(); } catch { token = null; }
    if (!token) return fail(409, 'NO_CLOUD_SESSION', 'This hub has not signed in to the cloud yet. It needs the internet once. Try again in a minute.');

    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      // The message of the thrown error is not passed on: a failure of a request that carries a token can quote it.
      return fail(503, 'OFFLINE', 'This needs the internet, and the hub cannot reach the billing service right now.');
    }

    let parsed = null;
    try { parsed = JSON.parse(await res.text()); } catch { parsed = null; }
    const readable = parsed && typeof parsed === 'object';

    if (res.ok) {
      return readable ? { ok: true, status: res.status, data: parsed } : fail(502, 'BILLING_UNAVAILABLE', 'The billing service answered with something that could not be read.');
    }
    // A status that is not a refusal or a failure (a redirect, say) is not passed on as if it were one.
    const status = res.status >= 400 && res.status <= 599 ? res.status : 502;
    if (!readable) return fail(status, 'BILLING_UNAVAILABLE', 'The billing service had a problem. Try again in a minute.');
    return fail(status, typeof parsed.code === 'string' ? parsed.code : 'BILLING_ERROR', typeof parsed.error === 'string' && parsed.error ? parsed.error : 'The billing service did not accept that.');
  }

  return {
    configured,
    current: () => request('GET', '/subscriptions/current'),
    subscribe: plan => request('POST', '/subscriptions', { plan }),
    changePlan: plan => request('POST', '/subscriptions/change-plan', { plan }),
    cancel: () => request('POST', '/subscriptions/cancel', {})
  };
}
