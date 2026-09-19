import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

import fs from 'fs';

import { hubConfig } from './lib/hubConfig.js';
import { ticketStore } from './lib/ticketStore.js';
import { syncQueue } from './lib/syncQueue.js';
import { authenticateHubStaff } from './lib/supabaseClient.js';
import { restaurantCache } from './lib/restaurantCache.js';
import { priceOrder } from './lib/pricing.js';
import { buildInvoicePreview } from './lib/invoice.js';
import { invoiceStore } from './lib/invoiceStore.js';
import { deviceAuth, requireDevice, extractToken, isLoopback, trustLocalAddress } from './lib/deviceAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const app = express();
const server = http.createServer(app);

// CORS is restricted to LAN/loopback origins. A wildcard here let any website a
// staff phone opened silently POST to the POS (e.g. /tables/1/clear).
const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

app.use(cors({
  origin(origin, callback) {
    // Non-browser clients (handset fetch, curl) send no Origin at all.
    if (!origin) return callback(null, true);
    try {
      const { hostname } = new URL(origin);
      return callback(null, PRIVATE_HOST.test(hostname));
    } catch {
      return callback(null, false);
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '256kb' }));

// -------------------------------------------------------------
// LAN IP Detection Helper
// -------------------------------------------------------------
function getLanIp() {
  const interfaces = os.networkInterfaces();
  let fallbackIp = '127.0.0.1';

  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && !alias.internal && alias.address !== '127.0.0.1') {
        // Skip VirtualBox host-only subnet 192.168.56.x
        if (alias.address.startsWith('192.168.56.')) continue;

        if (/wi-fi|wifi|wlan/i.test(devName)) {
          return alias.address;
        }
        fallbackIp = alias.address;
      }
    }
  }
  return fallbackIp;
}

const LAN_IP = getLanIp();
const SERVER_URL = `http://${LAN_IP}:${PORT}`;

// The KDS is often opened as http://<LAN-IP>:4000 on the reception laptop itself.
// Those requests are not loopback but do come from this same machine.
trustLocalAddress(LAN_IP);

// -------------------------------------------------------------
// WebSocket Layer (Live Real-Time Push to Kitchen KDS & Waiter Handsets)
// -------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const connectedClients = new Set();

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = url;

  if (pathname !== '/live' && pathname !== '/ws') {
    return socket.destroy();
  }

  // The live feed carries every ticket and table total, so it needs the same
  // authorisation as the REST endpoints.
  const token = url.searchParams.get('token');
  if (!isLoopback(request) && !deviceAuth.verifyToken(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

function broadcast(type, payload) {
  const pairing = hubConfig.getPairingInfo();
  const message = JSON.stringify({
    type,
    payload,
    restaurant_id: pairing.restaurant_id,
    timestamp: Date.now()
  });

  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws, req) => {
  connectedClients.add(ws);
  console.log(`📱 Client connected over LAN WebSocket (Total active: ${connectedClients.size})`);

  // Send initial connection handshake with pairing & sync info.
  // Only safe fields: the raw config carries the enrollment code and the
  // issued device token hashes.
  const pairing = hubConfig.getPairingInfo();
  const safePairing = {
    paired: pairing.paired,
    restaurant_id: pairing.restaurant_id,
    name: pairing.name,
    city: pairing.city
  };
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    payload: {
      pairing: safePairing,
      sync: syncQueue.getStatus(),
      active_tickets_count: ticketStore.getActiveTickets(pairing.restaurant_id).length,
      menu: restaurantCache.getMenuCache(pairing.restaurant_id),
      tables_layout: restaurantCache.getTablesCache(pairing.restaurant_id)
    }
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
    } catch (err) {
      console.warn('Malformed WS payload received');
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log(`📱 Client disconnected from LAN WebSocket (Total active: ${connectedClients.size})`);
  });
});

// Broadcast sync queue status changes to all connected WS clients
syncQueue.onStatusChange((status) => {
  broadcast('SYNC_STATUS_CHANGE', status);
});

// -------------------------------------------------------------
// HTTP REST Endpoints
// -------------------------------------------------------------

// 0. POST /auth/device — exchange the KDS-displayed enrollment code for a token
app.post('/auth/device', (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const result = deviceAuth.enroll(req.body?.enrollment_code, req.body?.device_label || 'Handset', ip);

  if (!result.ok) {
    console.warn(`🔒 Device enrollment refused for ${ip}: ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }

  console.log(`🔓 Device enrolled from ${ip} (${req.body?.device_label || 'Handset'})`);
  res.json({ success: true, device_token: result.device_token, expires_at: result.expires_at });
});

// 1. GET /pairing-info — public health probe used by handsets before enrolling.
// Deliberately omits enrollment_code, kitchen_pin and issued device tokens:
// this endpoint is reachable by anything on the LAN.
app.get('/pairing-info', (req, res) => {
  const info = hubConfig.getPairingInfo();
  const authorised = isLoopback(req) || deviceAuth.verifyToken(extractToken(req));

  res.json({
    paired: info.paired,
    restaurant_id: info.restaurant_id,
    name: info.name,
    city: info.city,
    lan_ip: LAN_IP,
    port: PORT,
    server_url: SERVER_URL,
    ws_url: `ws://${LAN_IP}:${PORT}/live`,
    authorised,
    // Shown on the KDS screen itself so staff can read the code off the display.
    ...(isLoopback(req) ? { enrollment_code: deviceAuth.getEnrollmentCode(), pairing_code: info.pairing_code } : {})
  });
});

// 2. POST /pair
app.post('/pair', requireDevice, async (req, res) => {
  const { pairing_code } = req.body;
  const result = await hubConfig.pairWithCode(pairing_code);
  if (result.success) {
    broadcast('PAIRING_UPDATED', result.restaurant);
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

// In-memory idempotency cache for order_request_id (60s TTL)
const recentRequests = new Map();

// 3. POST /orders — Waiter submits order over local WiFi
app.post('/orders', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  if (!pairing.paired) {
    return res.status(400).json({ error: 'Hub server is not paired to a restaurant yet.' });
  }

  const orderData = req.body;
  if (!orderData || !orderData.items || !orderData.items.length) {
    return res.status(400).json({ error: 'Order must contain at least 1 item.' });
  }

  // Idempotency check: if order_request_id seen within 60s, return original ticket immediately
  const reqId = orderData.order_request_id || orderData.requestId;
  if (reqId && recentRequests.has(reqId)) {
    console.log(`⚡ Idempotent hit: duplicate request_id '${reqId}' received. Returning original ticket.`);
    const existingTicket = recentRequests.get(reqId);
    return res.status(200).json({
      success: true,
      duplicate: true,
      message: 'Duplicate order request received; returning original ticket',
      ticket: existingTicket
    });
  }

  // Step 0: Re-price the order against the hub's own menu. Prices and names in
  // the request body are ignored entirely -- a tampered handset must not be able
  // to set what a guest is billed.
  const priced = priceOrder(orderData.items, pairing.restaurant_id);
  if (!priced.ok) {
    console.warn(`🧾 Order rejected at pricing: ${priced.error}`, priced.details || '');
    return res.status(400).json({ error: priced.error, code: priced.code, details: priced.details });
  }

  // Step 1: Assign ticket number & update memory store
  const newTicket = ticketStore.addTicket(orderData, pairing.restaurant_id, priced);

  // Step 2: Instantly push ticket to all connected Kitchen Display & Waiter WS clients over LAN BEFORE disk write
  const orderCreatedPayload = {
    order_id: newTicket.id,
    ticket_id: newTicket.id,
    ticket_number: newTicket.ticket_number,
    table_id: newTicket.table_id,
    table_name: newTicket.table_name,
    items: newTicket.items,
    status: 'in_progress',
    total_amount: newTicket.total_amount,
    created_at: newTicket.created_at,
    ticket: newTicket
  };
  broadcast('NEW_ORDER', newTicket);
  broadcast('order_created', orderCreatedPayload);

  // Store in idempotency cache for 60 seconds
  if (reqId) {
    recentRequests.set(reqId, newTicket);
    setTimeout(() => recentRequests.delete(reqId), 60000);
  }

  // Step 3: Asynchronously trigger background cloud sync
  syncQueue.enqueueTicket(newTicket);

  // Immediate success response to waiter handset
  res.status(201).json({
    success: true,
    message: 'Order received by local hub & pushed to kitchen',
    ticket: newTicket
  });
});

// 4. GET /orders/active — Kitchen display restores open tickets on connect/reload
app.get('/orders/active', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const activeTickets = ticketStore.getActiveTickets(pairing.restaurant_id);
  res.json({
    restaurant_id: pairing.restaurant_id,
    count: activeTickets.length,
    tickets: activeTickets
  });
});

// 5. POST /orders/:id/ready — Kitchen marks ticket ready
app.post('/orders/:id/ready', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const ticketId = req.params.id;

  const updatedTicket = ticketStore.markTicketReady(ticketId, pairing.restaurant_id);
  if (!updatedTicket) {
    return res.status(404).json({ error: 'Ticket not found.' });
  }

  // Step 1: Push update to all WS clients immediately over LAN
  const readyPayload = {
    order_id: updatedTicket.id,
    ticket_id: updatedTicket.id,
    ticket_number: updatedTicket.ticket_number,
    table_id: updatedTicket.table_id,
    table_name: updatedTicket.table_name,
    status: 'ready',
    ticket: updatedTicket
  };
  broadcast('TICKET_READY', readyPayload);
  broadcast('order_ready', readyPayload);

  // Step 2: Queue status update for background cloud sync
  syncQueue.enqueueStatusUpdate(updatedTicket.ticket_number, 'ready', pairing.restaurant_id);

  res.json({
    success: true,
    ticket: updatedTicket
  });
});

// 5b. GET /menu — Returns cached menu from local file disk cache
app.get('/menu', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const menuData = restaurantCache.getMenuCache(pairing.restaurant_id);
  res.json(menuData);
});

// 5c. GET /tables/layout — Returns cached static table layout from local disk cache
app.get('/tables/layout', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const layoutData = restaurantCache.getTablesCache(pairing.restaurant_id);
  res.json(layoutData);
});

// Master Table Floor Grid Layout (Single source of truth for Hub)
const MASTER_TABLES = [
  { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
  { id: 2, name: 'T2', section: 'Main Hall', capacity: 2 },
  { id: 3, name: 'T3', section: 'Main Hall', capacity: 4 },
  { id: 4, name: 'T4', section: 'Main Hall', capacity: 4 },
  { id: 5, name: 'T5', section: 'Main Hall', capacity: 6 },
  { id: 6, name: 'T6', section: 'Main Hall', capacity: 6 },
  { id: 7, name: 'T7', section: 'AC Room', capacity: 4 },
  { id: 8, name: 'T8', section: 'AC Room', capacity: 4 },
  { id: 9, name: 'T9', section: 'AC Room', capacity: 6 },
  { id: 10, name: 'T10', section: 'Family Room', capacity: 8 },
  { id: 11, name: 'T11', section: 'Family Room', capacity: 8 },
  { id: 12, name: 'T12', section: 'Family Room', capacity: 10 },
];

function getLiveTables(restaurantId) {
  const activeTickets = ticketStore.getActiveTickets(restaurantId);
  const layoutData = restaurantCache.getTablesCache(restaurantId);
  const baseTables = (layoutData && layoutData.tables && layoutData.tables.length > 0) ? layoutData.tables : MASTER_TABLES;

  return baseTables.map(table => {
    const tableTickets = activeTickets.filter(t => 
      String(t.table_id) === String(table.id) || 
      String(t.table_name).toLowerCase() === table.name.toLowerCase() ||
      String(t.table_name).toLowerCase() === `table ${table.id}`.toLowerCase()
    );

    if (!tableTickets.length) {
      return {
        ...table,
        status: 'available',
        activeOrderTotal: 0,
        occupiedSince: null
      };
    }

    const hasReady = tableTickets.some(t => t.status === 'ready');
    const totalAmount = tableTickets.reduce((sum, t) => sum + (Number(t.total_amount) || 0), 0);
    const earliestTime = tableTickets.reduce((min, t) => !min || t.created_at < min ? t.created_at : min, null);

    return {
      ...table,
      status: hasReady ? 'ready' : 'kot',
      activeOrderTotal: totalAmount,
      occupiedSince: earliestTime
    };
  });
}

// 6. GET /tables — Live Floor Grid table state derived from active tickets
app.get('/tables', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const liveTables = getLiveTables(pairing.restaurant_id);
  const layout = restaurantCache.getTablesCache(pairing.restaurant_id);

  res.json({
    restaurant_id: pairing.restaurant_id,
    uninitialized: layout.uninitialized || false,
    count: liveTables.length,
    tables: liveTables
  });
});

// 7a. GET /tables/:id/invoice — Preview the current bill for a table (any time)
app.get('/tables/:id/invoice', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const tableId = req.params.id;
  const openTickets = ticketStore.getActiveTicketsForTable(tableId, pairing.restaurant_id);

  if (openTickets.length === 0) {
    return res.status(404).json({
      success: false,
      error: `No open tickets for table ${tableId}.`,
      code: 'NO_OPEN_TICKETS'
    });
  }

  const invoice = buildInvoicePreview({
    tickets: openTickets,
    tableId,
    tableName: openTickets[0].table_name,
    restaurantId: pairing.restaurant_id,
    currency: pairing.currency || '₹',
    taxConfig: pairing
  });

  res.json({ success: true, preview: true, invoice });
});

// 7b. GET /invoices/:id — Retrieve a previously issued invoice
app.get('/invoices/:id', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const invoice = invoiceStore.getInvoice(req.params.id, pairing.restaurant_id);
  if (!invoice) {
    return res.status(404).json({ success: false, error: 'Invoice not found.' });
  }
  res.json({ success: true, invoice });
});

// 7c. GET /invoices — List issued invoices for this tenant
app.get('/invoices', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  res.json({
    success: true,
    restaurant_id: pairing.restaurant_id,
    invoices: invoiceStore.listInvoices(pairing.restaurant_id)
  });
});

function issueInvoiceForTable(tableId, pairing) {
  const openTickets = ticketStore.getActiveTicketsForTable(tableId, pairing.restaurant_id);
  if (openTickets.length === 0) return null;
  const result = invoiceStore.issueInvoice({
    tickets: openTickets,
    tableId,
    tableName: openTickets[0].table_name,
    restaurantId: pairing.restaurant_id,
    currency: pairing.currency || '₹',
    taxConfig: pairing
  });
  return result.ok ? result.invoice : null;
}

// 7. POST /tables/:id/clear — Close a bill: issue invoice, then complete tickets
app.post('/tables/:id/clear', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const tableId = req.params.id;

  // Issue the invoice BEFORE clearing so the tickets are still queryable.
  // invoiceStore.issueInvoice is idempotent per (table, ticket ids), so a
  // network-retry double-POST cannot produce a second invoice.
  const invoice = issueInvoiceForTable(tableId, pairing);

  const { clearedCount, clearedTickets } = ticketStore.clearTableTickets(tableId, pairing.restaurant_id);

  if (clearedTickets && clearedTickets.length > 0) {
    clearedTickets.forEach(t => {
      syncQueue.enqueueStatusUpdate(t.ticket_number || t.id, 'completed', pairing.restaurant_id);
    });
  }

  const clearPayload = {
    table_id: Number(tableId) || tableId,
    order_id: tableId,
    cleared_count: clearedCount,
    status: 'available',
    invoice_number: invoice?.invoice_number || null,
    grand_total: invoice?.grand_total ?? null
  };
  broadcast('CLEAR_TABLE', clearPayload);
  broadcast('bill_cleared', clearPayload);
  broadcast('order_cleared', clearPayload);
  if (invoice) broadcast('INVOICE_ISSUED', { invoice });

  const updatedTables = getLiveTables(pairing.restaurant_id);
  if (invoice) {
    console.log(`🧾 Issued ${invoice.invoice_number} for Table ${tableId} · ${pairing.currency || '₹'}${invoice.grand_total} · ${clearedCount} ticket(s) completed`);
  } else {
    console.log(`🧹 Cleared bill for Table ${tableId} (${clearedCount} ticket(s) completed, no invoice — no open tickets)`);
  }

  res.json({
    success: true,
    table_id: tableId,
    cleared_count: clearedCount,
    tables: updatedTables,
    invoice: invoice || null
  });
});

app.post('/orders/:id/clear', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const id = req.params.id;

  const invoice = issueInvoiceForTable(id, pairing);

  const { clearedCount, clearedTickets } = ticketStore.clearTableTickets(id, pairing.restaurant_id);

  if (clearedTickets && clearedTickets.length > 0) {
    clearedTickets.forEach(t => {
      syncQueue.enqueueStatusUpdate(t.ticket_number || t.id, 'completed', pairing.restaurant_id);
    });
  }

  const orderClearPayload = {
    table_id: Number(id) || id,
    order_id: id,
    cleared_count: clearedCount,
    status: 'available',
    invoice_number: invoice?.invoice_number || null,
    grand_total: invoice?.grand_total ?? null
  };
  broadcast('CLEAR_TABLE', orderClearPayload);
  broadcast('bill_cleared', orderClearPayload);
  broadcast('order_cleared', orderClearPayload);
  if (invoice) broadcast('INVOICE_ISSUED', { invoice });

  const updatedTables = getLiveTables(pairing.restaurant_id);
  if (invoice) {
    console.log(`🧾 Issued ${invoice.invoice_number} for Order/Table ${id} · ${pairing.currency || '₹'}${invoice.grand_total}`);
  } else {
    console.log(`🧹 Cleared bill for Order/Table ${id} (${clearedCount} ticket(s) completed)`);
  }

  res.json({
    success: true,
    id,
    cleared_count: clearedCount,
    tables: updatedTables,
    invoice: invoice || null
  });
});

// 8. GET /sync-status — Check cloud sync queue & online status
app.get('/sync-status', requireDevice, (req, res) => {
  res.json({
    ...syncQueue.getStatus(),
    pairing: hubConfig.getPairingInfo()
  });
});

// 9. POST /toggle-outage — Outage simulator. Demo tooling only: it forces the hub
// offline, so it is restricted to the hub's own screen and can be disabled outright.
app.post('/toggle-outage', (req, res) => {
  if (process.env.HUB_DISABLE_OUTAGE_SIM === 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!isLoopback(req)) {
    return res.status(403).json({ error: 'Outage simulation is only available on the Kitchen Display.' });
  }
  syncQueue.isOnline = !syncQueue.isOnline;
  syncQueue.notifyStatusChange();
  if (syncQueue.isOnline) {
    syncQueue.processQueue();
  }
  res.json({
    online: syncQueue.isOnline,
    queued: syncQueue.queue.length
  });
});

// 8. GET /qr — Returns QR code image for pairing (points to Waiter PWA URL)
// The QR carries a freshly issued device token so scanning it enrols the handset
// in one step. It is therefore only served to the KDS on the hub itself -- handing
// this to the LAN would hand out credentials.
app.get('/qr', async (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: 'QR pairing codes are only available on the Kitchen Display.' });
  }
  try {
    const { device_token } = deviceAuth.issueToken('Scanned handset');
    const waiterUrl = `${SERVER_URL}/waiter#t=${device_token}`;
    const qrDataUrl = await QRCode.toDataURL(waiterUrl);
    res.json({
      server_url: SERVER_URL,
      waiter_url: waiterUrl,
      qr_code: qrDataUrl,
      enrollment_code: deviceAuth.getEnrollmentCode()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Serve static built frontend files if dist folder exists
const distPath = path.join(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// 10. GET /dashboard-data — Operational metrics, active & completed tickets, daily totals
app.get('/dashboard-data', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const liveTables = getLiveTables(pairing.restaurant_id);
  const allTickets = ticketStore.getAllTickets(pairing.restaurant_id);
  const activeTickets = allTickets.filter(t => t.status === 'in_progress' || t.status === 'ready');
  const completedTickets = allTickets.filter(t => t.status === 'completed' || t.status === 'billed');
  const runningTotal = completedTickets.reduce((sum, t) => sum + (Number(t.total_amount) || 0), 0);

  res.json({
    restaurant: pairing,
    tables: liveTables,
    active_tickets: activeTickets,
    completed_tickets: completedTickets,
    running_total: runningTotal,
    connected_devices: connectedClients.size,
    sync_status: syncQueue.getStatus(),
    timestamp: Date.now()
  });
});

// Dedicated route for Hub Dashboard
app.get('/dashboard', (req, res) => {
  const dashboardHtml = path.join(distPath, 'dashboard.html');
  if (fs.existsSync(dashboardHtml)) {
    return res.sendFile(dashboardHtml);
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

// Dedicated route for Waiter App PWA
app.get('/waiter', (req, res) => {
  const waiterHtml = path.join(distPath, 'waiter.html');
  if (fs.existsSync(waiterHtml)) {
    return res.sendFile(waiterHtml);
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

// 9. GET / — Kitchen Hub Display frontend static page (or fallback dashboard)
app.get('/', async (req, res) => {
  const indexHtml = path.join(distPath, 'index.html');
  if (fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }

  const pairing = hubConfig.getPairingInfo();
  const qrDataUrl = await QRCode.toDataURL(`${SERVER_URL}/waiter`);
  const activeTickets = ticketStore.getActiveTickets(pairing.restaurant_id);
  const syncStatus = syncQueue.getStatus();


  const menuCache = restaurantCache.getMenuCache(pairing.restaurant_id);
  const isUninitialized = menuCache.uninitialized;

  const html = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reception Local Hub — ${pairing.name || 'POS Server'}</title>
    <style>
      :root {
        --bg: #0d0f12;
        --panel: #161a22;
        --panel-alt: #1e2430;
        --border: #2e3646;
        --text: #f0f4fc;
        --muted: #8c9ba5;
        --amber: #f59e0b;
        --amber-bg: rgba(245, 158, 11, 0.15);
        --green: #10b981;
        --green-bg: rgba(16, 185, 129, 0.15);
        --red: #ef4444;
        --mono: 'JetBrains Mono', 'Fira Code', monospace;
      }
      body {
        margin: 0;
        padding: 24px;
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .container {
        max-width: 960px;
        margin: 0 auto;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--border);
        padding-bottom: 16px;
        margin-bottom: 24px;
      }
      .badge {
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        font-family: var(--mono);
      }
      .badge-green { background: var(--green-bg); color: var(--green); border: 1px solid var(--green); }
      .badge-amber { background: var(--amber-bg); color: var(--amber); border: 1px solid var(--amber); }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 20px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 20px;
      }
      .title { fontSize: 14px; color: var(--muted); font-weight: 600; text-transform: uppercase; margin-bottom: 12px; }
      .big-val { font-size: 24px; font-weight: 800; font-family: var(--mono); color: var(--text); }
      .qr-box { text-align: center; background: white; padding: 12px; border-radius: 12px; display: inline-block; }
      .qr-box img { width: 160px; height: 160px; display: block; }
      .btn {
        background: var(--amber);
        color: #1a1000;
        border: none;
        padding: 10px 16px;
        border-radius: 8px;
        font-weight: 700;
        cursor: pointer;
        font-size: 13px;
      }
      .btn:hover { opacity: 0.9; }
      .ticket-list { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
      .ticket-item {
        background: var(--panel-alt);
        border: 1px solid var(--border);
        padding: 12px;
        border-radius: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
    </style>
  </head>
  <body>
    <div class="container">
      ${isUninitialized ? `
        <div style="background: rgba(245, 158, 11, 0.2); border: 1px solid var(--amber); color: var(--amber); padding: 14px 20px; border-radius: 10px; font-weight: 700; font-size: 14px; margin-bottom: 20px; display: flex; align-items: center; gap: 10px;">
          <span>⚠️</span>
          <span>No menu data available — connect this hub to the internet once to complete setup.</span>
        </div>
      ` : ''}
      <div class="header">
        <div>
          <h1 style="margin:0; font-size: 22px; color: var(--text)">⚡ Hotel Mejwani Reception Hub Server</h1>
          <div style="color: var(--muted); font-size: 13px; margin-top: 4px;">
            Zero-Internet LAN Order Gateway & Cloud Synchronization Engine
          </div>
        </div>
        <span class="badge ${syncStatus.online ? 'badge-green' : 'badge-amber'}">
          ${syncStatus.online ? '🌐 Online Sync' : '⚡ Local WiFi Only'}
        </span>
      </div>

      <div class="grid">
        <div class="card">
          <div class="title">📶 LAN WiFi Server URL</div>
          <div class="big-val" style="color: var(--amber)">${SERVER_URL}</div>
          <div style="font-size: 12px; color: var(--muted); margin-top: 8px;">
            Point waiter handsets on local WiFi to this LAN address
          </div>
          <div style="margin-top: 16px; display: flex; gap: 8px;">
            <button class="btn" onclick="toggleOutage()">Simulate ${syncStatus.online ? 'Internet Outage' : 'Internet Restored'}</button>
          </div>
        </div>

        <div class="card" style="text-align: center;">
          <div class="title">📱 Handset Pairing QR Code</div>
          <div class="qr-box">
            <img src="${qrDataUrl}" alt="Server QR Code">
          </div>
          <div style="font-size: 11px; color: var(--muted); margin-top: 8px;">
            Scan from waiter mobile device to connect
          </div>
        </div>

        <div class="card">
          <div class="title">☁️ Cloud Sync Status</div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <span style="font-size: 14px;">Queued Orders:</span>
            <span class="big-val" style="color: ${syncStatus.queued > 0 ? 'var(--amber)' : 'var(--green)'}">${syncStatus.queued}</span>
          </div>
          <div style="font-size: 12px; color: var(--muted)">
            Paired Tenant: <strong>${pairing.name}</strong> (${pairing.pairing_code})
          </div>
          <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">
            Last Synced: <strong>${syncStatus.last_synced_at ? new Date(syncStatus.last_synced_at).toLocaleTimeString() : 'Never'}</strong>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 20px;">
        <div class="title">🍳 Live Active Kitchen Tickets (${activeTickets.length})</div>
        <div class="ticket-list">
          ${activeTickets.map(t => `
            <div class="ticket-item">
              <div>
                <strong style="font-family: var(--mono); color: var(--amber)">Ticket #${t.ticket_number}</strong> — Table ${t.table_name}
                <div style="font-size: 12px; color: var(--muted)">${t.items.map(i => i.qty + 'x ' + i.name).join(', ')}</div>
              </div>
              <div>
                <span class="badge ${t.status === 'ready' ? 'badge-green' : 'badge-amber'}">${t.status}</span>
                <span style="font-size: 11px; font-family: var(--mono); color: ${t.synced_to_cloud ? 'var(--green)' : 'var(--muted)'}; margin-left: 8px;">
                  ${t.synced_to_cloud ? '✓ Cloud Synced' : '⏳ Unsynced'}
                </span>
              </div>
            </div>
          `).join('') || '<div style="color: var(--muted); font-size: 13px;">No active orders in kitchen right now</div>'}
        </div>
      </div>
    </div>

    <script>
      async function toggleOutage() {
        await fetch('/toggle-outage', { method: 'POST' });
        window.location.reload();
      }

      // Auto refresh metrics every 5 seconds
      setInterval(() => {
        fetch('/sync-status')
          .then(res => res.json())
          .then(data => {
            // reload if queue length changed
          });
      }, 5000);
    </script>
  </body>
  </html>
  `;

  res.send(html);
});

// -------------------------------------------------------------
// Start Server & Background Sync Engine
// -------------------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
==================================================================
🚀 RESTAURANT LOCAL HUB SERVER STARTED
==================================================================
📍 Local WiFi LAN Address: ${SERVER_URL}
📱 WebSocket Live Gateway: ws://${LAN_IP}:${PORT}/live
🏢 Paired Tenant: ${hubConfig.getPairingInfo().name} (${hubConfig.getPairingInfo().pairing_code})
⚡ LAN Order Delivery: Instant (Zero Internet Required)
☁️ Background Cloud Sync: Active (12s Retry Loop)
==================================================================
  `);

  // Terminal ASCII QR code
  QRCode.toString(SERVER_URL, { type: 'terminal', small: true }, (err, url) => {
    if (!err) {
      console.log('Scan QR Code on Waiter Handset:');
      console.log(url);
    }
  });

  // Authenticate dedicated kitchen staff identity with Supabase RLS
  const pairingInfo = hubConfig.getPairingInfo();
  if (pairingInfo.restaurant_id) {
    authenticateHubStaff(pairingInfo.restaurant_id);
    // Initialize Local Persisted Menu & Tables Disk Cache
    restaurantCache.initCache(pairingInfo.restaurant_id, broadcast);
  }

  // Start background sync retry loop
  syncQueue.startSyncLoop(12000);
});

