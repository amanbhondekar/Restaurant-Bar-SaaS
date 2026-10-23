import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createApp } from '../../signup_server/server.js';
import { parseTrustProxy } from '../../signup_server/lib/publicBooking.js';
import { BOOKING_LIMITS, validateGuestRequest, createLimiter } from '../../signup_server/lib/bookingPage.js';
import { memoryCloud } from './helpers/memoryCloud.mjs';

// The public page where a guest asks for a table (§4.6). It is the one place in the product a stranger can write something that
// ends up in a restaurant's hands, so what is tested is mostly what it will NOT do: store what it has not checked, let one person
// fill a restaurant's inbox, reveal which pages exist, trust a restaurant named in the request, or tell a guest anything about the
// database. The page goes through the operator service, never to Supabase directly.

const NOW = Date.parse('2026-10-23T10:00:00Z');
const HOUR = 3600 * 1000;
const at = hours => new Date(NOW + hours * HOUR).toISOString();
const CODE = 'pagecode12';
const OTHER_CODE = 'othercode12';
const OFF_CODE = 'offcode1234';

const restaurants = [{ id: 'r-uuid', name: 'Mejwani', city: 'Nagpur' }, { id: 'r-other', name: 'Other Place', city: 'Pune' }, { id: 'r-off', name: 'Closed Page', city: 'Delhi' }];
const bookingPages = [
  { restaurant_id: 'r-uuid', code: CODE, enabled: true },
  { restaurant_id: 'r-other', code: OTHER_CODE, enabled: true },
  { restaurant_id: 'r-off', code: OFF_CODE, enabled: false }
];
const good = (over = {}) => ({ guest_name: 'Asha Rao', phone: '98765 43210', party_size: 4, at: at(5), note: 'Window, if possible', ...over });

async function serve({ cloud = memoryCloud({ restaurants, bookingPages }), now = () => NOW, distDir, trustProxy, ...rest } = {}) {
  const server = http.createServer(createApp({ cloud, razorpay: { configured: () => false }, env: {}, operatorToken: 'op', webhookSecret: 'w', now, distDir, trustProxy, ...rest }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, p, body, headers = {}) => fetch(`${base}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  return {
    cloud, base, stop: () => new Promise(resolve => server.close(resolve)),
    info: (code = CODE, h) => send('GET', `/public/booking/${code}`, undefined, h),
    ask: (body, code = CODE, h) => send('POST', `/public/booking/${code}/requests`, body, h),
    get: (p, h) => send('GET', p, undefined, h)
  };
}
const json = r => r.json();
const stored = app => app.cloud.tables.booking_requests;

// --- what the page is told ----------------------------------------------------------------------------------------------

test('the page is told the restaurant\'s name and city and the limits, and nothing else', async () => {
  const app = await serve();
  try {
    const r = await app.info();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const body = await json(r);
    assert.deepEqual(body.restaurant, { name: 'Mejwani', city: 'Nagpur' });
    assert.deepEqual(body.limits, { max_party: BOOKING_LIMITS.maxParty, min_notice_mins: BOOKING_LIMITS.minNoticeMins, max_ahead_days: BOOKING_LIMITS.maxAheadDays });
    assert.doesNotMatch(JSON.stringify(body), /r-uuid|pagecode12|enabled/, 'no restaurant id, and nothing about how the page is set up');
  } finally { await app.stop(); }
});

test('a page that does not exist, one that is switched off and a code that is not a code all look the same', async () => {
  const app = await serve();
  try {
    const answers = [];
    for (const code of ['nosuchcode1', OFF_CODE, 'SHORT', 'has space code', '../../etc/passwd', 'x'.repeat(40)]) {
      const r = await app.info(encodeURIComponent(code));
      answers.push([r.status, JSON.stringify(await json(r))]);
    }
    assert.equal(new Set(answers.map(a => a[1])).size, 1, 'the same words each time, so a caller cannot tell which codes exist');
    for (const [status] of answers) assert.equal(status, 404);
    const post = await app.ask(good(), OFF_CODE);
    assert.equal(post.status, 404, 'and a switched-off page takes nothing');
    assert.equal(stored(app).length, 0);
  } finally { await app.stop(); }
});

test('a code that cannot be one never reaches the database, and the lengths that can be are accepted', async () => {
  const long = 'a1'.repeat(16);
  const short = 'b2'.repeat(5);
  const cloud = memoryCloud({ restaurants, bookingPages: [...bookingPages, { restaurant_id: 'r-uuid', code: long, enabled: true }, { restaurant_id: 'r-other', code: short, enabled: true }] });
  const app = await serve({ cloud });
  try {
    for (const code of ['b2'.repeat(4) + 'b', 'a1'.repeat(16) + 'a', `${CODE}!!!`, `${CODE}/..`, 'PAGECODE12', '', 'abc']) {
      const r = await app.info(encodeURIComponent(code));
      assert.equal(r.status, 404, code);
      assert.equal((await app.ask(good(), encodeURIComponent(code))).status, 404, code);
    }
    assert.equal(cloud.calls.selects.length, 0, 'not one of them was looked up');
    assert.equal((await app.info(long)).status, 200, '32 characters');
    assert.equal((await app.info(short)).status, 200, '10 characters');
  } finally { await app.stop(); }
});

test('a page whose restaurant is gone is not shown, and a database that fails on the way says try again', async () => {
  const orphan = memoryCloud({ restaurants: [], bookingPages });
  const a = await serve({ cloud: orphan });
  try {
    assert.equal((await a.info()).status, 404);
  } finally { await a.stop(); }

  const flaky = await serve({ cloud: memoryCloud({ restaurants, bookingPages, failures: { select: { restaurants: { message: 'timeout' } } } }) });
  try {
    assert.equal((await flaky.info()).status, 502);
  } finally { await flaky.stop(); }

  const counting = await serve({ cloud: memoryCloud({ restaurants, bookingPages, failures: { select: { booking_requests: { message: 'timeout' } } } }) });
  try {
    const r = await counting.ask(good());
    assert.deepEqual([r.status, (await json(r)).code], [502, 'UNAVAILABLE'], 'if the inbox cannot be counted nothing is added to it blind');
    assert.equal(stored(counting).length, 0);
  } finally { await counting.stop(); }
});

test('if the database cannot be reached the page is told to try again, without a word about why', async () => {
  const cloud = memoryCloud({ restaurants, bookingPages, failures: { select: { booking_pages: { message: 'connection to server at 10.0.0.5 failed' } } } });
  const app = await serve({ cloud });
  try {
    for (const call of [() => app.info(), () => app.ask(good())]) {
      const r = await call();
      assert.equal(r.status, 502);
      const text = JSON.stringify(await json(r));
      assert.match(text, /UNAVAILABLE/);
      assert.doesNotMatch(text, /10\.0\.0\.5|connection/);
    }
  } finally { await app.stop(); }
});

// --- taking a request ---------------------------------------------------------------------------------------------------

test('a request is stored for the restaurant whose page it came to, checked, and with nothing else kept', async () => {
  const app = await serve();
  try {
    const r = await app.ask({ ...good({ guest_name: '  Asha Rao  ', note: ' Window ' }), restaurant_id: 'r-other', id: 'forged', created_at: '2000-01-01' });
    assert.equal(r.status, 201);
    assert.deepEqual(await json(r), { success: true });
    assert.equal(stored(app).length, 1);
    const [row] = stored(app);
    assert.deepEqual(
      { restaurant_id: row.restaurant_id, guest_name: row.guest_name, phone: row.phone, party_size: row.party_size, requested_for: row.requested_for, note: row.note },
      { restaurant_id: 'r-uuid', guest_name: 'Asha Rao', phone: '919876543210', party_size: 4, requested_for: at(5), note: 'Window' },
      'the restaurant is the page\'s, the number is in one shape, and the words are trimmed'
    );
    assert.deepEqual(Object.keys(row).sort(), ['created_at', 'guest_name', 'id', 'note', 'party_size', 'phone', 'requested_for', 'restaurant_id'], 'no address, no browser details');
    assert.notEqual(row.id, 'forged');
    assert.notEqual(row.created_at, '2000-01-01');
  } finally { await app.stop(); }
});

test('the note is optional, and a note of nothing but spaces is not kept', async () => {
  const app = await serve();
  try {
    assert.equal((await app.ask(good({ note: undefined }))).status, 201);
    assert.equal((await app.ask(good({ note: '   ', phone: '98765 43211' }))).status, 201);
    assert.deepEqual(stored(app).map(r => r.note ?? null), [null, null]);
  } finally { await app.stop(); }
});

test('what is refused says which field and why, in words for the guest, and nothing is stored', async () => {
  const app = await serve({ trustProxy: true });
  try {
    const cases = [
      [{ guest_name: '' }, 'guest_name'], [{ guest_name: 'x'.repeat(BOOKING_LIMITS.name + 1) }, 'guest_name'], [{ guest_name: 'Asha\u0000Rao' }, 'guest_name'], [{ guest_name: 42 }, 'guest_name'],
      [{ phone: '' }, 'phone'], [{ phone: '12345' }, 'phone'], [{ phone: 'call me' }, 'phone'], [{ phone: undefined }, 'phone'],
      [{ party_size: 0 }, 'party_size'], [{ party_size: BOOKING_LIMITS.maxParty + 1 }, 'party_size'], [{ party_size: 2.5 }, 'party_size'], [{ party_size: 'many' }, 'party_size'], [{ party_size: undefined }, 'party_size'],
      [{ at: 'tomorrow' }, 'at'], [{ at: undefined }, 'at'], [{ at: at(-1) }, 'at'], [{ at: at(0.4) }, 'at'], [{ at: at(24 * BOOKING_LIMITS.maxAheadDays + 1) }, 'at'],
      [{ note: 'x'.repeat(BOOKING_LIMITS.note + 1) }, 'note']
    ];
    for (const [over, field] of cases) {
      const r = await app.ask(good(over), CODE, { 'X-Forwarded-For': `198.51.100.${cases.findIndex(c => c[0] === over) + 1}` });
      const body = await json(r);
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.equal(body.code, 'INVALID_REQUEST');
      assert.equal(body.errors[0].field, field, JSON.stringify(over));
      assert.ok(body.errors[0].message.length > 8, 'a sentence, not a code');
    }
    assert.equal(stored(app).length, 0);
  } finally { await app.stop(); }
});

test('every refused field is named at once, so the guest fixes the form in one go', async () => {
  const app = await serve();
  try {
    const r = await app.ask({ guest_name: '', phone: 'x', party_size: 0, at: 'soon' });
    assert.deepEqual((await json(r)).errors.map(e => e.field), ['guest_name', 'phone', 'party_size', 'at']);
  } finally { await app.stop(); }
});

test('a time is stored as the moment it names, whatever way the browser wrote it, and a time that is not text is not one', async () => {
  const app = await serve({ trustProxy: true });
  try {
    const local = '2026-10-23T20:30:00+05:30';
    assert.equal((await app.ask(good({ at: local }), CODE, { 'X-Forwarded-For': '203.0.113.1' })).status, 201);
    assert.equal(stored(app)[0].requested_for, '2026-10-23T15:00:00.000Z');
    for (const [i, odd] of [[at(5)], { when: at(5) }, 1793000000000, true, null].entries()) {
      const r = await app.ask(good({ at: odd, phone: `98765 4${i}000` }), CODE, { 'X-Forwarded-For': `203.0.113.${i + 10}` });
      assert.equal(r.status, 400, JSON.stringify(odd));
    }
  } finally { await app.stop(); }
});

test('a party size typed as text is a number, and a blank one is refused', async () => {
  const app = await serve({ trustProxy: true });
  try {
    assert.equal((await app.ask(good({ party_size: ' 4 ' }), CODE, { 'X-Forwarded-For': '203.0.113.1' })).status, 201);
    assert.strictEqual(stored(app)[0].party_size, 4);
    for (const [i, blank] of ['', '   ', 'four', '4 people', '2.5'].entries()) assert.equal((await app.ask(good({ party_size: blank }), CODE, { 'X-Forwarded-For': `203.0.113.${i + 10}` })).status, 400, JSON.stringify(blank));
  } finally { await app.stop(); }
});

test('line breaks, tabs and other control characters are refused in a name and become spaces in a note', async () => {
  const app = await serve({ trustProxy: true });
  try {
    for (const [i, ch] of ['\u0001', '\u001f', '\u007f', '\n', '\t'].entries()) {
      const r = await app.ask(good({ guest_name: `Asha${ch}Rao` }), CODE, { 'X-Forwarded-For': `203.0.113.${i + 1}` });
      assert.equal(r.status, 400, JSON.stringify(ch));
    }
    assert.equal((await app.ask(good({ note: 'Window\nseat\tplease\u001fthanks\u007f' }), CODE, { 'X-Forwarded-For': '203.0.113.50' })).status, 201);
    assert.equal(stored(app)[0].note, 'Window seat please thanks', 'the words stay apart');
  } finally { await app.stop(); }
});

test('whatever arrives in place of a request is refused, not tripped over', () => {
  for (const body of [null, undefined, 'text', 42, [], [1, 2], true]) {
    const r = validateGuestRequest(body, { now: new Date(NOW) });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.deepEqual(r.errors.map(e => e.field), ['guest_name', 'phone', 'party_size', 'at']);
  }
});

test('the earliest and the latest time and the biggest party that are allowed are allowed', async () => {
  const app = await serve({ trustProxy: true });
  try {
    const edge = [
      good({ at: at(BOOKING_LIMITS.minNoticeMins / 60), phone: '98765 40001' }),
      good({ at: at(24 * BOOKING_LIMITS.maxAheadDays), phone: '98765 40002' }),
      good({ party_size: BOOKING_LIMITS.maxParty, phone: '98765 40003' }),
      good({ party_size: 1, phone: '98765 40004' }),
      good({ guest_name: 'x'.repeat(BOOKING_LIMITS.name), note: 'y'.repeat(BOOKING_LIMITS.note), phone: '98765 40005' })
    ];
    for (const [i, body] of edge.entries()) assert.equal((await app.ask(body, CODE, { 'X-Forwarded-For': `203.0.113.${i + 1}` })).status, 201, JSON.stringify(body).slice(0, 60));
  } finally { await app.stop(); }
});

test('a number typed in any of the usual ways is stored the same way', async () => {
  const app = await serve({ trustProxy: true });
  try {
    // Three, because one number may ask only three times an hour.
    for (const [i, phone] of ['98765 43210', '+91 98765-43210', '098765 43210'].entries()) {
      assert.equal((await app.ask(good({ phone }), CODE, { 'X-Forwarded-For': `203.0.113.${i + 1}` })).status, 201);
    }
    assert.deepEqual(stored(app).map(r => r.phone), Array(3).fill('919876543210'));
    assert.equal(validateGuestRequest(good({ phone: 9876543210 }), { now: new Date(NOW) }).request.phone, '919876543210', 'a number the browser sent as a number');
  } finally { await app.stop(); }
});

test('what is not JSON, and what is far too big, is refused before it is looked at', async () => {
  const app = await serve();
  try {
    const bad = await app.ask('this is not json');
    assert.deepEqual([bad.status, (await json(bad)).code], [400, 'INVALID_REQUEST']);
    const big = await app.ask(JSON.stringify({ ...good(), note: 'x'.repeat(10000) }));
    assert.deepEqual([big.status, (await json(big)).code], [413, 'TOO_LARGE']);
    const array = await app.ask('[1,2,3]');
    assert.equal(array.status, 400, 'a list is not a request');
    assert.equal(stored(app).length, 0);
  } finally { await app.stop(); }
});

// --- bots and floods ----------------------------------------------------------------------------------------------------

test('a form field a person never sees is a trap: filling it looks like success and stores nothing; a blank one is a person', async () => {
  const app = await serve();
  try {
    assert.equal((await app.ask({ ...good(), website: '   ', phone: '98765 40009' })).status, 201);
    assert.equal(stored(app).length, 1, 'spaces are not a filled-in field');
    stored(app).length = 0;
    const r = await app.ask({ ...good(), website: 'http://spam.example' });
    assert.equal(r.status, 201, 'a bot is told it worked, so it does not learn what to change');
    assert.deepEqual(await json(r), { success: true });
    assert.equal(stored(app).length, 0);
    assert.equal((await app.ask({ ...good(), website: '' })).status, 201);
    assert.equal(stored(app).length, 1, 'an empty one is a person');
  } finally { await app.stop(); }
});

test('one address can send only a few requests in ten minutes, and gets its turn back afterwards', async () => {
  let clock = NOW;
  const app = await serve({ now: () => clock });
  try {
    const { max, windowMs } = BOOKING_LIMITS.perIp;
    for (let i = 0; i < max; i += 1) assert.equal((await app.ask(good({ phone: `98765 4100${i}` }))).status, 201, `request ${i + 1}`);
    const over = await app.ask(good({ phone: '98765 49999' }));
    assert.deepEqual([over.status, (await json(over)).code], [429, 'TOO_MANY']);
    assert.equal(stored(app).length, max);

    clock += windowMs - 1;
    assert.equal((await app.ask(good({ phone: '98765 49998', at: at(5) }))).status, 429, 'just inside the window');
    clock += 2;
    assert.equal((await app.ask(good({ phone: '98765 49997', at: new Date(clock + 5 * HOUR).toISOString() }))).status, 201, 'the window has passed');
  } finally { await app.stop(); }
});

test('an address is told apart by who is really connecting, not by a header anyone can write, unless the service sits behind a proxy', async () => {
  const direct = await serve();
  try {
    for (let i = 0; i < BOOKING_LIMITS.perIp.max; i += 1) await direct.ask(good({ phone: `98765 4200${i}` }), CODE, { 'X-Forwarded-For': `203.0.113.${i + 1}` });
    const r = await direct.ask(good({ phone: '98765 42999' }), CODE, { 'X-Forwarded-For': '203.0.113.99' });
    assert.equal(r.status, 429, 'a different header is the same caller');
  } finally { await direct.stop(); }

  const proxied = await serve({ trustProxy: true });
  try {
    for (let i = 0; i < BOOKING_LIMITS.perIp.max; i += 1) await proxied.ask(good({ phone: `98765 4300${i}` }), CODE, { 'X-Forwarded-For': '203.0.113.7' });
    assert.equal((await proxied.ask(good({ phone: '98765 43999' }), CODE, { 'X-Forwarded-For': '203.0.113.7' })).status, 429);
    assert.equal((await proxied.ask(good({ phone: '98765 43998' }), CODE, { 'X-Forwarded-For': '203.0.113.8' })).status, 201, 'another guest behind the same proxy');
  } finally { await proxied.stop(); }
});

test('mistakes do not use up a guest\'s turns, but a flood of them is still stopped', async () => {
  const app = await serve();
  try {
    for (let i = 0; i < BOOKING_LIMITS.perIp.max + 3; i += 1) assert.equal((await app.ask(good({ phone: 'x' }))).status, 400, 'typos are told what is wrong');
    assert.equal((await app.ask(good())).status, 201, 'and the guest can still ask once they have fixed it');
    for (let i = 0; i < BOOKING_LIMITS.perIp.attempts.max; i += 1) await app.ask(good({ phone: 'x' }));
    assert.equal((await app.ask(good({ phone: 'x' }))).status, 429, 'but not without end');
  } finally { await app.stop(); }
});

test('one number can ask only a few times an hour for one restaurant, and another restaurant is not affected', async () => {
  const app = await serve({ trustProxy: true });
  try {
    const { max } = BOOKING_LIMITS.perPhone;
    for (let i = 0; i < max; i += 1) assert.equal((await app.ask(good({ at: at(5 + i) }), CODE, { 'X-Forwarded-For': `203.0.113.${i + 1}` })).status, 201);
    const over = await app.ask(good({ at: at(20) }), CODE, { 'X-Forwarded-For': '203.0.113.50' });
    assert.deepEqual([over.status, (await json(over)).code], [429, 'TOO_MANY']);
    assert.equal((await app.ask(good(), OTHER_CODE, { 'X-Forwarded-For': '203.0.113.51' })).status, 201, 'the same guest asking another restaurant');
    assert.equal(stored(app).length, max + 1);
  } finally { await app.stop(); }
});

test('a restaurant\'s inbox is capped, and a full one says so without taking more', async () => {
  const full = Array.from({ length: BOOKING_LIMITS.pendingCap }, (_, i) => ({ id: `q${i}`, restaurant_id: 'r-uuid', guest_name: 'Waiting', phone: '9199', party_size: 2, requested_for: at(5 + i), created_at: at(-1) }));
  const app = await serve({ cloud: memoryCloud({ restaurants, bookingPages, bookingRequests: full }) });
  try {
    const r = await app.ask(good());
    assert.deepEqual([r.status, (await json(r)).code], [503, 'NOT_TAKING_REQUESTS']);
    assert.equal(stored(app).length, BOOKING_LIMITS.pendingCap);
    assert.equal((await app.ask(good(), OTHER_CODE)).status, 201, 'another restaurant\'s inbox is its own');
  } finally { await app.stop(); }
});

test('requests whose time has passed are cleared out first, so a forgotten inbox does not stay full for ever', async () => {
  const old = Array.from({ length: BOOKING_LIMITS.pendingCap }, (_, i) => ({ id: `old${i}`, restaurant_id: 'r-uuid', guest_name: 'Long ago', phone: '9199', party_size: 2, requested_for: at(-48 - i), created_at: at(-100) }));
  const live = { id: 'live', restaurant_id: 'r-uuid', guest_name: 'Still wanted', phone: '9199', party_size: 2, requested_for: at(3), created_at: at(-1) };
  const justPassed = { id: 'just', restaurant_id: 'r-uuid', guest_name: 'Two hours ago', phone: '9199', party_size: 2, requested_for: at(-2), created_at: at(-5) };
  const elsewhere = { id: 'else', restaurant_id: 'r-other', guest_name: 'Their old one', phone: '9199', party_size: 2, requested_for: at(-72), created_at: at(-100) };
  const app = await serve({ cloud: memoryCloud({ restaurants, bookingPages, bookingRequests: [...old, live, justPassed, elsewhere] }) });
  try {
    assert.equal((await app.ask(good())).status, 201);
    const names = stored(app).map(r => r.guest_name).sort();
    assert.deepEqual(names, ['Asha Rao', 'Still wanted', 'Their old one', 'Two hours ago'], 'only this restaurant\'s requests that lapsed a day ago went; one for tonight, or from a couple of hours ago, stays; another restaurant\'s are not ours to clear');
  } finally { await app.stop(); }
});

test('a request that could not be saved says so plainly, and does not leak the database\'s own words', async () => {
  const cloud = memoryCloud({ restaurants, bookingPages, failures: { insert: { booking_requests: { message: 'duplicate key value violates unique constraint "x"', code: '23505' } } } });
  const app = await serve({ cloud });
  try {
    const r = await app.ask(good());
    assert.equal(r.status, 502);
    const text = JSON.stringify(await json(r));
    assert.match(text, /UNAVAILABLE/);
    assert.doesNotMatch(text, /duplicate|constraint|23505/);
    assert.equal(stored(app).length, 0);
  } finally { await app.stop(); }
});

// --- the pure pieces ----------------------------------------------------------------------------------------------------

test('the limiter counts within a window, is per key, and forgets', () => {
  let t = 1000;
  const l = createLimiter({ max: 2, windowMs: 100, now: () => t });
  assert.deepEqual([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('b')], [true, true, false, true]);
  t += 99;
  assert.equal(l.hit('a'), false);
  t += 2;
  assert.equal(l.hit('a'), true, 'the oldest hit has aged out');
});

test('a hit exactly one window old no longer counts', () => {
  let t = 1000;
  const l = createLimiter({ max: 1, windowMs: 100, now: () => t });
  assert.equal(l.hit('a'), true);
  t = 1099;
  assert.equal(l.hit('a'), false);
  t = 1100;
  assert.equal(l.hit('a'), true, 'the window is the last 100 ms, not 101');
});

test('when the limiter has to forget someone it forgets whoever has been quiet longest', () => {
  const l = createLimiter({ max: 1, windowMs: 1e9, now: () => 1, maxKeys: 2 });
  l.hit('a'); l.hit('b');
  l.hit('a');            // refused, but a has just been seen
  l.hit('c');            // one key too many: b has been quiet longest
  assert.equal(l.hit('a'), false, 'a is still remembered');
  assert.equal(l.hit('b'), true, 'b was forgotten');
});

test('TRUST_PROXY means what Express means by it, and nothing means nobody', () => {
  for (const nothing of [undefined, null, '', false, 'false']) assert.equal(parseTrustProxy(nothing), false, String(nothing));
  for (const all of [true, 'true']) assert.equal(parseTrustProxy(all), true, String(all));
  assert.strictEqual(parseTrustProxy('1'), 1);
  assert.strictEqual(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
});

test('the limiter cannot be made to grow without end by a caller who keeps changing the key', () => {
  const l = createLimiter({ max: 1, windowMs: 1e9, now: () => 1, maxKeys: 50 });
  for (let i = 0; i < 500; i += 1) l.hit(`key${i}`);
  assert.ok(l.size() <= 50, `kept ${l.size()} keys`);
  assert.equal(l.hit('key499'), false, 'the newest are the ones remembered');
});

test('validation gives back exactly what is stored and nothing the guest added', () => {
  const r = validateGuestRequest({ ...good(), restaurant_id: 'x', extra: 1 }, { now: new Date(NOW) });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.request).sort(), ['guest_name', 'note', 'party_size', 'phone', 'requested_for']);
});

// --- the page itself ----------------------------------------------------------------------------------------------------

function builtPage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kullina-reserve-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'reserve.html'), '<!doctype html><title>Ask for a table</title><div id="root"></div>');
  fs.writeFileSync(path.join(dir, 'assets', 'reserve-abc.js'), 'console.log("page")');
  fs.writeFileSync(path.join(dir, 'admin.html'), '<!doctype html><title>The reception console</title>');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not for the public');
  return dir;
}

test('the operator service serves the page itself, with headers that keep the address and the page to themselves', async () => {
  const dir = builtPage();
  const app = await serve({ distDir: dir });
  try {
    const r = await app.get(`/book/${CODE}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(await r.text(), /Ask for a table/);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', 'the code is in the address, so it is not passed on to anyone');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(csp.split(';').map(d => d.trim()).find(d => d.startsWith('script-src')), "script-src 'self'", 'no inline script and nothing from elsewhere');
    assert.match(csp, /connect-src 'self'/, 'the page can only talk to the service that served it');

    const js = await app.get('/assets/reserve-abc.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only the booking page and its assets are served: not the other pages, not other files, not outside the folder', async () => {
  const dir = builtPage();
  const app = await serve({ distDir: dir });
  try {
    for (const p of ['/admin.html', '/reserve.html', '/secret.txt', '/assets/../secret.txt', '/assets/%2e%2e/secret.txt', '/book', `/book/${CODE}/extra`, '/book/SHORT', '/book/..%2fsecret']) {
      const r = await app.get(p);
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(await r.text(), /not for the public|reception console/, p);
    }
  } finally { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('if the page has not been built the service says so rather than failing oddly', async () => {
  const app = await serve({ distDir: path.join(os.tmpdir(), 'kullina-no-such-build') });
  try {
    const r = await app.get(`/book/${CODE}`);
    assert.equal(r.status, 503);
    assert.match(await r.text(), /built/i);
  } finally { await app.stop(); }
});
