// Guest feedback left after a meal (M4 · 4.5).
//
// Written from the hub's only unauthenticated *write*, which shapes everything here: a guest has
// no token, so validation and abuse limits are this module's job rather than the caller's, and a
// comment is stored as the text it is and never interpreted.
//
// Feedback is tied to a table, not to an invoice the guest names. The guest cannot see or guess a
// bill, so exposing one to them to "attach" feedback to would hand an unauthenticated caller a
// way to probe the ledger. The hub resolves the table's most recently settled bill itself, server
// side, and stamps it -- so reception sees which bill a comment belongs to while the guest never
// learns anything about it.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'feedback.json');

export const MAX_COMMENT = 500;
// How long after a bill is settled feedback still counts as being about it. A guest pays, walks
// out, and types something on the pavement; beyond this it is about the restaurant generally.
export const BILL_WINDOW_MS = 2 * 60 * 60 * 1000;
// One table, one piece of feedback per sitting. Not security -- it stops a bored guest filing
// forty ratings while they wait for a taxi.
const PER_TABLE_COOLDOWN_MS = 2 * 60 * 1000;

/** 1 to 5 stars, as an integer. Anything else is not a rating. */
export function validateFeedback({ rating, comment } = {}) {
  const errors = [];
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 5) errors.push('A rating from 1 to 5 is required.');

  const text = comment === undefined || comment === null ? '' : String(comment);
  // Trimmed before measuring so 500 spaces is not a valid comment.
  if (text.trim().length > MAX_COMMENT) errors.push(`Keep the comment under ${MAX_COMMENT} characters.`);

  return errors.length
    ? { ok: false, errors }
    : { ok: true, rating: n, comment: text.trim() || null };
}

class FeedbackStore {
  constructor() {
    this.entries = this.load();
  }

  load() {
    try {
      if (fs.existsSync(FILE)) {
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.warn('⚠️ Could not load feedback.json:', err.message);
    }
    return [];
  }

  save() {
    fs.writeFileSync(FILE, JSON.stringify(this.entries, null, 2), 'utf-8');
  }

  /** Newest first, which is the order anyone reading it wants. */
  list(restaurantId, limit = 100) {
    return this.entries
      .filter(e => e.restaurant_id === restaurantId)
      .slice()
      .reverse()
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  /** Whether this table has left feedback too recently to leave more. */
  isCoolingDown(restaurantId, table, now = Date.now()) {
    if (!table) return false;
    const last = this.entries
      .filter(e => e.restaurant_id === restaurantId && e.table === table)
      .at(-1);
    if (!last) return false;
    return now - new Date(last.created_at).getTime() < PER_TABLE_COOLDOWN_MS;
  }

  /**
   * Records one piece of feedback. `invoice` is resolved by the caller from the table's own
   * recent bills -- it is never taken from the guest.
   */
  add({ restaurantId, table, rating, comment, invoice = null, now = new Date() }) {
    const entry = {
      id: 'fb_' + now.getTime().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      restaurant_id: restaurantId,
      table: table || null,
      rating,
      comment,
      // Null when the table has no recently settled bill: feedback about the place rather than
      // about a meal we can point at.
      invoice_number: invoice?.invoice_number ?? null,
      invoice_id: invoice?.id ?? null,
      created_at: now.toISOString(),
      // Whether the cloud holds it (migration 013). Entries from before this existed have no flag, which
      // reads as "not yet", so the boot backfill carries them up.
      synced_to_cloud: false
    };
    this.entries = [...this.entries, entry];
    this.save();
    return entry;
  }

  /** Entries the cloud has not confirmed, oldest first so the history replicates in order. */
  listUnsynced(restaurantId) {
    return this.entries.filter(e => e.restaurant_id === restaurantId && e.synced_to_cloud !== true);
  }

  /** Records that the cloud now holds this entry. A statement a guest made never goes back to pending. */
  markSynced(entryId, restaurantId) {
    const entry = this.entries.find(e => e.id === entryId && (!restaurantId || e.restaurant_id === restaurantId));
    if (!entry || entry.synced_to_cloud === true) return false;
    entry.synced_to_cloud = true;
    this.save();
    return true;
  }

  /** Whether this restaurant has left no feedback at all on this hub. */
  isEmpty(restaurantId) {
    return !this.entries.some(e => e.restaurant_id === restaurantId);
  }

  /**
   * Fills an empty store from the cloud, for a replacement laptop. Only ever a restaurant with nothing here:
   * it never merges into feedback the hub already holds.
   */
  restoreAll(restaurantId, pulled) {
    if (!this.isEmpty(restaurantId)) return 0;
    const mine = pulled.filter(e => e.restaurant_id === restaurantId);
    this.entries = [...this.entries, ...mine];
    this.save();
    return mine.length;
  }

  /**
   * What reception sees at a glance: how many, the average to one decimal, and how the ratings
   * split. The split is counted here rather than from the listed entries because the list is
   * capped (100 by default) while this covers everything -- a distribution worked out from the
   * list would quietly stop adding up the day the restaurant passes a hundred.
   */
  summary(restaurantId) {
    const mine = this.entries.filter(e => e.restaurant_id === restaurantId);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const e of mine) if (distribution[e.rating] !== undefined) distribution[e.rating] += 1;
    if (mine.length === 0) return { count: 0, average: null, distribution };
    const total = mine.reduce((sum, e) => sum + e.rating, 0);
    return { count: mine.length, average: Math.round((total / mine.length) * 10) / 10, distribution };
  }
}

export const feedbackStore = new FeedbackStore();
