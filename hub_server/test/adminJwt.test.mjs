import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { verifyJwt, JwtError } from '../../admin_api/lib/jwt.js';
import { hsKeys, jwkKeys, remoteJwks, anyOf } from '../../admin_api/lib/keys.js';

// How the admin API decides a token is real. The token is the founder's Supabase session; the API checks its signature, its lifetime and who
// it is for before it believes a word of it, and refuses anything it does not positively understand (an algorithm it was not told to
// expect, a key it does not hold, a token with no end). Nothing here touches a database.

const SECRET = 'x'.repeat(48);
const NOW = Date.parse('2026-10-26T10:00:00Z');
const sec = ms => Math.floor(ms / 1000);

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const claims = (over = {}) => ({ sub: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', aal: 'aal2', aud: 'authenticated', role: 'authenticated', exp: sec(NOW) + 600, iat: sec(NOW) - 60, ...over });

function signHs(payload, secret = SECRET, header = {}) {
  const head = b64({ alg: 'HS256', typ: 'JWT', ...header });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function signAsym(payload, privateKey, alg, header = {}) {
  const head = b64({ alg, typ: 'JWT', ...header });
  const body = b64(payload);
  const data = Buffer.from(`${head}.${body}`);
  const sig = alg === 'ES256'
    ? crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('sha256', data, privateKey);
  return `${head}.${body}.${sig.toString('base64url')}`;
}
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (pub, kid, extra = {}) => ({ ...pub.export({ format: 'jwk' }), kid, use: 'sig', ...extra });

const verify = (token, over = {}) => verifyJwt(token, { keys: hsKeys(SECRET), now: NOW, ...over });
const rejects = async (token, code, over) => {
  await assert.rejects(() => verify(token, over), err => {
    assert.ok(err instanceof JwtError, `expected a JwtError, got ${err}`);
    if (code) assert.equal(err.code, code, err.message);
    return true;
  });
};

// --- a good token -----------------------------------------------------------------------------------------------------------

test('a token signed with the project secret, in date and for the right audience, is accepted and its claims returned', async () => {
  const out = await verify(signHs(claims()));
  assert.deepEqual([out.sub, out.aal, out.role], ['f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', 'aal2', 'authenticated']);
});

test('a token signed with an elliptic-curve key (the kind a project with signing keys issues) is accepted by its key id', async () => {
  const keys = jwkKeys({ keys: [jwkOf(ec.publicKey, 'k-ec')] });
  const out = await verify(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k-ec' }), { keys });
  assert.equal(out.aal, 'aal2');
});

test('and one signed with an RSA key', async () => {
  const keys = jwkKeys({ keys: [jwkOf(rsa.publicKey, 'k-rsa')] });
  assert.equal((await verify(signAsym(claims(), rsa.privateKey, 'RS256', { kid: 'k-rsa' }), { keys })).aal, 'aal2');
});

test('the right key is picked out of several by its id, and a token with an unknown id is refused', async () => {
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keys = jwkKeys({ keys: [jwkOf(other.publicKey, 'k-other'), jwkOf(ec.publicKey, 'k-ec')] });
  assert.ok(await verify(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k-ec' }), { keys }));
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k-missing' }), 'KEY', { keys });
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k-other' }), 'SIGNATURE', { keys });
});

// --- a forged or damaged token --------------------------------------------------------------------------------------------------

test('a wrong secret, an edited payload and an edited signature are refused', async () => {
  await rejects(signHs(claims(), 'y'.repeat(48)), 'SIGNATURE');
  const good = signHs(claims());
  const [h, , s] = good.split('.');
  await rejects(`${h}.${b64(claims({ sub: '99999999-9999-4999-8999-999999999999' }))}.${s}`, 'SIGNATURE');
  await rejects(`${good.slice(0, -2)}AA`, 'SIGNATURE');
  await rejects(`${h}.${b64(claims({ aal: 'aal1' }))}.${s}`, 'SIGNATURE');
});

test('"alg": "none" is refused, however the token is built', async () => {
  await rejects(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims())}.`, 'ALG');
  await rejects(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims())}.abc`, 'ALG');
  await rejects(`${b64({ alg: 'None', typ: 'JWT' })}.${b64(claims())}.`, 'ALG');
});

test('an algorithm the API was not told to expect is refused', async () => {
  for (const alg of ['HS512', 'RS512', 'ES384', 'PS256', 'EdDSA', '', 'hs256']) {
    await rejects(`${b64({ alg, typ: 'JWT' })}.${b64(claims())}.AAAA`, 'ALG');
  }
  await rejects(`${b64({ typ: 'JWT' })}.${b64(claims())}.AAAA`, 'ALG');
});

test('a token cannot be signed with the public key as if it were a secret (algorithm confusion)', async () => {
  const keys = jwkKeys({ keys: [jwkOf(ec.publicKey, 'k-ec')] });
  const pem = ec.publicKey.export({ type: 'spki', format: 'pem' });
  await rejects(signHs(claims(), pem, { kid: 'k-ec' }), 'KEY', { keys });
  const rsaKeys = jwkKeys({ keys: [jwkOf(rsa.publicKey, 'k-rsa')] });
  await rejects(signHs(claims(), rsa.publicKey.export({ type: 'spki', format: 'pem' }), { kid: 'k-rsa' }), 'KEY', { keys: rsaKeys });
});

test('a key of the wrong kind for the token\'s algorithm is refused', async () => {
  const keys = jwkKeys({ keys: [jwkOf(rsa.publicKey, 'k-rsa')] });
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k-rsa' }), 'KEY', { keys });
});

test('something that is not a token at all is refused, not crashed on', async () => {
  for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '..', 'a..c', 'ey.ey.ey', 'x'.repeat(9000), 42, null, undefined, {}, [], 'a.b.c\n']) {
    await rejects(bad, undefined);
  }
  await rejects(`${b64('not json')}.${b64(claims())}.AAAA`, 'MALFORMED');
  await rejects(`${b64({ alg: 'HS256' })}.${b64('not json')}.AAAA`, undefined);
  await rejects(`${b64({ alg: 'HS256' })}.${b64([1, 2])}.AAAA`, undefined);
  await rejects(`${b64({ alg: 'HS256' })}.${b64('"a string"')}.AAAA`, undefined);
});

test('a token with anything after its signature, or one longer than a header can carry, is refused even if the rest is perfect', async () => {
  await rejects(`${signHs(claims())}.extra`, 'MALFORMED');
  await rejects(`${signHs(claims())}.`, 'MALFORMED');
  await rejects(signHs(claims({ pad: 'x'.repeat(9000) })), 'MALFORMED');
});

test('a correctly signed payload that is not an object is refused', async () => {
  for (const payload of [[1, 2], '"a string"', 42, null, true]) await rejects(signHs(payload), 'MALFORMED');
});

test('a key offered for the wrong algorithm is not used, whoever offered it', async () => {
  await rejects(signAsym(claims(), ec.privateKey, 'ES256'), 'KEY', { keys: () => [{ type: 'public', alg: 'RS256', key: rsa.publicKey }] });
  await rejects(signAsym(claims(), rsa.privateKey, 'RS256'), 'KEY', { keys: () => [{ type: 'public', alg: 'ES256', key: ec.publicKey }] });
});

test('a key that carries a secret part, or is on another curve, is not a verifying key', async () => {
  const withSecret = jwkKeys({ keys: [jwkOf(ec.publicKey, 'k-ec', { k: 'AAAA' })] });
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k-ec' }), 'KEY', { keys: withSecret });
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const keys = jwkKeys({ keys: [jwkOf(p384.publicKey, 'k-384')] });
  await rejects(signAsym(claims(), p384.privateKey, 'ES256', { kid: 'k-384' }), 'KEY', { keys });
});

test('characters that are not base64url are refused rather than quietly ignored', async () => {
  const good = signHs(claims());
  const [h, p, s] = good.split('.');
  await rejects(`${h}.${p}+.${s}`, 'MALFORMED');
  await rejects(`${h} .${p}.${s}`, 'MALFORMED');
  await rejects(`${h}.${p}.${s}=`, 'MALFORMED');
});

// --- lifetime and audience -------------------------------------------------------------------------------------------------------

test('an expired token is refused, and one with no end at all is too', async () => {
  await rejects(signHs(claims({ exp: sec(NOW) - 60 })), 'EXPIRED');
  await rejects(signHs(claims({ exp: sec(NOW) - 6 })), 'EXPIRED');
  const { exp: _gone, ...noEnd } = claims();
  await rejects(signHs(noEnd), 'EXPIRED');
  await rejects(signHs(claims({ exp: 'tomorrow' })), 'EXPIRED');
  await rejects(signHs(claims({ exp: null })), 'EXPIRED');
});

test('a little clock difference is allowed, and no more', async () => {
  assert.ok(await verify(signHs(claims({ exp: sec(NOW) - 4 }))), 'four seconds past its end is within the leeway');
  await rejects(signHs(claims({ exp: sec(NOW) - 6 })), 'EXPIRED');
  assert.ok(await verify(signHs(claims({ exp: sec(NOW) - 30 })), { leewaySeconds: 60 }));
});

test('the clock leeway has an exact edge: five seconds past the end is over, five seconds early is allowed', async () => {
  await rejects(signHs(claims({ exp: sec(NOW) - 5 })), 'EXPIRED');
  assert.ok(await verify(signHs(claims({ exp: sec(NOW) - 4 }))));
  assert.ok(await verify(signHs(claims({ nbf: sec(NOW) + 5 }))), 'valid from five seconds from now is within the leeway');
  await rejects(signHs(claims({ nbf: sec(NOW) + 6 })), 'NOT_YET');
  assert.ok(await verify(signHs(claims({ iat: sec(NOW) + 5 }))));
  await rejects(signHs(claims({ iat: sec(NOW) + 6 })), 'NOT_YET');
  await rejects(signHs(claims({ nbf: 'soon' })), 'NOT_YET');
  await rejects(signHs(claims({ iat: 'earlier' })), 'NOT_YET');
});

test('a token whose algorithm no held key can verify is refused as having no key, not as having a bad signature', async () => {
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k' }), 'KEY');                    // only a secret is held
  await rejects(signAsym(claims(), rsa.privateKey, 'RS256', { kid: 'k' }), 'KEY');
  await rejects(signHs(claims()), 'KEY', { keys: jwkKeys({ keys: [jwkOf(ec.publicKey, 'k')] }) });   // only public keys are held
  await rejects(signHs(claims()), 'KEY', { keys: () => [] });
  await rejects(signHs(claims()), 'KEY', { keys: () => null });
  await rejects(signHs(claims()), 'KEY', { keys: () => [null, { type: 'weird' }] });
});

test('a token that is not valid yet, or was issued in the future, is refused', async () => {
  await rejects(signHs(claims({ nbf: sec(NOW) + 120 })), 'NOT_YET');
  assert.ok(await verify(signHs(claims({ nbf: sec(NOW) - 120 }))));
  await rejects(signHs(claims({ iat: sec(NOW) + 3600 })), 'NOT_YET');
});

test('a token for another audience is refused, and the audience may be a list', async () => {
  await rejects(signHs(claims({ aud: 'anon' })), 'AUDIENCE');
  await rejects(signHs(claims({ aud: undefined })), 'AUDIENCE');
  await rejects(signHs(claims({ aud: ['anon', 'service'] })), 'AUDIENCE');
  assert.ok(await verify(signHs(claims({ aud: ['x', 'authenticated'] }))));
  assert.ok(await verify(signHs(claims({ aud: 'other' })), { audience: 'other' }));
});

test('when an issuer is required it must match exactly', async () => {
  const issuer = 'https://abc.supabase.co/auth/v1';
  assert.ok(await verify(signHs(claims({ iss: issuer })), { issuer }));
  await rejects(signHs(claims({ iss: 'https://evil.example/auth/v1' })), 'ISSUER', { issuer });
  await rejects(signHs(claims({ iss: undefined })), 'ISSUER', { issuer });
  assert.ok(await verify(signHs(claims({ iss: 'anything' }))), 'and when none is required, none is checked');
});

// --- keys -------------------------------------------------------------------------------------------------------------------------------

test('a secret that is too short to be one is refused when the keys are set up', () => {
  assert.throws(() => hsKeys('short'), /secret/i);
  assert.throws(() => hsKeys(''), /secret/i);
  assert.throws(() => hsKeys(undefined), /secret/i);
});

test('a key set can hold a secret and public keys together, and each token goes to the one that fits', async () => {
  const keys = anyOf(hsKeys(SECRET), jwkKeys({ keys: [jwkOf(ec.publicKey, 'k-ec')] }));
  assert.ok(await verify(signHs(claims()), { keys }));
  assert.ok(await verify(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k-ec' }), { keys }));
});

test('keys that are not usable are skipped, not trusted: a private key, a symmetric key or an unknown type in the set', async () => {
  const set = { keys: [{ kty: 'oct', k: 'AAAA', kid: 'a' }, { ...ec.privateKey.export({ format: 'jwk' }), kid: 'b' }, { kty: 'RSA', kid: 'c' }, null, 'x'] };
  const keys = jwkKeys(set);
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'b' }), 'KEY', { keys });
});

test('a key set fetched from the project is cached, and refetched once when a new key id appears, but not on every unknown one', async () => {
  let calls = 0;
  let served = { keys: [jwkOf(ec.publicKey, 'k1')] };
  let clock = NOW;
  const fetchFn = async () => { calls++; return { ok: true, json: async () => served }; };
  const keys = remoteJwks({ url: 'https://abc.supabase.co/auth/v1/.well-known/jwks.json', fetch: fetchFn, ttlMs: 600000, minRefetchMs: 60000, now: () => clock });
  const t1 = signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k1' });
  assert.ok(await verify(t1, { keys }));
  assert.ok(await verify(t1, { keys }));
  assert.equal(calls, 1, 'cached');

  const next = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  served = { keys: [jwkOf(ec.publicKey, 'k1'), jwkOf(next.publicKey, 'k2')] };
  const t2 = signAsym(claims(), next.privateKey, 'ES256', { kid: 'k2' });
  clock += 61000;
  assert.ok(await verify(t2, { keys, now: clock }));
  assert.equal(calls, 2, 'a new key id caused one refetch');

  const t3 = signAsym(claims(), next.privateKey, 'ES256', { kid: 'k-unknown' });
  clock += 1000;
  await rejects(t3, 'KEY', { keys, now: clock });
  await rejects(t3, 'KEY', { keys, now: clock });
  assert.equal(calls, 2, 'and unknown ids do not make the API hammer the project');
});

test('a fetched key set is kept only for its lifetime, and an answer that is not a key set never replaces a good one', async () => {
  let calls = 0;
  let reply = { ok: true, json: async () => ({ keys: [jwkOf(ec.publicKey, 'k1')] }) };
  let clock = NOW;
  const keys = remoteJwks({ url: 'https://abc.supabase.co/x', fetch: async () => { calls++; return reply; }, ttlMs: 600000, minRefetchMs: 60000, now: () => clock });
  const token = signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k1' });
  assert.ok(await verify(token, { keys }));
  assert.equal(calls, 1);

  clock += 599000;
  assert.ok(await verify(token, { keys }));
  assert.equal(calls, 1, 'still fresh just inside its lifetime');
  clock += 2000;
  reply = { ok: false, status: 503, json: async () => ({ keys: [jwkOf(rsa.publicKey, 'k-evil')] }) };
  assert.ok(await verify(token, { keys }), 'after its lifetime it is asked again, and a failed answer leaves the old keys in place');
  assert.equal(calls, 2);
  await rejects(signAsym(claims(), rsa.privateKey, 'RS256', { kid: 'k-evil' }), 'KEY', { keys }, 'keys offered in a failed answer are not trusted');

  clock += 601000;
  reply = { ok: true, json: async () => ({ nothing: 'here' }) };
  assert.ok(await verify(token, { keys }), 'and an answer that is not a key set does not wipe the good one');
  assert.equal(calls, 3);
});

test('if the key set cannot be fetched the token is refused, never trusted', async () => {
  const keys = remoteJwks({ url: 'https://abc.supabase.co/x', fetch: async () => { throw new Error('offline'); }, now: () => NOW });
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k1' }), 'KEY', { keys });
  const bad = remoteJwks({ url: 'https://abc.supabase.co/x', fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), now: () => NOW });
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k1' }), 'KEY', { keys: bad });
  const junk = remoteJwks({ url: 'https://abc.supabase.co/x', fetch: async () => ({ ok: true, json: async () => ({ nothing: true }) }), now: () => NOW });
  await rejects(signAsym(claims(), ec.privateKey, 'ES256', { kid: 'k1' }), 'KEY', { keys: junk });
});
