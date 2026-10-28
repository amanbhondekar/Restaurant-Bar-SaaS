import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initCourseState, markAllReady, markStationReady, fireCourse, recallTicket, cancelTicket, withCourseState } from './courses.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initial demo seed tickets if clean start
const INITIAL_TICKETS = [
  {
    id: 't_seed_101',
    ticket_number: 101,
    restaurant_id: '11111111-1111-1111-1111-111111111111',
    table_id: 4,
    table_name: 'T4',
    items: [
      { id: 'm9', name: 'Mutton Biryani', qty: 2, price: 320 },
      { id: 'm5', name: 'Mutton Saoji', qty: 1, price: 340 },
      { id: 'm19', name: 'Butter Naan', qty: 4, price: 80 }
    ],
    total_amount: 1300,
    status: 'in_progress',
    note: 'Extra spicy Saoji masala',
    created_by_waiter: 'Vikram (W1)',
    synced_to_cloud: true,
    created_at: new Date(Date.now() - 25 * 60000).toISOString(),
    updated_at: new Date(Date.now() - 25 * 60000).toISOString()
  },
  {
    id: 't_seed_102',
    ticket_number: 102,
    restaurant_id: '11111111-1111-1111-1111-111111111111',
    table_id: 10,
    table_name: 'T10',
    items: [
      { id: 'm6', name: 'Chicken Saoji', qty: 2, price: 280 },
      { id: 'm20', name: 'Garlic Naan', qty: 3, price: 90 },
      { id: 'm23', name: 'Sol Kadhi', qty: 2, price: 60 },
      { id: 'm15', name: 'Veg Kolhapuri', qty: 1, price: 190 }
    ],
    total_amount: 1140,
    status: 'in_progress',
    note: 'Less oil in Kolhapuri',
    created_by_waiter: 'Sanjay (W2)',
    synced_to_cloud: true,
    created_at: new Date(Date.now() - 12 * 60000).toISOString(),
    updated_at: new Date(Date.now() - 12 * 60000).toISOString()
  }
];

/**
 * Does this ticket belong to the table `tableId` (named `tableName`, when the caller knows it)?
 *
 * A ticket that carries a table id belongs to exactly that table: the id is compared and
 * nothing else. Matching it on its name as well would let a table capture the open bill of
 * another one whenever their names and ids line up by accident (a table the hub numbers 1
 * next to a cloud table named "T1"; a table renamed away from "T5" next to a new one called
 * "T5"), and the next clear would invoice and complete someone else's tickets.
 *
 * Only a legacy ticket with no table id (null, undefined or '') falls back to its table name:
 * "t<id>", "table <id>", the bare id, and the table's own name when it is given.
 * Every place that asks "which tickets are on this table" must use this one rule.
 */
export function ticketMatchesTable(ticket, tableId, tableName) {
  const ticketTableId = ticket?.table_id;
  if (ticketTableId !== null && ticketTableId !== undefined && ticketTableId !== '') {
    return String(ticketTableId) === String(tableId);
  }

  const name = ticket?.table_name == null ? '' : String(ticket.table_name);
  const lowerName = name.toLowerCase();
  const id = String(tableId);
  const lowerId = id.toLowerCase();
  return lowerName === `t${lowerId}` ||
         lowerName === `table ${lowerId}` ||
         name === id ||
         (tableName != null && tableName !== '' && lowerName === String(tableName).toLowerCase());
}

class TicketStore {
  constructor() {
    this.tickets = this.loadTickets();
  }

  loadTickets() {
    try {
      if (fs.existsSync(TICKETS_FILE)) {
        const raw = fs.readFileSync(TICKETS_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('⚠️ Could not load tickets.json:', err.message);
    }
    this.saveTickets(INITIAL_TICKETS);
    return INITIAL_TICKETS;
  }

  saveTickets(ticketsList) {
    this.tickets = ticketsList;
    // Non-blocking async write to disk
    fs.promises.writeFile(TICKETS_FILE, JSON.stringify(ticketsList, null, 2), 'utf-8')
      .catch(err => console.error('❌ Async save tickets error:', err));
    return true;
  }

  getNextTicketNumber(restaurantId) {
    const restTickets = this.tickets.filter(t => t.restaurant_id === restaurantId);
    if (!restTickets.length) return 101;
    const maxNum = Math.max(...restTickets.map(t => Number(t.ticket_number) || 0));
    return maxNum + 1;
  }

  /**
   * `priced` must come from priceOrder() in lib/pricing.js -- it carries the
   * hub's own item names, prices and total. Client-supplied prices are never
   * trusted, so this method deliberately does not compute a total from
   * orderData.items.
   */
  addTicket(orderData, restaurantId, priced) {
    if (!priced || !Array.isArray(priced.items)) {
      throw new Error('addTicket requires server-priced items from priceOrder()');
    }

    const nextNum = this.getNextTicketNumber(restaurantId);
    const items = priced.items;
    const totalAmount = priced.total_amount;

    const ticketId = 't_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const nowIso = new Date().toISOString();
    // Course state (see lib/courses.js). `course_service: true` from the waiter holds later courses
    // until they are fired; anything else is a normal ticket, exactly as before.
    const courseState = initCourseState(items, { staged: orderData.course_service === true }, nowIso);

    const newTicket = {
      id: ticketId,
      ticket_number: nextNum,
      restaurant_id: restaurantId,
      table_id: orderData.table_id ?? orderData.tableId ?? null,
      table_name: orderData.table_name || orderData.tableName || 'Table',
      items,
      total_amount: totalAmount,
      status: 'in_progress',
      note: orderData.note || '',
      created_by_waiter: orderData.created_by_waiter || orderData.createdByWaiter || 'Waiter Handset',
      order_request_id: orderData.order_request_id || null,
      synced_to_cloud: false,
      ...courseState,
      created_at: nowIso,
      updated_at: nowIso
    };

    const updatedList = [newTicket, ...this.tickets];
    this.saveTickets(updatedList);
    return newTicket;
  }

  /** Find a ticket by id or ticket number, scoped to the tenant when one is given. */
  findTicket(ticketId, restaurantId) {
    return this.tickets.find(t =>
      (t.id === ticketId || String(t.ticket_number) === String(ticketId)) &&
      (!restaurantId || t.restaurant_id === restaurantId)
    ) || null;
  }

  /** Replace one ticket and persist. */
  replaceTicket(updated) {
    this.saveTickets(this.tickets.map(t => (t.id === updated.id ? updated : t)));
    return updated;
  }

  /**
   * Apply a pure transition from lib/courses.js to a ticket. `fn(ticket, nowIso)` returns
   * `{ ok, ticket, ...extra }` or a refusal `{ ok: false, code, error }`. The store only persists
   * on success. Returns `{ ok: false, code: 'NOT_FOUND' }` for an unknown ticket.
   */
  transition(ticketId, restaurantId, fn) {
    const current = this.findTicket(ticketId, restaurantId);
    if (!current) return { ok: false, code: 'NOT_FOUND', error: 'Ticket not found.' };
    const result = fn(current, new Date().toISOString());
    if (!result.ok) return result;
    this.replaceTicket(result.ticket);
    return result;
  }

  /** The whole-ticket "Ready" button. Returns the ticket, or null if it does not exist or is closed. */
  markTicketReady(ticketId, restaurantId) {
    const r = this.transition(ticketId, restaurantId, (t, now) => markAllReady(t, now));
    return r.ok ? r.ticket : null;
  }

  /** One station reports its part of the ticket ready. */
  markStationReady(ticketId, restaurantId, station) {
    return this.transition(ticketId, restaurantId, (t, now) => markStationReady(t, station, now));
  }

  /** Send the next held course (or a given one) to the kitchen. */
  fireCourse(ticketId, restaurantId, course) {
    return this.transition(ticketId, restaurantId, (t, now) => fireCourse(t, course, now));
  }

  /** Withdraw a ticket. `{ ok, ticket, cooked }`, or a refusal; nothing is persisted on a refusal. */
  cancel(ticketId, restaurantId, ctx) {
    return this.transition(ticketId, restaurantId, (t, now) => cancelTicket(t, now, ctx));
  }

  /** Put a ticket marked ready back on the board. */
  recall(ticketId, restaurantId) {
    return this.transition(ticketId, restaurantId, (t, now) => recallTicket(t, now));
  }

  markTicketSynced(ticketId) {
    const updatedList = this.tickets.map(t => {
      if (t.id === ticketId) {
        return { ...t, synced_to_cloud: true, updated_at: new Date().toISOString() };
      }
      return t;
    });
    this.saveTickets(updatedList);
  }

  clearTableTickets(tableId, restaurantId) {
    let clearedCount = 0;
    const clearedTickets = [];
    const updatedList = this.tickets.map(t => {
      const matchTable = ticketMatchesTable(t, tableId) ||
                         String(t.id) === String(tableId);
      if (matchTable && (t.status === 'in_progress' || t.status === 'ready')) {
        clearedCount++;
        // Remember what the ticket looked like BEFORE clearing so a later
        // void on the issued invoice can restore it verbatim.
        const updated = {
          ...t,
          status: 'completed',
          pre_clear_status: t.status,
          updated_at: new Date().toISOString()
        };
        clearedTickets.push(updated);
        return updated;
      }
      return t;
    });

    if (clearedCount > 0) {
      this.saveTickets(updatedList);
    }
    return { clearedCount, clearedTickets };
  }

  /**
   * Reopen a set of previously cleared tickets, restoring their pre-clear
   * status when known. Used by invoice void: an in-error close should not
   * strand the guest's KOTs in `completed` land.
   *
   * Returns the ids of tickets actually reopened, ignoring any that don't
   * exist any more, are still open, or belong to another tenant.
   */
  reopenTickets(ticketIds, restaurantId) {
    if (!Array.isArray(ticketIds) || ticketIds.length === 0) return [];
    const idSet = new Set(ticketIds.map(String));
    const reopened = [];
    const updatedList = this.tickets.map(t => {
      if (!idSet.has(String(t.id))) return t;
      if (restaurantId && t.restaurant_id !== restaurantId) return t;
      if (t.status !== 'completed') return t;
      reopened.push(t.id);
      const restored = t.pre_clear_status === 'ready' ? 'ready' : 'in_progress';
      const { pre_clear_status: _prev, ...rest } = t;
      return { ...rest, status: restored, updated_at: new Date().toISOString() };
    });
    if (reopened.length > 0) {
      this.saveTickets(updatedList);
    }
    return reopened;
  }

  getActiveTickets(restaurantId) {
    // Tickets saved before course state existed are filled in on the way out (not persisted), so the
    // kitchen screen can treat every ticket the same way.
    return this.tickets
      .filter(t =>
        (!restaurantId || t.restaurant_id === restaurantId) &&
        (t.status === 'in_progress' || t.status === 'ready')
      )
      .map(withCourseState);
  }

  getActiveTicketsForTable(tableId, restaurantId) {
    return this.getActiveTickets(restaurantId).filter(t => ticketMatchesTable(t, tableId));
  }

  getAllTickets(restaurantId) {
    return this.tickets.filter(t => !restaurantId || t.restaurant_id === restaurantId);
  }
}

export const ticketStore = new TicketStore();


