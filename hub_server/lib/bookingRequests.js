import crypto from 'crypto';

import { guestContact } from './guestContact.js';
import { book, LIMITS, REQUEST_STATUSES } from './reservations.js';

// A guest's request for a table, once the hub has collected it from the cloud (§4.6). Pure rules over the diary's state, in the shape the
// rest of lib/reservations.js uses: every function takes the state and returns `{ ok: true, data, meta }` or `{ ok: false, status, code,
// error }`, and nothing here touches the disk, the network or the clock.
//
// A request is a QUESTION. The hub owns the diary and checks every booking against the real table layout, so a request books nothing by
// itself: accepting it books the table through exactly the check any booking goes through (and the usual way of overbooking on purpose),
// and declining it books nothing. Either way a person decided, and a person tells the guest, from their own phone, as with every message
// this product writes.

export { REQUEST_STATUSES, normalizeRequests } from './reservations.js';

const HOUR = 60 * 60 * 1000;
/** A request is let go this long after the time it was for, which is when the operator service clears it from the cloud too. */
const LAPSE_AFTER_MS = 24 * HOUR;
/** A decided request is remembered this long, so a cloud copy that could not be cleared at once is not mistaken for a new one. */
const REMEMBER_DECIDED_MS = 7 * 24 * HOUR;

const fail = (status, code, error) => ({ ok: false, status, code, error });
const bump = (state, patch) => ({ ...state, ...patch, revision: (state.revision || 0) + 1 });
const id = () => `rq_${crypto.randomBytes(5).toString('hex')}`;

const requestsOf = state => (Array.isArray(state?.requests) ? state.requests : []);

/**
 * A row from the cloud's inbox as a request, or null if it is not one the hub can use (no name, a number that cannot be one, a party
 * the diary would refuse, a time that is not a time). Such a row is never kept, so it is named in `meta.invalid` to be cleared away.
 */
function toRequest(row, restaurantId, now) {
  const contact = guestContact(row?.phone, restaurantId);
  const name = typeof row?.guest_name === 'string' ? row.guest_name.trim() : '';
  const party = Math.floor(Number(row?.party_size));
  const at = Date.parse(row?.requested_for);
  if (!contact || !name || name.length > LIMITS.name || !Number.isFinite(party) || party < 1 || party > LIMITS.party || !Number.isFinite(at)) return null;
  const note = typeof row.note === 'string' ? row.note.trim() : '';
  return {
    id: id(),
    cloud_id: String(row.id),
    guest_name: name,
    ...contact,
    party_size: party,
    at: new Date(at).toISOString(),
    ...(note ? { note } : {}),
    created_at: row.created_at ?? now.toISOString(),
    received_at: now.toISOString(),
    status: 'pending'
  };
}

/**
 * Take what the cloud's inbox holds. A request already known (by the cloud's own id, pending or decided) is left alone, so collecting the
 * same inbox twice, or a cloud copy that could not be cleared, changes nothing. `meta.added` is what is new, `meta.invalid` the cloud ids
 * of rows that cannot be used.
 */
export function receiveRequests(state, rows, { now = new Date() } = {}) {
  const known = new Set(requestsOf(state).map(r => r.cloud_id));
  const added = [];
  const invalid = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id || known.has(String(row.id))) continue;
    const request = toRequest(row, state.restaurant_id, now);
    if (request) { added.push(request); known.add(request.cloud_id); } else invalid.push(String(row.id));
  }
  if (!added.length) return { ok: true, data: state, meta: { added, invalid } };
  return { ok: true, data: bump(state, { requests: [...requestsOf(state), ...added] }), meta: { added, invalid } };
}

/** The requests waiting for an answer, soonest first. `past` says the time they asked for has gone, so there is nothing left to accept. */
export function pendingRequests(state, { now = new Date() } = {}) {
  return requestsOf(state)
    .filter(r => r.status === 'pending')
    .map(r => ({ ...r, past: Date.parse(r.at) < now.getTime() }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const find = (state, requestId) => requestsOf(state).find(r => r.id === requestId);
const replace = (state, updated) => requestsOf(state).map(r => (r.id === updated.id ? updated : r));

function pendingOrRefuse(state, requestId) {
  const found = find(state, requestId);
  if (!found) return { refusal: fail(404, 'NOT_FOUND', 'That request is not in the list.') };
  if (found.status !== 'pending') return { refusal: fail(409, 'NOT_PENDING', `${found.guest_name}'s request has already been ${found.status}.`) };
  return { found };
}

/**
 * Accept a request: book the table. The booking goes through the diary's own check, so a table that is not there is refused (409, with
 * what is free) unless the restaurant says it knows (`force`), and the booking then records that it was overbooked. The request stays
 * pending if the booking is refused, and is linked to the booking if it is made. The diary changes once.
 */
export function acceptRequest(state, requestId, { now = new Date(), tables = [], seatedWalkIns = 0, force = false } = {}) {
  const { found, refusal } = pendingOrRefuse(state, requestId);
  if (refusal) return refusal;

  const booked = book(state, { guest_name: found.guest_name, phone: found.phone, party_size: found.party_size, at: found.at, ...(found.note ? { note: found.note } : {}) },
    { now, tables, seatedWalkIns, force });
  if (!booked.ok) return booked;

  const updated = { ...found, status: 'accepted', decided_at: now.toISOString(), reservation_id: booked.meta.reservation.id };
  return {
    ok: true,
    data: { ...booked.data, requests: replace(booked.data, updated) },
    meta: { ...booked.meta, request: updated }
  };
}

/** Decline a request: nothing is booked. */
export function declineRequest(state, requestId, { now = new Date() } = {}) {
  const { found, refusal } = pendingOrRefuse(state, requestId);
  if (refusal) return refusal;
  const updated = { ...found, status: 'declined', decided_at: now.toISOString() };
  return { ok: true, data: bump(state, { requests: replace(state, updated) }), meta: { request: updated } };
}

/**
 * What staff send a guest about their request, written once so every screen says the same thing. Opening the link is not sending: the
 * hub sends nothing, a person reads the words and presses send from their own phone.
 */
export const requestMessages = restaurant => {
  const when = r => new Date(r.at).toLocaleString();
  return {
    /** An opening line, for staff who want to talk to the guest before answering. */
    asked: r => `Hello ${r.guest_name}, this is ${restaurant}. Thank you for asking about a table for ${r.party_size} on ${when(r)}.`,
    confirmed: r => `Hello ${r.guest_name}, your table for ${r.party_size} at ${restaurant} on ${when(r)} is confirmed. We look forward to seeing you.`,
    declined: r => `Hello ${r.guest_name}, thank you for asking about a table for ${r.party_size} at ${restaurant} on ${when(r)}. We are sorry, we cannot take that booking. Please ring us and we will find another time.`
  };
};

/** Let go of pending requests whose time went more than a day ago: nobody is coming to a table for last night. */
export function settleLapsed(state, { now = new Date() } = {}) {
  const lapsed = [];
  const requests = requestsOf(state).map(r => {
    if (r.status !== 'pending' || Date.parse(r.at) + LAPSE_AFTER_MS >= now.getTime()) return r;
    const let_go = { ...r, status: 'lapsed', decided_at: now.toISOString() };
    lapsed.push(let_go);
    return let_go;
  });
  return lapsed.length ? { ok: true, data: bump(state, { requests }), meta: { lapsed } } : { ok: true, data: state, meta: { lapsed } };
}

/** Forget decided requests after a week. Pending ones are never forgotten: they are somebody waiting for an answer. */
export function pruneDecided(state, { now = new Date() } = {}) {
  const keep = requestsOf(state).filter(r => r.status === 'pending' || !(Date.parse(r.decided_at) < now.getTime() - REMEMBER_DECIDED_MS));
  return keep.length === requestsOf(state).length ? { ok: true, data: state } : { ok: true, data: bump(state, { requests: keep }) };
}
