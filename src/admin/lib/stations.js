// What the Kitchen tab says about station screens, from the hub's /kds/screens answer. Pure functions.
//
// The point of the panel is one case: a station has work waiting and nobody is looking at it. But the
// hub cannot see the main Kitchen Display on the reception laptop, which may be showing every station.
// A restaurant that does not use station screens at all would be told "no screen, tickets waiting" all
// day and learn to ignore it. So that warning is only raised once at least one station screen is
// connected: from then on a station without one is the odd one out.

export const STATION_ORDER = ['hot', 'cold', 'bar'];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "3 tickets (5 items)". */
export const waitingText = (tickets, items) => `${plural(tickets, 'ticket', 'tickets')} (${plural(items, 'item', 'items')})`;

/** Is any station screen connected at all? */
export const anyScreensUp = stations => STATION_ORDER.some(s => (stations?.[s]?.online ?? 0) > 0);

/**
 * One station's card: a tone, a headline and a line of detail, and whether it should be flagged as
 * unwatched. `anyUp` says whether the restaurant is using station screens at all (see above).
 */
export function stationStatus(station, anyUp) {
  const online = station?.online ?? 0;
  const tickets = station?.waiting_tickets ?? 0;
  const items = station?.waiting_items ?? 0;
  const waiting = tickets > 0;

  if (online > 0) {
    return {
      tone: 'green',
      unwatched: false,
      headline: `${plural(online, 'screen', 'screens')} up`,
      detail: waiting ? `${waitingText(tickets, items)} waiting` : 'Nothing waiting'
    };
  }
  if (!anyUp) {
    return {
      tone: 'muted',
      unwatched: false,
      headline: 'No screen',
      detail: waiting ? `${waitingText(tickets, items)} waiting, shown on the Kitchen Display` : 'Nothing waiting'
    };
  }
  return waiting
    ? { tone: 'rust', unwatched: true, headline: 'No screen', detail: `${waitingText(tickets, items)} waiting and nobody is looking at them` }
    : { tone: 'muted', unwatched: false, headline: 'No screen', detail: 'Nothing waiting' };
}

/** The sentence for the top of the panel, or '' when every station that has work also has a screen. */
export function unwatchedLine(stations, labels = {}) {
  if (!anyScreensUp(stations)) return '';
  const names = STATION_ORDER
    .filter(s => stationStatus(stations[s], true).unwatched)
    .map(s => stations[s]?.label || labels[s] || s);
  if (names.length === 0) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? 'has' : 'have'} work waiting and no screen connected.`;
}
