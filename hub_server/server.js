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
import { ticketStore, ticketMatchesTable } from './lib/ticketStore.js';
import { syncQueue } from './lib/syncQueue.js';
import { authenticateHubStaff } from './lib/supabaseClient.js';
import { restaurantCache } from './lib/restaurantCache.js';
import { priceOrder } from './lib/pricing.js';
import { resolveEffectivePrice } from './lib/dayParts.js';
import { buildInvoicePreview } from './lib/invoice.js';
import { invoiceStore } from './lib/invoiceStore.js';
import { reconciliationStore } from './lib/reconciliationStore.js';
import { paymentEvents, ledgerCsv } from './lib/reconciliation.js';
import { renderKot, renderReceipt, renderTestPage, sendToPrinter } from './lib/printer.js';
import { listSystemPrinters } from './lib/usbPrinter.js';
import { groupTicketByStation, STATION_LABELS } from './lib/kotRouting.js';
import { withCourseState, firedItems, heldCourses } from './lib/courses.js';
import { prepReport } from './lib/prepTelemetry.js';
import { waiterStore } from './lib/waiterStore.js';
import { addItem, updateItem, deleteItem, addCategory, renameCategory, reorderCategories, deleteCategory } from './lib/menuAdmin.js';
import { previewImport, applyImport } from './lib/menuImport.js';
import { applyLayout } from './lib/tablesAdmin.js';
import { checkLimit, featureRefusal, hasFeature, FEATURES } from './lib/plans.js';
import { crashReporter, attachHubProcessHandlers } from './lib/crashReporter.js';

attachHubProcessHandlers();
import { deviceAuth, requireDevice, requireReception, requireReceptionFor, isReceptionRequest, extractToken, isLoopback, trustLocalAddress } from './lib/deviceAuth.js';

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
// Menu imports can carry up to 2000 rows with modifiers. Give just those routes a
// bigger body limit. This MUST be mounted before the global parser: the global one
// would reject anything over 256 KB first, and a body that is already parsed is
// skipped by the later parser. The reception guard sits in front of the bigger
// parser, so a handset or any other LAN host is refused (403) before the hub
// reads up to 2 MB from it.
app.use('/admin/menu/import', requireReception, express.json({ limit: '2mb' }));
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

// Every change to a bill goes to the cloud as a full snapshot (migration 005). Before this the
// sync queue replicated orders but never bills, so revenue history lived only on this laptop.
const replicateInvoice = invoice => { if (invoice) syncQueue.enqueueInvoice(invoice); };

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

// Plan entitlements (M3 · PR 16). The menu cache reads the tenant's effective
// features through this provider so GET /menu and the order pricer always
// agree on what the plan lets the restaurant sell.
restaurantCache.setFeatureProvider(() => hubConfig.getEffectivePlan().features);

/** Refuse a route whose feature isn't in the tenant's effective plan. */
function requireFeature(feature) {
  return (req, res, next) => {
    const eff = hubConfig.getEffectivePlan();
    if (hasFeature(eff.plan, feature)) return next();
    const refusal = featureRefusal(eff.plan, feature);
    return res.status(refusal.status).json({
      success: false, error: refusal.error, code: refusal.code,
      feature: refusal.feature, plan: refusal.plan, upgrade_to: refusal.upgrade_to
    });
  };
}

// 0. POST /auth/device — exchange the KDS-displayed enrollment code for a token
app.post('/auth/device', (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const result = deviceAuth.enroll(
    req.body?.enrollment_code,
    req.body?.device_label || 'Handset',
    ip,
    // Evaluated only after the enrollment code checks out (see deviceAuth.enroll).
    () => checkLimit(hubConfig.getEffectivePlan().plan, 'devices', deviceAuth.activeDeviceCount())
  );

  if (!result.ok) {
    console.warn(`🔒 Device enrollment refused for ${ip}: ${result.error}`);
    return res.status(result.status).json({
      error: result.error,
      ...(result.code ? { code: result.code, limit_key: result.limit_key, limit: result.limit, current: result.current, plan: result.plan, upgrade_to: result.upgrade_to } : {})
    });
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

  // Stamp the ticket with the logged-in waiter's name when the handset supplies
  // a valid waiter_id. Unknown ids are refused so a bad handset can't attribute
  // its orders to someone else; missing ids fall back to the handset's own
  // `created_by_waiter` string (backwards-compatible with pre-PR-9 clients).
  if (orderData.waiter_id) {
    const waiter = waiterStore.getById(orderData.waiter_id);
    if (!waiter || waiter.active === false) {
      return res.status(400).json({
        error: 'Unknown or inactive waiter for this order.',
        code: 'UNKNOWN_WAITER'
      });
    }
    orderData.created_by_waiter = waiter.name;
    orderData.waiter_id = waiter.id;
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

  // Step 4: Fire-and-forget auto-KOT print if a printer is configured.
  // Never blocks the order response — a stuck printer must not lose the
  // order in the kitchen. Success/failure is logged and observable via
  // POST /orders/:id/print-kot as a manual retry.
  autoPrintKot(newTicket, pairing).catch(() => {});

  // Immediate success response to waiter handset
  res.status(201).json({
    success: true,
    message: 'Order received by local hub & pushed to kitchen',
    ticket: newTicket
  });
});

/** "On hold: course 2 (3 items), course 3 (1 item)" for a staged ticket, '' otherwise. */
function heldSummary(ticket) {
  const held = heldCourses(ticket);
  if (!ticket.staged || held.length === 0) return '';
  return 'On hold: ' + held.map(h => `course ${h.course} (${h.items.length} item${h.items.length === 1 ? '' : 's'})`).join(', ');
}

/**
 * Print the kitchen ticket(s) for a ticket. Only lines that have been fired are printed: all of them
 * for a normal ticket, the first course for one served in courses, and just the newly fired course
 * when `opts.items` / `opts.course` say so.
 */
async function autoPrintKot(ticketIn, pairing, opts = {}) {
  const printers = hubConfig.getPrinters('kot');
  if (printers.length === 0) return; // No KOT printer configured — silent no-op.
  const ticket = { ...withCourseState(ticketIn) };
  ticket.items = opts.items || firedItems(ticket);
  const courseLabel = ticket.staged && opts.course ? `Course ${opts.course} - fire now` : (ticket.staged ? 'Course 1' : '');
  const held = heldSummary(withCourseState(ticketIn));
  // Split by station (M2 · PR 15). A ticket with items across hot / cold /
  // bar produces multiple KOTs, one per station, each carrying only its
  // own items. A printer with a `station` field prints only jobs for that
  // station; a printer with no station prints ALL jobs (fallback for
  // single-printer deployments so nothing regresses).
  //
  // When the ticket resolves to a single station (the common case), no
  // station label is added to the header — a T5 order of curries prints
  // "KITCHEN ORDER TICKET" exactly as before PR 15. Once a split happens,
  // every KOT in the split carries its station in the header so the cook
  // can eyeball which one is theirs.
  const groups = groupTicketByStation(ticket);
  const shouldLabel = groups.length > 1;
  for (const g of groups) {
    const job = renderKot(g.ticket, pairing, {
      ...(shouldLabel ? { station_label: g.label } : {}),
      ...(courseLabel ? { course_label: courseLabel } : {}),
      ...(held ? { held_summary: held } : {})
    });
    for (const p of printers) {
      if (p.station && p.station !== g.station) continue;
      const res = await sendToPrinter(job, p);
      if (res.ok) {
        console.log(`🖨  KOT ${ticket.table_name || 'Table'} · #${ticket.ticket_number} [${g.station}] → ${p.id} (${res.sent_bytes ?? 0} bytes)`);
      } else {
        console.warn(`🖨  KOT print failed on ${p.id} [${g.station}]: ${res.error} [${res.code}]`);
      }
    }
  }
}

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

// Kitchen-board events: a ticket changed in a way that is not "ready". Every screen merges the
// ticket by id; the waiter app refetches live state on any event.
function broadcastTicketChange(type, ticket, extra = {}) {
  const payload = {
    ticket_id: ticket.id,
    ticket_number: ticket.ticket_number,
    table_id: ticket.table_id,
    table_name: ticket.table_name,
    status: ticket.status,
    ticket,
    ...extra
  };
  broadcast(type, payload);
  broadcast('TICKET_UPDATED', payload);
}

const ticketRefusalStatus = code => (code === 'NOT_FOUND' ? 404 : 409);

// 5a. POST /orders/:id/stations/:station/ready — one station (hot / cold / bar) reports its part done.
// The ticket becomes ready, and the waiter is told, only when every station that has lines on it has.
app.post('/orders/:id/stations/:station/ready', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const station = String(req.params.station).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(STATION_LABELS, station)) {
    return res.status(400).json({ success: false, error: `Station must be one of ${Object.keys(STATION_LABELS).join(', ')}.`, code: 'INVALID_STATION' });
  }
  const result = ticketStore.markStationReady(req.params.id, pairing.restaurant_id, station);
  if (!result.ok) {
    return res.status(ticketRefusalStatus(result.code)).json({ success: false, error: result.error, code: result.code });
  }
  const ticket = result.ticket;
  if (result.ticket_ready) {
    const readyPayload = {
      order_id: ticket.id, ticket_id: ticket.id, ticket_number: ticket.ticket_number,
      table_id: ticket.table_id, table_name: ticket.table_name, status: 'ready', ticket
    };
    broadcast('TICKET_READY', readyPayload);
    broadcast('order_ready', readyPayload);
    syncQueue.enqueueStatusUpdate(ticket.ticket_number, 'ready', pairing.restaurant_id);
  } else {
    broadcastTicketChange('STATION_READY', ticket, { station });
  }
  res.json({ success: true, ticket, ticket_ready: Boolean(result.ticket_ready), station });
});

// 5c. POST /orders/:id/fire — send the next held course (or body.course) to the kitchen.
app.post('/orders/:id/fire', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const result = ticketStore.fireCourse(req.params.id, pairing.restaurant_id, body.course);
  if (!result.ok) {
    return res.status(ticketRefusalStatus(result.code)).json({ success: false, error: result.error, code: result.code });
  }
  const ticket = result.ticket;
  console.log(`🔥 Fired course ${result.fired_course} on #${ticket.ticket_number} (${result.fired_items.length} item(s))`);
  broadcastTicketChange('COURSE_FIRED', ticket, { course: result.fired_course });
  // A ticket that had been marked ready is cooking again.
  syncQueue.enqueueStatusUpdate(ticket.ticket_number, 'in_progress', pairing.restaurant_id);
  autoPrintKot(ticket, pairing, { items: result.fired_items, course: result.fired_course }).catch(() => {});
  res.json({ success: true, ticket, fired_course: result.fired_course, fired_items: result.fired_items.length });
});

// 5d. POST /orders/:id/recall — a ticket marked ready goes back on the board (marked by mistake, or remake).
app.post('/orders/:id/recall', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = ticketStore.recall(req.params.id, pairing.restaurant_id);
  if (!result.ok) {
    return res.status(ticketRefusalStatus(result.code)).json({ success: false, error: result.error, code: result.code });
  }
  const ticket = result.ticket;
  console.log(`↩︎ Recalled #${ticket.ticket_number} (course ${result.recalled_course})`);
  broadcastTicketChange('TICKET_RECALLED', ticket, { course: result.recalled_course });
  syncQueue.enqueueStatusUpdate(ticket.ticket_number, 'in_progress', pairing.restaurant_id);
  res.json({ success: true, ticket, recalled_course: result.recalled_course });
});

// 5e. GET /telemetry/prep — how long the kitchen takes, per item and per station. Reception laptop only.
// `from` / `to` are ISO timestamps; the default is the last 24 hours.
app.get('/telemetry/prep', requireReceptionFor('Kitchen performance'), (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const parse = v => { const t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
  const toMs = req.query.to !== undefined ? parse(req.query.to) : Date.now();
  const fromMs = req.query.from !== undefined ? parse(req.query.from) : Date.now() - 24 * 60 * 60 * 1000;
  if (fromMs === null || toMs === null) {
    return res.status(400).json({ success: false, error: 'from and to must be ISO dates, for example 2026-10-01T00:00:00Z.', code: 'INVALID_RANGE' });
  }
  const report = prepReport(ticketStore.getAllTickets(pairing.restaurant_id), pairing.restaurant_id, { fromMs, toMs });
  res.json({ success: true, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), ...report });
});

// 5b. GET /menu — Returns cached menu from local file disk cache
app.get('/menu', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const menuData = restaurantCache.getMenuCache(pairing.restaurant_id);
  // Day-part enrichment (M2 · PR 13). We resolve the active window on every
  // request so the handset gets the currently-effective price without having
  // to duplicate the day-part logic client-side, and so the cart total the
  // waiter sees matches what the hub bills at POST /orders — modulo up to
  // one poll interval (~5s) of drift, which the server-authoritative
  // re-pricing at order time closes anyway.
  if (menuData && !menuData.uninitialized && Array.isArray(menuData.items)) {
    const now = new Date();
    menuData.items = menuData.items.map(i => {
      const dayParts = Array.isArray(i.day_parts) ? i.day_parts : [];
      const baseEff = resolveEffectivePrice(i, null, now);
      const nextVariants = Array.isArray(i.variants)
        ? i.variants.map(v => {
            const ve = resolveEffectivePrice(i, v, now);
            return {
              ...v,
              effective_price: ve.price,
              active_day_part: ve.day_part_id
                ? { id: ve.day_part_id, label: ve.day_part_label }
                : null
            };
          })
        : undefined;
      return {
        ...i,
        effective_price: baseEff.price,
        active_day_part: baseEff.day_part_id
          ? { id: baseEff.day_part_id, label: baseEff.day_part_label }
          : null,
        ...(nextVariants ? { variants: nextVariants } : {}),
        ...(dayParts.length > 0 ? { day_parts: dayParts } : {})
      };
    });
  }
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
  // MASTER_TABLES is only the demo fallback for a hub that has never loaded a
  // layout. An initialised hub with zero tables (the restaurant deleted them all)
  // must stay empty rather than resurrect the demo floor.
  const baseTables = layoutData.uninitialized ? MASTER_TABLES : (layoutData.tables || []);

  return baseTables.map(table => {
    // Same rule as the bill and the clear (ticketStore), so the floor, the open-bill lock
    // and the invoice can never disagree about whose ticket this is.
    const tableTickets = activeTickets.filter(t => ticketMatchesTable(t, table.id, table.name));

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
    sections: layout.sections || [],
    tables: liveTables
  });
});

// -------------------------------------------------------------
// Admin catalog editing — reception laptop only (requireReception).
// Every write carries `base_revision` (JSON body, or query string for DELETE).
// -------------------------------------------------------------
// Strict on purpose: coercing with Number() would accept [], false, " ", true and "0x1" as
// revisions. DELETE has no body, so it takes digits from the query string; every other
// method takes a JSON number from the body. Anything else is NaN, which updateCatalog
// refuses as BASE_REVISION_REQUIRED (as it does a non-integer such as 1.5 or Infinity).
function readBaseRevision(req) {
  if (req.method === 'DELETE') {
    const raw = req.query?.base_revision;
    return typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  }
  const raw = req.body?.base_revision;
  return typeof raw === 'number' ? raw : NaN;
}

function sendCatalogFailure(res, result) {
  return res.status(result.status).json({
    success: false,
    error: result.error,
    code: result.code,
    ...(result.errors ? { errors: result.errors } : {}),
    ...(result.details ? { details: result.details } : {}),
    ...(result.current_revision !== undefined ? { current_revision: result.current_revision } : {})
  });
}

async function commitMenu(req, res, mutator, { status = 200 } = {}) {
  const result = await restaurantCache.updateCatalog('menu', readBaseRevision(req), mutator);
  if (!result.ok) return sendCatalogFailure(res, result);

  const pairing = hubConfig.getPairingInfo();
  broadcast('menu_updated', restaurantCache.getMenuCache(pairing.restaurant_id));
  syncQueue.enqueueCatalog('menu', result.data);
  return res.status(status).json({ success: true, revision: result.data.revision, ...(result.meta || {}) });
}

// What the editor shows beside "Saved on hub": for each catalog, the revision on the hub, the newest
// revision the cloud is known to hold, and whether a push is waiting or was shelved.
app.get('/admin/sync-status', requireReception, (req, res) => {
  const catalog = syncQueue.getCatalogStatus();
  res.json({
    success: true,
    online: syncQueue.isOnline,
    menu: { revision: restaurantCache.getMenuCache().revision, ...catalog.menu },
    tables: { revision: restaurantCache.getTablesCache().revision, ...catalog.tables }
  });
});

// "Retry" beside a failed cloud push: shelved pushes (and orders) go back in the queue with a fresh retry budget.
app.post('/admin/sync/retry', requireReception, async (req, res) => {
  const result = await syncQueue.requeueQuarantined();
  res.json({ success: true, ...result, catalog: syncQueue.getCatalogStatus() });
});

app.post('/admin/menu/items', requireReception, (req, res) =>
  commitMenu(req, res, menu => addItem(menu, req.body?.item), { status: 201 }));

app.put('/admin/menu/items/:id', requireReception, (req, res) =>
  commitMenu(req, res, menu => updateItem(menu, req.params.id, req.body?.item)));

app.delete('/admin/menu/items/:id', requireReception, (req, res) =>
  commitMenu(req, res, menu => deleteItem(menu, req.params.id)));

app.post('/admin/menu/categories', requireReception, (req, res) =>
  commitMenu(req, res, menu => addCategory(menu, req.body?.name), { status: 201 }));

// Registered before any `/:name` style route would be: "order" is a path, not a category.
app.put('/admin/menu/categories/order', requireReception, (req, res) =>
  commitMenu(req, res, menu => reorderCategories(menu, req.body?.names)));

app.put('/admin/menu/categories', requireReception, (req, res) =>
  commitMenu(req, res, menu => renameCategory(menu, req.body?.from, req.body?.to)));

app.delete('/admin/menu/categories', requireReception, (req, res) =>
  commitMenu(req, res, menu => deleteCategory(menu, req.query?.name)));

app.post('/admin/menu/import/preview', requireReception, (req, res) => {
  const menu = restaurantCache.getMenuCache();
  if (menu.uninitialized) {
    return res.status(409).json({ success: false, error: menu.message, code: 'HUB_UNINITIALIZED' });
  }
  const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
  const result = previewImport(menu, req.body?.rows, { mode });
  if (!result.ok) return sendCatalogFailure(res, result);

  res.json({
    success: true,
    revision: menu.revision,
    counts: result.counts,
    rows: result.rows.map(({ item, ...row }) => row)
  });
});

app.post('/admin/menu/import/commit', requireReception, (req, res) => {
  const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace' && req.body?.confirm_replace !== true) {
    return res.status(400).json({
      success: false,
      error: 'Replacing the whole menu requires confirm_replace: true.',
      code: 'CONFIRM_REQUIRED'
    });
  }
  return commitMenu(req, res, menu =>
    applyImport(menu, req.body?.rows, { mode, skipInvalid: req.body?.skip_invalid === true }));
});

app.put('/admin/tables/layout', requireReception, async (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  // Evaluated inside the mutator (same tick as applyLayout) so it reflects open bills when the edit actually runs in the write chain.
  const openTableIds = () => new Set(
    getLiveTables(pairing.restaurant_id).filter(t => t.status !== 'available').map(t => String(t.id))
  );

  const result = await restaurantCache.updateCatalog('tables', readBaseRevision(req),
    layout => applyLayout(layout, req.body, openTableIds()));
  if (!result.ok) return sendCatalogFailure(res, result);

  broadcast('tables_updated', restaurantCache.getTablesCache(pairing.restaurant_id));
  syncQueue.enqueueCatalog('tables', result.data);
  res.json({ success: true, revision: result.data.revision, tables: result.data.tables, sections: result.data.sections });
});

// Every failure under /admin answers in the same { success, error, code } shape, never in
// Express's HTML page, which carries a stack trace and install paths. That covers the body-parser
// failures (oversize, malformed JSON), which are raised by the parsers mounted at the top of the
// stack before any admin route runs, and anything an admin route throws itself. Scoped to /admin
// so the other routes behave exactly as before.
app.use('/admin', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request is too large.', code: 'PAYLOAD_TOO_LARGE' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Request body is not valid JSON.', code: 'INVALID_JSON' });
  }
  // The cause stays in the hub's log; the client only learns that, and roughly why, it failed.
  console.error(`❌ ${req.method} ${req.originalUrl} failed:`, err);
  const status = [err?.status, err?.statusCode].find(s => Number.isInteger(s) && s >= 400 && s < 500);
  if (status) {
    return res.status(status).json({ success: false, error: 'The request could not be processed.', code: 'BAD_REQUEST' });
  }
  return res.status(500).json({ success: false, error: 'The hub could not complete this request.', code: 'INTERNAL_ERROR' });
});

function buildPreviewForTable(tableId, pairing, adjustments) {
  const openTickets = ticketStore.getActiveTicketsForTable(tableId, pairing.restaurant_id);
  if (openTickets.length === 0) {
    return { status: 404, body: {
      success: false,
      error: `No open tickets for table ${tableId}.`,
      code: 'NO_OPEN_TICKETS'
    }};
  }

  const preview = buildInvoicePreview({
    tickets: openTickets,
    tableId,
    tableName: openTickets[0].table_name,
    restaurantId: pairing.restaurant_id,
    currency: pairing.currency || '₹',
    taxConfig: pairing,
    adjustments
  });

  if (!preview.ok) {
    return { status: 400, body: {
      success: false,
      error: preview.error,
      code: 'INVALID_ADJUSTMENTS'
    }};
  }

  const { ok: _ok, ...invoice } = preview;
  return { status: 200, body: { success: true, preview: true, invoice } };
}

// 7a. GET /tables/:id/invoice — Preview the current bill for a table (any time)
app.get('/tables/:id/invoice', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const { status, body } = buildPreviewForTable(req.params.id, pairing, undefined);
  res.status(status).json(body);
});

// 7a-2. POST /tables/:id/invoice/preview — Preview with reception-supplied adjustments
app.post('/tables/:id/invoice/preview', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const adjustments = (req.body && typeof req.body === 'object') ? req.body : {};
  const { status, body } = buildPreviewForTable(req.params.id, pairing, adjustments);
  res.status(status).json(body);
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

// ---------------------------------------------------------------------------
// Payment reconciliation — reception laptop only (it is a money screen).
// ---------------------------------------------------------------------------
const receptionCash = requireReceptionFor('Cash and payment reconciliation');

// 7c-1. GET /reconciliation/preview — the period since the last close, per payment method. Stores nothing.
app.get('/reconciliation/preview', receptionCash, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  res.json({ success: true, ...reconciliationStore.preview(invoiceStore.listInvoices(pairing.restaurant_id), pairing.restaurant_id) });
});

// 7c-2. POST /reconciliation/close — count the drawer, compare with the system, store the record.
app.post('/reconciliation/close', receptionCash, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const result = reconciliationStore.close(invoiceStore.listInvoices(pairing.restaurant_id), pairing.restaurant_id, body);
  if (!result.ok) {
    return res.status(result.status).json({
      success: false, error: result.error, code: result.code,
      ...(result.errors ? { errors: result.errors } : {}),
      ...(result.preview ? { preview: result.preview } : {})
    });
  }
  const r = result.record;
  console.log(`🧾 ${r.number} closed · cash variance ${r.cash_variance} · ${r.status}`);
  broadcast('RECONCILIATION_CLOSED', { number: r.number, status: r.status });
  syncQueue.enqueueReconciliation(r);
  res.status(201).json({ success: true, record: r });
});

// 7c-3. GET /reconciliations — closed shifts, newest first.
app.get('/reconciliations', receptionCash, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  res.json({ success: true, records: reconciliationStore.list(pairing.restaurant_id).slice(0, limit) });
});

// 7c-4. GET /reconciliations/:id — one record (by id or REC-000001).
app.get('/reconciliations/:id', receptionCash, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const record = reconciliationStore.get(req.params.id, pairing.restaurant_id);
  if (!record) return res.status(404).json({ success: false, error: 'Record not found.', code: 'NOT_FOUND' });
  res.json({ success: true, record });
});

// 7c-5. GET /reconciliation/ledger.csv — every payment and refund in a period, for the accountant.
// `from` / `to` are ISO timestamps; the default is the period since the last close.
app.get('/reconciliation/ledger.csv', receptionCash, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const parse = v => { const t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
  const fromMs = req.query.from !== undefined ? parse(req.query.from) : reconciliationStore.periodStartMs(pairing.restaurant_id);
  const toMs = req.query.to !== undefined ? parse(req.query.to) : Date.now();
  if ((req.query.from !== undefined && fromMs === null) || (req.query.to !== undefined && toMs === null)) {
    return res.status(400).json({ success: false, error: 'from and to must be ISO dates, for example 2026-10-01T00:00:00Z.', code: 'INVALID_RANGE' });
  }
  const events = paymentEvents(invoiceStore.listInvoices(pairing.restaurant_id), pairing.restaurant_id)
    .filter(e => (fromMs === null || e.ms >= fromMs) && (toMs === null || e.ms < toMs));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="payments-ledger.csv"');
  res.send('﻿' + ledgerCsv(events));
});

// 7d. POST /invoices/:id/void — Reopen the underlying tickets and record why
app.post('/invoices/:id/void', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const result = invoiceStore.voidInvoice(req.params.id, pairing.restaurant_id, {
    reason: body.reason,
    actor: body.actor
  });

  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }

  const invoice = result.invoice;
  const reopened = ticketStore.reopenTickets(invoice.ticket_ids || [], pairing.restaurant_id);

  broadcast('INVOICE_VOIDED', { invoice, reopened_ticket_ids: reopened });
  replicateInvoice(invoice);
  console.log(`↩︎  Voided ${invoice.invoice_number} · ${invoice.currency || '₹'}${invoice.grand_total} · reason: ${invoice.voided_reason} · reopened ${reopened.length} ticket(s)`);

  res.json({
    success: true,
    invoice,
    reopened_ticket_ids: reopened,
    tables: getLiveTables(pairing.restaurant_id)
  });
});

// 7e. POST /invoices/:id/mark-paid — Record a settled payment against the invoice
app.post('/invoices/:id/mark-paid', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const result = invoiceStore.markPaid(req.params.id, pairing.restaurant_id, {
    method: body.payment_method,
    actor: body.actor,
    payment_ref: body.payment_ref
  });

  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }

  broadcast('INVOICE_PAID', { invoice: result.invoice });
  replicateInvoice(result.invoice);
  console.log(`💰 Marked ${result.invoice.invoice_number} paid · ${result.invoice.payment_method} · ${result.invoice.currency || '₹'}${result.invoice.grand_total}`);

  res.json({ success: true, invoice: result.invoice });
});

// 7c-2. GET /waiters — Active waiters (public shape only; PIN hashes never leave the hub)
app.get('/waiters', requireDevice, (req, res) => {
  res.json({ success: true, waiters: waiterStore.listActive() });
});

// 7c-3. POST /waiters/login — Verify a 4-digit PIN for a specific waiter
app.post('/waiters/login', requireDevice, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const result = waiterStore.verify(body.waiter_id, body.pin);
  if (!result.ok) {
    return res.status(401).json({ success: false, error: result.error, code: result.code });
  }
  res.json({ success: true, waiter: result.waiter });
});

// 7c-4. POST /waiters — Add a new waiter (reception / admin flow)
app.post('/waiters', requireDevice, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const limit = checkLimit(hubConfig.getEffectivePlan().plan, 'waiters', waiterStore.listActive().length);
  if (!limit.ok) {
    return res.status(limit.status).json({
      success: false, error: limit.error, code: limit.code,
      limit_key: limit.limit_key, limit: limit.limit, current: limit.current,
      plan: limit.plan, upgrade_to: limit.upgrade_to
    });
  }
  const result = waiterStore.addWaiter({ name: body.name, pin: body.pin });
  if (!result.ok) {
    return res.status(400).json({ success: false, error: result.error, code: result.code });
  }
  res.status(201).json({ success: true, waiter: result.waiter });
});

// 7c-5. DELETE /waiters/:id — Deactivate (soft delete preserves ticket history)
app.delete('/waiters/:id', requireDevice, (req, res) => {
  const result = waiterStore.deactivate(req.params.id);
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }
  res.json({ success: true });
});

// 7d-2. GET /printers — Configured printers (safe to expose to reception UI)
app.get('/printers', requireDevice, (req, res) => {
  res.json({ success: true, printers: hubConfig.getPrinters() });
});

// Printer setup — reception laptop only. A handset has no business adding printers.
const receptionPrinters = requireReceptionFor('Printer setup');

// 7d-2a. GET /printers/system — print queues the operating system knows about (USB printers appear here).
app.get('/printers/system', receptionPrinters, async (req, res) => {
  const result = await listSystemPrinters();
  res.json({ success: result.ok, platform: result.platform, printers: result.printers, ...(result.error ? { error: result.error } : {}) });
});

// 7d-2b. POST /printers — add a network, USB or device printer.
app.post('/printers', receptionPrinters, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const result = hubConfig.addPrinter(body);
  if (!result.ok) {
    return res.status(result.code === 'DUPLICATE_PRINTER' ? 409 : 400).json({ success: false, error: result.error, code: result.code });
  }
  console.log(`🖨  Printer added: ${result.printer.id} (${result.printer.transport}, ${result.printer.role})`);
  res.status(201).json({ success: true, printer: result.printer });
});

// 7d-2c. DELETE /printers/:id
app.delete('/printers/:id', receptionPrinters, (req, res) => {
  const result = hubConfig.removePrinter(req.params.id);
  if (!result.ok) return res.status(404).json({ success: false, error: result.error, code: result.code });
  res.json({ success: true });
});

// 7d-2d. POST /printers/:id/test — print a test page on one configured printer.
app.post('/printers/:id/test', receptionPrinters, async (req, res) => {
  const printer = hubConfig.getPrinters().find(p => p.id === req.params.id);
  if (!printer) return res.status(404).json({ success: false, error: 'Printer not found.', code: 'NOT_FOUND' });
  const job = renderTestPage(printer, hubConfig.getPairingInfo());
  const result = await sendToPrinter(job, printer);
  if (!result.ok) {
    return res.status(502).json({ success: false, error: result.error, code: result.code, preview_text: job.preview_text });
  }
  res.json({ success: true, printer_id: printer.id, sent_bytes: result.sent_bytes ?? 0, preview_text: job.preview_text });
});

// 7d-3. POST /orders/:id/print-kot — Explicit reprint of a ticket's KOT
app.post('/orders/:id/print-kot', requireDevice, async (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const id = req.params.id;
  const ticket = ticketStore.getAllTickets(pairing.restaurant_id).find(t =>
    t.id === id || String(t.ticket_number) === String(id)
  );
  if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found.', code: 'NOT_FOUND' });

  // Reprint mirrors the auto-print split (M2 · PR 15) — one KOT per
  // station, so a reprint after paper-out on the bar printer only re-
  // fires the bar-station lines, not the whole hot-line ticket.
  const groups = groupTicketByStation(ticket);
  const printers = hubConfig.getPrinters('kot');
  const results = [];
  const previewTexts = [];
  if (groups.length === 0) {
    // Legacy safety: never-empty ticket somehow arrived here. Fall back
    // to the pre-PR-15 behaviour so nothing regresses.
    const job = renderKot(ticket, pairing);
    previewTexts.push(job.preview_text);
    results.push({ printer_id: 'preview', ok: true, preview: true });
  } else {
    const shouldLabel = groups.length > 1;
    for (const g of groups) {
      const job = renderKot(g.ticket, pairing, shouldLabel ? { station_label: g.label } : {});
      previewTexts.push(job.preview_text);
      if (printers.length === 0) {
        results.push({ printer_id: 'preview', station: g.station, ok: true, preview: true });
      } else {
        for (const p of printers) {
          if (p.station && p.station !== g.station) continue;
          const r = await sendToPrinter(job, p);
          results.push({ printer_id: p.id, station: g.station, ...r });
        }
      }
    }
  }
  console.log(`🖨  KOT reprint #${ticket.ticket_number} → ${results.map(r => `${r.printer_id}[${r.station || '*'}]:${r.ok ? 'ok' : r.code}`).join(', ')}`);
  res.json({ success: true, ticket_id: ticket.id, results, preview_text: previewTexts.join('\n') });
});

// 7d-4. POST /invoices/:id/print-receipt — Customer receipt for the reception printer
app.post('/invoices/:id/print-receipt', requireDevice, async (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const invoice = invoiceStore.getInvoice(req.params.id, pairing.restaurant_id);
  if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found.', code: 'NOT_FOUND' });

  const job = renderReceipt(invoice, pairing);
  const printers = hubConfig.getPrinters('receipt');
  const results = [];
  if (printers.length === 0) {
    results.push({ printer_id: 'preview', ok: true, preview: true });
  } else {
    for (const p of printers) {
      const r = await sendToPrinter(job, p);
      results.push({ printer_id: p.id, ...r });
    }
  }
  console.log(`🧾 Receipt ${invoice.invoice_number} → ${results.map(r => `${r.printer_id}:${r.ok ? 'ok' : r.code}`).join(', ')}`);
  res.json({ success: true, invoice_number: invoice.invoice_number, results, preview_text: job.preview_text });
});

// 7e-2. POST /invoices/:id/refund — Reverse a paid invoice (parent + all paid splits)
app.post('/invoices/:id/refund', requireDevice, requireFeature(FEATURES.REFUNDS), (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const result = invoiceStore.refund(req.params.id, pairing.restaurant_id, {
    reason: body.reason,
    actor: body.actor
  });

  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }

  broadcast('INVOICE_REFUNDED', { invoice: result.invoice });
  replicateInvoice(result.invoice);
  console.log(`↩︎ Refunded ${result.invoice.invoice_number} · ${result.invoice.currency || '₹'}${result.invoice.grand_total} · reason: ${result.invoice.refund_reason}`);
  res.json({ success: true, invoice: result.invoice });
});

// 7f. POST /invoices/:id/split-by-seats — Divide grand_total into N equal shares
app.post('/invoices/:id/split-by-seats', requireDevice, requireFeature(FEATURES.SPLIT_BILL), (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const result = invoiceStore.splitBySeats(req.params.id, pairing.restaurant_id, {
    count: body.count,
    actor: body.actor
  });

  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }

  broadcast('INVOICE_SPLIT', { invoice: result.invoice });
  replicateInvoice(result.invoice);
  console.log(`🪓 Split ${result.invoice.invoice_number} into ${result.invoice.splits.length} seat share(s)`);
  res.json({ success: true, invoice: result.invoice });
});

// 7f-3. POST /invoices/:id/split-by-items — Per-split item assignment
app.post('/invoices/:id/split-by-items', requireDevice, requireFeature(FEATURES.SPLIT_BILL), (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const result = invoiceStore.splitByItems(req.params.id, pairing.restaurant_id, {
    splits: body.splits,
    actor: body.actor
  });

  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }

  broadcast('INVOICE_SPLIT', { invoice: result.invoice });
  replicateInvoice(result.invoice);
  console.log(`🪓 Split ${result.invoice.invoice_number} by item into ${result.invoice.splits.length} share(s)`);
  res.json({ success: true, invoice: result.invoice });
});

// 7f-2. POST /invoices/:id/split-by-amounts — Reception-supplied per-split amounts
app.post('/invoices/:id/split-by-amounts', requireDevice, requireFeature(FEATURES.SPLIT_BILL), (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const result = invoiceStore.splitByAmounts(req.params.id, pairing.restaurant_id, {
    splits: body.splits,
    actor: body.actor
  });

  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }

  broadcast('INVOICE_SPLIT', { invoice: result.invoice });
  replicateInvoice(result.invoice);
  console.log(`🪓 Split ${result.invoice.invoice_number} by amount into ${result.invoice.splits.length} share(s)`);
  res.json({ success: true, invoice: result.invoice });
});

// 7g. DELETE /invoices/:id/splits — Undo the split (only if nothing is paid yet)
app.delete('/invoices/:id/splits', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = invoiceStore.unsplit(req.params.id, pairing.restaurant_id);

  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }

  broadcast('INVOICE_UNSPLIT', { invoice: result.invoice });
  replicateInvoice(result.invoice);
  console.log(`↩︎ Unsplit ${result.invoice.invoice_number}`);
  res.json({ success: true, invoice: result.invoice });
});

// 7h. POST /invoices/:id/splits/:index/mark-paid — Settle one seat share
app.post('/invoices/:id/splits/:index/mark-paid', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const result = invoiceStore.markSplitPaid(req.params.id, pairing.restaurant_id, {
    splitIndex: Number(req.params.index),
    method: body.payment_method,
    actor: body.actor,
    payment_ref: body.payment_ref
  });

  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }

  broadcast('INVOICE_SPLIT_PAID', {
    invoice: result.invoice,
    split_index: Number(req.params.index),
    parent_settled: result.parent_settled
  });
  if (result.parent_settled) {
    broadcast('INVOICE_PAID', { invoice: result.invoice });
  }
  replicateInvoice(result.invoice);
  console.log(`💰 Split ${Number(req.params.index) + 1}/${result.invoice.splits.length} of ${result.invoice.invoice_number} paid · ${body.payment_method}${result.parent_settled ? ' · parent settled' : ''}`);

  res.json({ success: true, invoice: result.invoice, parent_settled: result.parent_settled });
});

function issueInvoiceForTable(tableId, pairing, adjustments) {
  const openTickets = ticketStore.getActiveTicketsForTable(tableId, pairing.restaurant_id);
  if (openTickets.length === 0) return { ok: true, invoice: null };
  const result = invoiceStore.issueInvoice({
    tickets: openTickets,
    tableId,
    tableName: openTickets[0].table_name,
    restaurantId: pairing.restaurant_id,
    currency: pairing.currency || '₹',
    taxConfig: pairing,
    adjustments
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, invoice: result.invoice };
}

// 7. POST /tables/:id/clear — Close a bill: issue invoice, then complete tickets
app.post('/tables/:id/clear', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const tableId = req.params.id;
  const adjustments = (req.body && typeof req.body === 'object') ? req.body : undefined;

  // Issue the invoice BEFORE clearing so the tickets are still queryable.
  // invoiceStore.issueInvoice is idempotent per (table, ticket ids), so a
  // network-retry double-POST cannot produce a second invoice.
  const issued = issueInvoiceForTable(tableId, pairing, adjustments);
  if (!issued.ok) {
    return res.status(400).json({
      success: false,
      error: issued.error,
      code: 'INVALID_ADJUSTMENTS'
    });
  }
  const invoice = issued.invoice;

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
  replicateInvoice(invoice);

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
  const adjustments = (req.body && typeof req.body === 'object') ? req.body : undefined;

  const issued = issueInvoiceForTable(id, pairing, adjustments);
  if (!issued.ok) {
    return res.status(400).json({
      success: false,
      error: issued.error,
      code: 'INVALID_ADJUSTMENTS'
    });
  }
  const invoice = issued.invoice;

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
  replicateInvoice(invoice);

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
// GET /plan — effective entitlements and current usage (feeds the owner console).
app.get('/plan', requireDevice, (req, res) => {
  const eff = hubConfig.getEffectivePlan();
  const info = hubConfig.getPairingInfo();
  res.json({
    success: true,
    plan: eff.plan,
    requested_plan: eff.requested_plan,
    status: eff.status,
    degraded: eff.degraded,
    degraded_reason: eff.reason,
    in_grace: eff.in_grace,
    grace_ends_at: eff.grace_ends_at,
    limits: eff.limits,
    features: eff.features,
    usage: {
      devices: deviceAuth.activeDeviceCount(),
      waiters: waiterStore.listActive().length,
      printers: hubConfig.getPrinters().length
    },
    synced_at: info.plan_synced_at || null
  });
});

app.get('/sync-status', requireDevice, (req, res) => {
  res.json({
    ...syncQueue.getStatus(),
    pairing: hubConfig.getPairingInfo()
  });
});

// POST /sync/requeue-quarantine — return shelved orders to the sync queue after
// fixing a hub-wide problem. Restricted to the hub's own screen.
app.post('/sync/requeue-quarantine', async (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: 'Only available on the Kitchen Display.' });
  }
  const result = await syncQueue.requeueQuarantined();
  res.json({ success: true, ...result, sync: syncQueue.getStatus() });
});

// 8b. POST /crash-report — Client-side crash sink for the KDS + waiter PWA
//
// Intentionally NOT gated behind requireDevice — a crash could happen before
// the handset finished enrolling, and losing that crash to a 401 is worse
// than accepting one from a device that doesn't own a token yet. Payloads are
// heavily size-capped in the reporter itself, and CORS is already restricted
// to LAN/loopback so this isn't reachable from a public tab.
app.post('/crash-report', (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const entry = crashReporter.report({
    source: body.source,
    message: body.message,
    stack: body.stack,
    url: body.url,
    user_agent: body.user_agent || req.get('user-agent'),
    extra: body.extra
  });
  console.warn(`💥 crash reported · ${entry.source} · ${entry.message}`);
  res.status(202).json({ success: true, id: entry.id });
});

// 8c. GET /crash-log — Recent crashes (auth'd, for reception debugging)
app.get('/crash-log', requireDevice, (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  res.json({ success: true, entries: crashReporter.list({ limit }) });
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
// The QR carries the enrollment code, not a token. The KDS re-fetches this
// endpoint on a timer, so minting a credential here issued a fresh 30-day token
// on every poll -- thousands of live grants and an ever-growing hub_config.json.
// The code is stable until rotated, and the handset exchanges it for exactly one
// token via /auth/device. Still KDS-only: the code is a credential.
app.get('/qr', async (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: 'QR pairing codes are only available on the Kitchen Display.' });
  }
  try {
    const waiterUrl = `${SERVER_URL}/waiter#e=${deviceAuth.getEnrollmentCode()}`;
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

// The admin page is reception-only. A person in a browser gets a plain-text 403 (the JSON API under
// /admin answers RECEPTION_ONLY as JSON). The static handler below would also serve dist/admin.html as
// a file, so that path gets the same answer.
const refuseNonReception = (res) => res.status(403).type('text/plain').send('Reception only');
app.get('/admin.html', (req, res, next) => (isReceptionRequest(req) ? next() : refuseNonReception(res)));

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

// Dedicated route for the reception-only Menu & Tables admin page (same decision as requireReception)
app.get('/admin', (req, res) => {
  if (!isReceptionRequest(req)) return refuseNonReception(res);
  const page = ['admin.html', 'index.html'].map(name => path.join(distPath, name)).find(file => fs.existsSync(file));
  if (!page) return res.status(404).type('text/plain').send('The admin page has not been built yet (run npm run build).');
  res.sendFile(page);
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

    // Refresh cache and subscribe to Realtime whenever connection is restored
    syncQueue.onReconnected(() => {
      restaurantCache.handleReconnection(pairingInfo.restaurant_id, broadcast);
    });
    // Refresh the subscription plan now and every 15 min. Fail-soft: offline
    // keeps the last synced plan, so LAN-only service is never interrupted.
    const syncPlan = () => hubConfig.syncPlanFromCloud().then(r => {
      if (r.ok && r.changed) console.log(`💳 Plan updated from cloud: ${r.effective.plan} (${r.effective.status})`);
    }).catch(() => {});
    syncPlan();
    setInterval(syncPlan, 15 * 60 * 1000).unref();

    // Carry up any bill the cloud has not confirmed. Pushes are triggered by a bill changing,
    // so anything issued before migration 005 has nothing coming for it; this is what gets an
    // existing ledger replicated rather than only new takings.
    syncQueue.enqueueUnsyncedInvoices(pairingInfo.restaurant_id);
    syncQueue.enqueueUnsyncedReconciliations(pairingInfo.restaurant_id);
  }

  // Start background sync retry loop
  syncQueue.startSyncLoop(12000);
});

