// The history of a bill (G0-4): what an event is, how it is hashed, how a chain of them is checked, and how a change to a bill is
// described. Pure functions; nothing here touches a disk or the cloud.
//
// A bill used to be overwritten in place, on the hub and in the cloud, so the only thing anyone could say about it was what it looked
// like now. Every change now also leaves an event, and the events of one bill form a chain: each carries the hash of the one before,
// so editing, removing or reordering an earlier event shows up as a break. What a chain cannot show is events cut off the END; for that
// the head hash has to be kept somewhere the hub cannot write to (see the G0-4 report).

import crypto from 'node:crypto';

/** What the first event of a bill chains to. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * `baseline` is the state of a bill that already existed when the hub began keeping a history: what came before is not known.
 * The rest are the changes the invoice store can make.
 */
export const EVENT_TYPES = Object.freeze(['baseline', 'issued', 'split', 'unsplit', 'paid', 'split_paid', 'voided', 'refunded']);

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_ACTOR = 60;

/** JSON with every object's keys in sorted order and undefined left out, so the same value always encodes the same way. */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** A short label or nothing. The actor is whatever the caller says it is; it is not a verified identity. */
function cleanActor(actor) {
  if (typeof actor !== 'string') return null;
  const trimmed = actor.trim().slice(0, MAX_ACTOR).trim();
  return trimmed || null;
}

const hashOf = e => crypto.createHash('sha256').update(canonicalJson({
  restaurant_id: e.restaurant_id,
  invoice_ref: e.invoice_ref,
  seq: e.seq,
  type: e.type,
  actor: e.actor,
  occurred_at: e.occurred_at,
  payload: e.payload,
  prev_hash: e.prev_hash
})).digest('hex');

/** One event, with its place in its bill's chain and its hash. Throws on anything that is not an event. */
export function buildEvent({ restaurantId, invoiceRef, seq, type, actor, occurredAt, payload, prevHash }) {
  if (typeof restaurantId !== 'string' || !restaurantId) throw new Error('An event needs a restaurant.');
  if (typeof invoiceRef !== 'string' || !invoiceRef) throw new Error('An event needs an invoice.');
  if (!Number.isInteger(seq) || seq < 1) throw new Error('An event\'s seq is a whole number from 1.');
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('An event\'s payload is an object.');
  if (typeof prevHash !== 'string' || !HEX64.test(prevHash)) throw new Error('An event\'s prev_hash is 64 lower-case hex characters.');

  const when = new Date(occurredAt ?? Date.now());
  if (Number.isNaN(when.getTime())) throw new Error('An event\'s occurred time is not a time.');

  const event = {
    id: `${invoiceRef}#${seq}`,
    restaurant_id: restaurantId,
    invoice_ref: invoiceRef,
    seq,
    type,
    actor: cleanActor(actor),
    occurred_at: when.toISOString(),
    payload,
    prev_hash: prevHash
  };
  return { ...event, hash: hashOf(event) };
}

/**
 * Checks the events of ONE bill, in order. `head` is the hash of the last event (the genesis hash for none): the value to keep
 * somewhere else if cutting events off the end is to be noticed.
 */
export function verifyChain(events) {
  let prev = GENESIS_HASH;
  let first = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const broken = reason => ({ ok: false, brokenAt: e.seq, reason, count: events.length, head: null });
    first = first || e;
    if (e.restaurant_id !== first.restaurant_id || e.invoice_ref !== first.invoice_ref) {
      return broken('The event belongs to a different invoice or restaurant than the rest of the chain.');
    }
    if (e.seq !== i + 1) return broken(`The event is seq ${e.seq} where seq ${i + 1} was expected (an event is missing, repeated or out of order).`);
    if (hashOf(e) !== e.hash) return broken('The hash does not match the contents of the event (it was edited).');
    if (e.prev_hash !== prev) return broken('The prev_hash does not match the hash of the event before it (the chain is broken here).');
    prev = e.hash;
  }
  return { ok: true, count: events.length, head: prev };
}

/**
 * What a change did to a bill: for each field that differs, what it was and what it became. A field that was not there is null, so a
 * field that was removed is a change to null and the event keeps the value it destroyed. The sync flag is bookkeeping, not part of the bill.
 */
export function diffInvoice(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.delete('synced_to_cloud');
  for (const key of keys) {
    const from = before?.[key];
    const to = after?.[key];
    if (canonicalJson(from) !== canonicalJson(to)) changes[key] = { from: JSON.parse(canonicalJson(from)), to: JSON.parse(canonicalJson(to)) };
  }
  return changes;
}
