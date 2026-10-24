import { vi } from 'vitest';

// A stand-in for the hub, answering fetch() the way the real routes do. Each route is either a
// fixed reply or a function of the request, and every call is recorded so a test can assert on
// exactly what the page sent -- which, for the guest-facing pages, is the point.
//
//   const hub = fakeHub({ 'GET /public/menu': { body: MENU } });
//   ...
//   expect(hub.calls('POST /public/feedback')[0].body).toEqual({ ... });

const json = (status, body) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

export function fakeHub(routes) {
  const log = [];

  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    let body;
    try {
      body = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init.body;
    }
    log.push({ key, url, body, init });

    const route = routes[key];
    if (route === undefined) {
      throw new Error(`fakeHub: no route for ${key}. A page asking for something the test did not expect is itself a finding.`);
    }
    const reply = typeof route === 'function' ? await route({ url, body, init, call: log.filter(c => c.key === key).length }) : route;
    if (reply instanceof Error) throw reply;
    return json(reply.status ?? 200, reply.body);
  });

  vi.stubGlobal('fetch', fetchImpl);

  return {
    fetch: fetchImpl,
    calls: key => log.filter(c => c.key === key),
    all: () => log.slice()
  };
}

/** A promise you resolve by hand, for holding a request open while the test looks at the page. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
