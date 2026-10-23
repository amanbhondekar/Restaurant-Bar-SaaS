// Wording and checks for the Bookings tab. Pure functions. The hub re-checks everything; these exist
// so reception hears about a mistake beside the field rather than after a round trip.

export const RESERVATION_TONE = { booked: 'amber', seated: 'green', no_show: 'rust', cancelled: 'muted' };
export const RESERVATION_LABEL = { booked: 'Booked', seated: 'Seated', no_show: 'No show', cancelled: 'Cancelled' };
export const WAITLIST_TONE = { waiting: 'amber', notified: 'green', seated: 'muted', left: 'muted' };
export const WAITLIST_LABEL = { waiting: 'Waiting', notified: 'Messaged', seated: 'Seated', left: 'Left' };

/** "7:30 pm" — a booking time as it is said out loud. */
export function bookingTime(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

/** Today in the restaurant's own timezone, which is the day a diary is kept in. */
export function today(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The day `offset` days from `day`, so the console can step through the diary. */
export function shiftDay(day, offset) {
  const d = new Date(`${day}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return day;
  d.setDate(d.getDate() + offset);
  return today(d);
}

/** "Fri 23 Oct", or "Today" — reception reads the date far more often than it types one. */
export function dayLabel(day, now = new Date()) {
  if (day === today(now)) return 'Today';
  if (day === shiftDay(today(now), 1)) return 'Tomorrow';
  const d = new Date(`${day}T12:00:00`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : day;
}

/** How long someone has been queueing, which is the number staff are judged on. */
export function waitedMins(entry, now = new Date()) {
  const since = Date.parse(entry?.created_at);
  return Number.isFinite(since) ? Math.max(0, Math.floor((now.getTime() - since) / 60000)) : null;
}

export function formatWait(mins) {
  if (mins === null || mins === undefined) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
}

/**
 * Whether a party has been waiting longer than they were told.
 *
 * The one thing on this screen worth a colour: a quoted wait that has run out is the moment a guest
 * starts to feel lied to, and it is invisible unless something says so.
 */
export function overdue(entry, now = new Date()) {
  const quoted = Number(entry?.quoted_wait_mins);
  if (!Number.isFinite(quoted) || quoted <= 0) return false;
  if (entry?.status !== 'waiting') return false;
  return (waitedMins(entry, now) ?? 0) > quoted;
}

const PARTY_MAX = 40;

/** Check a booking the way the hub does, so the two never disagree about what is acceptable. */
export function checkBooking(form, { now = new Date() } = {}) {
  const errors = {};
  const name = String(form?.guest_name ?? '').trim();
  if (!name) errors.guest_name = 'Whose booking is it?';
  else if (name.length > 80) errors.guest_name = 'At most 80 characters.';

  const digits = String(form?.phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) errors.phone = 'A number is needed to confirm or chase a booking.';
  else if (digits.length < 10) errors.phone = 'That does not look like a whole number.';

  const party = Math.floor(Number(form?.party_size));
  if (!Number.isFinite(party) || party < 1 || party > PARTY_MAX) errors.party_size = `Between 1 and ${PARTY_MAX} people.`;

  const at = Date.parse(form?.at);
  if (!Number.isFinite(at)) errors.at = 'When is it for?';
  else if (at < now.getTime() - 5 * 60000) errors.at = 'That time has already passed.';

  return { ok: Object.keys(errors).length === 0, errors };
}

/** Check a walk-in. A number is optional: people wait in the doorway without leaving one. */
export function checkWalkIn(form) {
  const errors = {};
  const name = String(form?.guest_name ?? '').trim();
  if (!name) errors.guest_name = 'Whose name shall we call?';

  const party = Math.floor(Number(form?.party_size));
  if (!Number.isFinite(party) || party < 1 || party > PARTY_MAX) errors.party_size = `Between 1 and ${PARTY_MAX} people.`;

  const quoted = String(form?.quoted_wait_mins ?? '').trim();
  if (quoted && !/^\d{1,3}$/.test(quoted)) errors.quoted_wait_mins = 'A number of minutes.';

  const phone = String(form?.phone ?? '').replace(/\D/g, '');
  if (phone && phone.replace(/^0+/, '').length < 10) errors.phone = 'That does not look like a whole number.';

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * What the time field starts at: dinner service on the day being looked at, unless that has already
 * gone by -- in which case the next half hour, because a form that opens on a time it then refuses
 * is a form that cannot be submitted at all.
 *
 * Returned in the shape `datetime-local` wants, which is local time with no zone.
 */
export function defaultBookingTime(day, now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const asField = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const dinner = new Date(`${day}T19:00`);
  if (Number.isFinite(dinner.getTime()) && dinner.getTime() > now.getTime()) return asField(dinner);

  const next = new Date(now.getTime());
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + (30 - (next.getMinutes() % 30)));
  return asField(next);
}

/** The header line: "6 booked · 14 covers · 2 waiting". */
export function bookingsSummary(summary) {
  if (!summary) return '';
  const parts = [];
  if (summary.booked) parts.push(`${summary.booked} booked`);
  if (summary.seated) parts.push(`${summary.seated} seated`);
  if (summary.covers) parts.push(`${summary.covers} ${summary.covers === 1 ? 'cover' : 'covers'}`);
  if (summary.no_show) parts.push(`${summary.no_show} no-show${summary.no_show === 1 ? '' : 's'}`);
  if (summary.waiting) parts.push(`${summary.waiting} waiting`);
  return parts.length ? parts.join(' · ') : 'Nothing booked yet.';
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st: how a visit is said out loud. */
export function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

/** The reward rule form: a whole number of visits from 2 to 50, and some words that fit on a diary row. */
export function checkReward(form, { max_visits: maxVisits = 50, max_text: maxText = 80 } = {}) {
  const errors = {};
  const raw = String(form?.every_n_visits ?? '').trim();
  if (!raw) errors.every_n_visits = 'How many visits between rewards?';
  else if (!/^\d+$/.test(raw)) errors.every_n_visits = 'A whole number of visits.';
  else if (Number(raw) < 2 || Number(raw) > maxVisits) errors.every_n_visits = `From 2 to ${maxVisits} visits.`;
  const text = String(form?.text ?? '').trim();
  if (!text) errors.text = 'What does the guest get?';
  else if (text.length > maxText) errors.text = `At most ${maxText} characters.`;
  return { ok: Object.keys(errors).length === 0, errors };
}
