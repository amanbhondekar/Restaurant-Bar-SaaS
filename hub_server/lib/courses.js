/**
 * Course firing, per-station readiness and recall (M2 leftovers). Pure functions: every one
 * takes a ticket and returns a new ticket; none touches the disk or the clock.
 *
 * Model
 * -----
 * A ticket's lines are split into GROUPS. A group is the unit that gets fired to the kitchen and
 * later marked ready.
 *
 *   - Normal ticket (the default, and every ticket from before this feature): one group, "1",
 *     fired when the order is placed. Behaviour is exactly as it always was.
 *   - Staged ticket ("serve in courses", chosen by the waiter): groups follow each line's
 *     `course` (1 starters, 2 mains, 3 desserts, ...). Only the first course is fired when the
 *     order is placed; later courses are HELD until someone fires them ("hold and fire").
 *
 * State on the ticket
 *   staged:        boolean
 *   fired_courses: number[]            groups already sent to the kitchen
 *   course_log:    { [group]: { fired_at, stations_ready: { [station]: iso }, ready_at? } }
 *   status:        'in_progress' | 'ready' | 'completed'  (unchanged vocabulary)
 *
 * A ticket is 'ready' when EVERY fired group has every one of its stations ready. Firing another
 * course puts it back to 'in_progress'. Recall puts a ready ticket back to 'in_progress' and
 * clears the readiness of the group that was last made ready (the kitchen re-does it).
 *
 * Stations
 * --------
 * Each line has a `station` ('hot' | 'cold' | 'bar'; see kotRouting.js). A station is "needed" for
 * a group when the group has at least one line for it, so a ticket of curries only waits on the hot
 * line, and a mixed ticket waits on all three.
 */

import { resolveStation } from './kotRouting.js';

export const MAX_COURSE = 9;

/** A line's course as a whole number 1..9 (missing or invalid means 1). */
export function normalizeCourse(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 && n <= MAX_COURSE ? n : 1;
}

const lineStation = line => resolveStation(line?.station);

/** The group a line belongs to on this ticket: its course when staged, otherwise always 1. */
export function groupOf(ticket, line) {
  return ticket?.staged ? normalizeCourse(line?.course) : 1;
}

/**
 * Fill in course state on a ticket that predates this feature (or was built without it). A ticket
 * that is already 'ready' is treated as having had its single group made ready at `updated_at`, so
 * old tickets recall and report sensibly.
 */
export function withCourseState(ticket) {
  if (!ticket || ticket.course_log) return ticket;
  const fired_at = ticket.created_at || new Date(0).toISOString();
  const ready = ticket.status === 'ready' || ticket.status === 'completed';
  const stations_ready = {};
  if (ready) for (const s of stationsFor({ ...ticket, staged: false }, 1)) stations_ready[s] = ticket.updated_at || fired_at;
  return {
    ...ticket,
    staged: false,
    fired_courses: [1],
    course_log: { 1: { fired_at, stations_ready, ...(ready ? { ready_at: ticket.updated_at || fired_at } : {}) } }
  };
}

/** Distinct stations that have lines in `group`. */
export function stationsFor(ticket, group) {
  const set = new Set();
  for (const line of ticket.items || []) if (groupOf(ticket, line) === group) set.add(lineStation(line));
  return [...set];
}

/** All groups on the ticket, ascending. */
export function allGroups(ticket) {
  const set = new Set();
  for (const line of ticket.items || []) set.add(groupOf(ticket, line));
  return [...set].sort((a, b) => a - b);
}

/**
 * Initial course state for a brand-new ticket. `staged` only has an effect when the order really
 * spans more than one course; a staged order with a single course behaves as a normal ticket.
 */
export function initCourseState(items, { staged = false } = {}, nowIso) {
  const probe = { staged: Boolean(staged), items };
  const groups = allGroups(probe);
  const reallyStaged = Boolean(staged) && groups.length > 1;
  const first = reallyStaged ? groups[0] : 1;
  return {
    staged: reallyStaged,
    fired_courses: [first],
    course_log: { [first]: { fired_at: nowIso, stations_ready: {} } }
  };
}

export const isFired = (ticket, line) => (ticket.fired_courses || [1]).includes(groupOf(ticket, line));

/** Lines already sent to the kitchen. */
export const firedItems = ticket => (ticket.items || []).filter(l => isFired(ticket, l));

/** Lines still held back, with their course. */
export const heldItems = ticket => (ticket.items || []).filter(l => !isFired(ticket, l));

/** Held lines grouped by course: `[{ course, items }]`, ascending. */
export function heldCourses(ticket) {
  const by = new Map();
  for (const l of heldItems(ticket)) {
    const g = groupOf(ticket, l);
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(l);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([course, items]) => ({ course, items }));
}

const fail = (code, error) => ({ ok: false, code, error });

function derive(ticket) {
  // 'completed' (table cleared) is final and never derived away.
  if (ticket.status === 'completed') return ticket;
  const fired = ticket.fired_courses || [1];
  const allReady = fired.length > 0 && fired.every(g => {
    const entry = ticket.course_log?.[g];
    if (!entry) return false;
    const need = stationsFor(ticket, g);
    return need.length > 0 && need.every(s => entry.stations_ready?.[s]);
  });
  return { ...ticket, status: allReady ? 'ready' : 'in_progress' };
}

/**
 * Mark one station's work ready for every fired group that is not finished yet.
 * Returns `{ ok, ticket, ticket_ready }`; `ticket_ready` is true only on the call that completes
 * the whole ticket (so the waiter is told exactly once).
 */
export function markStationReady(input, station, nowIso) {
  const ticket = withCourseState(input);
  const st = resolveStation(station);
  if (ticket.status === 'completed') return fail('TICKET_CLOSED', 'This ticket is already closed.');
  if (ticket.status === 'ready') return fail('ALREADY_READY', 'This ticket is already ready.');

  const log = { ...ticket.course_log };
  let touched = false;
  for (const g of ticket.fired_courses) {
    if (!stationsFor(ticket, g).includes(st)) continue;
    const entry = log[g];
    if (entry.stations_ready?.[st]) continue;
    log[g] = { ...entry, stations_ready: { ...entry.stations_ready, [st]: nowIso } };
    touched = true;
  }
  if (!touched) return fail('NOTHING_TO_MARK', `There is nothing for the ${st} station to mark ready on this ticket.`);

  let next = derive({ ...ticket, course_log: log });
  // Stamp each group's ready_at the moment its last station reports in.
  const stamped = { ...next.course_log };
  for (const g of next.fired_courses) {
    const entry = stamped[g];
    if (!entry.ready_at && stationsFor(next, g).every(s => entry.stations_ready?.[s])) stamped[g] = { ...entry, ready_at: nowIso };
  }
  next = { ...next, course_log: stamped, updated_at: nowIso };
  return { ok: true, ticket: next, ticket_ready: next.status === 'ready' };
}

/** The whole-ticket "Ready" button: every station of every fired group is done. */
export function markAllReady(input, nowIso) {
  const ticket = withCourseState(input);
  if (ticket.status === 'completed') return fail('TICKET_CLOSED', 'This ticket is already closed.');
  const log = { ...ticket.course_log };
  for (const g of ticket.fired_courses) {
    const entry = log[g];
    const stations_ready = { ...entry.stations_ready };
    for (const s of stationsFor(ticket, g)) if (!stations_ready[s]) stations_ready[s] = nowIso;
    log[g] = { ...entry, stations_ready, ready_at: entry.ready_at || nowIso };
  }
  return { ok: true, ticket: { ...derive({ ...ticket, course_log: log }), updated_at: nowIso } };
}

/** Send the next held course (or a specific one) to the kitchen. */
export function fireCourse(input, course, nowIso) {
  const ticket = withCourseState(input);
  if (ticket.status === 'completed') return fail('TICKET_CLOSED', 'This ticket is already closed.');
  if (!ticket.staged) return fail('NOT_STAGED', 'This order is not being served in courses.');

  const held = heldCourses(ticket).map(h => h.course);
  if (held.length === 0) return fail('NO_MORE_COURSES', 'Every course has already been fired.');

  let target;
  if (course === undefined || course === null || course === '') target = held[0];
  else {
    target = normalizeCourse(course);
    if (ticket.fired_courses.includes(target)) return fail('ALREADY_FIRED', `Course ${target} has already been fired.`);
    if (!held.includes(target)) return fail('UNKNOWN_COURSE', `This order has no course ${target}.`);
  }

  const fired_courses = [...ticket.fired_courses, target].sort((a, b) => a - b);
  const course_log = { ...ticket.course_log, [target]: { fired_at: nowIso, stations_ready: {} } };
  const next = derive({ ...ticket, fired_courses, course_log, updated_at: nowIso });
  return { ok: true, ticket: next, fired_course: target, fired_items: ticket.items.filter(l => groupOf(ticket, l) === target) };
}

/**
 * Put a ready ticket back on the board: the kitchen marked it ready by mistake, or the dish went
 * wrong. Only the group that was most recently made ready is reopened.
 */
export function recallTicket(input, nowIso) {
  const ticket = withCourseState(input);
  if (ticket.status === 'completed') return fail('TICKET_CLOSED', 'This ticket is already closed.');
  if (ticket.status !== 'ready') return fail('NOT_READY', 'Only a ticket that was marked ready can be recalled.');

  const latest = ticket.fired_courses
    .filter(g => ticket.course_log[g]?.ready_at)
    .sort((a, b) => String(ticket.course_log[b].ready_at).localeCompare(String(ticket.course_log[a].ready_at)) || b - a)[0];
  if (latest === undefined) return fail('NOT_READY', 'Only a ticket that was marked ready can be recalled.');

  const entry = ticket.course_log[latest];
  const { ready_at: _gone, ...rest } = entry;
  const course_log = { ...ticket.course_log, [latest]: { ...rest, stations_ready: {}, recalled_at: nowIso, recall_count: (entry.recall_count || 0) + 1 } };
  const next = derive({ ...ticket, course_log, updated_at: nowIso });
  // The lines that are being cooked again, so the caller can reprint them -- same derivation
  // fireCourse uses for fired_items.
  const recalled_items = ticket.items.filter(l => groupOf(ticket, l) === latest);
  return { ok: true, ticket: next, recalled_course: latest, recalled_items };
}

/**
 * Lines a station should see on its screen: fired lines for that station, with where the ticket
 * stands for that station. Used by the KDS so a bar tablet shows only drinks.
 */
export function stationView(ticket, station) {
  const t = withCourseState(ticket);
  const st = resolveStation(station);
  const lines = firedItems(t).filter(l => lineStation(l) === st);
  const pending = lines.filter(l => !t.course_log[groupOf(t, l)]?.stations_ready?.[st]);
  return { lines, pending_count: pending.length, done: lines.length > 0 && pending.length === 0 };
}
