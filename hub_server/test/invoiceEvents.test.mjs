import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GENESIS_HASH, EVENT_TYPES, canonicalJson, buildEvent, verifyChain, diffInvoice
} from '../lib/invoiceEvents.js';

// The rules of a bill's event history (G0-4): how an event is hashed, how a chain is checked, and how a change to a bill is
// described. Pure functions; nothing here touches a disk or the cloud.

const RID = '11111111-1111-1111-1111-111111111111';
const AT = '2026-10-26T10:00:00.000Z';

const make = (seq, prev, over = {}) => buildEvent({
  restaurantId: RID, invoiceRef: 'inv_1', seq, type: 'paid', actor: 'Priya', occurredAt: AT,
  payload: { changes: { payment_status: { from: 'pending', to: 'paid' } } }, prevHash: prev, ...over
});

function chain(n = 4) {
  const events = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const e = make(seq, prev, { type: seq === 1 ? 'issued' : 'split', payload: { n: seq } });
    events.push(e);
    prev = e.hash;
  }
  return events;
}

// --- canonical encoding -----------------------------------------------------------------------------------------------------

test('the encoding does not depend on key order, at any depth', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } }), canonicalJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }));
});

test('the encoding keeps the order of an array and tells values apart', () => {
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: '1' }));
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({}));
});

test('a key whose value is undefined is not part of the encoding', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

// --- an event -----------------------------------------------------------------------------------------------------------------

test('the first event of a bill chains to the genesis hash and carries a 64-character hash', () => {
  const e = make(1, GENESIS_HASH);
  assert.equal(e.prev_hash, GENESIS_HASH);
  assert.match(e.hash, /^[0-9a-f]{64}$/);
  assert.equal(GENESIS_HASH, '0'.repeat(64));
});

test('the same inputs give the same hash, whatever the key order of the payload', () => {
  const a = make(1, GENESIS_HASH, { payload: { x: 1, y: { p: 1, q: 2 } } });
  const b = make(1, GENESIS_HASH, { payload: { y: { q: 2, p: 1 }, x: 1 } });
  assert.equal(a.hash, b.hash);
});

test('changing any single input changes the hash', () => {
  const base = make(1, GENESIS_HASH);
  const variants = {
    restaurant: make(1, GENESIS_HASH, { restaurantId: '22222222-2222-2222-2222-222222222222' }),
    invoice: make(1, GENESIS_HASH, { invoiceRef: 'inv_2' }),
    seq: make(2, GENESIS_HASH),
    type: make(1, GENESIS_HASH, { type: 'voided' }),
    actor: make(1, GENESIS_HASH, { actor: 'Ravi' }),
    time: make(1, GENESIS_HASH, { occurredAt: '2026-10-26T10:00:00.001Z' }),
    payload: make(1, GENESIS_HASH, { payload: { changes: {} } }),
    prev: make(1, 'f'.repeat(64))
  };
  for (const [name, e] of Object.entries(variants)) assert.notEqual(e.hash, base.hash, `${name} must be part of the hash`);
});

test('an event names its bill, its place in the chain and the clock that stamped it', () => {
  const e = make(3, 'a'.repeat(64));
  assert.deepEqual(
    [e.restaurant_id, e.invoice_ref, e.seq, e.type, e.actor, e.occurred_at, e.id],
    [RID, 'inv_1', 3, 'paid', 'Priya', AT, 'inv_1#3']
  );
});

test('the time is stored as an ISO instant, so the same moment hashes the same however it was written', () => {
  const a = make(1, GENESIS_HASH, { occurredAt: '2026-10-26T15:30:00+05:30' });
  const b = make(1, GENESIS_HASH, { occurredAt: '2026-10-26T10:00:00.000Z' });
  assert.equal(a.occurred_at, '2026-10-26T10:00:00.000Z');
  assert.equal(a.hash, b.hash);
});

test('an actor is a short label or nothing: trimmed, capped at 60 characters, never a non-string', () => {
  assert.equal(make(1, GENESIS_HASH, { actor: '  Priya  ' }).actor, 'Priya');
  assert.equal(make(1, GENESIS_HASH, { actor: 'x'.repeat(100) }).actor.length, 60);
  assert.equal(make(1, GENESIS_HASH, { actor: 42 }).actor, null);
  assert.equal(make(1, GENESIS_HASH, { actor: '   ' }).actor, null);
  assert.equal(make(1, GENESIS_HASH, { actor: undefined }).actor, null);
});

test('every type the hub can record is accepted, and nothing else', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), ['baseline', 'issued', 'paid', 'refunded', 'split', 'split_paid', 'unsplit', 'voided']);
  for (const type of EVENT_TYPES) assert.equal(make(1, GENESIS_HASH, { type }).type, type);
  assert.throws(() => make(1, GENESIS_HASH, { type: 'edited' }), /type/i);
  assert.throws(() => make(1, GENESIS_HASH, { type: undefined }), /type/i);
});

test('an event with no restaurant, no bill, a bad place in the chain, a bad payload or a bad previous hash is refused', () => {
  assert.throws(() => make(1, GENESIS_HASH, { restaurantId: '' }), /restaurant/i);
  assert.throws(() => make(1, GENESIS_HASH, { invoiceRef: '' }), /invoice/i);
  assert.throws(() => make(0, GENESIS_HASH), /seq/i);
  assert.throws(() => make(1.5, GENESIS_HASH), /seq/i);
  assert.throws(() => make(-1, GENESIS_HASH), /seq/i);
  assert.throws(() => make(1, GENESIS_HASH, { payload: null }), /payload/i);
  assert.throws(() => make(1, GENESIS_HASH, { payload: 'text' }), /payload/i);
  assert.throws(() => make(1, GENESIS_HASH, { payload: [] }), /payload/i);
  assert.throws(() => make(1, 'short'), /prev/i);
  assert.throws(() => make(1, 'G'.repeat(64)), /prev/i);
  assert.throws(() => make(1, GENESIS_HASH, { occurredAt: 'not a time' }), /occurred time/i);
});

// --- verifying a chain --------------------------------------------------------------------------------------------------------

test('a whole chain verifies, and says where it ends', () => {
  const events = chain(4);
  const v = verifyChain(events);
  assert.deepEqual([v.ok, v.count, v.head], [true, 4, events[3].hash]);
});

test('no events is a valid chain that ends at the genesis hash', () => {
  const v = verifyChain([]);
  assert.deepEqual([v.ok, v.count, v.head], [true, 0, GENESIS_HASH]);
});

test('editing what an event says is found, at that event', () => {
  const events = chain(4);
  events[1] = { ...events[1], payload: { n: 999 } };
  const v = verifyChain(events);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  assert.match(v.reason, /hash/i);
});

test('editing who did it, when, or what kind of event it was is found', () => {
  for (const edit of [{ actor: 'Someone else' }, { occurred_at: '2026-10-27T00:00:00.000Z' }, { type: 'voided' }]) {
    const events = chain(3);
    events[1] = { ...events[1], ...edit };
    const v = verifyChain(events);
    assert.equal(v.ok, false, JSON.stringify(edit));
    assert.equal(v.brokenAt, 2);
  }
});

test('an edit whose hash was recomputed still breaks the link to the next event', () => {
  const events = chain(4);
  events[1] = make(2, events[0].hash, { type: 'split', payload: { n: 'rewritten' } });
  const v = verifyChain(events);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
  assert.match(v.reason, /prev|link|chain/i);
});

test('a missing event in the middle is found', () => {
  const events = chain(4);
  events.splice(1, 1);
  const v = verifyChain(events);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
  assert.match(v.reason, /seq|gap|missing/i);
});

test('events out of order, or a repeated one, are found', () => {
  const swapped = chain(3);
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.equal(verifyChain(swapped).ok, false);
  const repeated = chain(3);
  repeated.splice(2, 0, repeated[1]);
  assert.equal(verifyChain(repeated).ok, false);
});

test('a chain must begin at event 1 chained to the genesis hash', () => {
  const events = chain(3);
  assert.equal(verifyChain(events.slice(1)).ok, false, 'starting at event 2');
  const forged = [make(1, 'a'.repeat(64)), ...chain(2).slice(1)];
  assert.equal(verifyChain(forged).ok, false, 'a first event that does not start at genesis');
});

test('a chain of one bill cannot contain another bill\'s event', () => {
  const events = chain(3);
  events[2] = { ...make(3, events[1].hash, { invoiceRef: 'inv_other' }) };
  const v = verifyChain(events);
  assert.equal(v.ok, false);
  assert.match(v.reason, /invoice|restaurant/i);
  const other = chain(3);
  other[2] = make(3, other[1].hash, { restaurantId: '22222222-2222-2222-2222-222222222222' });
  assert.equal(verifyChain(other).ok, false);
});

test('cutting events off the end cannot be seen from the chain, but changes its head -- which is what an anchor keeps', () => {
  const events = chain(4);
  const cut = verifyChain(events.slice(0, 3));
  assert.equal(cut.ok, true, 'a shorter chain is still a valid chain');
  assert.notEqual(cut.head, verifyChain(events).head);
});

// --- describing a change ------------------------------------------------------------------------------------------------------

test('a change lists each field that differs, with what it was and what it became', () => {
  const before = { id: 'i', payment_status: 'pending', payment_method: undefined, grand_total: 100 };
  const after = { id: 'i', payment_status: 'paid', payment_method: 'cash', paid_by: 'Priya', grand_total: 100 };
  assert.deepEqual(diffInvoice(before, after), {
    payment_status: { from: 'pending', to: 'paid' },
    payment_method: { from: null, to: 'cash' },
    paid_by: { from: null, to: 'Priya' }
  });
});

test('a field that was removed is a change to nothing, so an undone split keeps what it destroyed', () => {
  const splits = [{ index: 0, amount: 50 }, { index: 1, amount: 50 }];
  const d = diffInvoice({ id: 'i', splits, split_mode: 'seats', split_by: 'Priya' }, { id: 'i' });
  assert.deepEqual(d.splits, { from: splits, to: null });
  assert.deepEqual(d.split_mode, { from: 'seats', to: null });
  assert.deepEqual(d.split_by, { from: 'Priya', to: null });
});

test('fields that did not change, and the sync flag, are not part of a change', () => {
  const same = { id: 'i', items: [{ n: 1 }], tax_rows: [], grand_total: 10 };
  assert.deepEqual(diffInvoice(same, { ...same, items: [{ n: 1 }] }), {});
  assert.deepEqual(diffInvoice({ ...same, synced_to_cloud: true }, { ...same, synced_to_cloud: false }), {});
});

test('a change to something nested is found', () => {
  const d = diffInvoice({ id: 'i', splits: [{ payment_status: 'pending' }] }, { id: 'i', splits: [{ payment_status: 'paid' }] });
  assert.deepEqual(Object.keys(d), ['splits']);
});
