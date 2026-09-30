/**
 * Multi-station KOT routing (M2 · PR 15).
 *
 * Each menu item optionally declares a `station` — 'hot' for the main
 * kitchen line, 'cold' for a cold-prep station (desserts, salads,
 * chaats), 'bar' for the bar. Items without a station default to 'hot'
 * so legacy carts still print as before.
 *
 * `groupTicketByStation(ticket)` splits a ticket into one sub-ticket per
 * distinct station touched by its lines. Each sub-ticket carries only
 * its own items but keeps the parent's identifying fields (number, table,
 * waiter, note, created_at) so the printed KOT and any KDS view reads
 * naturally. When every line resolves to the same station (very common
 * — a table ordering only mains prints one hot-line KOT), the return is
 * a single-element array.
 *
 * `STATION_LABELS` maps the machine id to the human-readable string that
 * shows on the KOT header and on KDS filter chips. Adding a station just
 * means adding a row here; no code path is hard-coded to a specific id.
 */

export const STATION_LABELS = {
  hot:  'Hot line',
  cold: 'Cold line',
  bar:  'Bar'
};

export const DEFAULT_STATION = 'hot';

/**
 * Normalise a station value from a menu item (or a priced line). Returns
 * a lowercased id that is known to STATION_LABELS, or DEFAULT_STATION
 * when the value is missing or unrecognised. The `hot` fallback is
 * intentional: a mis-tagged item still fires to the main kitchen rather
 * than silently disappearing into an unlabeled queue.
 */
export function resolveStation(raw) {
  const s = String(raw || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATION_LABELS, s) ? s : DEFAULT_STATION;
}

/**
 * Split a ticket by station. Returns `[{ station, label, ticket }]` where
 * the sub-ticket's `items` contain only lines routed to that station,
 * preserving line order. Iteration order of the return value follows the
 * order the stations were first seen in the ticket, so a printer setup
 * with multiple stations always prints in the same order for the same
 * cart shape.
 */
export function groupTicketByStation(ticket) {
  if (!ticket || !Array.isArray(ticket.items) || ticket.items.length === 0) {
    return [];
  }
  const buckets = new Map(); // station → items[]
  for (const line of ticket.items) {
    const station = resolveStation(line?.station);
    if (!buckets.has(station)) buckets.set(station, []);
    buckets.get(station).push(line);
  }
  return Array.from(buckets.entries()).map(([station, items]) => ({
    station,
    label: STATION_LABELS[station] || station,
    ticket: { ...ticket, items }
  }));
}
