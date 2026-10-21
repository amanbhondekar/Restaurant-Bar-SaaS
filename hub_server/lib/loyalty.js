import { phoneKey } from './guestContact.js';

// Recognising a guest who has been here before (§4.5).
//
// The identifier is the phone number, because it is the one thing already collected for a booking or
// a place in the queue -- a guest carries nothing new, and staff ask for nothing new. It is matched
// on `phone_key`, a hash salted with the restaurant's own id, so this never reads a number back and
// one tenant's guest list cannot be joined against another's.
//
// What this is NOT. There is no reward scheme here: no points, no tiers, no discounts. Those are a
// commercial decision nobody has made, and inventing one would be the wrong kind of guess. What it
// does is answer the question a host actually asks -- "have we seen them before?" -- which is the
// part that cannot be added later without the history, and the part that makes a guest feel known.
//
// Visits are counted from what already happens: a booking that was SEATED, and a walk-in that was
// SEATED. A booking nobody turned up to is not a visit, and neither is a party that gave up waiting.

/** A visit is someone who actually sat down. */
const SEATED_AT = { reservations: 'seated_at', waitlist: 'seated_at' };

// Array.isArray rather than a default: a damaged file can hold a string where a list should be, and
// a default only covers undefined.
const visitsFrom = (rows, kind) => (Array.isArray(rows) ? rows : [])
  .filter(r => r.status === 'seated' && r.phone_key)
  .map(r => ({
    kind,
    phone_key: r.phone_key,
    guest_name: r.guest_name,
    phone: r.phone ?? null,
    party_size: Number(r.party_size) || 1,
    at: r[SEATED_AT[kind]] ?? r.created_at ?? null
  }))
  .filter(v => v.at);

/**
 * Everyone the restaurant has seen, newest visit first.
 *
 * Built from the booking diary rather than stored separately, so there is one source of truth and
 * nothing to keep in step. A guest's name is taken from their MOST RECENT visit: people correct a
 * misspelling or give a fuller name the second time, and the newest is the best guess at what they
 * would like to be called.
 */
export function guestsFrom(state, { now = new Date() } = {}) {
  const visits = [
    ...visitsFrom(state?.reservations, 'reservations'),
    ...visitsFrom(state?.waitlist, 'waitlist')
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const byGuest = new Map();
  for (const visit of visits) {
    const found = byGuest.get(visit.phone_key);
    if (!found) {
      byGuest.set(visit.phone_key, {
        phone_key: visit.phone_key,
        guest_name: visit.guest_name,
        phone: visit.phone,
        visits: 1,
        first_visit: visit.at,
        last_visit: visit.at,
        covers: visit.party_size
      });
      continue;
    }
    found.visits += 1;
    found.covers += visit.party_size;
    // Sorted newest first, so anything after the first is older.
    found.first_visit = visit.at;
  }

  return [...byGuest.values()]
    .map(g => ({ ...g, days_since: daysBetween(g.last_visit, now) }))
    .sort((a, b) => Date.parse(b.last_visit) - Date.parse(a.last_visit));
}

const daysBetween = (iso, now) => {
  const then = Date.parse(iso);
  return Number.isFinite(then) ? Math.max(0, Math.floor((now.getTime() - then) / (24 * 60 * 60 * 1000))) : null;
};

/** What is known about one guest, by their number. Null when they have never sat down here. */
export function guestByPhone(state, phone, restaurantId, { now = new Date() } = {}) {
  const key = phoneKey(typeof phone === 'string' && /^\d+$/.test(phone) ? phone : null, restaurantId);
  if (!key) return null;
  return guestsFrom(state, { now }).find(g => g.phone_key === key) ?? null;
}

/**
 * What a host should be told when this guest's name comes up, or null when there is nothing worth
 * saying.
 *
 * Deliberately quiet about a first visit: "1 visit" on every new booking is noise, and noise on a
 * screen is how the useful line gets ignored. It only speaks when someone has been here before.
 */
export function recognise(guest) {
  if (!guest || guest.visits < 2) return null;
  const when = guest.days_since === null ? null
    : guest.days_since === 0 ? 'earlier today'
      : guest.days_since === 1 ? 'yesterday'
        : guest.days_since < 14 ? `${guest.days_since} days ago`
          : guest.days_since < 60 ? `${Math.round(guest.days_since / 7)} weeks ago`
            : `${Math.round(guest.days_since / 30)} months ago`;
  return {
    visits: guest.visits,
    line: `${guest.visits}${nth(guest.visits)} visit${when ? `, last ${when}` : ''}`
  };
}

const nth = n => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
};

/** The regulars, for reception: most visits first, then most recent. */
export function regulars(state, { now = new Date(), limit = 50, minVisits = 2 } = {}) {
  return guestsFrom(state, { now })
    .filter(g => g.visits >= minVisits)
    .sort((a, b) => b.visits - a.visits || Date.parse(b.last_visit) - Date.parse(a.last_visit))
    .slice(0, Math.max(1, Math.min(500, limit)));
}
