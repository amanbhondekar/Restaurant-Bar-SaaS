import crypto from 'crypto';

import { guestContact, normalizePhone } from './guestContact.js';
import { normalizeRewardScheme, rewardDue } from './loyalty.js';

// Reservations and the walk-in waitlist (§4.6). Pure rules: every function takes the current state
// and returns `{ ok: true, data, meta? }` or `{ ok: false, status, code, error }`, the same shape the
// menu and inventory stores use. Nothing here touches disk or the clock -- callers pass `now`.
//
// The two are deliberately one module and two lists. A booking is a promise about a FUTURE time and
// can be double-sold; a walk-in is a queue for right now and cannot. They meet at the same guest, and
// at the same tables, which is why the capacity rule has to know about both.

export const RESERVATION_STATUSES = ['booked', 'seated', 'no_show', 'cancelled'];
export const WAITLIST_STATUSES = ['waiting', 'notified', 'seated', 'left'];

export const DEFAULT_DURATION_MINS = 90;
/** How far ahead a reminder is due: a booking in the next day. Wider is the host's choice, capped at two weeks. */
export const REMINDER_WINDOW_HOURS = 24;
const MAX_REMINDER_WINDOW_HOURS = 24 * 14;

export const LIMITS = { name: 80, note: 200, party: 40, aheadDays: 180, durationMins: 480 };

const MIN = 60 * 1000;
const id = prefix => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

const fail = (status, code, error) => ({ ok: false, status, code, error });
const bump = (state, patch) => ({ ...state, ...patch, revision: (state.revision || 0) + 1 });

export function emptyState(restaurantId = null) {
  return { restaurant_id: restaurantId, revision: 0, reservations: [], waitlist: [] };
}

/** A state read from disk made safe to use: every list present, nothing else trusted. */
export function normalizeState(raw, restaurantId = null) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = (rows, statuses) => (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object' && r.id && String(r.guest_name ?? '').trim() && statuses.includes(r.status))
    .map(r => ({ ...r, id: String(r.id), party_size: Math.max(1, Math.floor(Number(r.party_size)) || 1) }));
  return {
    restaurant_id: s.restaurant_id ?? restaurantId,
    revision: Number.isInteger(s.revision) && s.revision >= 0 ? s.revision : 0,
    reservations: list(s.reservations, RESERVATION_STATUSES),
    waitlist: list(s.waitlist, WAITLIST_STATUSES)
  };
}

// --- what a booking has to be ------------------------------------------------------------------

function validateBooking(input, now) {
  const errors = [];
  const out = {};

  const name = typeof input?.guest_name === 'string' ? input.guest_name.trim() : '';
  if (!name) errors.push({ field: 'guest_name', message: 'Whose booking is it?' });
  else if (name.length > LIMITS.name) errors.push({ field: 'guest_name', message: `At most ${LIMITS.name} characters.` });
  else out.guest_name = name;

  // A phone number is required for a booking and not for a walk-in, because a walk-in is standing in
  // front of you and a booking is a promise you may need to chase.
  const phone = normalizePhone(input?.phone);
  if (!phone) errors.push({ field: 'phone', message: 'A phone number is needed to confirm or chase a booking.' });

  const party = Math.floor(Number(input?.party_size));
  if (!Number.isFinite(party) || party < 1 || party > LIMITS.party) {
    errors.push({ field: 'party_size', message: `How many people? Between 1 and ${LIMITS.party}.` });
  } else out.party_size = party;

  const at = Date.parse(input?.at);
  if (!Number.isFinite(at)) errors.push({ field: 'at', message: 'When is the booking for?' });
  else if (at < now.getTime() - 5 * MIN) errors.push({ field: 'at', message: 'That time has already passed.' });
  else if (at > now.getTime() + LIMITS.aheadDays * 24 * 60 * MIN) errors.push({ field: 'at', message: `Bookings can be made up to ${LIMITS.aheadDays} days ahead.` });
  else out.at = new Date(at).toISOString();

  const duration = input?.duration_mins === undefined ? DEFAULT_DURATION_MINS : Math.floor(Number(input.duration_mins));
  if (!Number.isFinite(duration) || duration < 15 || duration > LIMITS.durationMins) {
    errors.push({ field: 'duration_mins', message: `How long should the table be held? Between 15 and ${LIMITS.durationMins} minutes.` });
  } else out.duration_mins = duration;

  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (note.length > LIMITS.note) errors.push({ field: 'note', message: `At most ${LIMITS.note} characters.` });
  else if (note) out.note = note;

  return errors.length ? { ok: false, errors } : { ok: true, booking: out, phone };
}

const endOf = r => Date.parse(r.at) + (Number(r.duration_mins) || DEFAULT_DURATION_MINS) * MIN;

/** Does this booking's table-time overlap that one's? Touching at the edges does not count. */
const overlaps = (a, b) => Date.parse(a.at) < endOf(b) && Date.parse(b.at) < endOf(a);

/** Bookings that still hold a table: cancelled and no-show ones have given theirs back. */
const holdsATable = r => r.status === 'booked' || r.status === 'seated';

/**
 * Whether the restaurant can take one more party at this time, and on which tables.
 *
 * The rule, in one sentence: a party needs a table at least its own size, and competes for those
 * tables with every overlapping booking for a party at least as big.
 *
 * Smaller parties are assumed to take smaller tables, which is what a restaurant actually does. So
 * six people compete with other fives and sixes for the six-tops, and a couple booked at the same
 * time does not block them. It is an assumption, not a guarantee -- which is why `force` exists.
 *
 * Tables are deliberately NOT assigned at booking time: a restaurant shuffles tables on the night
 * and would resent being told which one to use. What is checked is that a table COULD be found,
 * which is the promise being made. Walk-ins already sitting down are counted too, because a floor
 * full of walk-ins is exactly when an accepted booking turns into an apology.
 */
export function availability(state, { at, duration_mins = DEFAULT_DURATION_MINS, party_size = 1, tables = [], excludeId = null, seatedWalkIns = 0 }) {
  const fits = (tables || []).filter(t => (Number(t.capacity) || 0) >= party_size);
  if (fits.length === 0) return { ok: false, code: 'NO_TABLE_THAT_SIZE', fitting: 0, taken: 0, free: 0 };

  const candidate = { at, duration_mins };
  const taken = (state.reservations || []).filter(r =>
    r.id !== excludeId &&
    holdsATable(r) &&
    (Number(r.party_size) || 1) >= party_size &&
    overlaps(candidate, r)
  ).length;

  const free = fits.length - taken - Math.max(0, seatedWalkIns);
  return { ok: free > 0, code: free > 0 ? null : 'FULLY_BOOKED', fitting: fits.length, taken, free: Math.max(0, free) };
}

/**
 * Take a booking. `tables` is the restaurant's layout; `seatedWalkIns` how many tables walk-ins are
 * sitting at right now, so a full floor is not double-sold.
 *
 * `force` takes it anyway, because a restaurant that knows it can squeeze one more in should not be
 * argued with by its own till -- but it has to say so, and the booking records that it was.
 */
export function book(state, input, { now = new Date(), tables = [], seatedWalkIns = 0, force = false } = {}) {
  const checked = validateBooking(input, now);
  if (!checked.ok) return { ...fail(400, 'INVALID_BOOKING', checked.errors[0].message), errors: checked.errors };

  const free = availability(state, { ...checked.booking, tables, seatedWalkIns });
  if (!free.ok && !force) {
    return {
      ...fail(409, free.code, free.code === 'NO_TABLE_THAT_SIZE'
        ? `No table here seats ${checked.booking.party_size}.`
        : 'Every table that size is already booked then.'),
      availability: free
    };
  }

  const contact = guestContact(checked.phone, state.restaurant_id);
  const reservation = {
    id: id('res'),
    ...checked.booking,
    ...contact,
    status: 'booked',
    ...(free.ok ? {} : { overbooked: true }),
    created_at: now.toISOString()
  };
  return { ok: true, data: bump(state, { reservations: [...state.reservations, reservation] }), meta: { reservation, availability: free } };
}

/** Move a booking along: seated, did not turn up, or called off. */
export function setReservationStatus(state, reservationId, status, { now = new Date() } = {}) {
  const found = state.reservations.find(r => r.id === reservationId);
  if (!found) return fail(404, 'NOT_FOUND', 'That booking is not in the book.');
  if (!RESERVATION_STATUSES.includes(status)) return fail(400, 'INVALID_STATUS', `A booking is ${RESERVATION_STATUSES.join(', ')}.`);
  if (found.status === status) return { ok: true, data: state, meta: { reservation: found } };
  if (found.status === 'seated' && status === 'no_show') {
    return fail(409, 'ALREADY_SEATED', `${found.guest_name} has already been seated.`);
  }

  const updated = { ...found, status, [`${status}_at`]: now.toISOString() };
  return {
    ok: true,
    data: bump(state, { reservations: state.reservations.map(r => (r.id === reservationId ? updated : r)) }),
    meta: { reservation: updated }
  };
}

// --- reminding a guest ----------------------------------------------------------------------------------------

/**
 * Bookings whose guest should be reminded now: still booked, with a number, not yet reminded, and starting within the
 * window but not already under way. Earliest first. A bad window falls back to the default rather than hiding the list.
 */
export function remindersDue(state, { now = new Date(), withinHours = REMINDER_WINDOW_HOURS } = {}) {
  const asked = Number(withinHours);
  const hours = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_REMINDER_WINDOW_HOURS) : REMINDER_WINDOW_HOURS;
  const from = now.getTime();
  const to = from + hours * 60 * MIN;
  return (state.reservations || [])
    .filter(r => r.status === 'booked' && r.phone && !r.reminded_at && Date.parse(r.at) > from && Date.parse(r.at) <= to)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Record that a member of staff sent this guest a reminder: when, and who. The hub sends nothing itself (staff tap a
 * WhatsApp link and send from their own phone), so this is a person's word that it went, not a delivery receipt. Marking
 * twice keeps the first time and changes nothing.
 */
export function markReminded(state, reservationId, { by, now = new Date() } = {}) {
  const found = state.reservations.find(r => r.id === reservationId);
  if (!found) return fail(404, 'NOT_FOUND', 'That booking is not in the book.');
  if (found.status !== 'booked') return fail(409, 'NOT_BOOKED', `${found.guest_name}'s booking is no longer booked, so there is nothing to remind them of.`);
  if (found.reminded_at) return { ok: true, data: state, meta: { reservation: found, already: true } };
  const who = typeof by === 'string' ? by.trim().slice(0, 60) : '';
  const updated = { ...found, reminded_at: now.toISOString(), ...(who ? { reminded_by: who } : {}) };
  return {
    ok: true,
    data: bump(state, { reservations: state.reservations.map(r => (r.id === reservationId ? updated : r)) }),
    meta: { reservation: updated }
  };
}

/** Take a reminder mark back (pressed by mistake): the booking is due again. */
export function unmarkReminded(state, reservationId) {
  const found = state.reservations.find(r => r.id === reservationId);
  if (!found) return fail(404, 'NOT_FOUND', 'That booking is not in the book.');
  if (!found.reminded_at && !found.reminded_by) return { ok: true, data: state, meta: { reservation: found } };
  const { reminded_at, reminded_by, ...rest } = found;
  return {
    ok: true,
    data: bump(state, { reservations: state.reservations.map(r => (r.id === reservationId ? rest : r)) }),
    meta: { reservation: rest }
  };
}

/** What staff send. Written here, with the other messages, so every screen says the same thing. */
export const reminderMessage = (reservation, restaurantName) =>
  `Hello ${reservation.guest_name}, a reminder from ${restaurantName}: your table for ${reservation.party_size} is booked for ${new Date(reservation.at).toLocaleString()}. Please reply if your plans change.`;

// --- the reward for coming back -------------------------------------------------------------------------------

/**
 * Record that a guest was given the reward their visit earned: when, the words that were promised and which visit it was, so
 * changing the scheme later does not rewrite what a guest was told. It only happens on a visit that earns it, while a scheme
 * is on: the host cannot hand it out at will. Giving it twice changes nothing.
 */
export function giveReward(state, reservationId, scheme, { now = new Date() } = {}) {
  const found = state.reservations.find(r => r.id === reservationId);
  if (!found) return fail(404, 'NOT_FOUND', 'That booking is not in the book.');
  if (!normalizeRewardScheme(scheme)) return fail(409, 'REWARDS_OFF', 'No reward is set up. Set one in the Rewards panel first.');
  if (found.reward_given_at) return { ok: true, data: state, meta: { reservation: found, already: true } };
  const earned = rewardDue(state, found, scheme);
  if (!earned) return fail(409, 'NOT_DUE', `This is not a visit that earns a reward for ${found.guest_name}.`);
  const updated = { ...found, reward_given_at: now.toISOString(), reward_given_text: earned.text, reward_visit: earned.visit_number };
  return {
    ok: true,
    data: bump(state, { reservations: state.reservations.map(r => (r.id === reservationId ? updated : r)) }),
    meta: { reservation: updated }
  };
}

/** Take it back (pressed by mistake): the visit is due the reward again. */
export function takeBackReward(state, reservationId) {
  const found = state.reservations.find(r => r.id === reservationId);
  if (!found) return fail(404, 'NOT_FOUND', 'That booking is not in the book.');
  if (!found.reward_given_at) return { ok: true, data: state, meta: { reservation: found } };
  const { reward_given_at, reward_given_text, reward_visit, ...rest } = found;
  return {
    ok: true,
    data: bump(state, { reservations: state.reservations.map(r => (r.id === reservationId ? rest : r)) }),
    meta: { reservation: rest }
  };
}

// --- the walk-in queue ---------------------------------------------------------------------------

function validateWalkIn(input) {
  const errors = [];
  const out = {};
  const name = typeof input?.guest_name === 'string' ? input.guest_name.trim() : '';
  if (!name) errors.push({ field: 'guest_name', message: 'Whose name shall we call?' });
  else if (name.length > LIMITS.name) errors.push({ field: 'guest_name', message: `At most ${LIMITS.name} characters.` });
  else out.guest_name = name;

  const party = Math.floor(Number(input?.party_size));
  if (!Number.isFinite(party) || party < 1 || party > LIMITS.party) {
    errors.push({ field: 'party_size', message: `How many people? Between 1 and ${LIMITS.party}.` });
  } else out.party_size = party;

  const quoted = input?.quoted_wait_mins === undefined || input.quoted_wait_mins === '' ? null : Math.floor(Number(input.quoted_wait_mins));
  if (quoted !== null && (!Number.isFinite(quoted) || quoted < 0 || quoted > 600)) {
    errors.push({ field: 'quoted_wait_mins', message: 'A wait is a number of minutes, up to 600.' });
  } else if (quoted !== null) out.quoted_wait_mins = quoted;

  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (note.length > LIMITS.note) errors.push({ field: 'note', message: `At most ${LIMITS.note} characters.` });
  else if (note) out.note = note;

  return errors.length ? { ok: false, errors } : { ok: true, entry: out };
}

/**
 * Add a walk-in. A phone number is optional here: plenty of people wait in the doorway, and refusing
 * to queue someone who will not give a number would be a worse product than one that cannot text them.
 */
export function addWalkIn(state, input, { now = new Date() } = {}) {
  const checked = validateWalkIn(input);
  if (!checked.ok) return { ...fail(400, 'INVALID_WALK_IN', checked.errors[0].message), errors: checked.errors };

  const contact = guestContact(input?.phone, state.restaurant_id);
  const entry = { id: id('wl'), ...checked.entry, ...(contact || {}), status: 'waiting', created_at: now.toISOString() };
  return { ok: true, data: bump(state, { waitlist: [...state.waitlist, entry] }), meta: { entry } };
}

export function setWaitlistStatus(state, entryId, status, { now = new Date() } = {}) {
  const found = state.waitlist.find(e => e.id === entryId);
  if (!found) return fail(404, 'NOT_FOUND', 'That party is not in the queue.');
  if (!WAITLIST_STATUSES.includes(status)) return fail(400, 'INVALID_STATUS', `A party is ${WAITLIST_STATUSES.join(', ')}.`);
  if (found.status === status) return { ok: true, data: state, meta: { entry: found } };
  if (status === 'notified' && !found.phone) {
    return fail(409, 'NO_PHONE', `${found.guest_name} did not leave a number, so there is nobody to message.`);
  }

  const updated = { ...found, status, [`${status}_at`]: now.toISOString() };
  return {
    ok: true,
    data: bump(state, { waitlist: state.waitlist.map(e => (e.id === entryId ? updated : e)) }),
    meta: { entry: updated }
  };
}

// --- reading -------------------------------------------------------------------------------------

/** Bookings for one day, earliest first. `day` is an ISO date in the restaurant's own timezone. */
export function bookingsOn(state, day) {
  const start = new Date(`${day}T00:00:00`);
  if (!Number.isFinite(start.getTime())) return [];
  const end = new Date(start.getTime() + 24 * 60 * MIN);
  return (state.reservations || [])
    .filter(r => {
      const at = Date.parse(r.at);
      return at >= start.getTime() && at < end.getTime();
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Who is still in the queue, longest wait first. */
export const queue = state => (state.waitlist || [])
  .filter(e => e.status === 'waiting' || e.status === 'notified')
  .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

/** How many tables walk-ins are sitting at right now, which bookings have to be checked against. */
export const seatedWalkInCount = (state, { now = new Date(), withinMins = 120 } = {}) =>
  (state.waitlist || []).filter(e => e.status === 'seated' && e.seated_at && now.getTime() - Date.parse(e.seated_at) < withinMins * MIN).length;

/** Counts for the console's header. */
export function summarize(state, day, { now = new Date() } = {}) {
  const today = bookingsOn(state, day);
  return {
    booked: today.filter(r => r.status === 'booked').length,
    seated: today.filter(r => r.status === 'seated').length,
    no_show: today.filter(r => r.status === 'no_show').length,
    covers: today.filter(r => r.status === 'booked' || r.status === 'seated').reduce((n, r) => n + (Number(r.party_size) || 0), 0),
    waiting: queue(state).length,
    seated_walk_ins: seatedWalkInCount(state, { now })
  };
}
