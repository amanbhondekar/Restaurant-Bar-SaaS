import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('SyncQueue: head-of-line blocking resolved with quarantine', async () => {
  // Setup throwaway directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  process.env.HUB_DATA_DIR = tempDir;

  const { syncQueue, MAX_SYNC_ATTEMPTS } = await import('../lib/syncQueue.js');

  // Verify MAX_SYNC_ATTEMPTS is 5
  assert.equal(MAX_SYNC_ATTEMPTS, 5);

  // Setup test queue with 1 bad item (simulating persistent failure) and 1 good item
  const badItem = {
    queue_id: 'q_bad_123',
    type: 'CREATE_ORDER',
    ticket: { id: 'bad_t1', ticket_number: 999, total_amount: 100 },
    attempts: 4 // Next attempt will trigger quarantine (attempt 5)
  };

  const goodItem = {
    queue_id: 'q_good_456',
    type: 'CREATE_ORDER',
    ticket: { id: 'good_t2', ticket_number: 1000, total_amount: 250 },
    attempts: 0
  };

  syncQueue.saveQueue([badItem, goodItem]);

  // Mock syncOrderToSupabase to fail badItem and succeed goodItem
  const originalSyncOrder = syncQueue.syncOrderToSupabase;
  syncQueue.syncOrderToSupabase = async (ticket) => {
    if (ticket.id === 'bad_t1') {
      return false; // Persistent failure
    }
    return true; // Success for good item
  };

  // Mock connection as online. processQueue() overwrites isOnline from
  // checkConnection(), so the probe itself has to be stubbed, not just the flag.
  const originalCheckConnection = syncQueue.checkConnection;
  syncQueue.checkConnection = async () => ({ online: true });
  syncQueue.isOnline = true;

  // Process queue
  await syncQueue.processQueue();

  // Bad item should be quarantined, and good item should be processed and removed!
  const remainingQueue = syncQueue.queue;
  assert.equal(remainingQueue.length, 0, 'Both items should be cleared from active queue');

  // Verify bad item exists in quarantine file
  const quarantineFile = path.join(tempDir, 'quarantine_sync_queue.json');
  assert.ok(fs.existsSync(quarantineFile), 'Quarantine file should be created');
  const quarantined = JSON.parse(fs.readFileSync(quarantineFile, 'utf-8'));
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].queue_id, 'q_bad_123');
  assert.equal(quarantined[0].quarantine_reason, 'Max retry attempts exceeded during cloud sync');

  // Restore original methods and clean up
  syncQueue.syncOrderToSupabase = originalSyncOrder;
  syncQueue.checkConnection = originalCheckConnection;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SyncQueue: onReconnected callback triggers upon offline->online transition', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-reconnect-test-'));
  process.env.HUB_DATA_DIR = tempDir;

  const { syncQueue } = await import('../lib/syncQueue.js');

  let reconnectedFired = false;
  const unsubscribe = syncQueue.onReconnected(() => {
    reconnectedFired = true;
  });

  // Trigger manual notification
  syncQueue.notifyReconnected();
  assert.equal(reconnectedFired, true, 'onReconnected callback should fire');

  unsubscribe();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
