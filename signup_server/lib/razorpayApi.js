// The calls the operator service makes TO Razorpay for a restaurant's subscription (§4.4).
//
// Four, and only four: create one (which returns the hosted page where the owner authorises payment), cancel one, schedule a
// change of plan, and read one. The operator service holds the keys; a hub never does, which is why this lives here and not in
// hub_server/.
//
// Every way a call can go wrong is an ANSWER, never an exception, so a route cannot forget to catch one: Razorpay refusing,
// Razorpay being down, the network being down, a reply that is not JSON, and no keys configured. And the secret is never in an
// answer: errors are worded here rather than copied from whatever the failure said, because the failure of a call that carries
// an Authorization header can quote it.
//
// Requests follow Razorpay's documented Subscriptions API: Basic auth with the key id and secret; POST /subscriptions;
// POST /subscriptions/:id/cancel with cancel_at_cycle_end; PATCH /subscriptions/:id with plan_id and schedule_change_at;
// GET /subscriptions/:id. This has been run against a stand-in for Razorpay, never against Razorpay itself.

const BASE_URL = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15000;

const refusalFor = (status, body) => {
  const description = body?.error?.description;
  return {
    ok: false,
    status,
    code: status >= 500 ? 'RAZORPAY_ERROR' : 'RAZORPAY_REFUSED',
    ...(body?.error?.code ? { razorpayCode: String(body.error.code) } : {}),
    error: typeof description === 'string' && description.trim()
      ? description.trim()
      : (status >= 500 ? 'Razorpay had a problem. Try again in a minute.' : `Razorpay did not accept that (status ${status}).`)
  };
};

export function createRazorpayApi({ keyId, keySecret, fetchImpl = globalThis.fetch, baseUrl = BASE_URL, timeoutMs = TIMEOUT_MS } = {}) {
  const configured = () => Boolean(keyId && keySecret);
  const authorization = configured() ? `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` : null;

  async function call(method, path, body) {
    if (!configured()) return { ok: false, code: 'NOT_CONFIGURED', error: 'This service has no Razorpay keys.' };

    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      return { ok: false, code: 'RAZORPAY_UNREACHABLE', error: 'Could not reach Razorpay.' };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      // Not JSON (a proxy's error page, say): parsed stays null.
    }

    if (!res.ok) return refusalFor(res.status, parsed);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, code: 'RAZORPAY_BAD_RESPONSE', error: 'Razorpay answered with something that could not be read.' };
    }
    return { ok: true, data: parsed };
  }

  // An id comes from our own database, but an id that is escaped into a path cannot be made to name another endpoint.
  const withId = (id, then) => (typeof id === 'string' && id.trim()
    ? then(encodeURIComponent(id))
    : Promise.resolve({ ok: false, code: 'INVALID_ID', error: 'That subscription has no id.' }));

  return {
    configured,

    async createSubscription(payload) {
      const r = await call('POST', '/subscriptions', payload);
      // One with no id is one we could never find again.
      if (r.ok && !r.data.id) return { ok: false, code: 'RAZORPAY_BAD_RESPONSE', error: 'Razorpay created a subscription but did not say which.' };
      return r;
    },

    cancelSubscription: (id, { atCycleEnd = true } = {}) =>
      withId(id, escaped => call('POST', `/subscriptions/${escaped}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 })),

    changePlan: (id, { planId, atCycleEnd = true } = {}) =>
      withId(id, escaped => call('PATCH', `/subscriptions/${escaped}`, { plan_id: planId, schedule_change_at: atCycleEnd ? 'cycle_end' : 'now' })),

    fetchSubscription: id => withId(id, escaped => call('GET', `/subscriptions/${escaped}`))
  };
}
