import { describe, expect, it, vi } from 'vitest';

import { createOpsApi, OpsError } from '@/ops/lib/api';

// What the console's browser code asks the operator service, and what it makes of the answer. The service is a fake `fetch`; the real routes
// are tested in hub_server/test/opsRoutes.test.mjs. What matters here: it only ever reads, it sends the token as a bearer and nowhere else,
// and every way an answer can go wrong becomes one of a few kinds the screen knows how to word.

const reply = (status, body) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

describe('asking', () => {
  it('asks for the fleet with a GET, the token as a bearer, and nothing in the address but the route', async () => {
    const fetchImpl = reply(200, { success: true, tenants: [] });
    const api = createOpsApi({ fetchImpl });
    await api.fleet('the-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/ops/api/fleet');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers).toEqual({ Authorization: 'Bearer the-token' });
    expect(init.cache).toBe('no-store');
    expect(init.body).toBeUndefined();
    expect(String(url)).not.toContain('the-token');
    expect(init.credentials).toBeUndefined();
  });

  it('asks for one restaurant by its id, written so that it cannot change the route', async () => {
    const fetchImpl = reply(200, { success: true, tenant: {} });
    const api = createOpsApi({ fetchImpl });
    await api.tenant('t', 'a0a0a0a0-0000-4000-8000-000000000001');
    expect(fetchImpl.mock.calls[0][0]).toBe('/ops/api/tenants/a0a0a0a0-0000-4000-8000-000000000001');
    await api.tenant('t', '../fleet?x=1');
    expect(fetchImpl.mock.calls[1][0]).toBe('/ops/api/tenants/..%2Ffleet%3Fx%3D1');
  });

  it('gives back what the service answered', async () => {
    const body = { success: true, tenants: [{ id: 'a' }], summary: {} };
    expect(await createOpsApi({ fetchImpl: reply(200, body) }).fleet('t')).toEqual(body);
  });

  it('has no way to write: the only things it offers are two reads', () => {
    expect(Object.keys(createOpsApi({ fetchImpl: reply(200, {}) })).sort()).toEqual(['fleet', 'tenant']);
  });
});

describe('what goes wrong', () => {
  const fails = async (status, body) => createOpsApi({ fetchImpl: reply(status, body) }).fleet('t').then(() => null, error => error);

  it('is a token that was not accepted', async () => {
    const e = await fails(401, { success: false, code: 'NOT_OPERATOR' });
    expect(e).toBeInstanceOf(OpsError);
    expect(e.kind).toBe('denied');
    expect(e.message).toBe('That token was not accepted.');
  });

  it('is being turned away for guessing', async () => {
    const e = await fails(429, { success: false, code: 'TOO_MANY' });
    expect(e.kind).toBe('locked');
    expect(e.message).toBe('Too many wrong tries from here. Wait a few minutes and try again.');
  });

  it('is a console that is not switched on', async () => {
    const e = await fails(503, { success: false, code: 'NOT_CONFIGURED' });
    expect(e.kind).toBe('off');
    expect(e.message).toBe('The operator console is not switched on at this service. Set OPS_TOKEN where the service runs.');
  });

  it('is a database that did not answer, whichever way the service says so', async () => {
    for (const [status, body] of [[502, { success: false, code: 'CLOUD' }], [500, null], [504, { success: false }], [503, { success: false, code: 'OTHER' }]]) {
      const e = await fails(status, body);
      expect(e.kind, String(status)).toBe('down');
      expect(e.message).toBe('The database did not answer. Try again in a moment.');
    }
  });

  it('is a restaurant that is not there', async () => {
    const e = await createOpsApi({ fetchImpl: reply(404, { success: false, code: 'NOT_FOUND' }) }).tenant('t', 'x').then(() => null, error => error);
    expect(e.kind).toBe('missing');
    expect(e.message).toBe('That restaurant is not there any more.');
  });

  it('is not a missing restaurant when the 404 came from elsewhere: a proxy page, or an answer in no shape we know', async () => {
    for (const body of [null, { success: false }, { success: false, code: 'OTHER' }]) {
      const e = await createOpsApi({ fetchImpl: reply(404, body) }).tenant('t', 'x').then(() => null, error => error);
      expect(e.kind, JSON.stringify(body)).toBe('down');
    }
  });

  it('does not take a success it was not given: a body that says so under a status that does not is a fault', async () => {
    for (const status of [500, 502, 503, 404, 401]) {
      const e = await fails(status, { success: true, tenants: [] });
      expect(e, String(status)).toBeInstanceOf(OpsError);
    }
    expect((await fails(500, { success: true })).kind).toBe('down');
  });

  it('is no connection at all', async () => {
    const e = await createOpsApi({ fetchImpl: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) }).fleet('t').then(() => null, error => error);
    expect(e.kind).toBe('offline');
    expect(e.message).toBe('Could not reach the service. Check your connection and try again.');
  });

  it('is an answer that is not what the service sends', async () => {
    const notJson = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    expect((await createOpsApi({ fetchImpl: notJson }).fleet('t').then(() => null, e => e)).kind).toBe('down');
    expect((await fails(200, { success: false })).kind).toBe('down');
    expect((await fails(200, null)).kind).toBe('down');
  });

  it('never carries the token in what it says', async () => {
    const e = await fails(401, { success: false });
    expect(JSON.stringify([e.kind, e.message])).not.toContain('"t"');
  });
});
