// The owner console's guest-feedback view, without React (M4 · 4.5). Everything here turns one
// GET /feedback answer into what the page shows: filters, the rating split, and the wording.

/** Ratings at or below this want a person to read them. */
export const ATTENTION_AT_OR_BELOW = 2;

export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'comments', label: 'With comments' }
];

/** A rating drawn as stars, for the eye. The accessible name comes from ratingLabel. */
export const starsText = rating => {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
};

export const ratingLabel = rating => `${Number(rating)} out of 5`;

export const needsAttention = entry => Number(entry?.rating) <= ATTENTION_AT_OR_BELOW;

/**
 * The listed entries a filter keeps, order unchanged (the hub already sends newest first).
 * An unknown filter keeps everything rather than hiding feedback behind a typo.
 */
export function filterEntries(entries, filter) {
  const list = Array.isArray(entries) ? entries : [];
  if (filter === 'attention') return list.filter(needsAttention);
  if (filter === 'comments') return list.filter(e => typeof e?.comment === 'string' && e.comment.trim() !== '');
  return list;
}

/**
 * One row per rating, best first, each with its share of ALL feedback.
 *
 * Built from the summary the hub sends, not from the listed entries: the list is capped while the
 * summary covers everything, so counting the list would stop adding up the day there are more
 * than a hundred. A summary from an older hub that has no split yields no rows rather than a
 * chart of zeroes that looks like data.
 */
export function distributionRows(summary) {
  const dist = summary?.distribution;
  const total = Number(summary?.count) || 0;
  if (!dist || total === 0) return [];
  return [5, 4, 3, 2, 1].map(rating => {
    const count = Number(dist[rating]) || 0;
    return { rating, count, percent: Math.round((count / total) * 100) };
  });
}

/** "4.2 average from 17 ratings", or a plain statement that there is nothing yet. */
export function summaryLine(summary) {
  const count = Number(summary?.count) || 0;
  if (count === 0 || summary?.average === null || summary?.average === undefined) {
    return 'No feedback yet.';
  }
  return `${summary.average} average from ${count} ${count === 1 ? 'rating' : 'ratings'}`;
}

/** Which meal a comment is about, in the words reception uses. */
export function billLabel(entry) {
  return entry?.invoice_number ? `Bill ${entry.invoice_number}` : 'No bill matched';
}

/** Where it came from: a table when the guest scanned one, otherwise the room generally. */
export function tableLabel(entry) {
  return entry?.table ? `Table ${entry.table}` : 'No table';
}

/** How many of the listed entries want attention, for the badge on that filter. */
export const attentionCount = entries => filterEntries(entries, 'attention').length;
