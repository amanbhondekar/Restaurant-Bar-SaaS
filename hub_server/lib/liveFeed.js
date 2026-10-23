// What each kind of connection is told over the live feed (/live), and what a kitchen screen is shown of a ticket.
//
// A kitchen screen needs the board: tickets, courses, which station is cooking what. It has no use for what a table
// owes, what a dish costs, whether a bill was voided or how the cloud sync is doing. The feed used to send every
// event to every connection, so a screen enrolled with the narrow `kitchen` scope still heard every bill. Here the
// decision is one pure function, so it can be pinned by tests and read in one place.
//
// The rule is default-deny at every level, for a narrow connection:
//   - an event reaches a kitchen screen only if it is named in KITCHEN_EVENTS;
//   - within an event, only the keys in EVENT_FIELDS;
//   - within a ticket, only the fields in TICKET_FIELDS, and within a line or an extra only ITEM_FIELDS / MODIFIER_FIELDS.
// So a new event, a new key on an event, or a new field on a ticket (a guest's phone number, a payment reference, a
// discount) tells a kitchen nothing until someone decides it should. The earlier version stripped money and let
// everything else through, which protects against the fields we thought of.

/** Events a kitchen screen is sent. Everything on the board, and the notice that a table was cleared. */
export const KITCHEN_EVENTS = new Set([
  'NEW_ORDER', 'order_created',
  'TICKET_UPDATED', 'COURSE_FIRED', 'STATION_READY', 'TICKET_RECALLED', 'TICKET_READY', 'order_ready',
  'TICKET_CANCELLED',
  'CLEAR_TABLE', 'bill_cleared', 'order_cleared'
]);

/** What the station screens and the board read of a ticket. */
export const TICKET_FIELDS = [
  'id', 'ticket_number', 'table_id', 'table_name', 'status', 'note', 'created_by_waiter', 'items',
  'staged', 'fired_courses', 'course_log',
  'created_at', 'updated_at', 'cancelled_at', 'cancel_reason', 'cancel_cooked'
];
export const ITEM_FIELDS = ['id', 'name', 'qty', 'station', 'course', 'variant_id', 'variant_label', 'day_part_label', 'modifiers'];
export const MODIFIER_FIELDS = ['group_id', 'option_id', 'group_label', 'option_label'];
/** The keys an event may carry to a kitchen: which ticket and table, what happened, and the ticket itself. */
export const EVENT_FIELDS = [
  'ticket_id', 'order_id', 'ticket_number', 'table_id', 'table_name', 'status', 'course', 'station', 'cleared_count', 'created_at', 'items', 'ticket'
];

function pick(object, keys) {
  const out = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(object, key)) out[key] = object[key];
  return out;
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function kitchenItems(items) {
  return items.map(line => {
    if (!isObject(line)) return line;
    const out = pick(line, ITEM_FIELDS);
    if (Array.isArray(out.modifiers)) out.modifiers = out.modifiers.map(m => (isObject(m) ? pick(m, MODIFIER_FIELDS) : m));
    return out;
  });
}

/**
 * A ticket as a kitchen screen is allowed to see it: the lines, quantities, notes and course state it draws, and nothing
 * else (no total, no prices, no stock used, no tenant or request ids, nothing added later). Returns a copy; the hub's own
 * ticket is never touched. Anything that is not an object comes back as it was, so a half-formed payload cannot throw in
 * the middle of a broadcast.
 */
export function kitchenTicket(ticket) {
  if (!isObject(ticket)) return ticket;
  const out = pick(ticket, TICKET_FIELDS);
  if ('items' in out) {
    if (Array.isArray(out.items)) out.items = kitchenItems(out.items);
    else delete out.items;
  }
  return out;
}

/** An event's payload narrowed for a kitchen. A payload that IS a ticket (NEW_ORDER sends one) is narrowed as a ticket. */
function kitchenPayload(payload) {
  if (typeof payload.id === 'string' && payload.ticket === undefined && Array.isArray(payload.items)) return kitchenTicket(payload);
  const out = pick(payload, EVENT_FIELDS);
  if (Array.isArray(out.items)) out.items = kitchenItems(out.items); else delete out.items;
  if ('ticket' in out) out.ticket = kitchenTicket(out.ticket);
  return out;
}

/**
 * The payload to send to a connection of this scope for this event, as `{ payload }`, or null for "send nothing".
 * A full-scope connection (a handset, or the reception laptop) is sent everything, untouched.
 */
export function feedFor(scope, type, payload) {
  if (scope === 'full') return { payload };
  if (scope !== 'kitchen' || !KITCHEN_EVENTS.has(type)) return null;
  if (!isObject(payload)) return { payload };
  return { payload: kitchenPayload(payload) };
}

/** The greeting sent on connecting. A kitchen screen gets who it is connected to and how many tickets are open: no menu prices, no sync detail, no table list. */
export function connectedFor(scope, greeting) {
  if (scope === 'full') return greeting;
  return { pairing: greeting.pairing, active_tickets_count: greeting.active_tickets_count };
}
