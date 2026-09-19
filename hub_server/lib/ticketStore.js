import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
      synced_to_cloud: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updatedList = [newTicket, ...this.tickets];
    this.saveTickets(updatedList);
    return newTicket;
  }

  markTicketReady(ticketId, restaurantId) {
    let updatedTicket = null;
    const updatedList = this.tickets.map(t => {
      if (t.id === ticketId || String(t.ticket_number) === String(ticketId)) {
        updatedTicket = { ...t, status: 'ready', updated_at: new Date().toISOString() };
        return updatedTicket;
      }
      return t;
    });

    if (updatedTicket) {
      this.saveTickets(updatedList);
    }
    return updatedTicket;
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
      const matchTable = String(t.table_id) === String(tableId) || 
                         String(t.table_name).toLowerCase() === `t${tableId}`.toLowerCase() || 
                         String(t.table_name).toLowerCase() === `table ${tableId}`.toLowerCase() ||
                         String(t.table_name) === String(tableId) ||
                         String(t.id) === String(tableId);
      if (matchTable && (t.status === 'in_progress' || t.status === 'ready')) {
        clearedCount++;
        const updated = { ...t, status: 'completed', updated_at: new Date().toISOString() };
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

  getActiveTickets(restaurantId) {
    return this.tickets.filter(t =>
      (!restaurantId || t.restaurant_id === restaurantId) &&
      (t.status === 'in_progress' || t.status === 'ready')
    );
  }

  getActiveTicketsForTable(tableId, restaurantId) {
    const idStr = String(tableId);
    return this.getActiveTickets(restaurantId).filter(t =>
      String(t.table_id) === idStr ||
      String(t.table_name).toLowerCase() === `t${idStr}`.toLowerCase() ||
      String(t.table_name).toLowerCase() === `table ${idStr}`.toLowerCase() ||
      String(t.table_name) === idStr
    );
  }

  getAllTickets(restaurantId) {
    return this.tickets.filter(t => !restaurantId || t.restaurant_id === restaurantId);
  }
}

export const ticketStore = new TicketStore();


