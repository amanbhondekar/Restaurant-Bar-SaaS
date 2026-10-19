import { stationView, withCourseState } from './courses.js';
import { STATION_LABELS } from './kotRouting.js';

// Station screens: a tablet at the hot line, the cold line or the bar that has been told which
// station it is. The hub learns this when the screen opens its live connection with `?station=bar`,
// and keeps count of which stations have a screen up.
//
// Why the hub needs to know: until now a station screen was a filter on the one Kitchen Display, so
// the hub had no idea whether anyone was looking at the bar. A drinks ticket for a bar with no screen
// just sat there. With this reception can see "Bar: no screen -- 3 drinks waiting".
//
// Cooperative, not a security boundary: a screen says which station it is, the hub believes it. What
// it may do is the same as any enrolled device (see lib/deviceAuth.js); a station screen cannot do
// more than a waiter's handset, but it is not stopped from marking another station's part ready.

export const STATIONS = Object.keys(STATION_LABELS);
const MAX_LABEL = 30;

/**
 * What a live-connection URL says about the screen at the other end, or null if it is not a station
 * screen. A station the hub does not know is ignored rather than guessed at, and a label is trimmed
 * and cut short: it is shown to reception, so it must not be able to be a paragraph.
 */
export function parseScreen(url) {
  const station = String(url?.searchParams?.get('station') ?? '').trim().toLowerCase();
  if (!STATIONS.includes(station)) return null;
  const label = String(url.searchParams.get('label') ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return { station, label };
}

export class StationScreens {
  constructor() {
    /** Open connections that declared a station: connection -> { station, label, since }. */
    this.screens = new Map();
  }

  add(connection, screen, now = new Date()) {
    this.screens.set(connection, { ...screen, since: now.toISOString() });
  }

  remove(connection) {
    return this.screens.delete(connection);
  }

  /** How many screens each station has up right now. Every station is present, at zero if need be. */
  counts() {
    const counts = Object.fromEntries(STATIONS.map(s => [s, 0]));
    for (const { station } of this.screens.values()) counts[station] += 1;
    return counts;
  }

  /** Who is connected, for the console: one row per screen. */
  list() {
    return [...this.screens.values()].map(({ station, label, since }) => ({ station, label, since }));
  }
}

/**
 * What is waiting at each station across the open tickets: how many tickets, and how many items
 * (counting quantities). Only lines that have been fired and not yet reported ready count, so a held
 * course is not "waiting" and a station that already finished its part is not either.
 */
export function backlog(tickets) {
  const out = Object.fromEntries(STATIONS.map(s => [s, { tickets: 0, items: 0 }]));
  for (const raw of tickets || []) {
    if (!raw || raw.status === 'completed') continue;
    const ticket = withCourseState(raw);
    for (const station of STATIONS) {
      const view = stationView(ticket, station);
      const pending = view.lines.filter(l => !ticket.course_log?.[groupOfLine(ticket, l)]?.stations_ready?.[station]);
      if (pending.length === 0) continue;
      out[station].tickets += 1;
      out[station].items += pending.reduce((n, l) => n + (Number(l.qty) || 1), 0);
    }
  }
  return out;
}

// A line's course group, as lib/courses.js reads it: its course on a ticket served in courses,
// otherwise always 1.
const groupOfLine = (ticket, line) => {
  if (!ticket.staged) return 1;
  const n = Math.floor(Number(line?.course));
  return Number.isFinite(n) && n >= 1 && n <= 9 ? n : 1;
};

/** What the console shows: per station its label, how many screens are up, and what is waiting. */
export function snapshot(registry, tickets) {
  const counts = registry.counts();
  const waiting = backlog(tickets);
  return Object.fromEntries(STATIONS.map(s => [s, {
    label: STATION_LABELS[s],
    online: counts[s],
    waiting_tickets: waiting[s].tickets,
    waiting_items: waiting[s].items
  }]));
}
