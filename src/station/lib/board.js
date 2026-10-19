import { STATIONS, STATION_LABEL, groupOf, lineDoneForStation, onStationBoard, visibleLines } from '../../lib/ticketView';

// What a station screen shows, worked out from the tickets the hub sends. Pure: no React, no clock of
// its own (callers pass `now`), so the rules are tested on their own. The hub is the authority on a
// ticket's course state; this only reads it, using the same rules as the Kitchen Display
// (src/lib/ticketView.js).

export { STATIONS, STATION_LABEL };

/** The station a page address names: "/station/bar" -> "bar". Anything else is null, never a guess. */
export function stationFromPath(pathname = '') {
  const match = String(pathname).match(/^\/station\/([^/?#]+)\/?$/i);
  const station = match ? decodeURIComponent(match[1]).toLowerCase() : '';
  return STATIONS.includes(station) ? station : null;
}

/** Add a ticket, or replace the one with the same id. */
export function upsertTicket(tickets, next) {
  if (!next || !next.id) return tickets;
  return tickets.some(t => t.id === next.id) ? tickets.map(t => (t.id === next.id ? { ...t, ...next } : t)) : [next, ...tickets];
}

/**
 * Combine a freshly fetched list with what the screen already holds. A re-read can come back OLDER than
 * a live message that arrived while it was in flight (the hub answered, then changed the ticket, and
 * the message got here before the answer did), so a plain replace would quietly undo it.
 *
 *   - a ticket in both: whichever the hub touched last (`updated_at`) wins, ties to the fetched one;
 *   - a ticket only in the fetch: kept;
 *   - a ticket only in memory: kept if a live message brought it in during this fetch (`arrivedIds`),
 *     dropped otherwise -- the hub no longer lists it, so it was cleared.
 */
export function mergeFetched(current, fetched, arrivedIds = new Set()) {
  const held = new Map((current || []).map(t => [t.id, t]));
  const merged = (fetched || []).map(f => {
    const c = held.get(f.id);
    return c && String(c.updated_at || '') > String(f.updated_at || '') ? c : f;
  });
  const listed = new Set(merged.map(t => t.id));
  const kept = (current || []).filter(t => arrivedIds.has(t.id) && !listed.has(t.id));
  return [...kept, ...merged];
}

const ticketOf = payload => (payload && (payload.ticket || (payload.id ? payload : null))) || null;

/**
 * Apply one live message from the hub. Returns `{ tickets, refetch }`: `refetch` asks the screen to
 * read the whole list again, for events that remove tickets (a table cleared) where the message does
 * not say which. Messages it does not know are ignored, so a newer hub cannot break an older screen.
 */
export function applyMessage(tickets, message) {
  const { type, payload } = message || {};
  switch (type) {
    case 'NEW_ORDER':
    case 'order_created': {
      const t = ticketOf(payload);
      return { tickets: t && !tickets.some(x => x.id === t.id) ? upsertTicket(tickets, t) : tickets, refetch: false };
    }
    case 'TICKET_UPDATED':
    case 'COURSE_FIRED':
    case 'STATION_READY':
    case 'TICKET_RECALLED':
    case 'TICKET_READY':
    case 'order_ready': {
      const t = payload?.ticket;
      if (t) return { tickets: upsertTicket(tickets, t), refetch: false };
      // An old-style ready event with no ticket in it: mark what it names.
      const id = payload?.ticket_id || payload?.order_id;
      return { tickets: id ? tickets.map(x => (x.id === id ? { ...x, status: 'ready' } : x)) : tickets, refetch: false };
    }
    case 'CLEAR_TABLE':
    case 'bill_cleared':
    case 'order_cleared':
      return { tickets, refetch: true };
    default:
      return { tickets, refetch: false };
  }
}

/**
 * The lines this station still has to cook on a ticket: fired, for this station, not yet reported
 * ready. Each carries its course group, so a course that is done is not shown while a later one is.
 */
export function pendingLines(ticket, station) {
  return visibleLines(ticket, station)
    .filter(({ item }) => !lineDoneForStation(ticket, item))
    .map(({ item, idx }) => ({ item, idx, group: groupOf(ticket, item) }));
}

/** Tickets to draw for a station, longest-waiting first (a kitchen works oldest to newest). */
export function board(tickets, station, now = Date.now()) {
  return (tickets || [])
    .filter(t => t.status !== 'completed' && onStationBoard(t, station))
    .map(t => ({ ticket: t, since: waitingSince(t, station), lines: pendingLines(t, station) }))
    .sort((a, b) => (Date.parse(a.since) || now) - (Date.parse(b.since) || now));
}

/**
 * When this station's current work on the ticket was sent to the kitchen: the earliest `fired_at` among
 * the courses it is still cooking. A second course fired an hour after the first starts its own clock.
 */
export function waitingSince(ticket, station) {
  let earliest = null;
  for (const group of new Set(pendingLines(ticket, station).map(l => l.group))) {
    const at = ticket.course_log?.[group]?.fired_at;
    if (at && (!earliest || at < earliest)) earliest = at;
  }
  return earliest || ticket.created_at || null;
}

/** Whole minutes since `iso`, never negative, or null if there is no usable time. */
export function minutesSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : null;
}

// A ticket is worth a glance after this many minutes, and needs one after this many.
export const WARN_AT = 10;
export const LATE_AT = 15;

export function urgencyOf(minutes) {
  if (minutes === null || minutes === undefined) return 'ok';
  if (minutes >= LATE_AT) return 'late';
  if (minutes >= WARN_AT) return 'warn';
  return 'ok';
}

/** "3 min", "1 h 05 min", or "just now" for under a minute. */
export function formatWait(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * The work this station has been handed, as a set of "ticket:course" keys. A screen compares it before
 * and after a message: a key that was not there is new work -- a new order, or a held course just fired
 * -- which is when it should make a sound.
 */
export function pendingKeys(tickets, station) {
  const keys = new Set();
  for (const t of tickets || []) {
    if (t.status === 'completed') continue;
    for (const { group } of pendingLines(t, station)) keys.add(`${t.id}:${group}`);
  }
  return keys;
}

/** A line as the card prints it: quantity, name, size, and what was chosen on it. */
export function describeLine(item) {
  const mods = (Array.isArray(item?.modifiers) ? item.modifiers : []).map(m => m.option_label).filter(Boolean);
  return { qty: Number(item?.qty) || 1, name: String(item?.name ?? ''), size: item?.variant_label || '', mods };
}
