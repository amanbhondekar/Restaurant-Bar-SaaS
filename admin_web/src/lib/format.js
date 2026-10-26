// How the admin console's page says when something was read (invariant I8: every figure says when it was read). Plain functions of the moment they are
// given; none reads a clock unless it is handed one.

const NONE = '—';
const moment = iso => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

const hhmm = (t, timeZone) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) });
const dayKey = (t, timeZone) => new Date(t).toLocaleDateString('en-CA', { ...(timeZone ? { timeZone } : {}) });
const dayWords = (t, timeZone) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}) });

/**
 * "as of 10:02", in the viewer's own time zone unless one is given. When `now` is given and the reading was on another day, the day is said too, so an
 * old reading is not mistaken for a recent one. Something that is not a time is "time not known", never a time that never was.
 */
export function asOf(iso, timeZone, now) {
  const t = moment(iso);
  if (t === null) return 'time not known';
  const time = hhmm(t, timeZone);
  if (now === undefined || dayKey(t, timeZone) === dayKey(now, timeZone)) return `as of ${time}`;
  return `as of ${dayWords(t, timeZone)}, ${time}`;
}

/** When something happened, to the minute: "26 Oct 2026, 10:02". */
export function when(iso, timeZone) {
  const t = moment(iso);
  if (t === null) return NONE;
  const date = new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(timeZone ? { timeZone } : {}) });
  return `${date}, ${hhmm(t, timeZone)}`;
}

/** A request id short enough for a table: the first part of a UUID, or the id itself if it is short and plain. */
export function plainRequestId(id) {
  if (typeof id !== 'string' || !id || !/^[A-Za-z0-9._-]+$/.test(id)) return NONE;
  return /^[0-9a-f]{8}-/i.test(id) ? id.slice(0, 8) : id.slice(0, 16);
}
