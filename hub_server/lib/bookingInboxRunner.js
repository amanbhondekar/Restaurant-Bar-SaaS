// Checking the booking inbox, on a timer and when reception asks (§4.6). Kept apart from the routes so it can be tested without a hub or a
// cloud: it is handed how to get a cloud session and how to pull, and does only what is its own.
//
//   * Two checks at once are one check: asked while one is running, it gives that check's answer.
//   * A check that did not work is remembered as a failure, never as "nothing new", and the time of the last check that DID work is kept
//     through it, so the screen can say "last checked at 12:03, and the last attempt failed".
//   * It never throws. It runs from a timer, and an exception there would take the hub down.

export const CLOUD_DOWN = { success: false, code: 'CLOUD', error: 'The hub could not reach the cloud. Check the internet connection and try again.' };

/** `promise`'s answer, or null if it has not come within `ms`: for a read that has to wait for the internet and must not hold up a screen. */
export function withinMs(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

export function createInboxRunner({ cloudSession, pull, now = () => new Date() }) {
  let running = null;
  let last = { at: null, ok: null };
  const failed = () => { last = { at: last.at, ok: false }; return CLOUD_DOWN; };

  const run = () => {
    if (running) return running;
    running = (async () => {
      try {
        const cloud = await cloudSession();
        if (!cloud) return failed();
        const result = await pull(cloud);
        last = { at: result.ok ? now().toISOString() : last.at, ok: result.ok };
        return result;
      } catch (err) {
        console.warn('⚠️ Booking inbox check failed:', err.message);
        return failed();
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return { run, last: () => ({ ...last }) };
}
