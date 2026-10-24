// What the console's browser code asks the operator service, and what it makes of the answer. It only ever reads: two GETs, the token as a
// bearer in a header and nowhere else (never in an address, never stored), and every way an answer can go wrong becomes one of a few kinds
// the screen knows how to word.

export class OpsError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'OpsError';
    this.kind = kind;
  }
}

const WORDS = {
  denied: 'That token was not accepted.',
  locked: 'Too many wrong tries from here. Wait a few minutes and try again.',
  off: 'The operator console is not switched on at this service. Set OPS_TOKEN where the service runs.',
  missing: 'That restaurant is not there any more.',
  down: 'The database did not answer. Try again in a moment.',
  offline: 'Could not reach the service. Check your connection and try again.'
};

const failure = kind => new OpsError(kind, WORDS[kind]);

const kindOf = (status, body) => {
  if (status === 401) return 'denied';
  if (status === 429) return 'locked';
  if (status === 503 && body?.code === 'NOT_CONFIGURED') return 'off';
  if (status === 404 && body?.code === 'NOT_FOUND') return 'missing';
  return 'down';
};

export function createOpsApi({ fetchImpl = (...args) => fetch(...args) } = {}) {
  async function get(route, token) {
    let response;
    try {
      response = await fetchImpl(route, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    } catch {
      throw failure('offline');
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.ok && body?.success === true) return body;
    throw failure(kindOf(response.status, body));
  }

  return {
    fleet: token => get('/ops/api/fleet', token),
    tenant: (token, id) => get(`/ops/api/tenants/${encodeURIComponent(id)}`, token)
  };
}
