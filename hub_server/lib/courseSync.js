import { withCourseState, normalizeCourse } from './courses.js';
import { resolveStation } from './kotRouting.js';

// What of a ticket's course state goes to the cloud (migration 008).
//
// The hub keeps three things per ticket (see lib/courses.js): whether it is served in courses,
// which courses have been fired, and a log of when each was fired and when each station finished
// it. The cloud used to hold only a coarse status ("in_progress" / "ready"), so an owner reading
// the cloud copy could not tell a ticket that was slow from one that was deliberately held.
//
//   orders.staged       boolean  -- served in courses?
//   orders.course_log   jsonb    -- { "1": { fired_at, stations_ready: { hot: iso }, ready_at?, ... } }
//   order_items.course  smallint -- the line's serving course
//   order_items.station text     -- hot | cold | bar
//
// `fired_courses` is not stored: every fired course has an entry in `course_log`, so it is its keys.

/** The order-level columns for a ticket, filling in state for one that predates courses. */
export function orderCourseColumns(ticket) {
  const t = withCourseState(ticket);
  return {
    staged: t?.staged === true,
    course_log: t?.course_log ?? null
  };
}

/** The line-level columns for one order line. */
export function itemCourseColumns(item) {
  return {
    course: normalizeCourse(item?.course),
    station: resolveStation(item?.station)
  };
}

const COURSE_COLUMNS = ['staged', 'course_log', 'course', 'station'];

/**
 * Whether the cloud refused a write because these columns do not exist there yet, i.e. migration 008
 * has not been applied. PostgREST reports an unknown column as PGRST204; Postgres itself as 42703.
 *
 * Deliberately narrow: it only matches when the message names one of OUR columns, so an unrelated
 * schema error is still a failure rather than being quietly retried without data.
 */
export function isMissingCourseColumn(error) {
  if (!error) return false;
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`;
  const schemaError = error.code === 'PGRST204' || error.code === '42703' || /could not find the .* column|column .* does not exist/i.test(text);
  return schemaError && COURSE_COLUMNS.some(c => new RegExp(`\\b${c}\\b`, 'i').test(text));
}

/** A copy of `record` without the course columns, for a cloud that has not been migrated. */
export function withoutCourseColumns(record) {
  const copy = { ...record };
  for (const c of COURSE_COLUMNS) delete copy[c];
  return copy;
}
