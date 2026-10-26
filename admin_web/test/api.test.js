import { describe, expect, it, vi } from 'vitest';

import { AdminApiError, createAdminApi } from '../src/lib/api.js';

// What the admin console's page asks the admin API, and what it makes of the answer. It reads; the one write is recording that a person signed in.
// The token goes in a header and nowhere else (never an address, never stored), and every way an answer can go wrong becomes one of a few kinds the
// screens know how to word.

const BASE = 'https://admin-api.kullina.example';
const TOKEN = 'tok-AAAA.BBBB.CCCC';

function reply(status, body, { headers = {}, text } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => lower[name.toLowerCase()] ?? null },
    json: async () => { if (body === undefined) throw new Error('not json'); return body; },
    blob: async () => new Blob([text ?? ''], { type: 'text/csv' }),
    text: async () => text ?? JSON.stringify(body)
  };
}
const make = (respond, over = {}) => {
  const fetchImpl = vi.fn(async (...args) => respond(...args));
  const api = createAdminApi({ baseUrl: BASE, getToken: async () => TOKEN, fetchImpl, ...over });
  return { api, fetchImpl };
};
const ok = body => () => reply(200, { success: true, ...body });
const readBlob = blob => new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsText(blob); });

describe('how a request is made', () => {
  it('asks for a fleet with the token in a header, and sends nothing else that identifies anyone', async () => {
    const { api, fetchImpl } = make(ok({ tenants: [] }));
    await api.fleet();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/fleet`);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.credentials).toBe('omit');
    expect(init.mode).toBe('cors');
    expect(init.cache).toBe('no-store');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.body).toBeUndefined();
  });

  it('never puts the token in an address', async () => {
    const { api, fetchImpl } = make(ok({ events: [], next_before: null, tenant: {}, subscriptions: [], ok: true, checked: 0 }));
    await api.fleet(); await api.tenant('abc'); await api.audit({ type: 'x' }); await api.verify('abc'); await api.me(); await api.recordSession();
    for (const [url] of fetchImpl.mock.calls) expect(url).not.toContain(TOKEN);
  });

  it('asks for a fresh token each time, so a refreshed session is used at once', async () => {
    const tokens = ['first', 'second'];
    const getToken = vi.fn(async () => tokens.shift());
    const { api, fetchImpl } = make(ok({}), { getToken });
    await api.fleet(); await api.fleet();
    expect(fetchImpl.mock.calls.map(c => c[1].headers.Authorization)).toEqual(['Bearer first', 'Bearer second']);
  });

  it('trims a trailing slash from the address it is given', async () => {
    const { api, fetchImpl } = make(ok({}), { baseUrl: `${BASE}/` });
    await api.fleet();
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/fleet`);
  });

  it('gives each request an id of its own, plain enough for the API to keep', async () => {
    const { api, fetchImpl } = make(ok({}));
    await api.fleet(); await api.fleet();
    const ids = fetchImpl.mock.calls.map(c => c[1].headers['X-Request-Id']);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(new Set(ids).size).toBe(2);
  });

  it('reads with GET everywhere except recording a sign-in, which is a POST with no body', async () => {
    const { api, fetchImpl } = make(ok({ event_id: 5, user: {}, tenant: {}, events: [], ok: true, checked: 0, next_before: null, subscriptions: [] }));
    await api.me(); await api.fleet(); await api.tenant('a'); await api.audit({}); await api.verify(null);
    expect(fetchImpl.mock.calls.map(c => c[1].method ?? 'GET')).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
    await api.recordSession();
    const [, init] = fetchImpl.mock.calls.at(-1);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
});

describe('the routes', () => {
  it('encodes a restaurant id in the address', async () => {
    const { api, fetchImpl } = make(ok({}));
    await api.tenant('a b/c?d');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/tenants/a%20b%2Fc%3Fd`);
  });

  it('turns the audit filters into a query, leaving out what is empty', async () => {
    const { api, fetchImpl } = make(ok({ events: [] }));
    await api.audit({});
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/audit`);
    await api.audit({ restaurant: '', type: null, source: undefined, from: '', to: '', before: null, limit: undefined });
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/api/audit`);
    await api.audit({ restaurant: 'r1', type: 'admin.signin', source: 'admin', from: '2026-10-01', to: '2026-10-27', before: 90, limit: 50 });
    const url = new URL(fetchImpl.mock.calls[2][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ restaurant_id: 'r1', type: 'admin.signin', source: 'admin', from: '2026-10-01', to: '2026-10-27', before: '90', limit: '50' });
  });

  it('encodes what a person typed, so it cannot add parameters', async () => {
    const { api, fetchImpl } = make(ok({ events: [] }));
    await api.audit({ type: 'a&limit=1000&before=1 #x' });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect([...url.searchParams.keys()]).toEqual(['type']);
    expect(url.searchParams.get('type')).toBe('a&limit=1000&before=1 #x');
  });

  it('checks the chain of one restaurant, or the console\'s own when none is named', async () => {
    const { api, fetchImpl } = make(ok({ ok: true, checked: 3 }));
    await api.verify(null);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/audit/verify`);
    await api.verify('r 1');
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/api/audit/verify?restaurant_id=r%201`);
  });

  it('gets the audit log as a file, with the name the API gave it', async () => {
    const { api, fetchImpl } = make(() => reply(200, undefined, { text: 'Event,When\r\n1,x\r\n', headers: { 'Content-Disposition': 'attachment; filename="kullina-audit-2026-10-26.csv"', 'Content-Type': 'text/csv; charset=utf-8' } }));
    const file = await api.auditCsv({ type: 'admin.signin', limit: 20 });
    expect(file.filename).toBe('kullina-audit-2026-10-26.csv');
    expect(await readBlob(file.blob)).toBe('Event,When\r\n1,x\r\n');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/audit.csv?type=admin.signin&limit=20`);
  });

  it('falls back to a plain file name, and never trusts one with a path in it', async () => {
    for (const header of [null, 'attachment', 'attachment; filename="../../etc/passwd"', 'attachment; filename="a/b.csv"', 'attachment; filename="x\\y.csv"']) {
      const { api } = make(() => reply(200, undefined, { text: 'x', headers: header ? { 'Content-Disposition': header } : {} }));
      const file = await api.auditCsv({});
      expect(file.filename).toBe('kullina-audit.csv');
    }
  });

  it('reports a failed file as an error like any other', async () => {
    const { api } = make(() => reply(502, { success: false, code: 'DATABASE' }));
    await expect(api.auditCsv({})).rejects.toMatchObject({ kind: 'down' });
  });
});

describe('what an answer means', () => {
  const fails = (status, body) => make(() => reply(status, body)).api.fleet();

  it('returns the body of a good answer, whole', async () => {
    const { api } = make(ok({ generated_at: 'x', tenants: [1, 2] }));
    expect(await api.fleet()).toEqual({ success: true, generated_at: 'x', tenants: [1, 2] });
  });

  it.each([
    [401, { success: false, code: 'UNAUTHENTICATED' }, 'denied'],
    [403, { success: false, code: 'MFA_REQUIRED' }, 'mfa'],
    [403, { success: false, code: 'ADMIN_ONLY' }, 'not_admin'],
    [403, { success: false, code: 'SOMETHING_ELSE' }, 'down'],
    [429, { success: false, code: 'TOO_MANY' }, 'locked'],
    [404, { success: false, code: 'NOT_FOUND' }, 'missing'],
    [502, { success: false, code: 'DATABASE' }, 'down'],
    [500, { success: false }, 'down'],
    [503, undefined, 'down']
  ])('an answer of %i %j is "%s"', async (status, body, kind) => {
    await expect(fails(status, body)).rejects.toMatchObject({ name: 'AdminApiError', kind });
  });

  it('a failure status is a failure even if the body says it succeeded', async () => {
    await expect(make(() => reply(500, { success: true })).api.fleet()).rejects.toMatchObject({ kind: 'down' });
    await expect(make(() => reply(403, { success: true })).api.fleet()).rejects.toMatchObject({ kind: 'down' });
  });

  it('a 404 is "missing" only when the API said what was not found', async () => {
    await expect(make(() => reply(404, { success: false, code: 'SOMETHING' })).api.fleet()).rejects.toMatchObject({ kind: 'down' });
    await expect(make(() => reply(404, undefined)).api.fleet()).rejects.toMatchObject({ kind: 'down' });
  });

  it('a 400 with words too long to be a sentence is not shown to anyone', async () => {
    const e = await fails(400, { success: false, error: 'x'.repeat(500) }).catch(x => x);
    expect(e.kind).toBe('down');
    expect(e.message).not.toMatch(/xxxx/);
  });

  it('a 400 says what the API said was wrong, because that was written for a person', async () => {
    const e = await fails(400, { success: false, code: 'BAD_REQUEST', error: 'limit is a number from 1 to 500.' }).catch(x => x);
    expect(e).toBeInstanceOf(AdminApiError);
    expect(e.kind).toBe('bad');
    expect(e.message).toBe('limit is a number from 1 to 500.');
  });

  it('an answer that says it is fine but is not marked successful is not believed', async () => {
    await expect(make(() => reply(200, { tenants: [] })).api.fleet()).rejects.toMatchObject({ kind: 'down' });
    await expect(make(() => reply(200, { success: false })).api.fleet()).rejects.toMatchObject({ kind: 'down' });
    await expect(make(() => reply(200, undefined)).api.fleet()).rejects.toMatchObject({ kind: 'down' });
  });

  it('no connection is "offline", and a missing session is "denied" without asking the network at all', async () => {
    await expect(make(() => { throw new TypeError('Failed to fetch'); }).api.fleet()).rejects.toMatchObject({ kind: 'offline' });
    const getToken = vi.fn(async () => { throw new Error('no session'); });
    const { api, fetchImpl } = make(ok({}), { getToken });
    await expect(api.fleet()).rejects.toMatchObject({ kind: 'denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(make(ok({}), { getToken: async () => '' }).api.fleet()).rejects.toMatchObject({ kind: 'denied' });
  });

  it('puts a person-readable sentence on every kind, and never the token, the address or the raw server text', async () => {
    const cases = [
      [401, { code: 'UNAUTHENTICATED' }], [403, { code: 'MFA_REQUIRED' }], [403, { code: 'ADMIN_ONLY' }], [429, {}], [404, { code: 'NOT_FOUND' }],
      [502, { error: `internal ${TOKEN} at ${BASE}` }], [500, {}]
    ];
    for (const [status, body] of cases) {
      const e = await fails(status, { success: false, ...body }).catch(x => x);
      expect(e.message.length).toBeGreaterThan(10);
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain('kullina.example');
      expect(e.message).not.toMatch(/internal/);
    }
  });
});
