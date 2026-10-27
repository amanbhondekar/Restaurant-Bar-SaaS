// One pass of the alert worker, and the loop that repeats it (Phase 2, P2-2; docs/SUPER_ADMIN_BUILD_SHEET.md §8).
//
// A pass reads the fleet, works out which alerts are true (common/alertRules.js), opens the new ones, resolves the ones that cleared, flags the ones nobody
// answered, and then pages whoever is due a page (common/alertEngine.js), recording each page that went out. It never decides anything itself: the rules and
// the timing are the pure modules', so the tests move the clock to the minute.
//
// Four things it is careful about:
//  - A page that could not be sent is NOT recorded as sent, so the next pass tries again; and only the kind of failure is kept (a channel's error message can
//    carry the address it called, token and all).
//  - A page that was sent but could not be recorded is sent again next pass. Paging is at-least-once: better twice than never.
//  - A pass that cannot see the whole fleet resolves nothing; a pass that cannot read the database does nothing.
//  - What the channel is given is a closed list of fields, so nothing else a row carries can reach a phone (invariant I9).
//
// The channel itself (Telegram or ntfy, decision D3) is the next task, P2-3. `notifier.send(message)` resolves when the page is delivered and rejects when it
// is not; it may put `publicNote` on the error, words that are safe to keep.

import { evaluateFleet } from '../../common/alertRules.js';
import { ALERT_DEFAULTS, reconcileAlerts, dueNotifications, unattendedAlerts, describeAlert, isQuietHours } from '../../common/alertEngine.js';
import { readTime } from '../../common/opsRules.js';

/** What may be kept about a failure: its own safe words if it has them, else only its kind. Never its message. */
function safeNote(err) {
  const words = typeof err?.publicNote === 'string' && err.publicNote.trim() ? err.publicNote : typeof err?.name === 'string' && err.name ? err.name : 'Error';
  return words.slice(0, 200);
}
const kindOf = err => `${typeof err?.name === 'string' && err.name ? err.name : 'Error'}${err?.code ? ` ${err.code}` : ''}`;

const openedFrom = c => ({ restaurant_id: c.restaurant_id, rule_key: c.rule_key, severity: c.severity, dedupe_key: c.dedupe_key, detail: c.detail });

/** Builds one pass. Throws at once if the quiet hours cannot be read or the database or channel is missing: a worker that is never quiet is not a fix. */
export function createTick({ db, notifier, config = ALERT_DEFAULTS }) {
  if (!db || typeof db.snapshot !== 'function' || typeof db.apply !== 'function') throw new TypeError('The alert worker needs a way to read and write alerts.');
  if (!notifier || typeof notifier.send !== 'function') throw new TypeError('The alert worker needs a channel to page through.');
  isQuietHours(0, config.quiet);   // throws if the quiet hours cannot be read

  return async function tick() {
    const seen = await db.snapshot();
    const now = readTime(seen.now);
    if (now === null) throw new Error('The database did not say what time it is.');

    const plan = reconcileAlerts(evaluateFleet(seen.tenants, seen.meta, now), seen.alerts, { complete: seen.complete });
    const flag = unattendedAlerts(seen.alerts, now, config).map(a => a.id);
    const requestId = `alert-worker:${seen.now}`;

    const changed = plan.open.length + plan.resolve.length + flag.length > 0;
    const applied = changed
      ? await db.apply({ open: plan.open.map(openedFrom), resolve: plan.resolve.map(r => ({ id: r.id, reason: r.reason })), unattended: flag }, requestId)
      : { opened: [], resolved: [], flagged: [] };

    // Page from what the database holds now, so a new alert has its id and a resolved one is no longer there to be paged.
    const current = changed ? await db.snapshot() : seen;
    const due = dueNotifications(current.alerts, readTime(current.now) ?? now, config);

    const out = { opened: applied.opened, resolved: applied.resolved, flagged: applied.flagged, notified: [], failed: [], errors: [] };
    for (const d of due) {
      const words = describeAlert(d.alert, d.level, config);
      const message = {
        alert_id: d.alert_id, level: d.level, kind: d.kind, urgency: d.urgency, severity: d.severity,
        restaurant_id: d.alert.restaurant_id ?? null, restaurant_name: d.alert.restaurant_name ?? null, title: words.title, body: words.body
      };
      try {
        await notifier.send(message);
      } catch (err) {
        out.failed.push(d.alert_id);
        try { await db.notifyFailed(d.alert_id, d.level, safeNote(err), requestId); } catch (inner) {
          out.errors.push(`a page for alert ${d.alert_id} failed (${kindOf(err)}) and that could not be recorded (${kindOf(inner)})`);
        }
        continue;
      }
      try {
        if (await db.notified(d.alert_id, d.level, requestId)) out.notified.push(d.alert_id);
      } catch (err) {
        out.errors.push(`a page for alert ${d.alert_id} was sent but could not be recorded (${kindOf(err)}); it will be sent again`);
      }
    }
    return out;
  };
}

const line = s => `[alert_worker] opened ${s.opened?.length ?? 0}, resolved ${s.resolved?.length ?? 0}, flagged ${s.flagged?.length ?? 0}, paged ${s.notified?.length ?? 0}, `
  + `failed ${s.failed?.length ?? 0}${s.errors?.length ? `, ${s.errors.length} problem(s): ${s.errors.join('; ')}` : ''}`;

/**
 * Runs `tick` now and then again `intervalMs` after each pass finishes, so two passes never overlap. A pass that throws is logged and the loop carries on.
 * `stop()` cancels the next pass and waits for the one running.
 */
export function startWorker({ tick, intervalMs, log = console.log, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false;
  let timer = null;
  let current = null;

  const run = async () => {
    if (stopped || current) return;
    current = (async () => {
      try { log(line(await tick())); } catch (err) { log(`[alert_worker] a pass failed: ${kindOf(err)}: ${err?.message ?? err}`); }
    })();
    await current;
    current = null;
    if (!stopped) timer = setTimer(run, intervalMs);
  };
  run();

  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      await current;
    }
  };
}
