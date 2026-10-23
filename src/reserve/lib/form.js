// What a guest has to fill in to ask a restaurant for a table (§4.6), and how it is sent. Without React, so each rule is tested on its own.
//
// These mirror the rules the operator service enforces, and exist only so a guest hears what is wrong before sending rather than after. The
// service is the authority: it checks everything again and its words are shown too.

export const NAME_MAX = 80;
export const NOTE_MAX = 200;

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const pad = n => String(n).padStart(2, '0');

/** A moment in the form a datetime-local field uses: the guest's own clock, to the minute. */
export const inputValue = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** The page's code from its address, which is `/book/<code>`: or null, when this is not one. */
export function codeFromPath(pathname) {
  const found = /^\/book\/([a-z0-9]{10,32})\/?$/.exec(String(pathname ?? ''));
  return found ? found[1] : null;
}

/** "30 minutes", "1 hour", "2 hours": the notice the restaurant needs, in words. */
const notice = mins => (mins % 60 === 0 ? (mins === 60 ? '1 hour' : `${mins / 60} hours`) : `${mins} minutes`);

/** The request as the guest filled it in, checked. `errors` is by field, each a sentence for a guest. */
export function checkRequest(form, limits, now = new Date()) {
  const errors = {};

  const name = String(form.guest_name ?? '').trim();
  if (!name) errors.guest_name = 'Please tell us your name.';
  else if (name.length > NAME_MAX) errors.guest_name = `Please use at most ${NAME_MAX} characters for your name.`;

  // Ten digits at the least, however they are written: spaces, dashes, a + and brackets are how people write them.
  if (!/^\d{10,15}$/.test(String(form.phone ?? '').replace(/[\s().+-]/g, ''))) errors.phone = 'Please give a phone number the restaurant can reach you on.';

  const party = String(form.party_size ?? '').trim() === '' ? NaN : Number(form.party_size);
  if (!Number.isInteger(party) || party < 1 || party > limits.max_party) errors.party_size = `Please choose between 1 and ${limits.max_party} people.`;

  const at = form.at ? Date.parse(form.at) : NaN;
  if (!Number.isFinite(at)) errors.at = 'Please choose a day and time.';
  else if (at < now.getTime() + limits.min_notice_mins * MIN) errors.at = `Please choose a time at least ${notice(limits.min_notice_mins)} from now. To book sooner, phone the restaurant.`;
  else if (at > now.getTime() + limits.max_ahead_days * DAY) errors.at = `Requests can be made up to ${limits.max_ahead_days} days ahead.`;

  if (String(form.note ?? '').trim().length > NOTE_MAX) errors.note = `Please keep the note to ${NOTE_MAX} characters.`;

  return { ok: Object.keys(errors).length === 0, errors };
}

/** What is sent: the time as the moment it names, the words trimmed, and no note at all when there is none. `trap` is the field no person sees. */
export function requestBody(form, trap = '') {
  const note = String(form.note ?? '').trim();
  return {
    guest_name: String(form.guest_name).trim(),
    phone: String(form.phone).trim(),
    party_size: Number(form.party_size),
    at: new Date(form.at).toISOString(),
    ...(note ? { note } : {}),
    website: trap
  };
}
