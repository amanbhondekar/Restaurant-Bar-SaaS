import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { bookingPageRoutes, pageMemory } from '../lib/bookingPageRoutes.js';
import { CLOUD_DOWN } from '../lib/bookingInboxRunner.js';

// The screen's way to the booking page (§4.6): see where it stands, switch it on or off, give it a new address. The routes are thin by
// design: the cloud does the work (lib/bookingInbox.js) and the operator service serves the page. What is tested is what they decide:
// reception only, the page shown from memory when the cloud cannot be reached, a page that cannot be switched ON with nowhere to serve it
// from, a cloud that hangs not holding the screen, and the hub remembering only what the cloud actually confirmed.

const OPS = 'https://ops.example.com';
const page = (over = {}) => ({ code: 'abcdefghij12', enabled: true, ...over });

function setup({ cloud = { rid: 'r1', client: {} }, ops = OPS, memory: start = null, ...over } = {}) {
  const calls = [];
  const memory = { value: start, sets: [], get() { return this.value; }, set(p) { this.sets.push(p); this.value = p; } };
  const fakeOps = {
    readPage: async (...a) => { calls.push(['read', ...a.slice(1)]); return over.read ?? { ok: true, page: page() }; },
    enablePage: async (...a) => { calls.push(['enable', ...a.slice(1)]); return over.enable ?? { ok: true, page: page() }; },
    disablePage: async (...a) => { calls.push(['disable', ...a.slice(1)]); return over.disable ?? { ok: true, page: page({ enabled: false }) }; },
    newAddress: async (...a) => { calls.push(['new', ...a.slice(1)]); return over.newAddress ?? { ok: true, page: page({ code: 'newcode12345' }) }; }
  };
  const router = bookingPageRoutes({
    guard: over.guard ?? ((req, res, next) => next()),
    cloudSession: async () => cloud,
    pageOps: over.pageOps ?? fakeOps,
    operatorUrl: () => ops,
    memory,
    readMs: over.readMs ?? 4000,
    changeMs: over.changeMs ?? 15000
  });
  return { router, calls, memory };
}

async function serve(options) {
  const built = setup(options);
  const app = express();
  app.use(express.json());
  app.use(built.router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, path, body) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...built, stop: () => new Promise(resolve => server.close(resolve)), get: p => send('GET', p), put: (p, b) => send('PUT', p, b), post: (p, b) => send('POST', p, b ?? {}) };
}
const json = r => r.json();
const never = new Promise(() => {});

// --- looking ---------------------------------------------------------------------------------------------------------------

test('the page as the cloud holds it, with its address, and remembered', async () => {
  const app = await serve();
  try {
    const body = await json(await app.get('/admin/booking-page'));
    assert.deepEqual(body, { success: true, configured: true, enabled: true, code: 'abcdefghij12', url: `${OPS}/book/abcdefghij12`, reachable: true });
    assert.deepEqual(app.memory.sets, [page()]);
    assert.deepEqual(app.calls, [['read', 'r1']]);
  } finally { await app.stop(); }
});

test('a page that is switched off has an address kept but is not on, and no page at all is not on either', async () => {
  const off = await serve({ read: { ok: true, page: page({ enabled: false }) } });
  const none = await serve({ read: { ok: true, page: null } });
  try {
    const a = await json(await off.get('/admin/booking-page'));
    assert.deepEqual([a.enabled, a.code, a.url], [false, 'abcdefghij12', `${OPS}/book/abcdefghij12`]);
    const b = await json(await none.get('/admin/booking-page'));
    assert.deepEqual([b.enabled, b.code, b.url, b.reachable], [false, null, null, true]);
    assert.deepEqual(none.memory.sets, [null], 'what the cloud says there is none of is forgotten too');
  } finally { await off.stop(); await none.stop(); }
});

test('with no operator service there is no address to give, and the screen is told what is missing', async () => {
  const app = await serve({ ops: null });
  try {
    const body = await json(await app.get('/admin/booking-page'));
    assert.deepEqual([body.configured, body.url, body.needs_operator_url, body.enabled], [false, null, true, true]);
    const none = await serve({ ops: null, read: { ok: true, page: null } });
    const b = await json(await none.get('/admin/booking-page'));
    assert.equal('needs_operator_url' in b, false, 'nothing to say about an address when there is no page');
    await none.stop();
  } finally { await app.stop(); }
});

test('with no cloud session the screen shows what the hub last knew, and says so, without asking the cloud', async () => {
  const app = await serve({ cloud: null, memory: page({ code: 'rememberedcode' }) });
  try {
    const body = await json(await app.get('/admin/booking-page'));
    assert.deepEqual([body.reachable, body.code, body.url, body.enabled], [false, 'rememberedcode', `${OPS}/book/rememberedcode`, true]);
    assert.match(body.message, /could not reach the cloud/);
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.memory.sets, [], 'and does not overwrite what it knows with nothing');
  } finally { await app.stop(); }
});

test('when the cloud cannot be read, or hangs, the screen still loads from memory', async () => {
  const failing = await serve({ read: { ok: false, code: 'CLOUD', error: 'x' }, memory: page({ code: 'rememberedcode' }) });
  const hanging = await serve({ pageOps: { readPage: () => never }, memory: page({ code: 'rememberedcode' }), readMs: 40 });
  try {
    for (const app of [failing, hanging]) {
      const body = await json(await app.get('/admin/booking-page'));
      assert.deepEqual([body.reachable, body.code], [false, 'rememberedcode']);
      assert.deepEqual(app.memory.sets, []);
    }
  } finally { await failing.stop(); await hanging.stop(); }
});

test('nothing known and no cloud: not on, no address', async () => {
  const app = await serve({ cloud: null });
  try {
    const body = await json(await app.get('/admin/booking-page'));
    assert.deepEqual([body.enabled, body.code, body.url, body.reachable], [false, null, null, false]);
  } finally { await app.stop(); }
});

// --- changing --------------------------------------------------------------------------------------------------------------

test('switching on asks the cloud, answers with the page as it now is, and remembers it', async () => {
  const app = await serve({ enable: { ok: true, page: page({ code: 'madeonjustnow' }) } });
  try {
    const r = await app.put('/admin/booking-page', { enabled: true });
    assert.equal(r.status, 200);
    const body = await json(r);
    assert.deepEqual([body.enabled, body.code, body.url, body.reachable], [true, 'madeonjustnow', `${OPS}/book/madeonjustnow`, true]);
    assert.deepEqual(app.calls, [['enable', 'r1']]);
    assert.deepEqual(app.memory.sets, [page({ code: 'madeonjustnow' })]);
  } finally { await app.stop(); }
});

test('switching off asks the cloud to switch off, and needs no operator service to do it', async () => {
  const app = await serve({ ops: null, disable: { ok: true, page: page({ enabled: false }) } });
  try {
    const r = await app.put('/admin/booking-page', { enabled: false });
    assert.equal(r.status, 200);
    assert.equal((await json(r)).enabled, false);
    assert.deepEqual(app.calls, [['disable', 'r1']]);
    assert.deepEqual(app.memory.sets, [page({ enabled: false })]);
  } finally { await app.stop(); }
});

test('a page cannot be switched on with nowhere to serve it from, and nothing is asked of the cloud', async () => {
  const app = await serve({ ops: null });
  try {
    const r = await app.put('/admin/booking-page', { enabled: true });
    assert.deepEqual([r.status, (await json(r)).code], [409, 'NOT_CONFIGURED']);
    assert.deepEqual(app.calls, []);
  } finally { await app.stop(); }
});

test('what is not a plain yes or no is refused before anything is asked', async () => {
  const app = await serve();
  try {
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { enabled: [true] }, { enable: true }]) {
      const r = await app.put('/admin/booking-page', body);
      assert.deepEqual([r.status, (await json(r)).code], [400, 'INVALID'], JSON.stringify(body));
    }
    assert.deepEqual(app.calls, []);
  } finally { await app.stop(); }
});

test('a new address is made by the cloud, answered, and remembered; and needs a page to exist', async () => {
  const app = await serve();
  const none = await serve({ newAddress: { ok: false, code: 'NO_PAGE', error: 'There is no booking page yet, so there is no address to change.' } });
  try {
    const r = await app.post('/admin/booking-page/new-address');
    assert.equal(r.status, 200);
    assert.deepEqual([(await json(r)).code, app.calls[0][0]], ['newcode12345', 'new']);
    assert.deepEqual(app.memory.sets, [page({ code: 'newcode12345' })]);

    const missing = await none.post('/admin/booking-page/new-address');
    const answer = await json(missing);
    assert.deepEqual([missing.status, answer.code, answer.success], [404, 'NO_PAGE', false]);
    assert.match(answer.error, /no booking page/);
    assert.deepEqual(none.memory.sets, []);
  } finally { await app.stop(); await none.stop(); }
});

test('with no cloud session every change says so plainly and changes nothing', async () => {
  const app = await serve({ cloud: null });
  try {
    for (const call of [() => app.put('/admin/booking-page', { enabled: true }), () => app.put('/admin/booking-page', { enabled: false }), () => app.post('/admin/booking-page/new-address')]) {
      const r = await call();
      assert.equal(r.status, 503);
      assert.deepEqual(await json(r), CLOUD_DOWN);
    }
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.memory.sets, []);
  } finally { await app.stop(); }
});

test('a change the cloud refuses is said in its own plain words and is not remembered', async () => {
  const refusal = { ok: false, code: 'CLOUD', error: 'The hub could not reach the cloud. Check the internet connection and try again.' };
  const app = await serve({ enable: refusal, disable: refusal, newAddress: refusal });
  try {
    for (const call of [() => app.put('/admin/booking-page', { enabled: true }), () => app.put('/admin/booking-page', { enabled: false }), () => app.post('/admin/booking-page/new-address')]) {
      const r = await call();
      assert.equal(r.status, 503);
      assert.deepEqual(await json(r), { success: false, code: 'CLOUD', error: refusal.error });
    }
    assert.deepEqual(app.memory.sets, []);
  } finally { await app.stop(); }
});

test('a cloud that never answers a change does not hold the screen for ever', async () => {
  const app = await serve({ pageOps: { enablePage: () => never, disablePage: () => never, newAddress: () => never, readPage: () => never }, changeMs: 40 });
  try {
    for (const call of [() => app.put('/admin/booking-page', { enabled: true }), () => app.put('/admin/booking-page', { enabled: false }), () => app.post('/admin/booking-page/new-address')]) {
      const r = await call();
      assert.deepEqual([r.status, await json(r)], [503, CLOUD_DOWN]);
    }
    assert.deepEqual(app.memory.sets, []);
  } finally { await app.stop(); }
});

// --- who ---------------------------------------------------------------------------------------------------------------------

test('every route is behind the guard, so a handset gets nothing and the cloud is never asked', async () => {
  const deny = (req, res) => res.status(403).json({ success: false, code: 'RECEPTION_ONLY' });
  const app = await serve({ guard: deny });
  try {
    for (const call of [() => app.get('/admin/booking-page'), () => app.put('/admin/booking-page', { enabled: true }), () => app.post('/admin/booking-page/new-address')]) {
      const r = await call();
      assert.deepEqual([r.status, (await json(r)).code], [403, 'RECEPTION_ONLY']);
    }
    assert.deepEqual(app.calls, []);
    assert.deepEqual(app.memory.sets, []);
  } finally { await app.stop(); }
});

// --- what the hub remembers ------------------------------------------------------------------------------------------------

test('the hub remembers its page in its own config, beside what else is there, and forgets it when there is none', () => {
  let config = { restaurant_id: 'r1', name: 'Mejwani', rewards: { every_n_visits: 5 } };
  const saves = [];
  const store = { getPairingInfo: () => config, saveConfig: next => { saves.push(next); config = next; } };
  const memory = pageMemory(store);
  assert.equal(memory.get(), null);
  memory.set({ code: 'abcdefghij12', enabled: true, something: 'else', restaurant_id: 'leak' });
  assert.deepEqual(saves.at(-1), { restaurant_id: 'r1', name: 'Mejwani', rewards: { every_n_visits: 5 }, booking_page: { code: 'abcdefghij12', enabled: true } }, 'only the two things worth remembering, and nothing else lost');
  assert.deepEqual(memory.get(), { code: 'abcdefghij12', enabled: true });
  memory.set(null);
  assert.equal(saves.at(-1).booking_page, null);
  assert.equal(memory.get(), null);
  assert.equal(saves.at(-1).name, 'Mejwani');
});
