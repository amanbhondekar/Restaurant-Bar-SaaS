// The reception Kitchen Display's board: what a live message from the hub does to the tickets on screen, and how the
// "connected" light follows the socket. Pulled out of src/kitchen_main.jsx so they can be tested without rendering a
// 2,000-line component; it behaves exactly as the inline code did.

import { mergeTicketInto } from './kitchenBill.js';

const sameTicket = (t, other) => t.id === other.id || String(t.ticket_number) === String(other.ticket_number);

/**
 * Apply one live message. Returns `{ tickets, refetch, sync }`:
 *   - `refetch` asks the screen to read the whole list again, for events that remove tickets without saying which;
 *   - `sync` is the new sync status when the message carries one, otherwise null.
 * Messages it does not know leave the board alone, so a newer hub cannot break an older screen.
 */
export function applyLiveMessage(tickets, message) {
  const type = message?.type;
  const payload = message?.payload || {};
  const unchanged = { tickets, refetch: false, sync: null };

  switch (type) {
    case 'NEW_ORDER':
    case 'order_created': {
      const added = payload.ticket || payload;
      if (!added || !(added.id || added.ticket_number)) return unchanged;
      if (tickets.some(t => sameTicket(t, added))) return unchanged;
      return { tickets: [added, ...tickets], refetch: false, sync: null };
    }
    case 'TICKET_READY':
    case 'order_ready': {
      const ready = payload.ticket || payload;
      const readyId = ready.ticket_id || ready.id || ready.ticket_number;
      if (!readyId) return unchanged;
      return {
        // Take the hub's whole ticket when it sent one, so the course and station state is current.
        tickets: tickets.map(t => (t.id === readyId || String(t.ticket_number) === String(readyId) ? { ...t, ...(payload.ticket || {}), status: 'ready' } : t)),
        refetch: false,
        sync: null
      };
    }
    case 'TICKET_UPDATED':
      // Station ready, course fired, ticket recalled: the hub sends the ticket as it now stands.
      if (!payload.ticket) return unchanged;
      return { tickets: mergeTicketInto(tickets, payload.ticket), refetch: false, sync: null };
    case 'TICKET_CANCELLED': {
      const gone = payload.ticket_id || payload.ticket?.id;
      return { tickets: gone ? tickets.filter(t => t.id !== gone) : tickets, refetch: true, sync: null };
    }
    case 'CLEAR_TABLE':
    case 'bill_cleared':
    case 'order_cleared':
      return { tickets, refetch: true, sync: null };
    case 'SYNC_STATUS_CHANGE':
      return { tickets, refetch: true, sync: payload };
    default:
      return unchanged;
  }
}

/** The ticket after the hub accepted "mark ready": the hub's copy if it sent one, and ready either way. */
export function markedReady(tickets, ticket, reply) {
  return tickets.map(t => (t.id === ticket.id || t.ticket_number === ticket.ticket_number ? { ...t, ...(reply?.ticket || {}), status: 'ready' } : t));
}

/**
 * The light after the socket closes. For the first few seconds after the page opens a failed connection is shown as
 * still "connecting" (a hub that is a moment slow should not flash red), unless it has already failed twice.
 */
export function statusAfterClose({ failures, inGracePeriod }) {
  return !inGracePeriod || failures >= 2 ? 'disconnected' : 'connecting';
}

/** The light when the grace period ends: red only if the socket has failed at least twice by then. */
export function statusAfterGrace({ failures, current }) {
  return failures >= 2 ? 'disconnected' : current;
}
