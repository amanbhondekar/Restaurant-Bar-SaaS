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

describe('the alerts', () => {
  const alerts = { alerts: [], counts: { open: 0, acked: 0, unattended: 0 }, truncated: false };

  it('reads the inbox with GET, asking for what is waiting and taken on unless told otherwise', async () => {
    const { api, fetchImpl } = make(ok(alerts));
    await api.alerts();
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/alerts`);
    expect(fetchImpl.mock.calls[0][1].method ?? 'GET').toBe('GET');
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
  });

  it('turns the filters into a query, leaving out what is empty, and encodes what is given', async () => {
    const { api, fetchImpl } = make(ok(alerts));
    await api.alerts({ state: 'open', limit: 20 });
    await api.alerts({ state: '', limit: undefined });
    await api.alerts({ state: 'a&b=c' });
    expect(fetchImpl.mock.calls.map(c => c[0])).toEqual([`${BASE}/api/alerts?state=open&limit=20`, `${BASE}/api/alerts`, `${BASE}/api/alerts?state=a%26b%3Dc`]);
  });

  it('acknowledges with a POST of JSON holding the reason and nothing else, the token in the header only', async () => {
    const { api, fetchImpl } = make(ok({ alert: { id: 7, state: 'acked' }, event_id: 3 }));
    const out = await api.acknowledgeAlert(7, 'the owner is ringing them back');
    expect(out.alert).toEqual({ id: 7, state: 'acked' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/alerts/7/ack`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ reason: 'the owner is ringing them back' });
    expect(init.body).not.toContain(TOKEN);
    expect(url).not.toContain(TOKEN);
    expect([init.credentials, init.cache, init.referrerPolicy, init.mode]).toEqual(['omit', 'no-store', 'no-referrer', 'cors']);
  });

  it('resolves the same way, at its own address', async () => {
    const { api, fetchImpl } = make(ok({ alert: { id: 7, state: 'resolved' }, event_id: 4 }));
    await api.resolveAlert(7, 'the hub is back on, they rang');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/alerts/7/resolve`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: 'the hub is back on, they rang' });
  });

  it('encodes an id in the address, so it cannot reach another route', async () => {
    const { api, fetchImpl } = make(ok({ alert: {}, event_id: 1 }));
    await api.acknowledgeAlert('7/../fleet?x=', 'a perfectly good reason');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/alerts/7%2F..%2Ffleet%3Fx%3D/ack`);
  });

  it('sends a body only for these two, and a reason that is not text is sent as text, never as something else', async () => {
    const { api, fetchImpl } = make(ok({ alert: {}, event_id: 1, user: {}, tenant: {}, events: [], ok: true, checked: 0, next_before: null, subscriptions: [], ...alerts }));
    await api.me(); await api.fleet(); await api.alerts(); await api.audit({}); await api.recordSession();
    for (const [, init] of fetchImpl.mock.calls) expect(init.body).toBeUndefined();
    await api.acknowledgeAlert(1, { toString: () => 'sneaky' });
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body)).toEqual({ reason: 'sneaky' });
  });

  it('says in its own words that an alert is already resolved, and a missing one is missing', async () => {
    const conflict = await make(() => reply(409, { success: false, code: 'CONFLICT', error: 'That alert is already resolved.' })).api.resolveAlert(1, 'a perfectly good reason').catch(e => e);
    expect(conflict).toBeInstanceOf(AdminApiError);
    expect(conflict.kind).toBe('conflict');
    expect(conflict.message).toBe('That alert is already resolved.');
    await expect(make(() => reply(404, { success: false, code: 'NOT_FOUND' })).api.acknowledgeAlert(1, 'a perfectly good reason')).rejects.toMatchObject({ kind: 'missing' });
  });

  it('a 409 is a conflict whatever words come with it: the words shown are the page\'s own', async () => {
    const e = await make(() => reply(409, { success: false, code: 'CONFLICT', error: `internal ${TOKEN}` })).api.resolveAlert(1, 'a perfectly good reason').catch(x => x);
    expect(e.kind).toBe('conflict');
    expect(e.message).not.toContain(TOKEN);
  });

  it('a 400 about the reason says what the API said was wrong, because that was written for a person', async () => {
    const e = await make(() => reply(400, { success: false, code: 'BAD_REQUEST', error: 'Give a reason of at least 10 characters, in your own words.' })).api.acknowledgeAlert(1, 'short').catch(x => x);
    expect(e.kind).toBe('bad');
    expect(e.message).toBe('Give a reason of at least 10 characters, in your own words.');
  });

  it('a refused session on a write is "denied", an administrator-only refusal "not_admin", and no connection "offline"; none of them sends twice', async () => {
    const one = (status, body) => make(() => reply(status, { success: false, ...body }));
    for (const [status, body, kind] of [[401, { code: 'UNAUTHENTICATED' }, 'denied'], [403, { code: 'MFA_REQUIRED' }, 'mfa'], [403, { code: 'ADMIN_ONLY' }, 'not_admin'], [502, { code: 'DATABASE' }, 'down']]) {
      const { api, fetchImpl } = one(status, body);
      await expect(api.acknowledgeAlert(1, 'a perfectly good reason')).rejects.toMatchObject({ kind });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    await expect(make(() => { throw new TypeError('Failed to fetch'); }).api.resolveAlert(1, 'a perfectly good reason')).rejects.toMatchObject({ kind: 'offline' });
  });

  it('with no session a write asks the network for nothing', async () => {
    const getToken = vi.fn(async () => '');
    const { api, fetchImpl } = make(ok({}), { getToken });
    await expect(api.acknowledgeAlert(1, 'a perfectly good reason')).rejects.toMatchObject({ kind: 'denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
