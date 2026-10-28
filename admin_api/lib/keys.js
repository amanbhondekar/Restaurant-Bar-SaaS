// The keys the admin API will believe a token against (see jwt.js). A key provider is a function from a token's header (`{ alg, kid }`) to a list
// of keys that might have signed it, each either `{ type: 'secret', secret }` or `{ type: 'public', alg, key }`. It may be asynchronous.
//
// Nothing here trusts a key just because it was offered: a private key, a symmetric key or an unknown type inside a key set is skipped, and a
// key set that cannot be fetched yields no keys, which means every token is refused.

import crypto from 'node:crypto';

const MIN_SECRET = 32;

/** The project's shared secret (what a project that has not moved to signing keys signs with). Too short to be a secret is refused up front. */
export function hsKeys(secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) throw new Error(`The JWT secret must be at least ${MIN_SECRET} characters.`);
  const keys = [{ type: 'secret', secret }];
  return () => keys;
}

/** One JWK as a verifying key, or null if it is not a PUBLIC RSA or P-256 key. */
function fromJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || typeof jwk.kty !== 'string') return null;
  if (jwk.d !== undefined || jwk.p !== undefined || jwk.q !== undefined || jwk.k !== undefined) return null;   // private or symmetric: never a verifying key
  try {
    if (jwk.kty === 'RSA') return { type: 'public', alg: 'RS256', kid: jwk.kid, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) };
    if (jwk.kty === 'EC' && jwk.crv === 'P-256') return { type: 'public', alg: 'ES256', kid: jwk.kid, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) };
  } catch { /* a malformed key is no key */ }
  return null;
}

/** A key set (`{ keys: [...] }`) held in memory. A token that names a key id gets that key; one that names none gets every key of its algorithm. */
export function jwkKeys(set) {
  const keys = (Array.isArray(set?.keys) ? set.keys : []).map(fromJwk).filter(Boolean);
  return ({ alg, kid }) => keys.filter(k => k.alg === alg && (kid === undefined || k.kid === kid));
}

/** Every provider is asked, and what they all offer is tried. */
export function anyOf(...providers) {
  return async header => (await Promise.all(providers.map(p => p(header)))).flat();
}

/**
 * A project's published key set, fetched and cached. It is refetched when it has aged out, and once more when a token names a key id it has not
 * seen -- but not more often than `minRefetchMs`, so a stream of tokens with made-up ids cannot make this API hammer the project.
 */
export function remoteJwks({ url, fetch: fetchFn = globalThis.fetch, ttlMs = 10 * 60 * 1000, minRefetchMs = 60 * 1000, now = Date.now } = {}) {
  let provider = jwkKeys(null);
  let fetchedAt = null;
  let known = new Set();

  async function refresh() {
    fetchedAt = now();   // set first: a failing fetch is not retried on every request either
    try {
      const res = await fetchFn(url);
      if (!res?.ok) return;
      const set = await res.json();
      if (!Array.isArray(set?.keys)) return;
      provider = jwkKeys(set);
      known = new Set(set.keys.map(k => k?.kid).filter(Boolean));
    } catch { /* keep what we had; with nothing, every token is refused */ }
  }

  return async header => {
    const at = now();
    const stale = fetchedAt === null || at - fetchedAt >= ttlMs;
    const unseen = header.kid !== undefined && !known.has(header.kid) && at - (fetchedAt ?? -Infinity) >= minRefetchMs;
    if (stale || unseen) await refresh();
    return provider(header);
  };
}
