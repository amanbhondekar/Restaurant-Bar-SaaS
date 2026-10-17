import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Throwaway data directory, set before the store is imported: feedbackStore resolves it at load.
process.env.HUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-feedback-'));
process.env.SUPABASE_URL = 'https://example.supabase.co';

const {
  ATTENTION_AT_OR_BELOW, FILTERS, attentionCount, billLabel, distributionRows, filterEntries,
  needsAttention, ratingLabel, starsText, summaryLine, tableLabel
} = await import('../../src/admin/lib/feedback.js');
const { feedbackStore } = await import('../lib/feedbackStore.js');

// The owner console's feedback view (M4 · 4.5). The hub's feedbackStore is the oracle: whatever it
// sends is what the page has to draw correctly.

const RID = '11111111-1111-1111-1111-111111111111';
const reset = () => { feedbackStore.entries = []; feedbackStore.save(); };
const add = (rating, over = {}) =>
  feedbackStore.add({ restaurantId: RID, table: 'T1', rating, comment: null, ...over });

/** What GET /feedback answers, assembled the way server.js does. */
const response = () => ({
  success: true,
  ...feedbackStore.summary(RID),
  entries: feedbackStore.list(RID)
});

// --- stars and labels --------------------------------------------------------------------------

test('feedback view: a rating is drawn as stars and named for screen readers', () => {
  assert.equal(starsText(4), '★★★★☆');
  assert.equal(starsText(1), '★☆☆☆☆');
  assert.equal(starsText(5), '★★★★★');
  assert.equal(ratingLabel(4), '4 out of 5');
});

test('feedback view: a nonsense rating draws as empty stars rather than throwing or overflowing', () => {
  assert.equal(starsText(undefined), '☆☆☆☆☆');
  assert.equal(starsText(NaN), '☆☆☆☆☆');
  assert.equal(starsText(99), '★★★★★', 'clamped, never more than five');
  assert.equal(starsText(-3), '☆☆☆☆☆');
});

test('feedback view: where a comment came from, and which meal it is about', () => {
  assert.equal(tableLabel({ table: 'T8' }), 'Table T8');
  assert.equal(tableLabel({ table: null }), 'No table');
  assert.equal(billLabel({ invoice_number: 'INV-000012' }), 'Bill INV-000012');
  assert.equal(billLabel({ invoice_number: null }), 'No bill matched');
  assert.equal(billLabel(undefined), 'No bill matched');
});

// --- what wants attention ----------------------------------------------------------------------

test('feedback view: low ratings are flagged, and the threshold is two stars or below', () => {
  assert.equal(ATTENTION_AT_OR_BELOW, 2);
  assert.equal(needsAttention({ rating: 1 }), true);
  assert.equal(needsAttention({ rating: 2 }), true);
  assert.equal(needsAttention({ rating: 3 }), false);
  assert.equal(needsAttention({ rating: 5 }), false);
  assert.equal(needsAttention(undefined), false, 'nothing to flag is not an alarm');
});

test('feedback view: filters keep order, and an unknown filter hides nothing', () => {
  reset();
  add(5, { comment: 'Lovely' });
  add(1, { comment: 'Cold', table: 'T2' });
  add(2);
  add(4, { comment: '   ', table: 'T3' });
  const { entries } = response();

  assert.deepEqual(filterEntries(entries, 'all').map(e => e.rating), [4, 2, 1, 5], 'newest first, untouched');
  assert.deepEqual(filterEntries(entries, 'attention').map(e => e.rating), [2, 1]);
  assert.deepEqual(filterEntries(entries, 'comments').map(e => e.rating), [1, 5],
    'a whitespace-only comment is not a comment');
  assert.equal(filterEntries(entries, 'banana').length, 4, 'a typo must not hide feedback');
  assert.equal(attentionCount(entries), 2);
});

test('feedback view: a missing or malformed list is an empty one', () => {
  for (const bad of [null, undefined, 'nope', {}, 42]) {
    assert.deepEqual(filterEntries(bad, 'all'), []);
  }
  assert.equal(attentionCount(undefined), 0);
});

test('feedback view: every filter the page offers is one filterEntries understands', () => {
  // Drift guard: a filter button that did nothing would look like a broken page.
  reset();
  add(1, { comment: 'x' });
  const { entries } = response();
  for (const f of FILTERS) {
    assert.ok(Array.isArray(filterEntries(entries, f.id)), `${f.id} should return a list`);
  }
  assert.deepEqual(FILTERS.map(f => f.id), ['all', 'attention', 'comments']);
});

// --- the split -----------------------------------------------------------------------------------

test('feedback view: the split comes from the hub summary, best rating first', () => {
  reset();
  add(5); add(5); add(5, { table: 'T2' }); add(4, { table: 'T3' }); add(1, { table: 'T4' });
  const rows = distributionRows(response());

  assert.deepEqual(rows.map(r => r.rating), [5, 4, 3, 2, 1]);
  assert.deepEqual(rows.map(r => r.count), [3, 1, 0, 0, 1]);
  assert.deepEqual(rows.map(r => r.percent), [60, 20, 0, 0, 20]);
});

test('feedback view: the split still adds up when there is more feedback than the list holds', () => {
  // The reason it is counted on the hub: the list is capped, the summary is not. Worked out from
  // the list, 130 ratings would draw a split of 100.
  reset();
  for (let i = 0; i < 130; i++) add(5, { table: `T${i}` });
  const summary = feedbackStore.summary(RID);
  const listed = feedbackStore.list(RID, 100);

  assert.equal(listed.length, 100, 'the list is capped');
  assert.equal(summary.count, 130, 'the summary is not');
  const rows = distributionRows({ ...summary, entries: listed });
  assert.equal(rows.find(r => r.rating === 5).count, 130, 'the split counts all of them');
  assert.equal(rows.find(r => r.rating === 5).percent, 100);
});

test('feedback view: no feedback, or a hub too old to send a split, draws no chart at all', () => {
  assert.deepEqual(distributionRows({ count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }), []);
  // A chart of zeroes would look like data.
  assert.deepEqual(distributionRows({ count: 12, average: 4.1 }), []);
  assert.deepEqual(distributionRows(undefined), []);
});

// --- the headline --------------------------------------------------------------------------------

test('feedback view: the summary line reads naturally, singular and plural', () => {
  reset();
  assert.equal(summaryLine(feedbackStore.summary(RID)), 'No feedback yet.');
  add(4);
  assert.equal(summaryLine(feedbackStore.summary(RID)), '4 average from 1 rating');
  add(5, { table: 'T2' });
  assert.equal(summaryLine(feedbackStore.summary(RID)), '4.5 average from 2 ratings');
});

test('feedback view: a comment is carried as the text it is, never altered on the way', () => {
  // Escaping is the renderer's job -- React does it -- so the data layer must not mangle or
  // pre-escape it, or reception would read "&lt;b&gt;" instead of what the guest typed.
  reset();
  add(1, { comment: '<b>cold</b> & slow' });
  assert.equal(response().entries[0].comment, '<b>cold</b> & slow');
});
