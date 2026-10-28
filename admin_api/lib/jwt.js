// How the admin API decides a token is real (Phase 1, P1-2/P1-3). The token is the founder's Supabase session; before the API believes a word of
// it, it checks the signature, the lifetime and who the token is for, and it refuses anything it does not positively understand: an algorithm
// it was not told to expect, a key it does not hold, a token with no end.
//
// Written against node:crypto with no library, because the surface is small and every line of it is a decision: which algorithms (HS256, RS256
// and ES256: what a Supabase project signs with), which keys may verify which algorithm (a public key can never be used as an HMAC secret: the
// classic confusion), and what a token must carry (an `exp`, the right `aud`).

import crypto from 'node:crypto';

export class JwtError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

const ALGS = new Set(['HS256', 'RS256', 'ES256']);
const MAX_LENGTH = 8192;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

const fail = (code, message) => { throw new JwtError(code, message); };

function decodeJson(segment, what) {
  if (!SEGMENT.test(segment)) fail('MALFORMED', `The token's ${what} is not base64url.`);
  let value;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    fail('MALFORMED', `The token's ${what} is not JSON.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('MALFORMED', `The token's ${what} is not an object.`);
  return value;
}

/** Which of the candidate keys can verify this algorithm. A secret verifies only HS256; a public key only the algorithm it was made for. */
function fits(key, alg) {
  if (!key) return false;
  if (key.type === 'secret') return alg === 'HS256';
  if (key.type === 'public') return key.alg === alg;
  return false;
}

function signatureOk(alg, key, data, signature) {
  if (alg === 'HS256') {
    const expected = crypto.createHmac('sha256', key.secret).update(data).digest();
    return expected.length === signature.length && crypto.timingSafeEqual(expected, signature);
  }
  if (alg === 'ES256') return crypto.verify('sha256', data, { key: key.key, dsaEncoding: 'ieee-p1363' }, signature);
  return crypto.verify('sha256', data, key.key, signature);
}

const aud = claim => (Array.isArray(claim) ? claim : claim === undefined ? [] : [claim]);

/**
 * Returns the token's claims, or throws a JwtError whose `code` says why not: MALFORMED, ALG, KEY, SIGNATURE, EXPIRED, NOT_YET, AUDIENCE, ISSUER.
 * `keys` is a function from the token's header to the keys that might have signed it (see keys.js); it may be asynchronous.
 */
export async function verifyJwt(token, { keys, now = Date.now(), audience = 'authenticated', issuer, leewaySeconds = 5 } = {}) {
  if (typeof token !== 'string' || token.length > MAX_LENGTH) fail('MALFORMED', 'There is no usable token.');
  const parts = token.split('.');
  if (parts.length !== 3) fail('MALFORMED', 'A token has three parts.');
  const [head, body, sig] = parts;
  const header = decodeJson(head, 'header');
  if (!ALGS.has(header.alg)) fail('ALG', `The algorithm ${JSON.stringify(header.alg)} is not accepted.`);
  if (!SEGMENT.test(body)) fail('MALFORMED', 'The token\'s payload is not base64url.');
  if (!SEGMENT.test(sig)) fail('MALFORMED', 'The token\'s signature is not base64url.');

  const candidates = (await keys({ alg: header.alg, kid: typeof header.kid === 'string' ? header.kid : undefined }) || []).filter(k => fits(k, header.alg));
  if (!candidates.length) fail('KEY', 'No key this API holds can verify that token.');

  const data = Buffer.from(`${head}.${body}`);
  const signature = Buffer.from(sig, 'base64url');
  let signed = false;
  for (const key of candidates) {
    try {
      if (signatureOk(header.alg, key, data, signature)) { signed = true; break; }
    } catch { /* a signature of the wrong shape is simply not a match */ }
  }
  if (!signed) fail('SIGNATURE', 'The token\'s signature does not match.');

  const claims = decodeJson(body, 'payload');
  const at = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp + leewaySeconds <= at) fail('EXPIRED', 'The token has expired, or has no end.');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - leewaySeconds > at)) fail('NOT_YET', 'The token is not valid yet.');
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - leewaySeconds > at)) fail('NOT_YET', 'The token was issued in the future.');
  if (!aud(claims.aud).includes(audience)) fail('AUDIENCE', 'The token is not for this audience.');
  if (issuer !== undefined && claims.iss !== issuer) fail('ISSUER', 'The token was not issued by the expected party.');
  return claims;
}
