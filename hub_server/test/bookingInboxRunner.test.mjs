import test from 'node:test';
import assert from 'node:assert/strict';

import { createInboxRunner, withinMs, CLOUD_DOWN } from '../lib/bookingInboxRunner.js';

// The hub's check of the booking inbox, which runs on a timer and when reception asks (§4.6). What matters: two checks at once are one
// check, a failed check is remembered as a failure and never as nothing new, the time of the last SUCCESSFUL check is kept through failures,
// and nothing here can throw into a timer, which would take the hub down.

const quiet = fn => async () => {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
const session = { rid: 'r1', client: {} };
const clock = (...times) => () => new Date(times.shift());

test('the first check has not happened, so there is nothing to say about it', () => {
  const runner = createInboxRunner({ cloudSession: async () => session, pull: async () => ({ ok: true }) });
  assert.deepEqual(runner.last(), { at: null, ok: null });
});

test('a check that works is remembered with when it was, and hands back what the pull said', async () => {
  const runner = createInboxRunner({ cloudSession: async () => session, pull: async () => ({ ok: true, received: 2, cleared: 1 }), now: clock('2026-10-23T12:00:00Z') });
  assert.deepEqual(await runner.run(), { ok: true, received: 2, cleared: 1 });
  assert.deepEqual(runner.last(), { at: '2026-10-23T12:00:00.000Z', ok: true });
});

test('the pull is given the hub\'s own cloud session', async () => {
  let given;
  const runner = createInboxRunner({ cloudSession: async () => session, pull: async cloud => { given = cloud; return { ok: true }; } });
  await runner.run();
  assert.equal(given, session);
});

test('a check with no cloud session is a failure, not a quiet success, and asks nothing of the cloud', async () => {
  let pulled = 0;
  const runner = createInboxRunner({ cloudSession: async () => null, pull: async () => { pulled += 1; return { ok: true }; } });
  assert.deepEqual(await runner.run(), CLOUD_DOWN);
  assert.equal(pulled, 0);
  assert.deepEqual(runner.last(), { at: null, ok: false });
});

test('a pull that fails is remembered as a failure, and the time of the last good check is kept', async () => {
  const results = [{ ok: true }, { ok: false, code: 'CLOUD', error: 'down' }, { ok: true }];
  const runner = createInboxRunner({ cloudSession: async () => session, pull: async () => results.shift(), now: clock('2026-10-23T12:00:00Z', '2026-10-23T12:10:00Z') });
  await runner.run();
  assert.deepEqual(runner.last(), { at: '2026-10-23T12:00:00.000Z', ok: true });
  assert.deepEqual(await runner.run(), { ok: false, code: 'CLOUD', error: 'down' });
  assert.deepEqual(runner.last(), { at: '2026-10-23T12:00:00.000Z', ok: false }, 'it did not work, and the last time it did is not forgotten');
  await runner.run();
  assert.deepEqual(runner.last(), { at: '2026-10-23T12:10:00.000Z', ok: true });
});

test('anything thrown is an answer, never an exception, and is remembered as a failure', quiet(async () => {
  for (const broken of [{ cloudSession: async () => { throw new Error('auth blew up'); }, pull: async () => ({ ok: true }) }, { cloudSession: async () => session, pull: async () => { throw new Error('pull blew up'); } }]) {
    const runner = createInboxRunner(broken);
    assert.deepEqual(await runner.run(), CLOUD_DOWN);
    assert.deepEqual(runner.last(), { at: null, ok: false });
  }
}));

test('asked while a check is running, it gives that check\'s answer rather than starting another', async () => {
  const hold = gate();
  let pulls = 0;
  const runner = createInboxRunner({ cloudSession: async () => session, pull: async () => { pulls += 1; await hold.promise; return { ok: true, received: 3 }; } });
  const first = runner.run();
  const second = runner.run();
  assert.equal(second, first, 'the same check');
  hold.open();
  assert.deepEqual(await first, { ok: true, received: 3 });
  assert.equal(pulls, 1);
});

test('once a check is over the next one runs, even after a failure', async () => {
  let pulls = 0;
  const runner = createInboxRunner({ cloudSession: async () => session, pull: async () => { pulls += 1; if (pulls === 1) throw new Error('once'); return { ok: true }; } });
  const warn = console.warn;
  console.warn = () => {};
  try { await runner.run(); } finally { console.warn = warn; }
  await runner.run();
  await runner.run();
  assert.equal(pulls, 3);
});

test('a wait is the answer if it comes in time, and nothing if it does not', async () => {
  assert.equal(await withinMs(Promise.resolve('answer'), 1000), 'answer');
  assert.equal(await withinMs(new Promise(() => {}), 30), null);
  const slow = new Promise(resolve => setTimeout(() => resolve('late'), 200));
  const started = Date.now();
  assert.equal(await withinMs(slow, 30), null);
  assert.ok(Date.now() - started < 150, 'it gave up at the limit, not when the answer came');
});

test('a wait that was answered in time leaves no timer behind to hold the process open', async () => {
  const before = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  await withinMs(Promise.resolve(1), 60000);
  assert.equal(process.getActiveResourcesInfo().filter(r => r === 'Timeout').length, before);
});

test('a wait that fails fails for the caller', async () => {
  await assert.rejects(() => withinMs(Promise.reject(new Error('boom')), 1000), /boom/);
});

test('what it says when there is no cloud is a plain failure, spelled out', () => {
  assert.deepEqual(CLOUD_DOWN, { success: false, code: 'CLOUD', error: 'The hub could not reach the cloud. Check the internet connection and try again.' });
});

test('a wait that never ends does not keep the process alive', () => {
  const countTimers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  const before = countTimers();
  withinMs(new Promise(() => {}), 60000);
  assert.equal(countTimers(), before, 'its timer is not one the process waits for');
});

test('a wait that was answered in time clears its own timer', async () => {
  const cleared = [];
  const real = globalThis.clearTimeout;
  globalThis.clearTimeout = timer => { cleared.push(timer); return real(timer); };
  try {
    await withinMs(Promise.resolve('fast'), 60000);
  } finally { globalThis.clearTimeout = real; }
  assert.equal(cleared.length, 1);
});

test('the time of the last good check survives a check that could not even start, and what is handed out is a copy', async () => {
  let up = true;
  const runner = createInboxRunner({ cloudSession: async () => (up ? session : null), pull: async () => ({ ok: true }), now: clock('2026-10-23T12:00:00Z') });
  await runner.run();
  up = false;
  await runner.run();
  assert.deepEqual(runner.last(), { at: '2026-10-23T12:00:00.000Z', ok: false });
  const given = runner.last();
  given.at = 'tampered';
  given.ok = true;
  assert.deepEqual(runner.last(), { at: '2026-10-23T12:00:00.000Z', ok: false }, 'nobody can rewrite the record by changing what they were given');
});
