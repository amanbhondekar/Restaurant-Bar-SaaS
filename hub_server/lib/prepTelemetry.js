/**
 * Prep-time telemetry (M2 leftovers). Pure: tickets in, numbers out.
 *
 * A sample is "how long from the moment a course was fired to the kitchen until a station said its
 * part was ready". Everything comes from the timestamps the hub already keeps in `course_log`
 * (see courses.js), so there is nothing extra to record and old tickets still count.
 *
 * Per ticket, per fired course that finished:
 *   - one OVERALL sample: fired_at -> the course's ready_at (the slowest station decides it)
 *   - one STATION sample per station in the course: fired_at -> that station's ready time
 *   - one ITEM sample per line: the line's station time, so "Butter Chicken takes 14 min on the hot
 *     line" can be read straight off the report
 *
 * A course that was recalled counts with its full time since it was fired, remake included: that is
 * what the guest experienced.
 */

import { withCourseState, groupOf, stationsFor } from './courses.js';
import { resolveStation } from './kotRouting.js';

const toMs = v => {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Nearest-rank percentile of an ascending numeric array (p in 0..100). */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function stats(values) {
  const v = values.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, avg: null, p50: null, p90: null, max: null };
  const sum = v.reduce((s, n) => s + n, 0);
  return {
    n: v.length,
    avg: Math.round(sum / v.length),
    p50: Math.round(percentile(v, 50)),
    p90: Math.round(percentile(v, 90)),
    max: Math.round(v[v.length - 1])
  };
}

/**
 * Raw samples for tickets whose course was fired in [fromMs, toMs).
 * Returns `{ overall: number[], station: {st: number[]}, items: Map<key, {name, station, secs[]}>, recalls }`.
 */
export function collectSamples(tickets, restaurantId, { fromMs = null, toMs: toMsArg = null } = {}) {
  const overall = [];
  const station = {};
  const items = new Map();
  let recalls = 0;

  for (const raw of Array.isArray(tickets) ? tickets : []) {
    if (!raw || (restaurantId && raw.restaurant_id !== restaurantId)) continue;
    const t = withCourseState(raw);
    for (const g of t.fired_courses || []) {
      const entry = t.course_log?.[g];
      const firedMs = toMs(entry?.fired_at);
      if (firedMs === null) continue;
      if (fromMs !== null && firedMs < fromMs) continue;
      if (toMsArg !== null && firedMs >= toMsArg) continue;
      recalls += entry.recall_count || 0;

      const readyMs = toMs(entry.ready_at);
      if (readyMs === null || readyMs < firedMs) continue; // still cooking, or bad data

      overall.push((readyMs - firedMs) / 1000);
      for (const st of stationsFor(t, g)) {
        const stMs = toMs(entry.stations_ready?.[st]);
        if (stMs === null || stMs < firedMs) continue;
        const secs = (stMs - firedMs) / 1000;
        (station[st] ||= []).push(secs);
        for (const line of t.items || []) {
          if (groupOf(t, line) !== g || resolveStation(line.station) !== st) continue;
          const key = `${line.id ?? line.name}|${line.variant_id || ''}`;
          const label = line.variant_label ? `${line.name} (${line.variant_label})` : String(line.name || 'Item');
          if (!items.has(key)) items.set(key, { name: label, station: st, secs: [] });
          items.get(key).secs.push(secs);
        }
      }
    }
  }
  return { overall, station, items, recalls };
}

/** The report the admin screen shows: overall, per station, and per item (slowest first). */
export function prepReport(tickets, restaurantId, window = {}) {
  const s = collectSamples(tickets, restaurantId, window);
  const by_station = {};
  for (const [st, secs] of Object.entries(s.station)) by_station[st] = stats(secs);
  const by_item = [...s.items.values()]
    .map(i => ({ name: i.name, station: i.station, ...stats(i.secs) }))
    .sort((a, b) => b.avg - a.avg || b.n - a.n || a.name.localeCompare(b.name));
  return { overall: stats(s.overall), by_station, by_item, recalls: s.recalls };
}
