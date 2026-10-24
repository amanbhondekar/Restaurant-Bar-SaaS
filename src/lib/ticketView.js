// What the kitchen screen shows for a ticket: which lines are on the board, which are held back for a
// later course, and where each station stands. Pure and framework-free so it can be tested on its own.
//
// It mirrors the rules in hub_server/lib/courses.js (a line's group is its course on a ticket served in
// courses, otherwise 1; a station's part of a group is ready when the hub recorded it). The hub is the
// authority; this only reads what the hub sent.

export const STATIONS = ['hot', 'cold', 'bar'];
export const STATION_LABEL = { hot: 'Hot line', cold: 'Cold line', bar: 'Bar' };

export const stationOf = line => (STATIONS.includes(String(line?.station || '').toLowerCase()) ? String(line.station).toLowerCase() : 'hot');

const courseOf = line => {
  const n = Math.floor(Number(line?.course));
  return Number.isFinite(n) && n >= 1 && n <= 9 ? n : 1;
};

/** The group a line is fired and finished with. */
export const groupOf = (ticket, line) => (ticket?.staged ? courseOf(line) : 1);

const firedList = ticket => (Array.isArray(ticket?.fired_courses) && ticket.fired_courses.length ? ticket.fired_courses : [1]);

export const isFired = (ticket, line) => firedList(ticket).includes(groupOf(ticket, line));

/** Has this station reported its part of the line's group done? Tickets from older hubs have no log: not done. */
export function lineDoneForStation(ticket, line) {
  return Boolean(ticket?.course_log?.[groupOf(ticket, line)]?.stations_ready?.[stationOf(line)]);
}

/**
 * Lines to draw on a ticket card, each with its index into `ticket.items` (the screen's checklist is
 * keyed by that index). Only fired lines; and only the given station's when one is chosen.
 */
export function visibleLines(ticket, station = 'all') {
  const out = [];
  (ticket?.items || []).forEach((item, idx) => {
    if (!isFired(ticket, item)) return;
    if (station !== 'all' && stationOf(item) !== station) return;
    out.push({ item, idx });
  });
  return out;
}

/** Held courses with how many lines each: `[{ course, count }]`, ascending. */
export function heldGroups(ticket) {
  const counts = new Map();
  for (const item of ticket?.items || []) {
    if (isFired(ticket, item)) continue;
    const g = groupOf(ticket, item);
    counts.set(g, (counts.get(g) || 0) + (Number(item.qty) || 1));
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([course, count]) => ({ course, count }));
}

/** Per-station state for the chips on a card: every station with fired lines, and whether it is done. */
export function stationStates(ticket) {
  const by = new Map();
  for (const item of ticket?.items || []) {
    if (!isFired(ticket, item)) continue;
    const st = stationOf(item);
    const entry = by.get(st) || { station: st, lines: 0, done: true };
    entry.lines += 1;
    if (!lineDoneForStation(ticket, item)) entry.done = false;
    by.set(st, entry);
  }
  return STATIONS.filter(s => by.has(s)).map(s => by.get(s));
}

/**
 * Should this ticket appear on a station's screen? It does when the station has a fired line on it that
 * is still pending, so a bar tablet never shows a ticket that is only food. (`all` shows everything.)
 */
export function onStationBoard(ticket, station) {
  if (station === 'all') return true;
  return stationStates(ticket).some(s => s.station === station && !s.done);
}

/** How many tickets are waiting on each station, for the filter chips. */
export function stationCounts(tickets) {
  const counts = { all: 0, hot: 0, cold: 0, bar: 0 };
  for (const t of tickets || []) {
    counts.all += 1;
    for (const s of stationStates(t)) if (!s.done) counts[s.station] += 1;
  }
  return counts;
}

/** Read the station from the page address (?station=bar), else from storage; anything else means all. */
export function initialStation(search = '', stored = null) {
  const fromUrl = new URLSearchParams(search).get('station');
  for (const v of [fromUrl, stored]) {
    const s = String(v || '').toLowerCase();
    if (s === 'all' || STATIONS.includes(s)) return s;
  }
  return 'all';
}
