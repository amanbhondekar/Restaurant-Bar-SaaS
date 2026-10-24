import crypto from 'crypto';

// The hub's side of the public booking page (§4.6): the page's address, and the guests' requests that wait in the cloud for this restaurant.
//
// The hub reaches the cloud only as its own restaurant (the `kitchen` identity), so row-level security is what keeps it to its own rows;
// every query here also names the restaurant, so that is not the only thing standing in the way. `client` is a supabase-js client, a
// parameter so tests can hand in a stand-in.
//
// Every failure is an ANSWER (`{ ok: false, code, error }`) in plain words. The database's own message goes to the log and never to the
// screen: it can name hosts and policies a restaurant owner has no use for.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 12;
const TRIES = 5;

/** A code for a page's address: random, lower-case letters and digits, drawn without bias (`random(n)` is a whole number below n). */
export function newBookingCode(random = crypto.randomInt) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[random(ALPHABET.length)];
  return code;
}

const CLOUD_FAILED = { ok: false, code: 'CLOUD', error: 'The hub could not reach the cloud. Check the internet connection and try again.' };
function cloudFailure(what, error) {
  console.warn(`⚠️ Booking page: could not ${what}:`, error?.message || error);
  return CLOUD_FAILED;
}

const pageOf = row => (row ? { code: row.code, enabled: row.enabled === true } : null);

/** The restaurant's booking page, or null when it has never switched one on. */
export async function readPage(client, restaurantId) {
  const found = await client.from('booking_pages').select('code, enabled').eq('restaurant_id', restaurantId).maybeSingle();
  if (found.error) return cloudFailure('read the page', found.error);
  return { ok: true, page: pageOf(found.data) };
}

/**
 * Switch the page on. The first time this makes it, with a new address; after that it is the same page at the same address (a card
 * printed with the address on it must keep working through a switch off and on), and doing it twice does nothing.
 */
export async function enablePage(client, restaurantId, { random } = {}) {
  const read = await readPage(client, restaurantId);
  if (!read.ok) return read;
  if (read.page) {
    if (read.page.enabled) return read;
    const switched = await client.from('booking_pages').update({ enabled: true }).eq('restaurant_id', restaurantId);
    if (switched.error) return cloudFailure('switch the page on', switched.error);
    return { ok: true, page: { ...read.page, enabled: true } };
  }

  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const code = newBookingCode(random);
    // `enabled` said outright: a page that was just switched on is on, whatever the column's default is.
    const made = await client.from('booking_pages').insert({ restaurant_id: restaurantId, code, enabled: true });
    if (!made.error) return { ok: true, page: { code, enabled: true } };
    // A taken code (or a page another run of this hub made a moment ago): look again, and otherwise draw another code.
    if (made.error.code !== '23505') return cloudFailure('make the page', made.error);
    const again = await readPage(client, restaurantId);
    if (!again.ok || again.page) return again;
  }
  return cloudFailure('find a free address for the page', { message: 'every code drawn was taken' });
}

/** Switch the page off. Its address is kept. A restaurant that never had one has nothing to switch off. */
export async function disablePage(client, restaurantId) {
  const read = await readPage(client, restaurantId);
  if (!read.page || !read.page.enabled) return read;   // a failed read has no page, so it is answered as it is
  const switched = await client.from('booking_pages').update({ enabled: false }).eq('restaurant_id', restaurantId);
  if (switched.error) return cloudFailure('switch the page off', switched.error);
  return { ok: true, page: { ...read.page, enabled: false } };
}

/** Give the page a new address, for when the old one has gone where it should not. Whether the page is on or off is left as it was. */
export async function newAddress(client, restaurantId, { random } = {}) {
  const read = await readPage(client, restaurantId);
  if (!read.ok) return read;
  if (!read.page) return { ok: false, code: 'NO_PAGE', error: 'There is no booking page yet, so there is no address to change.' };
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const code = newBookingCode(random);
    const changed = await client.from('booking_pages').update({ code }).eq('restaurant_id', restaurantId);
    if (!changed.error) return { ok: true, page: { code, enabled: read.page.enabled } };
    if (changed.error.code !== '23505') return cloudFailure('change the address', changed.error);
  }
  return cloudFailure('find a free address for the page', { message: 'every code drawn was taken' });
}

/**
 * Collect what guests have asked for. New requests are added to the diary's list; requests staff have answered (and ones the hub cannot
 * use, and ones whose time has gone) are cleared from the cloud, by id. Nothing is cleared before a person has answered it, so a hub
 * that is lost between collecting and answering loses nothing: the replacement collects the same inbox.
 *
 * Safe to repeat, which matters: the hub can be off for days and the cloud can fail halfway. A request is recognised by the cloud's own
 * id, so reading the same inbox again adds nothing, and one the clearing failed for is not mistaken for a new one.
 */
export async function pullInbox(client, restaurantId, store, { now = new Date() } = {}) {
  const read = await client.from('booking_requests').select('*').eq('restaurant_id', restaurantId).order('created_at', { ascending: true }).limit(200);
  if (read.error) return cloudFailure('read the inbox', read.error);
  const rows = read.data || [];

  const received = store.receiveRequests(restaurantId, rows, { now });
  store.settleLapsed(restaurantId, { now });

  const answered = new Set(store.stateFor(restaurantId).requests.filter(r => r.status !== 'pending').map(r => r.cloud_id));
  const unusable = new Set(received.meta?.invalid ?? []);
  const clear = rows.map(r => String(r.id)).filter(cloudId => answered.has(cloudId) || unusable.has(cloudId));

  let cleared = 0;
  if (clear.length) {
    const removed = await client.from('booking_requests').delete().eq('restaurant_id', restaurantId).in('id', clear);
    if (removed.error) cloudFailure('clear answered requests', removed.error);   // tried again next time
    else cleared = clear.length;
  }

  store.pruneDecided(restaurantId, { now });
  return { ok: true, received: received.meta?.added.length ?? 0, cleared };
}
