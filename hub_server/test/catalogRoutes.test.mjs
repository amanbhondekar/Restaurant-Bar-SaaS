import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import { startHub, call, RESTAURANT_ID } from './helpers/spawnHub.mjs';

const MENU = {
  restaurant_id: RESTAURANT_ID,
  categories: ['Starters'],
  items: [{ id: 'm1', name: 'Paneer Tikka', price: 230, category: 'Starters', isVeg: true, available: true }]
};
const TABLES = {
  restaurant_id: RESTAURANT_ID,
  tables: [
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 4 },
    { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 }
  ]
};

let rec;      // reception: loopback is trusted
let handset;  // remote handset: loopback is NOT trusted, needs a token
let token;

before(async () => {
  rec = await startHub({ trustLoopback: true, menu: MENU, tables: TABLES });
  handset = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES });
  const enrol = await call(handset, '/auth/device', { method: 'POST', body: { enrollment_code: 'TESTCODE', device_label: 'test' } });
  token = (await enrol.json()).device_token;
});

after(() => {
  rec?.stop();
  handset?.stop();
});

const json = async res => res.json();

/** Waits for the hub's queue file to hold what the test expects, rather than assuming it does. */
async function queueUntil(hub, predicate, ms = 5000) {
  const file = path.join(hub.dataDir, 'sync_queue.json');
  const deadline = Date.now() + ms;
  let last = [];
  for (;;) {
    try { last = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { last = []; }
    if (predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise(r => setTimeout(r, 50));
  }
}
const menuRev = async () => (await json(await call(rec, '/menu'))).revision;
const tablesRev = async () => (await json(await call(rec, '/tables/layout'))).revision;
const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
};

// ---------------------------------------------------------------- reads

test('GET /menu and /tables/layout expose revision, and layout exposes sections', async () => {
  const menu = await json(await call(rec, '/menu'));
  assert.equal(menu.revision, 0);
  const layout = await json(await call(rec, '/tables/layout'));
  assert.equal(layout.revision, 0);
  assert.deepEqual(layout.sections, ['Main Hall']);
});

// ---------------------------------------------------------------- menu items

test('POST /admin/menu/items adds an item, bumps the revision and refuses a stale base', async () => {
  const res = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { base_revision: 0, item: { name: 'Masala Chaas', category: 'Beverages', price: 50, isVeg: true, station: 'bar' } }
  });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.equal(body.success, true);
  assert.equal(body.revision, 1);
  assert.equal(body.item.name, 'Masala Chaas');

  const menu = await json(await call(rec, '/menu'));
  assert.equal(menu.revision, 1);
  assert.ok(menu.items.some(i => i.name === 'Masala Chaas'));
  assert.ok(menu.categories.includes('Beverages'));

  const stale = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { base_revision: 0, item: { name: 'Other', category: 'Beverages', price: 5, isVeg: true } }
  });
  assert.equal(stale.status, 409);
  const staleBody = await json(stale);
  assert.equal(staleBody.code, 'STALE_REVISION');
  assert.equal(staleBody.current_revision, 1);

  const missing = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { item: { name: 'Other', category: 'Beverages', price: 5, isVeg: true } }
  });
  assert.equal(missing.status, 400);
  assert.equal((await json(missing)).code, 'BASE_REVISION_REQUIRED');

  const invalid = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { base_revision: 1, item: { name: '', category: 'Beverages', price: 0, isVeg: true } }
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await json(invalid);
  assert.equal(invalidBody.code, 'INVALID_ITEM');
  assert.ok(invalidBody.errors.length >= 2);
});

test('PUT merges the provided keys and DELETE removes the item', async () => {
  const menu = await json(await call(rec, '/menu'));
  const chaas = menu.items.find(i => i.name === 'Masala Chaas');

  const put = await call(rec, `/admin/menu/items/${chaas.id}`, {
    method: 'PUT',
    body: { base_revision: menu.revision, item: { price: 60 } }
  });
  assert.equal(put.status, 200);
  const updated = (await json(await call(rec, '/menu'))).items.find(i => i.id === chaas.id);
  assert.equal(updated.price, 60);
  assert.equal(updated.station, 'bar', 'omitted keys are preserved');

  const rev = await menuRev();
  const del = await call(rec, `/admin/menu/items/${chaas.id}?base_revision=${rev}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.ok(!(await json(await call(rec, '/menu'))).items.some(i => i.id === chaas.id));

  const gone = await call(rec, `/admin/menu/items/${chaas.id}?base_revision=${await menuRev()}`, { method: 'DELETE' });
  assert.equal(gone.status, 404);
});

// ---------------------------------------------------------------- categories

test('category add, rename, reorder and delete', async () => {
  let r = await call(rec, '/admin/menu/categories', { method: 'POST', body: { base_revision: await menuRev(), name: 'Drinks' } });
  assert.equal(r.status, 201);

  r = await call(rec, '/admin/menu/categories', { method: 'PUT', body: { base_revision: await menuRev(), from: 'Drinks', to: 'Cold Drinks' } });
  assert.equal(r.status, 200);

  r = await call(rec, '/admin/menu/categories/order', { method: 'PUT', body: { base_revision: await menuRev(), names: ['Cold Drinks', 'Starters', 'Beverages'] } });
  assert.equal(r.status, 200);
  const menu = await json(await call(rec, '/menu'));
  assert.deepEqual(menu.categories, ['Cold Drinks', 'Starters', 'Beverages']);

  r = await call(rec, `/admin/menu/categories?name=${encodeURIComponent('Cold Drinks')}&base_revision=${await menuRev()}`, { method: 'DELETE' });
  assert.equal(r.status, 200);

  r = await call(rec, `/admin/menu/categories?name=Starters&base_revision=${await menuRev()}`, { method: 'DELETE' });
  assert.equal(r.status, 409);
  assert.equal((await json(r)).code, 'CATEGORY_NOT_EMPTY');
});

// ---------------------------------------------------------------- import

test('import preview does not write; commit applies; replace needs confirmation', async () => {
  const rows = [
    { name: 'Paneer Tikka', category: 'Starters', price: '240' },
    { name: 'New Dish', category: 'Starters', price: '100', veg: 'yes' }
  ];
  const before = await menuRev();

  const preview = await call(rec, '/admin/menu/import/preview', { method: 'POST', body: { rows } });
  assert.equal(preview.status, 200);
  const p = await json(preview);
  assert.deepEqual(p.counts, { new: 1, updated: 1, unchanged: 0, error: 0, removed: 0 });
  assert.equal(p.rows[0].item, undefined, 'preview rows omit the full item');
  assert.equal(await menuRev(), before, 'preview must not write');

  const commit = await call(rec, '/admin/menu/import/commit', { method: 'POST', body: { base_revision: before, rows } });
  assert.equal(commit.status, 200);
  const c = await json(commit);
  assert.equal(c.revision, before + 1);
  assert.equal(c.counts.new, 1);
  const menu = await json(await call(rec, '/menu'));
  assert.equal(menu.items.find(i => i.name === 'Paneer Tikka').price, 240);
  assert.ok(menu.items.some(i => i.name === 'New Dish'));

  const unconfirmed = await call(rec, '/admin/menu/import/commit', {
    method: 'POST', body: { base_revision: await menuRev(), rows, mode: 'replace' }
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await json(unconfirmed)).code, 'CONFIRM_REQUIRED');

  const blocked = await call(rec, '/admin/menu/import/commit', {
    method: 'POST', body: { base_revision: await menuRev(), rows: [{ name: 'Bad', category: 'Starters', price: 'x', veg: 'yes' }] }
  });
  assert.equal(blocked.status, 400);
  const blockedBody = await json(blocked);
  assert.equal(blockedBody.code, 'INVALID_ROWS');
  assert.equal(blockedBody.details[0].row, 2);
});

test('import bodies above the global 256 KB limit are accepted; more than 2000 rows are refused', async () => {
  const pad = 'x'.repeat(100);
  const big = Array.from({ length: 2000 }, (_, i) => ({ name: `Dish ${i} ${pad}`, category: 'Bulk', price: '10', veg: 'yes' }));
  assert.ok(JSON.stringify({ rows: big }).length > 256 * 1024, 'fixture must exceed the global limit');

  const ok = await call(rec, '/admin/menu/import/preview', { method: 'POST', body: { rows: big } });
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).counts.new, 2000);

  const tooMany = await call(rec, '/admin/menu/import/preview', {
    method: 'POST', body: { rows: [...big, { name: 'One too many', category: 'Bulk', price: '10', veg: 'yes' }] }
  });
  assert.equal(tooMany.status, 400);
  assert.equal((await json(tooMany)).code, 'TOO_MANY_ROWS');
});

// ---------------------------------------------------------------- tables

test('PUT /admin/tables/layout saves sections, order, rename and a new table; stale base is refused', async () => {
  const layout = {
    base_revision: 0,
    sections: ['Main Hall', 'Patio'],
    tables: [
      { id: 1, name: 'T1', section: 'Main Hall', capacity: 4 },
      { id: 2, name: 'Window', section: 'Main Hall', capacity: 4 },
      { name: 'P1', section: 'Patio', capacity: 6 }
    ]
  };
  const res = await call(rec, '/admin/tables/layout', { method: 'PUT', body: layout });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.revision, 1);
  assert.equal(body.tables[2].id, 3, 'a new table gets the next id');

  const live = await json(await call(rec, '/tables'));
  assert.deepEqual(live.sections, ['Main Hall', 'Patio']);
  assert.deepEqual(live.tables.map(t => t.name), ['T1', 'Window', 'P1']);

  const stale = await call(rec, '/admin/tables/layout', { method: 'PUT', body: layout });
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).code, 'STALE_REVISION');

  const dup = await call(rec, '/admin/tables/layout', {
    method: 'PUT',
    body: { ...layout, base_revision: 1, tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 4 }, { id: 2, name: 't1', section: 'Main Hall', capacity: 4 }] }
  });
  assert.equal(dup.status, 400);
  assert.equal((await json(dup)).code, 'INVALID_LAYOUT');
});

test('a table with an open bill cannot be renamed or deleted, but can be moved', async () => {
  const order = await call(rec, '/orders', { method: 'POST', body: { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 1 }] } });
  assert.ok(order.ok, 'fixture order must be accepted');

  const base = await tablesRev();
  const rename = await call(rec, '/admin/tables/layout', {
    method: 'PUT',
    body: {
      base_revision: base,
      sections: ['Main Hall', 'Patio'],
      tables: [
        { id: 1, name: 'Renamed', section: 'Main Hall', capacity: 4 },
        { id: 2, name: 'Window', section: 'Main Hall', capacity: 4 },
        { id: 3, name: 'P1', section: 'Patio', capacity: 6 }
      ]
    }
  });
  assert.equal(rename.status, 409);
  const renameBody = await json(rename);
  assert.equal(renameBody.code, 'TABLE_HAS_OPEN_BILL');
  assert.deepEqual(renameBody.details, [{ id: 1, name: 'T1', action: 'rename' }]);

  const move = await call(rec, '/admin/tables/layout', {
    method: 'PUT',
    body: {
      base_revision: base,
      sections: ['Main Hall', 'Patio'],
      tables: [
        { id: 1, name: 'T1', section: 'Patio', capacity: 8 },
        { id: 2, name: 'Window', section: 'Main Hall', capacity: 4 },
        { id: 3, name: 'P1', section: 'Patio', capacity: 6 }
      ]
    }
  });
  assert.equal(move.status, 200);

  const cleared = await call(rec, '/tables/1/clear', { method: 'POST' });
  assert.ok(cleared.ok);
});

test('menu and layout commits are broadcast over the live socket', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${rec.port}/live`);
  const seen = [];
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', m => seen.push(JSON.parse(m.toString()).type));

  const t = await call(rec, '/admin/tables/layout', {
    method: 'PUT',
    body: {
      base_revision: await tablesRev(),
      sections: ['Main Hall', 'Patio'],
      tables: [
        { id: 1, name: 'T1', section: 'Patio', capacity: 8 },
        { id: 2, name: 'Window', section: 'Main Hall', capacity: 4 },
        { id: 3, name: 'P1', section: 'Patio', capacity: 6 }
      ]
    }
  });
  assert.equal(t.status, 200);
  assert.ok(await waitFor(() => seen.includes('tables_updated')), 'tables_updated must be broadcast');

  const m = await call(rec, '/admin/menu/categories', { method: 'POST', body: { base_revision: await menuRev(), name: 'Specials' } });
  assert.equal(m.status, 201);
  assert.ok(await waitFor(() => seen.includes('menu_updated')), 'menu_updated must be broadcast');
  ws.close();
});

test('deleting every table leaves the floor empty instead of resurrecting the demo tables', async () => {
  const res = await call(rec, '/admin/tables/layout', {
    method: 'PUT', body: { base_revision: await tablesRev(), sections: ['Main Hall'], tables: [] }
  });
  assert.equal(res.status, 200);
  const live = await json(await call(rec, '/tables'));
  assert.equal(live.count, 0);
  assert.deepEqual(live.tables, []);
});

test('replace import (confirmed) leaves only the file contents', async () => {
  const rows = [{ name: 'Only Dish', category: 'Mains', price: '99', veg: 'yes' }];
  const res = await call(rec, '/admin/menu/import/commit', {
    method: 'POST', body: { base_revision: await menuRev(), rows, mode: 'replace', confirm_replace: true }
  });
  assert.equal(res.status, 200);
  const menu = await json(await call(rec, '/menu'));
  assert.deepEqual(menu.items.map(i => i.name), ['Only Dish']);
  assert.deepEqual(menu.categories, ['Mains']);
});

// ---------------------------------------------------------------- access control

test('enrolled handsets can read the menu but get 403 RECEPTION_ONLY on every admin route', async () => {
  const read = await call(handset, '/menu', { token });
  assert.equal(read.status, 200);

  const attempts = [
    ['POST', '/admin/menu/items', { base_revision: 0, item: { name: 'X', category: 'Starters', price: 1, isVeg: true } }],
    ['PUT', '/admin/menu/items/m1', { base_revision: 0, item: { price: 1 } }],
    ['DELETE', '/admin/menu/items/m1?base_revision=0', undefined],
    ['POST', '/admin/menu/categories', { base_revision: 0, name: 'X' }],
    ['PUT', '/admin/menu/categories', { base_revision: 0, from: 'Starters', to: 'X' }],
    ['PUT', '/admin/menu/categories/order', { base_revision: 0, names: [] }],
    ['DELETE', '/admin/menu/categories?name=Starters&base_revision=0', undefined],
    ['POST', '/admin/menu/import/preview', { rows: [] }],
    ['POST', '/admin/menu/import/commit', { base_revision: 0, rows: [] }],
    ['PUT', '/admin/tables/layout', { base_revision: 0, sections: [], tables: [] }]
  ];
  for (const [method, p, body] of attempts) {
    const res = await call(handset, p, { method, body, token });
    assert.equal(res.status, 403, `${method} ${p} must be reception-only`);
    assert.equal((await json(res)).code, 'RECEPTION_ONLY');
  }

  const anonymous = await call(handset, '/admin/tables/layout', { method: 'PUT', body: { base_revision: 0, sections: [], tables: [] } });
  assert.equal(anonymous.status, 403);

  const unchanged = await json(await call(handset, '/menu', { token }));
  assert.equal(unchanged.revision, 0, 'a refused edit must not change anything');
});

// ---------------------------------------------------------------- body errors, guard order, strict revisions

// Same as `call`, but the body goes out exactly as given, so it can be malformed JSON.
const rawCall = (hub, pathname, { method = 'POST', body, token } = {}) => fetch(`${hub.base}${pathname}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body
});

// A body-parser failure must look like every other admin failure: JSON { success, error, code },
// never Express's HTML error page, which carries a stack trace with install paths.
const assertJsonFailure = async (res, status, code) => {
  const text = await res.text();
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${text.slice(0, 120)}`);
  assert.match(res.headers.get('content-type') || '', /application\/json/, 'must be JSON, not an HTML error page');
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'success']);
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  assert.doesNotMatch(text, /node_modules|\.js:\d+|\bat \S+ \(|SyntaxError|[A-Za-z]:\\/, 'no stack trace or file paths');
};

test('an import body over 2 MB gets a JSON 413 PAYLOAD_TOO_LARGE instead of an HTML stack trace', async () => {
  const rev = await menuRev();
  const body = { base_revision: rev, rows: [], pad: 'x'.repeat(2 * 1024 * 1024 + 4096) };
  for (const p of ['/admin/menu/import/commit', '/admin/menu/import/preview']) {
    await assertJsonFailure(await call(rec, p, { method: 'POST', body }), 413, 'PAYLOAD_TOO_LARGE');
  }
  assert.equal(await menuRev(), rev, 'a refused body must not change anything');
});

test('a body over the global 256 KB limit on an admin route gets the same JSON 413', async () => {
  const rev = await menuRev();
  const pad = 'x'.repeat(300 * 1024);
  await assertJsonFailure(
    await call(rec, '/admin/menu/items', { method: 'POST', body: { base_revision: rev, item: { name: pad, category: 'Starters', price: 1, isVeg: true } } }),
    413, 'PAYLOAD_TOO_LARGE'
  );
  await assertJsonFailure(
    await call(rec, '/admin/tables/layout', { method: 'PUT', body: { base_revision: await tablesRev(), sections: ['Main Hall'], tables: [], pad } }),
    413, 'PAYLOAD_TOO_LARGE'
  );
  assert.equal(await menuRev(), rev, 'a refused body must not change anything');
});

test('malformed JSON on an admin route gets a JSON 400 INVALID_JSON; routes outside /admin keep their own handling', async () => {
  // One request per parser: the global 256 KB one and the 2 MB one mounted for the import routes.
  for (const [method, p] of [['POST', '/admin/menu/items'], ['PUT', '/admin/tables/layout'], ['POST', '/admin/menu/import/commit']]) {
    await assertJsonFailure(await rawCall(rec, p, { method, body: '{"base_revision": 1, ' }), 400, 'INVALID_JSON');
  }
  // The strict parser also refuses a JSON value that is neither an object nor an array.
  await assertJsonFailure(await rawCall(rec, '/admin/menu/items', { body: '"just a string"' }), 400, 'INVALID_JSON');

  // The handler is scoped to /admin, so the existing routes answer a parse failure exactly as before.
  const other = await rawCall(rec, '/orders', { body: '{"table_id": ' });
  assert.equal(other.status, 400);
  assert.doesNotMatch(other.headers.get('content-type') || '', /application\/json/, 'the /admin handler must not change other routes');
});

test('any other failure on an admin route is a JSON error too, never an HTML page with a stack trace', async () => {
  // Valid JSON that makes the route itself throw (outside updateCatalog): String({ toString: 1 }) is a TypeError.
  const rev = await menuRev();
  const hostile = '{"rows":[{"name":{"toString":1},"category":"Starters","price":"10","veg":"yes"}]}';
  await assertJsonFailure(await rawCall(rec, '/admin/menu/import/preview', { body: hostile }), 500, 'INTERNAL_ERROR');

  // An error that carries its own 4xx status keeps it: an unsupported charset is the client's problem.
  const latin1 = await fetch(`${rec.base}/admin/menu/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=latin1' },
    body: JSON.stringify({ base_revision: rev, item: { name: 'X', category: 'Starters', price: 1, isVeg: true } })
  });
  await assertJsonFailure(latin1, 415, 'BAD_REQUEST');

  assert.equal(await menuRev(), rev, 'a failed request must not change anything');
});

// ---------------------------------------------------------------- Host and Origin

// A request from loopback with whatever Host and Origin headers are asked for. fetch will not let a
// test choose its Host, and the Host a request names is exactly what is under test here.
const rawHttp = ({ port, path: urlPath, headers = {}, body, method = 'POST' }) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: urlPath,
    method,
    headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers }
  }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

test('a request from loopback is refused unless it is addressed to this machine: Host and Origin are checked too', async () => {
  const port = rec.port;
  const rev = await menuRev();
  const categoriesBefore = (await json(await call(rec, '/menu'))).categories;
  const attempt = (headers, p = '/admin/menu/categories') =>
    rawHttp({ port, path: p, headers, body: p.includes('/import/') ? { rows: [] } : { base_revision: rev, name: 'HostProbe' } });
  const refused = (res, label) => {
    assert.equal(res.status, 403, `${label}: expected 403, got ${res.status}: ${res.text.slice(0, 120)}`);
    const body = res.json();
    assert.equal(body.success, false, label);
    assert.equal(body.code, 'RECEPTION_ONLY', label);
  };

  // DNS rebinding: the page's own hostname resolves to this laptop, so the request arrives from loopback.
  refused(await attempt({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` }), 'rebinding (Host and Origin)');
  refused(await attempt({ Host: `evil.example:${port}` }), 'a foreign Host alone');
  // A page served by some other device and opened in a browser on this laptop.
  refused(await attempt({ Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' }), 'a foreign Origin');
  refused(await attempt({ Host: `127.0.0.1:${port}`, Origin: 'http://10.254.254.254:8080' }), 'an Origin on the LAN that is not this machine');
  refused(await attempt({ Host: `127.0.0.1:${port}`, Origin: 'null' }), 'an opaque Origin');
  // The same guard sits in front of the bigger import parser.
  refused(await attempt({ Host: `evil.example:${port}` }, '/admin/menu/import/preview'), 'the import routes');

  assert.equal(await menuRev(), rev, 'a refused request must not change anything');
  assert.deepEqual((await json(await call(rec, '/menu'))).categories, categoriesBefore);
});

test('the reception laptop can still reach /admin as localhost, as 127.0.0.1, as [::1] or by its own LAN IP', async () => {
  const port = rec.port;
  const { lan_ip: lanIp } = await json(await call(rec, '/pairing-info'));
  // A revision other than the current one is refused as stale, so nothing here can change anything:
  // a 409 STALE_REVISION proves the request got past the guard and into the route.
  const stale = (await menuRev()) + 1;
  const probe = headers => rawHttp({ port, path: '/admin/menu/categories', headers, body: { base_revision: stale, name: 'HostProbe' } });

  for (const [label, headers] of [
    ['Host 127.0.0.1 and no Origin', { Host: `127.0.0.1:${port}` }],
    ['Host localhost', { Host: `localhost:${port}` }],
    ['Host localhost without a port', { Host: 'localhost' }],
    ['Host [::1]', { Host: `[::1]:${port}` }],
    ['the hub\'s LAN IP as Host and Origin', { Host: `${lanIp}:${port}`, Origin: `http://${lanIp}:${port}` }],
    ['an Origin on localhost with another port (a dev server)', { Host: `127.0.0.1:${port}`, Origin: 'http://localhost:5173' }]
  ]) {
    const res = await probe(headers);
    assert.equal(res.status, 409, `${label} must pass the guard, got ${res.status}: ${res.text.slice(0, 120)}`);
    assert.equal(res.json().code, 'STALE_REVISION', label);
  }
  assert.equal(await menuRev(), stale - 1, 'nothing changed');
});

test('a non-reception host gets 403 RECEPTION_ONLY before an oversized import body is parsed', async () => {
  const body = { base_revision: 0, rows: [], pad: 'x'.repeat(2 * 1024 * 1024 + 4096) };
  for (const p of ['/admin/menu/import/preview', '/admin/menu/import/commit']) {
    for (const t of [token, undefined]) {
      await assertJsonFailure(await call(handset, p, { method: 'POST', body, token: t }), 403, 'RECEPTION_ONLY');
    }
  }
});

test('base_revision is strict: a JSON number in the body, or digits in the DELETE query string, nothing else', async () => {
  const rev = await menuRev();
  const categoriesBefore = (await json(await call(rec, '/menu'))).categories;
  const refused = async (res, label) => {
    assert.equal(res.status, 400, `${label} should be refused, got ${res.status}`);
    assert.equal((await json(res)).code, 'BASE_REVISION_REQUIRED', label);
  };

  // Values JavaScript would quietly turn into a number. The first four coerce to the CURRENT
  // revision, so a loose reader would accept them and the edit would go through.
  const odd = [String(rev), [rev], ` ${rev} `, `${rev}.0`, false, [], ' ', true, '0', 0.5, {}, null];
  for (const value of odd) {
    await refused(
      await call(rec, '/admin/menu/categories', { method: 'POST', body: { base_revision: value, name: 'StrictProbe' } }),
      `body base_revision ${JSON.stringify(value)}`
    );
  }
  // 1e400 is valid JSON that parses to Infinity; the integer check refuses it.
  await refused(await rawCall(rec, '/admin/menu/categories', { body: '{"base_revision":1e400,"name":"StrictProbe"}' }), 'body base_revision 1e400');

  // DELETE takes digits from the query string and nothing else. The category does not exist,
  // so even a loose reader could not delete anything real.
  for (const q of ['abc', '3.0', `${rev}.0`, ' ', `-${rev}`, `${rev}%20`, `0x${rev.toString(16)}`]) {
    await refused(await call(rec, `/admin/menu/categories?name=NoSuchCategory&base_revision=${q}`, { method: 'DELETE' }), `DELETE ?base_revision=${q}`);
  }
  await refused(await call(rec, '/admin/menu/categories?name=NoSuchCategory', { method: 'DELETE', body: { base_revision: rev } }), 'DELETE with the revision only in the body');
  const wellFormed = await call(rec, `/admin/menu/categories?name=NoSuchCategory&base_revision=${rev}`, { method: 'DELETE' });
  assert.equal(wellFormed.status, 404, 'digits get past the revision gate (the category simply does not exist)');

  // Every other method takes the revision from the JSON body only, never from the query string.
  await refused(await call(rec, `/admin/menu/categories?base_revision=${rev}`, { method: 'POST', body: { name: 'StrictProbe' } }), 'POST with the revision only in the query string');
  await refused(await call(rec, `/admin/menu/categories?base_revision=${rev}`, { method: 'PUT', body: { from: 'Starters', to: 'StrictProbe' } }), 'PUT with the revision only in the query string');

  const after = await json(await call(rec, '/menu'));
  assert.equal(after.revision, rev, 'a refused edit must not change anything');
  assert.deepEqual(after.categories, categoriesBefore);
});

test('a merge import with skip_invalid but no valid row is refused with NO_VALID_ROWS and writes nothing', async () => {
  const backupsDir = path.join(rec.dataDir, 'backups');
  const menuBackups = () => (fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []).filter(f => f.startsWith('menu_cache.')).sort();
  const revisionOnDisk = () => JSON.parse(fs.readFileSync(path.join(rec.dataDir, 'menu_cache.json'), 'utf8')).revision;

  const ws = new WebSocket(`ws://127.0.0.1:${rec.port}/live`);
  const seen = [];
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', m => seen.push(JSON.parse(m.toString()).type));

  const rev = await menuRev();
  const backupsBefore = menuBackups();
  const res = await call(rec, '/admin/menu/import/commit', {
    method: 'POST',
    body: { base_revision: rev, rows: [{ name: 'Bad', category: 'Starters', price: 'x', veg: 'yes' }], skip_invalid: true }
  });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'NO_VALID_ROWS');
  assert.equal(await menuRev(), rev, 'a refused import must not bump the revision');
  assert.equal(revisionOnDisk(), rev, 'nor touch the file on disk');
  assert.deepEqual(menuBackups(), backupsBefore, 'nor write a backup');

  await new Promise(r => setTimeout(r, 400)); // a broadcast would have arrived well within this
  ws.close();
  assert.ok(!seen.includes('menu_updated'), 'nor broadcast a menu update');
});

// ---------------------------------------------------------------- the /admin page

const expectReceptionOnlyPage = (res, label) => {
  assert.equal(res.status, 403, label);
  assert.match(res.headers['content-type'] || '', /^text\/plain/, `${label}: a person in a browser gets plain text, not JSON`);
  assert.equal(res.text, 'Reception only', label);
};

test('GET /admin on a hub that does not trust loopback is a plain-text 403 "Reception only", token or not', async () => {
  for (const [label, auth] of [['with an enrolled handset token', { Authorization: `Bearer ${token}` }], ['with no token', {}]]) {
    for (const p of ['/admin', '/admin.html']) {
      expectReceptionOnlyPage(await rawHttp({ port: handset.port, path: p, method: 'GET', headers: auth }), `${p} ${label}`);
    }
  }
});

test('GET /admin from loopback is refused when the request is not addressed to this machine (Host or Origin)', async () => {
  const port = rec.port;
  for (const [label, headers] of [
    ['a foreign Host (DNS rebinding)', { Host: `evil.example:${port}` }],
    ['a foreign Host and Origin', { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` }],
    ['a foreign Origin', { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' }]
  ]) {
    for (const p of ['/admin', '/admin.html']) {
      expectReceptionOnlyPage(await rawHttp({ port, path: p, method: 'GET', headers }), `${p} with ${label}`);
    }
  }
});

test('GET /admin from the reception laptop is not refused', async () => {
  const port = rec.port;
  for (const [label, headers] of [
    ['127.0.0.1', { Host: `127.0.0.1:${port}` }],
    ['localhost', { Host: `localhost:${port}` }],
    ['[::1]', { Host: `[::1]:${port}` }]
  ]) {
    const res = await rawHttp({ port, path: '/admin', method: 'GET', headers });
    // 200 when dist/ has been built (admin.html, or the index.html fallback); a plain 404 when it has not.
    // Anything else, a 403 above all, means the guard got in the way of the reception laptop.
    assert.ok([200, 404].includes(res.status), `${label}: expected 200 or 404, got ${res.status}: ${res.text.slice(0, 120)}`);
    assert.notEqual(res.text, 'Reception only', label);
  }
});

// Keep this one last: it adds 2000 items to the shared hub.
test('a 2000-row import commit larger than the global 256 KB limit is accepted', async () => {
  const pad = 'x'.repeat(100);
  const rows = Array.from({ length: 2000 }, (_, i) => ({ name: `Commit ${i} ${pad}`, category: 'Bulk', price: '10', veg: 'yes' }));
  const rev = await menuRev();
  assert.ok(JSON.stringify({ base_revision: rev, rows }).length > 256 * 1024, 'fixture must exceed the global limit');

  const res = await call(rec, '/admin/menu/import/commit', { method: 'POST', body: { base_revision: rev, rows } });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.counts.new, 2000);
  assert.equal(body.revision, rev + 1);
});

// ---------------------------------------------------------------- cloud sync status

test('GET /admin/sync-status is reception-only and shows an offline edit waiting for the cloud', async () => {
  const refused = await call(handset, '/admin/sync-status', { token });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'RECEPTION_ONLY');

  // The test hub is pointed at the unconfigured placeholder Supabase URL, so it is offline and nothing leaves it.
  const before = await json(await call(rec, '/admin/sync-status'));
  assert.equal(before.success, true);
  const rev = before.menu.revision;
  const added = await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { base_revision: rev, item: { name: 'Sync Probe', category: 'Starters', price: 10, isVeg: true } }
  });
  assert.equal(added.status, 201);

  const after = await json(await call(rec, '/admin/sync-status'));
  assert.equal(after.menu.revision, rev + 1);
  assert.equal(after.menu.pending_revision, rev + 1, 'the edit is queued for the cloud');
  assert.equal(after.menu.synced_revision, 0);
  assert.equal(after.menu.failed, false);
  // Earlier tests edited the layout on this same offline hub, so its newest revision is waiting too.
  assert.equal(after.tables.pending_revision, after.tables.revision);

  // Several offline edits are still one queued push, carrying the newest revision.
  await call(rec, '/admin/menu/items', {
    method: 'POST',
    body: { base_revision: rev + 1, item: { name: 'Sync Probe 2', category: 'Starters', price: 10, isVeg: true } }
  });
  // The hub writes its queue asynchronously (to a temp file, then renames), so reading it once
  // right after the request can still see the previous contents. Wait for the push to land.
  const queue = await queueUntil(rec, q =>
    q.some(x => x.type === 'SYNC_MENU' && x.payload?.revision === rev + 2));
  assert.equal(queue.filter(q => q.type === 'SYNC_MENU').length, 1);
  assert.equal(queue.find(q => q.type === 'SYNC_MENU').payload.revision, rev + 2);
});
