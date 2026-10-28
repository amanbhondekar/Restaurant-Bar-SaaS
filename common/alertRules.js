// Which alerts are true right now (docs/SUPER_ADMIN_BUILD_SHEET.md §8, task P2-2): pure rules over a row of the `ops_tenants` view, what the console
// knows about the restaurant's service hours, and the moment it is read in. Nothing here reads a database or a clock, so every threshold can be pinned
// to the millisecond on both sides in the tests, and the alert worker and the tests run the very same function.
//
// The rules reuse the operator console's own constants (common/opsRules.js) rather than keeping a second set that drifts: a hub the console calls "live"
// is a hub no alert calls silent.
//
// What is NOT here, because the data for it does not exist yet: webhook signature failures, the operator service and the alert worker being down,
// repeated failed admin sign-ins, and the hosted schema being behind the repository. They are listed in docs/SUPER_ADMIN.md as not built.
//
// Nothing an alert says may be a secret or a guest (invariant I9): a condition carries the restaurant's id and name, a rule, and counts and times.

import { OPS_LIMITS, hubState, readTime, readCount } from './opsRules.js';

const MIN = 60 * 1000;

/** How bad each rule is. P1 is a page at any hour; P2 never pages overnight; P3 is shown, never sent. */
export const ALERT_RULES = Object.freeze({
  hub_silent_service: 'P1',
  orders_shelved: 'P1',
  hub_silent_long: 'P2',
  sync_backlog: 'P2',
  payment_past_due: 'P2',
  service_hours_missing: 'P3'
});

const RANK = { P1: 0, P2: 1, P3: 2 };
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = text => {
  const m = typeof text === 'string' ? CLOCK.exec(text) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** The service hours as windows per day, in minutes after midnight, or null if anything in them cannot be read: a table half understood is not used. */
function readHours(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const out = {};
  let any = false;
  for (const [day, windows] of Object.entries(table)) {
    if (!DAYS.includes(day) || !Array.isArray(windows)) return null;
    out[day] = [];
    for (const w of windows) {
      if (!Array.isArray(w) || w.length !== 2) return null;
      const open = minutesOf(w[0]);
      const close = minutesOf(w[1]);
      if (open === null || close === null || open === close) return null;
      out[day].push({ open, close });
      any = true;
    }
  }
  return any ? out : null;
}

/** The weekday and minute of the day, in `timeZone`, or null for a zone that is not one. */
export function localTime(timeZone, now) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(now));
    const at = type => parts.find(p => p.type === type)?.value;
    const day = DAYS.indexOf(String(at('weekday')).toLowerCase().slice(0, 3));
    const minutes = Number(at('hour')) * 60 + Number(at('minute'));
    return day < 0 || !Number.isFinite(minutes) ? null : { day, minutes };
  } catch {
    return null;   // RangeError: not a time zone
  }
}

/**
 * Is the restaurant open at `now`? { state: 'open', since } (the moment the window opened), { state: 'closed' }, or { state: 'unknown' } when the hours or the
 * time zone are missing or unreadable. A window that runs past midnight belongs to the day it opened on.
 */
export function serviceWindowAt(meta, now) {
  const hours = readHours(meta?.service_hours);
  const local = hours ? localTime(meta?.timezone, now) : null;
  if (!hours || !local) return { state: 'unknown' };

  const minuteStart = Math.floor(now / MIN) * MIN;
  const today = hours[DAYS[local.day]] ?? [];
  const yesterday = hours[DAYS[(local.day + 6) % 7]] ?? [];
  const m = local.minutes;

  for (const { open, close } of today) {
    const through = close > open ? m >= open && m < close : m >= open;   // past midnight: open from `open` to the end of today
    if (through) return { state: 'open', since: minuteStart - (m - open) * MIN };
  }
  for (const { open, close } of yesterday) {
    if (close < open && m < close) return { state: 'open', since: minuteStart - (m + 24 * 60 - open) * MIN };
  }
  return { state: 'closed' };
}

/** What is wrong with one restaurant right now: worst first, then by rule, so the same row always gives the same list. */
export function evaluateTenant(row, meta, now) {
  const found = [];
  const add = (rule_key, detail = {}) => found.push({
    restaurant_id: row.restaurant_id,
    restaurant_name: row.name,
    rule_key,
    severity: ALERT_RULES[rule_key],
    dedupe_key: `${rule_key}:${row.restaurant_id}`,
    detail
  });

  const stays = row.plan_status !== 'cancelled';   // a cancelled restaurant's hub is meant to be off
  const seen = readTime(row.hub_seen_at);

  if (stays && seen !== null) {
    const window = serviceWindowAt(meta, now);
    if (window.state === 'open') {
      // Only the silence while the restaurant has been open counts: a hub that last spoke last night has not missed three reports five minutes after opening.
      const silent = Math.min(now - seen, now - window.since);
      if (silent > OPS_LIMITS.hubLiveMs) add('hub_silent_service', { last_seen_at: new Date(seen).toISOString(), silent_ms: silent });
    } else if (window.state === 'unknown') {
      add('service_hours_missing');
    }
  }

  const shelved = readCount(row.hub_quarantined);
  if (shelved > 0) add('orders_shelved', { count: shelved });

  if (stays && hubState(row, now) === 'silent') add('hub_silent_long', { last_seen_at: new Date(seen).toISOString() });

  const waiting = readCount(row.hub_queued);
  if (stays && waiting >= OPS_LIMITS.backlog) add('sync_backlog', { count: waiting });

  if (row.plan_status === 'past_due') add('payment_past_due');

  return found.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.rule_key < b.rule_key ? -1 : a.rule_key > b.rule_key ? 1 : 0));
}

/** Every restaurant's conditions together. `metaById` is keyed by restaurant id; a restaurant with no entry has unknown hours. */
export function evaluateFleet(rows, metaById, now) {
  return rows.flatMap(row => evaluateTenant(row, metaById?.[row.restaurant_id] ?? null, now));
}
