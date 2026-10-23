// What each kind of connection is told over the live feed (/live), and what a kitchen screen is shown of a ticket.
//
// A kitchen screen needs the board: tickets, courses, which station is cooking what. It has no use for what a table
// owes, what a dish costs, whether a bill was voided or how the cloud sync is doing. The feed used to send every
// event to every connection, so a screen enrolled with the narrow `kitchen` scope still heard every bill. Here the
// decision is one pure function, so it can be pinned by tests and read in one place.
//
// The rule is default-deny for a narrow connection: an event is sent to a kitchen screen only if it is named below,
// so a new event type added to the hub tells a kitchen nothing until someone decides it should.

/** Events a kitchen screen is sent. Everything on the board, and the notice that a table was cleared. */
export const KITCHEN_EVENTS = new Set([
  'NEW_ORDER', 'order_created',
  'TICKET_UPDATED', 'COURSE_FIRED', 'STATION_READY', 'TICKET_RECALLED', 'TICKET_READY', 'order_ready',
  'TICKET_CANCELLED',
  'CLEAR_TABLE', 'bill_cleared', 'order_cleared'
]);

const LINE_MONEY = ['price', 'line_total'];
const EXTRA_MONEY = ['price', 'price_delta'];

function withoutKeys(object, keys) {
  const copy = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * A ticket as a kitchen screen is allowed to see it: the same lines, quantities, notes and course state, without
 * the total, each line's price, or each extra's price. Returns a copy; the hub's own ticket is never touched.
 * Anything that is not an object comes back as it was, so a half-formed payload cannot throw in the middle of a
 * broadcast.
 */
export function withoutMoney(ticket) {
  if (!ticket || typeof ticket !== 'object') return ticket;
  const copy = withoutKeys(ticket, ['total_amount']);
  if (Array.isArray(copy.items)) {
    copy.items = copy.items.map(line => {
      if (!line || typeof line !== 'object') return line;
      const stripped = withoutKeys(line, LINE_MONEY);
      if (Array.isArray(stripped.modifiers)) {
        stripped.modifiers = stripped.modifiers.map(m => (m && typeof m === 'object' ? withoutKeys(m, EXTRA_MONEY) : m));
      }
      return stripped;
    });
  }
  return copy;
}

/**
 * The payload to send to a connection of this scope for this event, as `{ payload }`, or null for "send nothing".
 * A full-scope connection (a handset, or the reception laptop) is sent everything, untouched.
 */
export function feedFor(scope, type, payload) {
  if (scope === 'full') return { payload };
  if (scope !== 'kitchen' || !KITCHEN_EVENTS.has(type)) return null;

  if (!payload || typeof payload !== 'object') return { payload };
  const stripped = withoutKeys(withoutMoney(payload), ['grand_total', 'invoice_number']);
  if (stripped.ticket) stripped.ticket = withoutMoney(stripped.ticket);
  return { payload: stripped };
}

/** The greeting sent on connecting. A kitchen screen gets who it is connected to and how many tickets are open: no menu prices, no sync detail, no table list. */
export function connectedFor(scope, greeting) {
  if (scope === 'full') return greeting;
  return { pairing: greeting.pairing, active_tickets_count: greeting.active_tickets_count };
}
