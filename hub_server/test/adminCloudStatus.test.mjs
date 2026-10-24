import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudState } from '../../src/admin/lib/cloudStatus.js';

const status = over => ({ revision: 5, synced_revision: 0, pending_revision: null, failed: false, ...over });

test('nothing to say before the hub has an answer or a hub edit', () => {
  assert.equal(cloudState(null), null);
  assert.equal(cloudState(undefined), null);
  assert.equal(cloudState({}), null);
  assert.equal(cloudState(status({ revision: 0 })), null);
});

test('synced once the cloud holds the current revision', () => {
  assert.equal(cloudState(status({ synced_revision: 5 })).state, 'synced');
  assert.equal(cloudState(status({ synced_revision: 9 })).state, 'synced');
});

test('pending while a push is queued, with a different label when the hub is offline', () => {
  assert.deepEqual(cloudState(status({ synced_revision: 3, pending_revision: 5 })), { state: 'pending', label: 'Cloud: saving…' });
  assert.equal(cloudState(status({ pending_revision: 5 }), false).label, 'Cloud: waiting for internet');
});

test('a shelved push is failed even if an older one still shows as synced', () => {
  assert.equal(cloudState(status({ failed: true, synced_revision: 2 })).state, 'failed');
  assert.equal(cloudState(status({ failed: true, pending_revision: 5 })).state, 'failed');
});

test('behind the hub with nothing queued counts as failed, never as synced', () => {
  assert.equal(cloudState(status({ synced_revision: 2 })).state, 'failed');
});
