import { upsertAll, deleteStale } from './catalogSync.js';

// The cloud copy of the booking diary (migration 011). Same arrangement as the menu, tables and
// stock: the hub is the single writer, each push is a full snapshot upserted on
// (restaurant_id, hub_ref), and rows the snapshot no longer holds are deleted.
//
// `client` is a supabase-js client; it is a parameter so tests can hand in a recording fake.

/** `at` on the hub is `booked_for` in the cloud: `at` is a reserved-ish word and reads as nothing. */
export function reservationRow(restaurantId, r) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(r.id),
    guest_name: r.guest_name,
    phone: r.phone ?? null,
    phone_key: r.phone_key ?? null,
    party_size: Number(r.party_size) || 1,
    booked_for: r.at,
    duration_mins: Number(r.duration_mins) || 90,
    status: r.status,
    overbooked: r.overbooked === true,
    note: r.note ?? null,
    created_at: r.created_at,
    seated_at: r.seated_at ?? null,
    cancelled_at: r.cancelled_at ?? null,
    no_show_at: r.no_show_at ?? null
  };
}

export function walkInRow(restaurantId, e) {
  return {
    restaurant_id: restaurantId,
    hub_ref: String(e.id),
    guest_name: e.guest_name,
    phone: e.phone ?? null,
    phone_key: e.phone_key ?? null,
    party_size: Number(e.party_size) || 1,
    quoted_wait_mins: e.quoted_wait_mins ?? null,
    status: e.status,
    created_at: e.created_at,
    notified_at: e.notified_at ?? null,
    seated_at: e.seated_at ?? null,
    left_at: e.left_at ?? null
  };
}

/** Pushes `{ reservations, waitlist }` for one restaurant. Throws the Supabase error on refusal. */
export async function pushReservations(client, restaurantId, snapshot) {
  const reservations = (snapshot.reservations || []).map(r => reservationRow(restaurantId, r));
  const walkins = (snapshot.waitlist || []).map(e => walkInRow(restaurantId, e));

  // Upserts before deletes, so an interrupted push never loses a booking.
  await upsertAll(client, 'reservations', reservations);
  await upsertAll(client, 'walkins', walkins);
  const removedReservations = await deleteStale(client, 'reservations', restaurantId, new Set(reservations.map(r => r.hub_ref)));
  const removedWalkins = await deleteStale(client, 'walkins', restaurantId, new Set(walkins.map(r => r.hub_ref)));
  return { reservations: reservations.length, walkins: walkins.length, removed: removedReservations + removedWalkins };
}

const check = ({ data, error }) => {
  if (error) throw error;
  return data || [];
};

/** Reads the diary back in the hub's own shapes, for a replacement laptop that starts with nothing. */
export async function pullReservations(client, restaurantId) {
  const reservationRows = check(await client.from('reservations').select('*').eq('restaurant_id', restaurantId));
  const walkinRows = check(await client.from('walkins').select('*').eq('restaurant_id', restaurantId));

  const back = (rows, map) => rows.filter(r => r.hub_ref).map(map);
  return {
    reservations: back(reservationRows, r => ({
      id: String(r.hub_ref),
      guest_name: r.guest_name,
      ...(r.phone ? { phone: r.phone } : {}),
      ...(r.phone_key ? { phone_key: r.phone_key } : {}),
      party_size: Number(r.party_size) || 1,
      at: r.booked_for,
      duration_mins: Number(r.duration_mins) || 90,
      status: r.status,
      ...(r.overbooked ? { overbooked: true } : {}),
      ...(r.note ? { note: r.note } : {}),
      created_at: r.created_at,
      ...(r.seated_at ? { seated_at: r.seated_at } : {}),
      ...(r.cancelled_at ? { cancelled_at: r.cancelled_at } : {}),
      ...(r.no_show_at ? { no_show_at: r.no_show_at } : {})
    })),
    waitlist: back(walkinRows, e => ({
      id: String(e.hub_ref),
      guest_name: e.guest_name,
      ...(e.phone ? { phone: e.phone } : {}),
      ...(e.phone_key ? { phone_key: e.phone_key } : {}),
      party_size: Number(e.party_size) || 1,
      ...(e.quoted_wait_mins === null || e.quoted_wait_mins === undefined ? {} : { quoted_wait_mins: Number(e.quoted_wait_mins) }),
      status: e.status,
      created_at: e.created_at,
      ...(e.notified_at ? { notified_at: e.notified_at } : {}),
      ...(e.seated_at ? { seated_at: e.seated_at } : {}),
      ...(e.left_at ? { left_at: e.left_at } : {})
    }))
  };
}
