import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guest feedback (M4 · 4.5). The hub's only unauthenticated write, so most of what matters is
// what it refuses and what it refuses to tell the caller.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-feedback-'));
process.env.HUB_DATA_DIR = dataDir;
process.env.SUPABASE_URL = 'https://example.supabase.co';

const { validateFeedback, feedbackStore, MAX_COMMENT } = await import('../lib/feedbackStore.js');

const RID = '11111111-1111-1111-1111-111111111111';
const reset = () => { feedbackStore.entries = []; feedbackStore.save(); };

// --- what counts as feedback -------------------------------------------------------------------

test('feedback: a rating of 1 to 5 is required, as a whole number', () => {
  for (const good of [1, 2, 3, 4, 5, '4']) {
    assert.equal(validateFeedback({ rating: good }).ok, true, `${good} should be accepted`);
  }
  for (const bad of [0, 6, -1, 4.5, 'good', null, undefined, NaN, Infinity, [], {}]) {
    assert.equal(validateFeedback({ rating: bad }).ok, false, `${JSON.stringify(bad)} is not a rating`);
  }
});

test('feedback: the comment is optional and an empty one is stored as nothing', () => {
  assert.equal(validateFeedback({ rating: 5 }).comment, null);
  assert.equal(validateFeedback({ rating: 5, comment: '   ' }).comment, null,
    'whitespace is not a comment');
  assert.equal(validateFeedback({ rating: 5, comment: '  Lovely dal  ' }).comment, 'Lovely dal');
});

test('feedback: an over-long comment is refused, measured after trimming', () => {
  assert.equal(validateFeedback({ rating: 5, comment: 'x'.repeat(MAX_COMMENT) }).ok, true);
  assert.equal(validateFeedback({ rating: 5, comment: 'x'.repeat(MAX_COMMENT + 1) }).ok, false);
  // 500 spaces around a short comment is a short comment.
  assert.equal(validateFeedback({ rating: 5, comment: ' '.repeat(600) + 'ok' }).ok, true);
});

test('feedback: a comment is stored as text and never interpreted', () => {
  const out = validateFeedback({ rating: 1, comment: '<script>alert(1)</script>' });
  assert.equal(out.ok, true, 'a guest may write angle brackets; they are just characters');
  assert.equal(out.comment, '<script>alert(1)</script>',
    'stored verbatim -- escaping belongs where it is rendered, not where it is kept');
});

// --- the store ---------------------------------------------------------------------------------

test('feedback: entries come back newest first, with a summary', () => {
  reset();
  feedbackStore.add({ restaurantId: RID, table: 'T1', rating: 4, comment: 'Good' });
  feedbackStore.add({ restaurantId: RID, table: 'T2', rating: 2, comment: 'Slow' });
  feedbackStore.add({ restaurantId: RID, table: 'T3', rating: 5, comment: null });

  assert.deepEqual(feedbackStore.list(RID).map(e => e.rating), [5, 2, 4]);
  assert.deepEqual(feedbackStore.summary(RID), { count: 3, average: 3.7, distribution: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 } });
});

test('feedback: another tenant\'s feedback is never listed or counted', () => {
  reset();
  feedbackStore.add({ restaurantId: RID, table: 'T1', rating: 5, comment: null });
  feedbackStore.add({ restaurantId: '22222222-2222-2222-2222-222222222222', table: 'T1', rating: 1, comment: null });

  assert.equal(feedbackStore.list(RID).length, 1);
  assert.deepEqual(feedbackStore.summary(RID), { count: 1, average: 5, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } });
});

test('feedback: an empty ledger has no average rather than a zero', () => {
  reset();
  assert.deepEqual(feedbackStore.summary(RID), { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
});

test('feedback: a table that has just been heard from is cooling down', () => {
  reset();
  feedbackStore.add({ restaurantId: RID, table: 'T1', rating: 5, comment: null });
  assert.equal(feedbackStore.isCoolingDown(RID, 'T1'), true);
  assert.equal(feedbackStore.isCoolingDown(RID, 'T2'), false, 'other tables are unaffected');
  // Three minutes later the table has turned over.
  assert.equal(feedbackStore.isCoolingDown(RID, 'T1', Date.now() + 3 * 60 * 1000), false);
});

// --- through the route ---------------------------------------------------------------------------

test('hub: a guest can leave feedback without a token, and it reaches reception', async () => {
  const { startHub, call: hubCall, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    trustLoopback: true,
    menu: {
      restaurant_id: RESTAURANT_ID, categories: ['Mains'],
      items: [{ id: 'm1', name: 'Dal', price: 200, category: 'Mains', isVeg: true, available: true }]
    },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });

  try {
    // No Authorization header: this is a phone that scanned a sticker.
    const res = await fetch(`${hub.base}/public/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'T1', rating: 5, comment: 'Excellent dal' })
    });
    assert.equal(res.status, 201);

    // The acknowledgement is deliberately thin: nothing to enumerate.
    assert.deepEqual(await res.json(), { success: true });

    const listed = await (await hubCall(hub, '/feedback')).json();
    assert.equal(listed.count, 1);
    assert.equal(listed.entries[0].rating, 5);
    assert.equal(listed.entries[0].comment, 'Excellent dal');
    assert.equal(listed.entries[0].table, 'T1');
  } finally {
    hub.stop();
  }
});

test('hub: a bad rating is refused and nothing is stored', async () => {
  const { startHub, call: hubCall, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    trustLoopback: true,
    menu: { restaurant_id: RESTAURANT_ID, categories: [], items: [] },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });

  try {
    const res = await fetch(`${hub.base}/public/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'T1', rating: 50 })
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_FEEDBACK');

    assert.equal((await (await hubCall(hub, '/feedback')).json()).count, 0);
  } finally {
    hub.stop();
  }
});

test('hub: one table cannot file feedback over and over', async () => {
  const { startHub, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    trustLoopback: true,
    menu: { restaurant_id: RESTAURANT_ID, categories: [], items: [] },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });
  const send = () => fetch(`${hub.base}/public/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: 'T1', rating: 3 })
  });

  try {
    assert.equal((await send()).status, 201);
    const second = await send();
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, 'ALREADY_SUBMITTED');
  } finally {
    hub.stop();
  }
});

test('hub: reading the feedback is reception-only -- it is the restaurant\'s own mail', async () => {
  const { startHub, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    trustLoopback: false,
    menu: { restaurant_id: RESTAURANT_ID, categories: [], items: [] },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });

  try {
    // A guest may write, but must not read what other guests wrote.
    assert.equal((await fetch(`${hub.base}/public/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'T1', rating: 4 })
    })).status, 201);

    assert.equal((await fetch(`${hub.base}/feedback`)).status, 403);
  } finally {
    hub.stop();
  }
});

test('hub: feedback is stamped with the table\'s own settled bill, which the guest never sees', async () => {
  const { startHub, call: hubCall, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    trustLoopback: true,
    menu: {
      restaurant_id: RESTAURANT_ID, categories: ['Mains'],
      items: [{ id: 'm1', name: 'Dal', price: 200, category: 'Mains', isVeg: true, available: true }]
    },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });

  try {
    // A real meal: ordered, closed, paid.
    await hubCall(hub, '/orders', { method: 'POST', body: { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 2 }] } });
    const invoice = (await (await hubCall(hub, '/tables/1/clear', { method: 'POST' })).json()).invoice;
    await hubCall(hub, `/invoices/${invoice.id}/mark-paid`, { method: 'POST', body: { payment_method: 'cash' } });

    const res = await fetch(`${hub.base}/public/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'T1', rating: 4 })
    });
    assert.equal(res.status, 201);

    // The guest is told nothing about the bill...
    assert.deepEqual(await res.json(), { success: true });

    // ...but reception can see which meal the rating is about.
    const entry = (await (await hubCall(hub, '/feedback')).json()).entries[0];
    assert.equal(entry.invoice_number, invoice.invoice_number);
    assert.equal(entry.invoice_id, invoice.id);
  } finally {
    hub.stop();
  }
});

test('hub: feedback from a table with no recent bill is still kept, just unattached', async () => {
  const { startHub, call: hubCall, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    trustLoopback: true,
    menu: { restaurant_id: RESTAURANT_ID, categories: [], items: [] },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });

  try {
    // Someone scanning a code without having eaten is still worth hearing from.
    const res = await fetch(`${hub.base}/public/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 2, comment: 'Could not get a table' })
    });
    assert.equal(res.status, 201);

    const entry = (await (await hubCall(hub, '/feedback')).json()).entries[0];
    assert.equal(entry.invoice_number, null);
    assert.equal(entry.table, null);
    assert.equal(entry.comment, 'Could not get a table');
  } finally {
    hub.stop();
  }
});

// --- replication (migration 013) ----------------------------------------------------------------

test('hub: feedback a guest leaves is queued for the cloud, and a refused rating is not', async () => {
  const { startHub, RESTAURANT_ID } = await import('./helpers/spawnHub.mjs');
  const hub = await startHub({
    trustLoopback: true,
    menu: { restaurant_id: RESTAURANT_ID, categories: [], items: [] },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });
  const queued = () => {
    try { return JSON.parse(fs.readFileSync(path.join(hub.dataDir, 'sync_queue.json'), 'utf-8')).filter(q => q.type === 'SYNC_FEEDBACK'); } catch { return []; }
  };
  const post = body => fetch(`${hub.base}/public/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  try {
    assert.equal((await post({ table: 'T1', rating: 9 })).status, 400);
    assert.equal((await post({ table: 'T1', rating: 4, comment: 'Lovely' })).status, 201);

    const deadline = Date.now() + 15000;
    while (queued().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 150));

    const items = queued();
    assert.equal(items.length, 1, 'one queued, for the one accepted');
    assert.equal(items[0].payload.restaurant_id, RESTAURANT_ID);
    assert.deepEqual([items[0].payload.entry.rating, items[0].payload.entry.comment, items[0].payload.entry.table], [4, 'Lovely', 'T1']);
  } finally {
    hub.stop();
  }
});
