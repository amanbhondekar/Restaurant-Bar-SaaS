// The hub's report on itself (§4.9): every few minutes it tells the cloud it is alive and how its sync is doing, so that the operator
// console can show which restaurants have gone quiet. Until now the only sign of life the cloud had was a bill arriving, which on a
// quiet day is no sign at all.
//
// Counts and times only. Never a name, a token, a PIN, a bill or a guest: the operator is told how the hub is, not what it holds.
//
// What the hub does not know is said as nothing, not as a comfortable zero or a time that never was. And a report that did not get
// through is a failure the hub can show, never a success: the runner keeps the time of the last report that DID get through beside it.

const MAX_VERSION = 40;   // what the cloud's column holds

/** A whole number of things, never negative. A number, or a number written as text; anything else (true, a list, nothing) is none. */
const count = value => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** A moment as the cloud keeps it, or null if `value` is not one. Only a date or a written date is: `Date.parse('5')` is a day in 2001. */
const moment = value => {
  const t = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** What the hub says about itself, as the row the cloud keeps (migration 021): these eight things and nothing else. */
export function buildReport({ now = new Date(), startedAt, version, sync, devices, waiters } = {}) {
  const queue = sync && typeof sync === 'object' ? sync : {};
  const named = typeof version === 'string' ? version.trim().slice(0, MAX_VERSION) : '';
  return {
    reported_at: now.toISOString(),
    started_at: moment(startedAt),
    version: named || null,
    queued: count(queue.queued),
    quarantined: count(queue.quarantined),
    last_synced_at: moment(queue.last_synced_at),
    devices: count(devices),
    waiters: count(waiters)
  };
}

/**
 * What the hub knows of itself at the moment it is asked, for `buildReport`: the queue's own account of itself, and how many handsets and
 * waiters it has. Asked afresh each time, so a queue that grew is reported as grown. Handed the things it asks, so it can be tested without a hub.
 */
export const makeCollector = ({ startedAt, version, syncQueue, deviceAuth, waiterStore }) => () => ({
  startedAt,
  version,
  sync: syncQueue.getStatus(),
  devices: deviceAuth.activeDeviceCount(),
  waiters: waiterStore.listActive().length
});

/** Say it to the cloud, as the restaurant the hub is signed in as. Never throws: it is `{ ok: true }` or `{ ok: false, error }`. */
export async function sendReport(client, restaurantId, report) {
  try {
    const { error } = await client.from('hub_status').upsert({ ...report, restaurant_id: restaurantId }, { onConflict: 'restaurant_id' });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Reporting on a timer. `cloudSession()` gives `{ rid, client }` or null while the hub has no cloud; `collect()` says what the hub knows
 * at the moment of sending (so a queue that grew is reported as grown).
 *
 *   * Two at once are one: asked while one is running, it gives that one's answer.
 *   * A report that did not get through is remembered as a failure, and the time of the last one that DID is kept through it.
 *   * It never throws. It runs from a timer, and an exception there would take the hub down.
 */
export function createHeartbeatRunner({ cloudSession, collect, now = () => new Date() }) {
  let running = null;
  let last = { at: null, ok: null };
  const failed = error => { last = { at: last.at, ok: false }; return { ok: false, code: 'FAILED', error }; };

  const run = () => {
    if (running) return running;
    running = (async () => {
      try {
        const cloud = await cloudSession();
        if (!cloud) return failed('The hub has no cloud sign-in.');
        const report = buildReport({ ...collect(), now: now() });
        const sent = await sendReport(cloud.client, cloud.rid, report);
        if (!sent.ok) return failed(sent.error);
        last = { at: report.reported_at, ok: true };
        return { ok: true, at: report.reported_at };
      } catch (err) {
        console.warn('⚠️ Hub report failed:', err.message);
        return failed(err.message);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return { run, last: () => ({ ...last }) };
}
