import { normalizePhone } from '../../hub_server/lib/guestContact.js';

// What a stranger may ask of a restaurant through the public booking page (§4.6), and how often. Pure, so each rule is tested on its own.
//
// The page can only make a REQUEST. The restaurant's hub owns the diary and checks every booking against the real table layout, so
// nothing here promises a table; these rules decide only what is worth passing on, and how much of it one caller may pass.

export const BOOKING_LIMITS = {
  name: 80,
  note: 200,
  /** Bigger than this is a phone call: a restaurant is not going to find 21 seats from a form. */
  maxParty: 20,
  /** Time for the restaurant to see it. Sooner than this, the guest phones. */
  minNoticeMins: 30,
  maxAheadDays: 60,
  /** Requests waiting in one restaurant's inbox. A full inbox says so rather than taking more. */
  pendingCap: 50,
  /** A request is cleared out this long after the time it was for. */
  lapsedAfterMs: 24 * 60 * 60 * 1000,
  // Per caller. `attempts` counts everything, mistakes included, so a flood of bad requests is stopped too; `max` counts only the
  // requests that were good enough to keep, so a guest who mistypes a few times is not locked out of asking.
  perIp: { max: 5, windowMs: 10 * 60 * 1000, attempts: { max: 30, windowMs: 10 * 60 * 1000 } },
  perPhone: { max: 3, windowMs: 60 * 60 * 1000 }
};

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
// A line break or a tab in a name is not a name, and a number or note carrying one would break the message staff send.
const CONTROL = /[\u0000-\u001f\u007f]/;
// To replace every one. A global pattern remembers its place between calls to `test`, so `CONTROL` is the one to test with.
const CONTROLS = /[\u0000-\u001f\u007f]/g;

/**
 * A guest's request, checked. Returns `{ ok: true, request }` with exactly the columns that are stored (nothing the guest added),
 * or `{ ok: false, errors }` naming every field at fault, in the order of the form, so a guest fixes it in one go.
 * `at` is the form's name for the time and `requested_for` the column's.
 */
export function validateGuestRequest(body, { now = new Date(), limits = BOOKING_LIMITS } = {}) {
  const input = body || {};   // anything else that arrives has none of these fields, and is refused field by field
  const errors = [];
  const request = {};

  const name = typeof input.guest_name === 'string' ? input.guest_name.trim() : '';
  if (!name) errors.push({ field: 'guest_name', message: 'Please tell us your name.' });
  else if (name.length > limits.name) errors.push({ field: 'guest_name', message: `Please use at most ${limits.name} characters for your name.` });
  else if (CONTROL.test(name)) errors.push({ field: 'guest_name', message: 'Please use letters and numbers only in your name.' });
  else request.guest_name = name;

  const phone = normalizePhone(input.phone);
  if (!phone) errors.push({ field: 'phone', message: 'Please give a phone number the restaurant can reach you on.' });
  else request.phone = phone;

  // A form sends text. A blank one becomes 0, which the range below refuses.
  const party = typeof input.party_size === 'string' ? Number(input.party_size) : input.party_size;
  if (!Number.isInteger(party) || party < 1 || party > limits.maxParty) {
    errors.push({ field: 'party_size', message: `Please choose between 1 and ${limits.maxParty} people. For a bigger party, phone the restaurant.` });
  } else request.party_size = party;

  const at = typeof input.at === 'string' ? Date.parse(input.at) : NaN;
  if (!Number.isFinite(at)) errors.push({ field: 'at', message: 'Please choose a day and time.' });
  else if (at < now.getTime() + limits.minNoticeMins * MIN) errors.push({ field: 'at', message: `Please choose a time at least ${limits.minNoticeMins} minutes from now. To book sooner, phone the restaurant.` });
  else if (at > now.getTime() + limits.maxAheadDays * DAY) errors.push({ field: 'at', message: `Requests can be made up to ${limits.maxAheadDays} days ahead.` });
  else request.requested_for = new Date(at).toISOString();

  const note = typeof input.note === 'string' ? input.note.replace(CONTROLS, ' ').trim() : '';
  if (note.length > limits.note) errors.push({ field: 'note', message: `Please keep the note to ${limits.note} characters.` });
  else if (note) request.note = note;

  return errors.length ? { ok: false, errors } : { ok: true, request };
}

/**
 * A count of how often a key has done something within a window, kept in memory (losing it on a restart costs a few early retries).
 * `hit` records one and says whether it was allowed; a refused one is not recorded, so being refused never extends the wait.
 * Bounded: a caller who keeps changing the key cannot make it grow for ever, the oldest keys are dropped first.
 */
export function createLimiter({ max, windowMs, now = Date.now, maxKeys = 20000 }) {
  const seen = new Map();
  return {
    hit(key) {
      const t = now();
      const recent = (seen.get(key) || []).filter(at => at > t - windowMs);
      seen.delete(key);
      if (recent.length >= max) {
        seen.set(key, recent);
        return false;
      }
      recent.push(t);
      seen.set(key, recent);
      while (seen.size > maxKeys) seen.delete(seen.keys().next().value);
      return true;
    },
    size: () => seen.size
  };
}
