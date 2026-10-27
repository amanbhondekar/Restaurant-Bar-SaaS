// What to do about the alerts (docs/SUPER_ADMIN_BUILD_SHEET.md §8, task P2-2): the lifecycle half. common/alertRules.js says which conditions are true
// right now; this says which of them open an alert, which alerts have cleared, who is due a page and how urgent it is, and which alerts nobody has answered.
// Pure: the worker reads the database and the clock and calls these, so every minute of the timing is pinned in the tests.
//
// The state machine is open -> acked -> resolved. An alert opens when its condition becomes true and nothing is open for it (dedupe by key), and
// resolves by itself when the condition clears, acknowledged or not. Paging: both founders at once; if nobody has acknowledged it ten minutes after the
// last page, a reminder at higher urgency, every ten minutes, three times; ten minutes after the third it is flagged unattended in the console.
// A P2 never pages while the founders are asleep: it waits, and is paged when they wake. A P1 pages at any hour. A P3 is shown and never sent.
//
// An alert carries counts and times and a restaurant's name, never a secret or a guest (invariant I9).

import { readTime } from './opsRules.js';
import { localTime } from './alertRules.js';

const MIN = 60 * 1000;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const ALERT_DEFAULTS = Object.freeze({
  escalateAfterMs: 10 * MIN,
  reminders: 3,
  // The founders' own clock, not the restaurant's: the question is whether anyone is asleep.
  quiet: Object.freeze({ timeZone: 'Asia/Kolkata', from: '22:00', to: '08:00' })
});

const PAGED = new Set(['P1', 'P2']);
const RANK = { P1: 0, P2: 1 };

/** Is `now` inside the quiet window? Throws if the window cannot be read: a window nobody can read must stop the worker starting, not become "never quiet". */
export function isQuietHours(now, quiet) {
  const clock = text => { const m = typeof text === 'string' ? CLOCK.exec(text) : null; return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const from = clock(quiet?.from);
  const to = clock(quiet?.to);
  if (from === null || to === null || from === to) throw new RangeError('quiet hours need a start and an end, as HH:MM, that differ');
  const local = localTime(quiet.timeZone, now);
  if (!local) throw new RangeError('quiet hours need a time zone that exists');
  return from < to ? local.minutes >= from && local.minutes < to : local.minutes >= from || local.minutes < to;
}

/**
 * Which conditions open an alert and which open alerts have cleared. `open` is every alert that is not resolved. When `complete` is false (the read of the
 * fleet was cut short) nothing is resolved: a list that stopped early is not a healthy fleet.
 */
export function reconcileAlerts(conditions, open, { complete = true } = {}) {
  const wanted = new Map();
  for (const c of conditions) if (!wanted.has(c.dedupe_key)) wanted.set(c.dedupe_key, c);
  const live = open.filter(a => a.state !== 'resolved');
  const have = new Set(live.map(a => a.dedupe_key));
  return {
    open: [...wanted.values()].filter(c => !have.has(c.dedupe_key)),
    resolve: complete
      ? live.filter(a => !wanted.has(a.dedupe_key)).map(a => ({ id: a.id, dedupe_key: a.dedupe_key, reason: 'condition_cleared' }))
      : []
  };
}

/** Who is due a page right now: worst first, then oldest first. */
export function dueNotifications(alerts, now, config = ALERT_DEFAULTS) {
  let quiet = null;   // asked only if a P2 is waiting
  const asleep = () => (quiet ??= { value: isQuietHours(now, config.quiet) }).value;
  const due = [];
  for (const a of alerts) {
    if (a.state !== 'open' || !PAGED.has(a.severity)) continue;
    const last = readTime(a.last_notified_at);
    let level;
    if (last === null) level = 0;
    else if (a.escalation_level < config.reminders && now - last >= config.escalateAfterMs) level = a.escalation_level + 1;
    else continue;
    if (a.severity === 'P2' && asleep()) continue;
    due.push({ alert_id: a.id, level, kind: level === 0 ? 'new' : 'reminder', urgency: level === 0 ? 'normal' : 'high', severity: a.severity, alert: a });
  }
  const opened = n => readTime(n.alert.opened_at) ?? 0;
  return due.sort((x, y) => RANK[x.severity] - RANK[y.severity] || opened(x) - opened(y) || x.alert_id - y.alert_id);
}

/** Alerts that have had every reminder and ten minutes more with nobody answering: to be flagged in the console. */
export function unattendedAlerts(alerts, now, config = ALERT_DEFAULTS) {
  return alerts.filter(a => {
    if (a.state !== 'open' || !PAGED.has(a.severity) || readTime(a.unattended_at) !== null) return false;
    const last = readTime(a.last_notified_at);
    return last !== null && a.escalation_level >= config.reminders && now - last >= config.escalateAfterMs;
  });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const duration = ms => {
  const minutes = Math.max(1, Math.floor(ms / MIN));
  return minutes >= 120 ? plural(Math.floor(minutes / 60), 'hour') : plural(minutes, 'minute');
};
/** A moment on the founders' own clock, e.g. "11:45", or with the date when it is not today ("27 Oct 11:45"). */
function clockIn(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(new Date(ms));
}
const oneLine = text => String(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

const WORDS = {
  hub_silent_service: d => ({ what: 'hub silent while open', text: `The hub has not reported for ${duration(d.silent_ms ?? 0)} while the restaurant is open.` }),
  orders_shelved: d => ({ what: 'orders shelved', text: `${plural(d.count ?? 0, 'order')} ${(d.count ?? 0) === 1 ? 'was' : 'were'} shelved and ${(d.count ?? 0) === 1 ? 'has' : 'have'} not reached the cloud.` }),
  hub_silent_long: () => ({ what: 'hub silent for a long time', text: 'No word from the hub for more than a day and a half.' }),
  sync_backlog: d => ({ what: 'bills waiting to sync', text: `${plural(d.count ?? 0, 'bill')} ${(d.count ?? 0) === 1 ? 'is' : 'are'} waiting to reach the cloud.` }),
  payment_past_due: () => ({ what: 'payment overdue', text: 'Payment is overdue.' }),
  service_hours_missing: () => ({ what: 'service hours missing', text: 'Service hours are not set, so a silent hub cannot be told from a shut restaurant.' })
};

/**
 * The words of one page: a one-line title and a short body. Only what the rule needs from `detail` is used, by name, so nothing else that ever lands
 * there (a phone number, a token) can reach a phone. `level` is 0 for the first page and 1..n for reminders.
 */
export function describeAlert(alert, level, config = ALERT_DEFAULTS) {
  const known = WORDS[alert.rule_key];
  const detail = alert.detail && typeof alert.detail === 'object' ? alert.detail : {};
  const { what, text } = known ? known(detail) : { what: alert.rule_key, text: `Rule ${alert.rule_key} is firing.` };
  const opened = readTime(alert.opened_at);
  const since = opened === null ? '' : ` Open since ${clockIn(opened, config.quiet.timeZone)}.`;
  const lead = level > 0 ? `Reminder ${level} of ${config.reminders}: ` : '';
  return {
    title: oneLine(`[${alert.severity}] ${lead}${alert.restaurant_name ?? 'Kullina'}: ${what}`),
    body: `${text}${since}`
  };
}
