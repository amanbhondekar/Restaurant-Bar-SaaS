import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InvoiceEventStore } from '../lib/invoiceEventStore.js';
import { GENESIS_HASH, verifyChain } from '../lib/invoiceEvents.js';

// The hub's own copy of every bill's event history (G0-4): one JSON line per event, only ever added to, so a crash can tear the last
// line and nothing else.

const RID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-events-'));
let n = 0;
const fresh = () => {
  const file = path.join(dir, `events-${++n}.jsonl`);
  return { file, store: new InvoiceEventStore({ file }) };
};
const add = (store, over = {}) => store.append({
  restaurantId: RID, invoiceRef: 'inv_1', type: 'paid', actor: 'Priya', payload: { changes: {} }, ...over
});

test('a bill\'s events are numbered from 1 and each carries the hash of the one before', () => {
  const { store } = fresh();
  const a = add(store, { type: 'issued', payload: { invoice: { id: 'inv_1' } } });
  const b = add(store, { type: 'paid' });
  const c = add(store, { type: 'refunded' });
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  assert.equal(a.prev_hash, GENESIS_HASH);
  assert.equal(b.prev_hash, a.hash);
  assert.equal(c.prev_hash, b.hash);
  assert.equal(verifyChain(store.list(RID, 'inv_1')).ok, true);
});

test('each bill has its own chain, and so does each restaurant', () => {
  const { store } = fresh();
  add(store, { invoiceRef: 'inv_1' });
  add(store, { invoiceRef: 'inv_1' });
  const other = add(store, { invoiceRef: 'inv_2' });
  const elsewhere = add(store, { restaurantId: OTHER, invoiceRef: 'inv_1' });
  assert.equal(other.seq, 1);
  assert.equal(other.prev_hash, GENESIS_HASH);
  assert.equal(elsewhere.seq, 1, 'the same hub reference under another restaurant is another bill');
  assert.equal(store.list(RID, 'inv_1').length, 2);
  assert.equal(store.list(OTHER, 'inv_1').length, 1);
  assert.equal(store.list(RID, 'inv_9').length, 0);
});

test('the time an event is stamped with is the hub\'s clock unless one is given', () => {
  const { store } = fresh();
  const before = Date.now();
  const e = add(store);
  assert.ok(Date.parse(e.occurred_at) >= before && Date.parse(e.occurred_at) <= Date.now());
  assert.equal(add(store, { occurredAt: '2026-10-26T10:00:00.000Z' }).occurred_at, '2026-10-26T10:00:00.000Z');
});

test('events are kept on disk, and a new store on the same file sees them in the same chain', () => {
  const { file, store } = fresh();
  const a = add(store);
  const b = add(store);
  const again = new InvoiceEventStore({ file });
  assert.deepEqual(again.list(RID, 'inv_1').map(e => e.hash), [a.hash, b.hash]);
  const c = add(again);
  assert.equal(c.seq, 3);
  assert.equal(c.prev_hash, b.hash);
});

test('the file is only ever added to: nothing already written is rewritten', () => {
  const { file, store } = fresh();
  add(store);
  const first = fs.readFileSync(file);
  add(store);
  store.markSynced([store.list(RID, 'inv_1')[0].id]);
  const later = fs.readFileSync(file);
  assert.ok(later.length > first.length);
  assert.ok(later.subarray(0, first.length).equals(first), 'the earlier bytes are unchanged');
  assert.ok(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).every(line => JSON.parse(line)), 'one JSON document per line');
});

test('a line torn by a crash is skipped and counted, and the rest of the history is intact', () => {
  const { file, store } = fresh();
  add(store);
  add(store);
  fs.appendFileSync(file, '{"id":"inv_1#3","restaurant_id":"' + RID + '","invoice_ref":"inv_1","seq":3,"ty');
  const again = new InvoiceEventStore({ file });
  assert.equal(again.list(RID, 'inv_1').length, 2);
  assert.equal(again.damagedLines, 1);
  const next = add(again);
  assert.equal(next.seq, 3, 'the chain carries on from the last whole event');
  const reread = new InvoiceEventStore({ file }).list(RID, 'inv_1');
  assert.equal(reread.length, 3, 'and the new event is on a line of its own, so it is read back');
  assert.equal(verifyChain(reread).ok, true);
});

test('events start unsynced and stop being unsynced once the cloud confirms them', () => {
  const { store } = fresh();
  const a = add(store);
  const b = add(store);
  const x = add(store, { invoiceRef: 'inv_2' });
  assert.equal(store.listUnsynced(RID).length, 3);
  assert.deepEqual(store.listUnsynced(RID).map(e => e.id), [a.id, b.id, x.id], 'oldest bill first, then in order within a bill');
  store.markSynced([a.id, b.id]);
  assert.deepEqual(store.listUnsynced(RID).map(e => e.id), [x.id]);
  assert.deepEqual(store.listUnsyncedFor(RID, 'inv_2').map(e => e.id), [x.id]);
  assert.deepEqual(store.unsyncedRefs(RID), ['inv_2']);
});

test('what the cloud confirmed survives a restart', () => {
  const { file, store } = fresh();
  const a = add(store);
  add(store);
  store.markSynced([a.id]);
  const again = new InvoiceEventStore({ file });
  assert.deepEqual(again.listUnsynced(RID).map(e => e.seq), [2]);
});

test('confirming an event that is not there, or twice, changes nothing', () => {
  const { store } = fresh();
  const a = add(store);
  assert.equal(store.markSynced(['nope#1']), 0);
  assert.equal(store.markSynced([a.id]), 1);
  assert.equal(store.markSynced([a.id]), 0);
});

test('the unsynced list is only this restaurant\'s', () => {
  const { store } = fresh();
  add(store);
  add(store, { restaurantId: OTHER });
  assert.equal(store.listUnsynced(RID).length, 1);
  assert.equal(store.listUnsynced(OTHER).length, 1);
});

test('the head of a bill is the hash of its last event, or the genesis hash for none', () => {
  const { store } = fresh();
  assert.equal(store.head(RID, 'inv_1'), GENESIS_HASH);
  add(store);
  const b = add(store);
  assert.equal(store.head(RID, 'inv_1'), b.hash);
});

test('a store can check a bill\'s history and say where it is broken', () => {
  const { file, store } = fresh();
  add(store);
  add(store);
  add(store);
  assert.equal(store.verify(RID, 'inv_1').ok, true);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const edited = JSON.parse(lines[1]);
  edited.actor = 'Someone else';
  lines[1] = JSON.stringify(edited);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const v = new InvoiceEventStore({ file }).verify(RID, 'inv_1');
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test('which bills have no history is a question the store answers, so they can be given a baseline', () => {
  const { store } = fresh();
  add(store, { invoiceRef: 'inv_1' });
  const bills = [{ id: 'inv_1', restaurant_id: RID }, { id: 'inv_2', restaurant_id: RID }, { id: 'inv_3', restaurant_id: OTHER }];
  assert.deepEqual(store.withoutHistory(RID, bills).map(b => b.id), ['inv_2']);
});

test('a store is empty for a restaurant until it holds one of its events', () => {
  const { store } = fresh();
  assert.equal(store.isEmpty(RID), true);
  add(store, { restaurantId: OTHER });
  assert.equal(store.isEmpty(RID), true);
  add(store);
  assert.equal(store.isEmpty(RID), false);
});

test('restoring fills an empty store from the cloud, keeps the chain, and marks the events as already in the cloud', () => {
  const source = fresh().store;
  add(source);
  add(source);
  const pulled = source.list(RID, 'inv_1');
  const { store } = fresh();
  const r = store.restoreAll(RID, [...pulled].reverse());   // however the cloud happened to hand them over
  assert.deepEqual([r.restored, r.broken], [2, []]);
  assert.deepEqual(store.list(RID, 'inv_1').map(e => e.hash), pulled.map(e => e.hash));
  assert.equal(store.listUnsynced(RID).length, 0);
  assert.equal(add(store).seq, 3, 'the hub carries on the restored chain');
});

test('restoring never merges into a store that already holds events', () => {
  const source = fresh().store;
  add(source);
  const { store } = fresh();
  add(store, { invoiceRef: 'inv_9' });
  const r = store.restoreAll(RID, source.list(RID, 'inv_1'));
  assert.equal(r.restored, 0);
  assert.equal(store.list(RID, 'inv_1').length, 0);
});

test('a restored history that does not verify is kept, and the bills it belongs to are named', () => {
  const source = fresh().store;
  add(source);
  add(source);
  add(source, { invoiceRef: 'inv_2' });
  const pulled = source.list(RID, 'inv_1').concat(source.list(RID, 'inv_2'));
  pulled[1] = { ...pulled[1], actor: 'Someone else' };
  const { store } = fresh();
  const r = store.restoreAll(RID, pulled);
  assert.equal(r.restored, 3, 'the evidence is kept, not thrown away');
  assert.deepEqual(r.broken, ['inv_1']);
});

test('restoring ignores events for another restaurant', () => {
  const source = fresh().store;
  add(source, { restaurantId: OTHER });
  const { store } = fresh();
  assert.equal(store.restoreAll(RID, source.list(OTHER, 'inv_1')).restored, 0);
});
