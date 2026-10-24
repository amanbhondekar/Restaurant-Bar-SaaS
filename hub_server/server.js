import './lib/logInstall.js';   // first: wraps the console before anything else prints (a no-op unless asked for)
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
import { authenticateHubStaff, supabase } from './lib/supabaseClient.js';
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
import { waiterStore, ROLES, ROLE_LABEL } from './lib/waiterStore.js';
import { addItem, updateItem, deleteItem, addCategory, renameCategory, reorderCategories, deleteCategory } from './lib/menuAdmin.js';
import { previewImport, applyImport } from './lib/menuImport.js';
import { applyLayout } from './lib/tablesAdmin.js';
import { publicMenu } from './lib/dinerMenu.js';
import { inventoryStore } from './lib/inventoryStore.js';
import { reservationStore } from './lib/reservationStore.js';
import { whatsappLink, telLink, formatPhone, normalizePhone } from './lib/guestContact.js';
import { reminderMessage } from './lib/reservations.js';
import { normalizeRewardScheme, MAX_VISITS_BETWEEN, REWARD_TEXT_MAX } from './lib/loyalty.js';
import { guestByPhone, recognise, regulars, allVisits } from './lib/loyalty.js';
import { windowFor, salesReport, monthlyCohorts, PRESET_IDS } from './lib/analytics.js';
import { reportStore } from './lib/reportStore.js';
import { validateGuestOrder, guestOrderReceipt, isCoolingDown as orderCoolingDown } from './lib/guestOrdering.js';
import { refusalFor, UNITS } from './lib/inventory.js';
import { StationScreens, STATIONS as STATION_IDS, parseScreen, snapshot as stationSnapshot } from './lib/stationScreens.js';
import { feedbackStore, validateFeedback, BILL_WINDOW_MS } from './lib/feedbackStore.js';
import { checkLimit, featureRefusal, hasFeature, FEATURES } from './lib/plans.js';
import { crashReporter, attachHubProcessHandlers } from './lib/crashReporter.js';

attachHubProcessHandlers();
import { feedFor, connectedFor, kitchenTicket } from './lib/liveFeed.js';
import { activeLogging, requestLogger } from './lib/log.js';
import { createBillingClient, normalizeOperatorUrl } from './lib/billingClient.js';
import { requestMessages } from './lib/bookingRequests.js';
import { pullInbox } from './lib/bookingInbox.js';
import { createInboxRunner, withinMs } from './lib/bookingInboxRunner.js';
import { createHeartbeatRunner, makeCollector } from './lib/heartbeat.js';
import { bookingPageRoutes, pageMemory } from './lib/bookingPageRoutes.js';
import { billingRoutes } from './lib/billingRoutes.js';
import { deviceAuth, requireDevice, requireKitchenDevice, DEVICE_SCOPES, requireReception, requireReceptionFor, isReceptionRequest, extractToken, isLoopback, trustLocalAddress } from './lib/deviceAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PORT=0 asks the operating system for a free port. The hub then only knows which one it got
// once it is listening, so this and SERVER_URL are resolved in the listen callback below rather
// than being fixed here. Everything that reads them does so while serving a request or after
// start-up, so both are always resolved by the time they are used.
let PORT = Number(process.env.PORT ?? 4000);
const app = express();
const server = http.createServer(app);
// One record per answered request, when structured logging or a collector is on (lib/log.js). Before everything else, so it sees every answer.
if (activeLogging()?.requests) app.use(requestLogger());

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
let SERVER_URL = `http://${LAN_IP}:${PORT}`;

// The KDS is often opened as http://<LAN-IP>:4000 on the reception laptop itself.
// Those requests are not loopback but do come from this same machine.
trustLocalAddress(LAN_IP);

/** 'full' for the reception laptop and any full-scope handset, 'kitchen' for a station screen, null for a stranger. */
const callerScope = (req, token = extractToken(req)) => (isLoopback(req) ? 'full' : deviceAuth.scopeFor(token));
/** A ticket as the caller may see it: a kitchen screen is not shown what anything costs. */
const ticketFor = (req, ticket) => (callerScope(req) === 'kitchen' ? kitchenTicket(ticket) : ticket);

// -------------------------------------------------------------
// WebSocket Layer (Live Real-Time Push to Kitchen KDS & Waiter Handsets)
// -------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const connectedClients = new Set();
// Which stations have a screen up. A screen declares its station when it opens the live connection
// (/live?station=bar), so the hub can tell reception when a station has nobody looking at it.
const stationScreens = new StationScreens();

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = url;

  if (pathname !== '/live' && pathname !== '/ws') {
    return socket.destroy();
  }

  // The live feed carries tickets, bills and table totals, so it needs the same authorisation as the
  // REST endpoints -- and the same scopes: a kitchen screen is sent the board and not the bill (lib/liveFeed.js).
  const token = url.searchParams.get('token');
  request.feedScope = callerScope(request, token);
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
  const timestamp = Date.now();
  // One message per scope, built once however many screens are connected.
  const byScope = new Map();
  const messageFor = scope => {
    if (!byScope.has(scope)) {
      const feed = feedFor(scope, type, payload);
      byScope.set(scope, feed ? JSON.stringify({ type, payload: feed.payload, restaurant_id: pairing.restaurant_id, timestamp }) : null);
    }
    return byScope.get(scope);
  };

  connectedClients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    const message = messageFor(client.feedScope);
    if (message) client.send(message);
  });
}

// A tablet that drops off the wifi, or is put to sleep, does not always close its connection: the hub
// would keep counting it for as long as the operating system takes to give up, which for the station
// panel means "1 screen up" over a bar that nobody is watching. So every connection is pinged on an
// interval, and one that did not answer the previous ping is dropped. Browsers answer a ping by
// themselves, so no client needs to know about it.
const WS_HEARTBEAT_MS = Number(process.env.HUB_WS_HEARTBEAT_MS) || 30000;
setInterval(() => {
  for (const client of connectedClients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch { /* it is closing; the close handler will tidy up */ }
  }
}, WS_HEARTBEAT_MS).unref();

wss.on('connection', (ws, req) => {
  ws.feedScope = req.feedScope;
  connectedClients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const screen = parseScreen(new URL(req.url, 'http://hub'));
  if (screen) stationScreens.add(ws, screen);
  console.log(`📱 Client connected over LAN WebSocket (Total active: ${connectedClients.size})${screen ? ` -- ${screen.station} screen${screen.label ? ` "${screen.label}"` : ''}` : ''}`);

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
    payload: connectedFor(ws.feedScope, {
      pairing: safePairing,
      sync: syncQueue.getStatus(),
      active_tickets_count: ticketStore.getActiveTickets(pairing.restaurant_id).length,
      menu: restaurantCache.getMenuCache(pairing.restaurant_id),
      tables_layout: restaurantCache.getTablesCache(pairing.restaurant_id)
    })
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
    stationScreens.remove(ws);
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

// Stock (inventory). The overlay flags dishes that cannot be made from what is on hand, in the same
// read point as the plan so every menu agrees. The store judges stock against the raw cache, not the
// overlaid one it is itself producing.
inventoryStore.setMenuProvider(() => restaurantCache.menuCache?.items ?? []);
// Bookings are checked against the real table layout, so a restaurant cannot sell a six-top it
// does not have.
reservationStore.setTableProvider(() => restaurantCache.getTablesCache()?.tables ?? []);
restaurantCache.setStockProvider((items, restaurantId) => inventoryStore.overlay(restaurantId, items));

// When a change moves a dish in or out of stock, every handset's menu has to hear about it, the
// same as when reception 86s something by hand.
inventoryStore.onChange(({ availability_changed }) => {
  scheduleInventoryPush();
  if (!availability_changed) return;
  const rid = hubConfig.getPairingInfo().restaurant_id;
  broadcast('menu_updated', restaurantCache.getMenuCache(rid));
  broadcast('STOCK_CHANGED', { restaurant_id: rid });
});

// Stock changes with every order, and every push is a full snapshot, so pushing on each change would
// send the whole ingredient list once per order. One push a few seconds after the last change is
// enough: the cloud's copy is a backup, not something anyone reads at the pass. Anything the timer
// has not flushed when the hub stops is carried up by the boot-time backfill.
// The diary changes a handful of times an evening rather than on every order, but the same
// debounce keeps a burst of seatings from becoming a burst of snapshots.
const RESERVATION_PUSH_MS = Number(process.env.HUB_RESERVATION_PUSH_MS) || 5000;
let reservationPushTimer = null;
reservationStore.onChange(() => {
  if (reservationPushTimer) return;
  reservationPushTimer = setTimeout(() => {
    reservationPushTimer = null;
    const rid = hubConfig.getPairingInfo().restaurant_id;
    const state = reservationStore.stateFor(rid);
    if (state.restaurant_id) syncQueue.enqueueCatalog('reservations', { restaurant_id: state.restaurant_id, revision: state.revision, ...reservationStore.all(rid) });
  }, RESERVATION_PUSH_MS);
  reservationPushTimer.unref?.();
});

const INVENTORY_PUSH_MS = Number(process.env.HUB_INVENTORY_PUSH_MS) || 5000;
let inventoryPushTimer = null;
function scheduleInventoryPush() {
  if (inventoryPushTimer) return;
  inventoryPushTimer = setTimeout(() => {
    inventoryPushTimer = null;
    const state = inventoryStore.stateFor(hubConfig.getPairingInfo().restaurant_id);
    if (state.restaurant_id) syncQueue.enqueueCatalog('inventory', state);
  }, INVENTORY_PUSH_MS);
  inventoryPushTimer.unref?.();
}

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
  // A screen at the pass asks for 'kitchen'. Refused for anything unrecognised rather than quietly
  // read as 'full': a typo should not hand a tablet more than it asked for. This check says nothing
  // about the code, so it can come first without telling a guesser anything.
  const scope = req.body?.scope ?? 'full';
  if (!DEVICE_SCOPES.includes(scope)) {
    return res.status(400).json({ error: 'Unknown device type.', code: 'INVALID_SCOPE' });
  }
  const result = deviceAuth.enroll(
    req.body?.enrollment_code,
    req.body?.device_label || 'Handset',
    ip,
    // Evaluated only after the enrollment code checks out (see deviceAuth.enroll).
    () => checkLimit(hubConfig.getEffectivePlan().plan, 'devices', deviceAuth.activeDeviceCount()),
    scope
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
    // The caller's OWN authority, so a tablet can tell it was enrolled as a kitchen screen: `authorised`
    // is true for any live token, and a waiter app that took that for "I am a handset" would go on to
    // a sign-in screen the hub then refuses. 'full' for the reception laptop; null with no live token.
    device_scope: isLoopback(req) ? 'full' : deviceAuth.scopeFor(extractToken(req)),
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

// What an order took out of stock, written onto the ticket. A cancellation puts back exactly this -- not a
// fresh calculation from today's recipes, which may differ from the ones the order was taken under.
function recordStockUse(ticket, result) {
  const uses = (result?.meta?.movements ?? []).map(m => ({ inventory_item_id: m.inventory_item_id, qty: Math.abs(m.delta) }));
  if (uses.length > 0) ticketStore.replaceTicket({ ...ticket, stock_used: uses });
}

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

  // Step 0b: Stock. An order is checked as a whole against what is on hand -- two dishes that share
  // an ingredient are checked against it together -- and refused before anything is created. A dish
  // with no recipe needs nothing, so a restaurant that has not set stock up is never held up by it.
  const short = inventoryStore.check(pairing.restaurant_id, priced.items);
  if (short.length > 0) {
    const refusal = refusalFor(short, priced.items);
    console.warn(`📦 Order rejected for stock: ${refusal.error}`);
    return res.status(409).json({ success: false, ...refusal });
  }

  // Step 1: Assign ticket number & update memory store
  const newTicket = ticketStore.addTicket(orderData, pairing.restaurant_id, priced);

  // The kitchen is going to cook this, so it comes out of stock now. Never allowed to fail the
  // order: a bad write here must not lose a table's food.
  try {
    recordStockUse(newTicket, inventoryStore.consume(pairing.restaurant_id, priced.items, { ref: `#${newTicket.ticket_number}`, by: orderData.created_by_waiter }));
  } catch (err) {
    console.error('📦 Could not record stock use for ticket', newTicket.ticket_number, err);
  }

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
  // A reprint has to be unmistakable. An identical second KOT landing on the pass is how a
  // course gets cooked twice, so a recall says so on the banner instead of looking like a
  // fresh order.
  const courseLabel = opts.reprint
    ? `Recall - course ${opts.course || 1} - reprint`
    : ticket.staged && opts.course ? `Course ${opts.course} - fire now` : (ticket.staged ? 'Course 1' : '');
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
app.get('/orders/active', requireKitchenDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const activeTickets = ticketStore.getActiveTickets(pairing.restaurant_id);
  res.json({
    restaurant_id: pairing.restaurant_id,
    count: activeTickets.length,
    tickets: activeTickets.map(t => ticketFor(req, t))
  });
});

// POST /orders/:id/cancel — withdraw an order that is still on the board.
//
// Policy, in one place. Before anything has been cooked the ingredients go back on the shelf; once any of it
// has been made they stay consumed (the food exists), and the ticket says it was cancelled after cooking.
// A billed order is reversed by voiding the bill. Full-scope devices and reception only: a screen at the
// pass marks tickets done, it does not withdraw them.
app.post('/orders/:id/cancel', requireDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const result = ticketStore.cancel(req.params.id, pairing.restaurant_id, { reason: body.reason, by: body.by });
  if (!result.ok) {
    return res.status(result.code === 'NOT_FOUND' ? 404 : 409).json({ success: false, error: result.error, code: result.code });
  }

  const ticket = result.ticket;
  let stockReturned = false;
  if (!result.cooked && Array.isArray(ticket.stock_used) && ticket.stock_used.length > 0) {
    try {
      const back = inventoryStore.restock(pairing.restaurant_id, ticket.stock_used, { ref: `#${ticket.ticket_number}`, note: 'order cancelled', by: ticket.cancelled_by });
      stockReturned = (back.meta?.movements?.length ?? 0) > 0;
    } catch (err) {
      // Never lets a stock write undo a cancellation the kitchen has already been told about.
      console.error('📦 Could not return stock for cancelled ticket', ticket.ticket_number, err);
    }
  }

  syncQueue.enqueueStatusUpdate(ticket.ticket_number, 'cancelled', pairing.restaurant_id, ticket);
  broadcast('TICKET_CANCELLED', { ticket, ticket_id: ticket.id, table_id: ticket.table_id, table_name: ticket.table_name });
  res.json({ success: true, ticket, cooked: result.cooked, stock_returned: stockReturned });
});

// 5. POST /orders/:id/ready — Kitchen marks ticket ready
app.post('/orders/:id/ready', requireKitchenDevice, (req, res) => {
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
  syncQueue.enqueueStatusUpdate(updatedTicket.ticket_number, 'ready', pairing.restaurant_id, updatedTicket);

  res.json({
    success: true,
    ticket: ticketFor(req, updatedTicket)
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
app.post('/orders/:id/stations/:station/ready', requireKitchenDevice, (req, res) => {
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
    syncQueue.enqueueStatusUpdate(ticket.ticket_number, 'ready', pairing.restaurant_id, ticket);
  } else {
    broadcastTicketChange('STATION_READY', ticket, { station });
    // The status has not changed, but which stations have finished has: send the course state.
    syncQueue.enqueueStatusUpdate(ticket.ticket_number, 'in_progress', pairing.restaurant_id, ticket);
  }
  res.json({ success: true, ticket: ticketFor(req, ticket), ticket_ready: Boolean(result.ticket_ready), station });
});

// 5c. POST /orders/:id/fire — send the next held course (or body.course) to the kitchen.
// Course firing is M2 menu-depth, gated like the rest of it. Recall is deliberately NOT gated:
// it undoes a mistake on a ticket that is already on the pass, and refusing that would leave a
// kitchen stuck mid-service -- which is the one thing plan enforcement must never do.
app.post('/orders/:id/fire', requireKitchenDevice, requireFeature(FEATURES.COURSE_FIRING), (req, res) => {
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
  syncQueue.enqueueStatusUpdate(ticket.ticket_number, 'in_progress', pairing.restaurant_id, ticket);
  autoPrintKot(ticket, pairing, { items: result.fired_items, course: result.fired_course }).catch(() => {});
  res.json({ success: true, ticket: ticketFor(req, ticket), fired_course: result.fired_course, fired_items: result.fired_items.length });
});

// 5d. POST /orders/:id/recall — a ticket marked ready goes back on the board (marked by mistake, or remake).
app.post('/orders/:id/recall', requireKitchenDevice, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = ticketStore.recall(req.params.id, pairing.restaurant_id);
  if (!result.ok) {
    return res.status(ticketRefusalStatus(result.code)).json({ success: false, error: result.error, code: result.code });
  }
  const ticket = result.ticket;
  console.log(`↩︎ Recalled #${ticket.ticket_number} (course ${result.recalled_course})`);
  broadcastTicketChange('TICKET_RECALLED', ticket, { course: result.recalled_course });
  syncQueue.enqueueStatusUpdate(ticket.ticket_number, 'in_progress', pairing.restaurant_id, ticket);
  // The paper KOT for this course was spiked when the course was marked ready, so without this
  // the kitchen is asked to cook again from memory. Fire already reprints; recall now matches it.
  autoPrintKot(ticket, pairing, {
    items: result.recalled_items,
    course: result.recalled_course,
    reprint: true
  }).catch(() => {});
  res.json({ success: true, ticket: ticketFor(req, ticket), recalled_course: result.recalled_course });
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

// 5b-2. GET /public/menu — the menu as a diner sees it (M4 · diner QR menu).
//
// The hub's only unauthenticated read, and deliberately so: a guest scans the code on their table
// and gets the menu without being enrolled as a device. Three things keep that safe.
//
// It is still LAN-only in practice -- the hub binds the restaurant's wifi and CORS is already
// restricted to private hosts -- so this is not an internet-facing endpoint.
// lib/dinerMenu.js builds the answer from an allow-list rather than deleting fields from a copy,
// so station routing, day-part schedules and anything the cache gains later stay invisible.
// And the plan-gated cache is the input, so a tenant without modifiers does not leak them here.
app.get('/public/menu', (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const menuData = restaurantCache.getMenuCache(pairing.restaurant_id);
  if (!menuData || menuData.uninitialized) {
    return res.status(503).json({ success: false, error: 'The menu is not available yet.', code: 'MENU_UNAVAILABLE' });
  }
  // A guest reloads; the kitchen does not. Short enough that an 86'd dish disappears quickly.
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    success: true,
    restaurant: { name: pairing.name || 'Restaurant', currency: pairing.currency || '₹' },
    ...publicMenu(menuData, new Date())
  });
});

// 5b-2b. Guest ordering (§4.5): a guest sends an order to the kitchen from the code on their table.
//
// The hub's SECOND unauthenticated write, and far more consequential than the first -- feedback adds
// a row nobody acts on; this puts food on a pass. It is OFF unless the restaurant turns it on,
// because a kitchen that starts receiving tickets because a hub updated itself would be a bad thing
// to do to someone.
//
// When a table last ordered is held in memory rather than on disk: it bounds a nuisance, and a hub
// restart clearing it is not worth a write on every guest order.
const lastGuestOrderByTable = new Map();

app.get('/public/ordering', (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  // Told to the diner page so it can show a basket, or not, without guessing.
  res.json({ success: true, ordering: pairing.guest_ordering === true, pay_online: false });
});

app.post('/public/order', (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  if (pairing.guest_ordering !== true) {
    return res.status(403).json({ success: false, code: 'ORDERING_OFF', error: 'Ordering from your phone is not switched on here. Please ask a member of staff.' });
  }
  if (!pairing.paired) {
    return res.status(503).json({ success: false, code: 'NOT_READY', error: 'This hub is not set up yet.' });
  }

  const layout = restaurantCache.getTablesCache(pairing.restaurant_id);
  const checked = validateGuestOrder(req.body, { tables: layout?.tables ?? [] });
  if (!checked.ok) {
    return res.status(400).json({ success: false, code: 'INVALID_ORDER', error: checked.errors[0].message, errors: checked.errors });
  }

  const tableKey = String(checked.order.table_id);
  if (orderCoolingDown(lastGuestOrderByTable.get(tableKey))) {
    return res.status(429).json({ success: false, code: 'TOO_SOON', error: 'That has just been sent to the kitchen. Give them a moment, or ask a member of staff.' });
  }

  // Priced by the hub, exactly as a waiter's order is: nothing in the body is trusted.
  const priced = priceOrder(checked.order.items, pairing.restaurant_id);
  if (!priced.ok) {
    return res.status(400).json({ success: false, code: priced.code, error: 'Something on that order is no longer available. Please check the menu and try again.', details: priced.details });
  }

  const short = inventoryStore.check(pairing.restaurant_id, priced.items);
  if (short.length > 0) {
    const refusal = refusalFor(short, priced.items);
    return res.status(409).json({ success: false, code: 'OUT_OF_STOCK', error: refusal.error });
  }

  const ticket = ticketStore.addTicket({
    table_id: checked.order.table_id,
    table_name: checked.order.table_name,
    note: checked.order.note,
    // How the kitchen and the waiter know this came from a phone rather than from staff. It is the
    // name printed on the KOT and shown on the board, which is where someone would actually look.
    created_by_waiter: 'Guest (QR)'
  }, pairing.restaurant_id, priced);

  lastGuestOrderByTable.set(tableKey, new Date().toISOString());
  try {
    recordStockUse(ticket, inventoryStore.consume(pairing.restaurant_id, priced.items, { ref: `#${ticket.ticket_number}`, by: 'Guest (QR)' }));
  } catch (err) {
    console.error('📦 Could not record stock use for guest ticket', ticket.ticket_number, err);
  }

  broadcast('NEW_ORDER', ticket);
  broadcast('order_created', { ticket_id: ticket.id, ticket_number: ticket.ticket_number, table_id: ticket.table_id, table_name: ticket.table_name, status: 'in_progress', ticket });
  syncQueue.enqueueTicket(ticket);
  autoPrintKot(ticket, pairing).catch(() => {});
  console.log(`📱 Guest order from ${ticket.table_name}: ticket #${ticket.ticket_number}.`);

  res.status(201).json(guestOrderReceipt(ticket));
});

// Reception turns guest ordering on and off. Reception-only: it decides whether strangers on the
// wifi may send tickets to the kitchen.
app.put('/admin/guest-ordering', requireReception, (req, res) => {
  const on = req.body?.ordering === true;
  hubConfig.saveConfig({ ...hubConfig.getPairingInfo(), guest_ordering: on });
  console.warn(`📱 Guest ordering from the table QR is now ${on ? 'ON' : 'OFF'}.`);
  res.json({ success: true, ordering: on });
});

// 5b-3. POST /public/feedback — a guest rates their meal (M4 · 4.5).
//
// The hub's only unauthenticated WRITE, so it is deliberately narrow: a rating, an optional
// comment, and the table from the code they scanned. Nothing else is read from the body.
//
// The bill is resolved here rather than sent by the guest. A guest cannot see or guess an invoice,
// and asking them to name one would hand an unauthenticated caller a way to probe the ledger --
// so the hub finds the table's own most recently settled bill and stamps it. Reception learns
// which meal a comment is about; the guest learns nothing.
app.post('/public/feedback', (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const checked = validateFeedback(body);
  if (!checked.ok) {
    return res.status(400).json({ success: false, error: checked.errors[0], errors: checked.errors, code: 'INVALID_FEEDBACK' });
  }

  // Carried from the QR, same rule as the diner page: a label, never trusted, never a lookup key
  // beyond matching a table we already know about.
  const raw = body.table === undefined ? '' : String(body.table).trim().slice(0, 20);
  const table = /^[A-Za-z0-9 _-]*$/.test(raw) ? raw : '';

  if (feedbackStore.isCoolingDown(pairing.restaurant_id, table || null)) {
    return res.status(429).json({ success: false, error: 'Thanks — we have already got your feedback for this table.', code: 'ALREADY_SUBMITTED' });
  }

  // The table's own most recent settled bill, within the window. Never exposed in the response.
  const since = Date.now() - BILL_WINDOW_MS;
  const invoice = table
    ? invoiceStore.listInvoices(pairing.restaurant_id)
        .filter(inv => String(inv.table_name ?? inv.table_id) === table && inv.paid_at && new Date(inv.paid_at).getTime() >= since)
        .sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)))[0] || null
    : null;

  const entry = feedbackStore.add({
    restaurantId: pairing.restaurant_id,
    table: table || null,
    rating: checked.rating,
    comment: checked.comment,
    invoice
  });

  syncQueue.enqueueFeedback(entry);
  console.log(`⭐ Feedback ${entry.rating}/5 from ${entry.table || 'the floor'}${entry.invoice_number ? ` (${entry.invoice_number})` : ''}`);
  broadcast('FEEDBACK_RECEIVED', { rating: entry.rating, table: entry.table });
  // Deliberately thin: a guest gets an acknowledgement, not a record id they could enumerate.
  res.status(201).json({ success: true });
});

// GET /feedback — what guests have said. Reception only; this is the restaurant's own mail.
app.get('/feedback', requireReceptionFor('Guest feedback'), (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  res.json({
    success: true,
    ...feedbackStore.summary(pairing.restaurant_id),
    entries: feedbackStore.list(pairing.restaurant_id, req.query.limit)
  });
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
    tables: { revision: restaurantCache.getTablesCache().revision, ...catalog.tables },
    inventory: { revision: inventoryStore.stateFor(hubConfig.getPairingInfo().restaurant_id).revision, ...catalog.inventory }
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

// ----- Stock & recipes (inventory). Reception only: it is the owner's costing and counts. -----
// Stock changes with every order, so these carry no base_revision guard (the menu's would conflict
// constantly). Adjustments are deltas rather than overwrites, except a count, which is by design.
const inventoryRefusal = (res, result) => res.status(result.status).json({
  success: false, error: result.error, code: result.code, ...(result.errors ? { errors: result.errors } : {})
});

app.get('/admin/inventory', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const menu = restaurantCache.menuCache?.items ?? [];
  const snap = inventoryStore.snapshot(rid);
  // A recipe for a dish that has since left the menu is kept, and flagged rather than silently hidden.
  const recipes = snap.recipes.map(r => {
    const dish = menu.find(i => String(i.id) === r.item_id);
    return { ...r, item_name: dish?.name ?? null, on_menu: Boolean(dish) };
  });
  res.json({ success: true, ...snap, recipes, units: UNITS });
});

app.get('/admin/inventory/movements', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const itemId = typeof req.query.item_id === 'string' ? req.query.item_id : undefined;
  res.json({ success: true, movements: inventoryStore.movements(rid, { itemId, limit: req.query.limit }) });
});

app.post('/admin/inventory/items', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const result = inventoryStore.addIngredient(rid, req.body?.item, { by: 'Reception' });
  if (!result.ok) return inventoryRefusal(res, result);
  res.status(201).json({ success: true, revision: result.data.revision, item: result.meta.item });
});

app.put('/admin/inventory/items/:id', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const result = inventoryStore.updateIngredient(rid, req.params.id, req.body?.item);
  if (!result.ok) return inventoryRefusal(res, result);
  res.json({ success: true, revision: result.data.revision, item: result.meta.item });
});

app.delete('/admin/inventory/items/:id', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const result = inventoryStore.deleteIngredient(rid, req.params.id);
  if (!result.ok) return inventoryRefusal(res, result);
  res.json({ success: true, revision: result.data.revision });
});

app.post('/admin/inventory/items/:id/adjust', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const result = inventoryStore.adjust(rid, req.params.id, req.body, { by: 'Reception' });
  if (!result.ok) return inventoryRefusal(res, result);
  res.json({ success: true, revision: result.data.revision, item: result.meta.item, delta: result.meta.delta });
});

app.put('/admin/inventory/recipes', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const result = inventoryStore.setRecipe(rid, req.body, { items: restaurantCache.menuCache?.items ?? [] });
  if (!result.ok) return inventoryRefusal(res, result);
  res.json({ success: true, revision: result.data.revision, ...(result.meta.recipe ? { recipe: result.meta.recipe } : { removed: true }) });
});

app.post('/admin/menu/import/preview', requireReception, (req, res) => {
  // The stored menu, as the commit below will see it: a preview of what a save will do must not be
  // worked out from a view with the plan's or stock's overlays on.
  const menu = restaurantCache.getStoredMenu();
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
// A hub that holds SOME bills is refused by the restore (it is the authority on what it holds), so a
// ledger that is merely short stays short and nobody finds out. This reports the gap, and fills it
// only when asked: the merge adds what is missing and never touches a record already here.
app.get('/reconciliation/ledger-gap', receptionCash, async (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  res.json({ success: true, ...(await syncQueue.checkLedgerGap(pairing.restaurant_id)) });
});

app.post('/reconciliation/ledger-repair', receptionCash, async (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = await syncQueue.repairLedgerFromCloud(pairing.restaurant_id, { apply: req.body?.apply === true });
  if (!result.ok) {
    const status = result.reason === 'OFFLINE' ? 503 : result.reason === 'NOT_PAIRED' ? 409 : 502;
    return res.status(status).json({ success: false, code: result.reason, error: ledgerRepairRefusal(result) });
  }
  res.json({ success: true, ...result });
});

const ledgerRepairRefusal = result => ({
  OFFLINE: 'The hub cannot reach the internet, so it cannot compare its bills with the cloud. Try again when it is back.',
  NOT_PAIRED: 'This hub is not paired to a restaurant, so there is no cloud ledger to compare with.',
  CLOUD_ERROR: `The cloud refused the request${result.detail ? `: ${result.detail}` : '.'}`
}[result.reason] || 'The ledger could not be checked.');

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
app.post('/invoices/:id/void', requireDevice, requireReceptionFor('Voiding a bill'), (req, res) => {
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
app.post('/invoices/:id/mark-paid', requireDevice, requireReceptionFor('Settling a bill'), (req, res) => {
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
// ----- Bookings and the walk-in queue (§4.6). Reception only: it is the front-of-house diary. ----
//
// Guests are reached by WhatsApp click-to-chat rather than an API: the hub builds a link, and a
// member of staff taps it to send from their own phone. No provider, no approval, no per-message
// fee, and it works on a hub with no internet at all -- the only cost is that a person presses
// send, which when a table is about to be given away is not really a cost.
const RESERVATION_REFUSAL = { NOT_FOUND: 404, ALREADY_SEATED: 409, NO_PHONE: 409, FULLY_BOOKED: 409, NO_TABLE_THAT_SIZE: 409 };
const bookingRefusal = (res, result) =>
  res.status(result.status || RESERVATION_REFUSAL[result.code] || 400).json({
    success: false, error: result.error, code: result.code,
    ...(result.errors ? { errors: result.errors } : {}),
    ...(result.availability ? { availability: result.availability } : {})
  });

/** The restaurant's own day, since 'tonight's bookings' is a local idea, not a UTC one. */
const localDay = (value, now = new Date()) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/**
 * What staff send a guest. Written here rather than on a screen so every route says the same thing,
 * and so a booking taken at the counter and one listed in the diary carry an identical message.
 */
const bookingMessage = (row, restaurantName) =>
  `Hello ${row.guest_name}, this is ${restaurantName}. We are looking forward to seeing you at ${new Date(row.at).toLocaleString()}.`;
const readyMessage = (row, restaurantName) =>
  `Hello ${row.guest_name}, your table at ${restaurantName} is ready.`;

/** A guest row with the ways to reach them already built, so no screen has to know the format. */
const withContact = (row, message) => ({
  ...row,
  ...(row.phone ? { phone_display: formatPhone(row.phone), whatsapp: whatsappLink(row.phone, message), tel: telLink(row.phone) } : {})
});
const restaurantName = () => hubConfig.getPairingInfo().name || 'the restaurant';

// ----- Recognising a returning guest (§4.5). ----------------------------------------------------
//
// Read from the booking diary rather than a list of its own, so there is one source of truth. The
// identifier is the phone number, matched on a per-restaurant salted hash -- this never reads a
// number back out of the key, and one tenant's guests cannot be joined against another's.
//
// There is deliberately no reward scheme: no points, no tiers, no discounts. Those are a
// commercial decision nobody has made. This answers the question a host actually asks, which is
// whether they have been here before.
app.get('/admin/guests', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  res.json({ success: true, guests: regulars(reservationStore.stateFor(rid), { limit: Number(req.query.limit) || 50 }) });
});

// Asked as reception types a number into a booking, so a regular is recognised before the booking
// is taken rather than after.
app.get('/admin/guests/lookup', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.json({ success: true, guest: null, recognised: null });
  const guest = guestByPhone(reservationStore.stateFor(rid), phone, rid);
  res.json({ success: true, guest, recognised: recognise(guest) });
});

// ---------------------------------------------------------------------------------------------------
// Sales analytics and scheduled summaries (§3 analytics). Reception-only: this is the restaurant's revenue.
// ---------------------------------------------------------------------------------------------------

const analyticsInputs = () => {
  const pairing = hubConfig.getPairingInfo();
  const rid = pairing.restaurant_id;
  return { rid, currency: pairing.currency || '₹', invoices: invoiceStore.listInvoices(rid), visits: allVisits(reservationStore.stateFor(rid)) };
};

// GET /admin/sales?period=today|week|month|custom[&from=&to=] -- the period against the one before it,
// like for like, with guests new and returning, and the cohorts by month of first visit.
app.get('/admin/sales', requireReception, (req, res) => {
  const win = windowFor(String(req.query.period || 'today'), new Date(), { from: req.query.from, to: req.query.to });
  if (!win.ok) return res.status(400).json({ success: false, code: win.code, error: win.error });
  const { rid, currency, invoices, visits } = analyticsInputs();
  res.json({ success: true, currency, periods: [...PRESET_IDS, 'custom'], ...salesReport({ invoices, visits, restaurantId: rid, window: win }), cohorts: monthlyCohorts(visits) });
});

// GET /admin/reports -- the summaries the hub has prepared, newest first, each with a link that opens
// WhatsApp with it written. Preparing is idempotent, so opening the screen can never find it stale.
app.get('/admin/reports', requireReception, (req, res) => {
  const { rid, currency, invoices, visits } = analyticsInputs();
  reportStore.ensure({ invoices, visits, restaurantId: rid, currency });
  res.json({ success: true, contact: reportStore.contactFor(rid), summaries: reportStore.list(rid) });
});

app.put('/admin/reports/contact', requireReception, (req, res) => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const result = reportStore.setContact(rid, req.body?.phone);
  if (!result.ok) return res.status(400).json({ success: false, code: result.code, error: result.error });
  res.json({ success: true, contact: result.phone });
});

app.post('/admin/reports/:id/sent', requireReception, (req, res) => {
  const result = reportStore.markSent(hubConfig.getPairingInfo().restaurant_id, req.params.id);
  if (!result.ok) return res.status(404).json({ success: false, code: result.code, error: result.error });
  res.json({ success: true, sent_at: result.summary.sent_at });
});

// The summaries are prepared on a timer and at boot, not only when someone opens the screen: the point of
// a scheduled summary is that it is already there in the morning. Idempotent, so a restart repeats nothing.
const prepareSummaries = () => {
  try {
    const { rid, currency, invoices, visits } = analyticsInputs();
    reportStore.ensure({ invoices, visits, restaurantId: rid, currency });
  } catch (err) {
    console.error('📊 Could not prepare summaries:', err);
  }
};
setTimeout(prepareSummaries, 3000).unref();
setInterval(prepareSummaries, 30 * 60 * 1000).unref();

// What a booking or a walk-in earns under the restaurant's own rule, if it has set one (lib/loyalty.js).
const rewardOffer = row => {
  const earned = reservationStore.rewardDue(hubConfig.getPairingInfo().restaurant_id, row, rewardScheme());
  return earned ? { reward_due: earned } : {};
};

app.get('/admin/bookings', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const snap = reservationStore.snapshot(pairing.restaurant_id, localDay(req.query.day));
  const name = restaurantName();
  res.json({
    success: true,
    ...snap,
    reservations: snap.reservations.map(r => ({
      ...withContact(r, bookingMessage(r, name)),
      // The same link with the reminder's words in it, for a booking that can still be reminded.
      ...(r.phone && r.status === 'booked' ? { reminder_whatsapp: whatsappLink(r.phone, reminderMessage(r, name)) } : {}),
      ...rewardOffer(r)
    })),
    waitlist: snap.waitlist.map(e => ({ ...withContact(e, readyMessage(e, name)), ...rewardOffer(e) }))
  });
});

// Whether a time could be taken, without taking it: the console asks before it offers to book.
app.get('/admin/bookings/availability', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  res.json({
    success: true,
    ...reservationStore.availability(pairing.restaurant_id, {
      at: req.query.at,
      party_size: Math.floor(Number(req.query.party_size)) || 1,
      duration_mins: req.query.duration_mins ? Math.floor(Number(req.query.duration_mins)) : undefined
    })
  });
});

app.post('/admin/bookings', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.book(pairing.restaurant_id, req.body, { force: req.body?.force === true });
  if (!result.ok) return bookingRefusal(res, result);
  res.status(201).json({ success: true, revision: result.data.revision, reservation: withContact(result.meta.reservation, bookingMessage(result.meta.reservation, restaurantName())), availability: result.meta.availability });
});

// The restaurant's own rule for rewarding a guest who comes back ("every 5th visit, a free dessert"), off until it sets one. The
// product chooses nothing: how generous to be is the owner's decision. The hub only tells the host when a booking earns it and
// records that it was given; applying it to the bill is a person's job (lib/loyalty.js).
const rewardScheme = () => normalizeRewardScheme(hubConfig.getPairingInfo().rewards);

app.get('/admin/rewards', requireReception, (req, res) => {
  const scheme = rewardScheme();
  res.json({ success: true, enabled: Boolean(scheme), ...(scheme ? { every_n_visits: scheme.every_n_visits, text: scheme.text } : {}), limits: { max_visits: MAX_VISITS_BETWEEN, max_text: REWARD_TEXT_MAX } });
});

app.put('/admin/rewards', requireReception, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.enabled === false) {
    hubConfig.saveConfig({ ...hubConfig.getPairingInfo(), rewards: null });
    return res.json({ success: true, enabled: false });
  }
  const scheme = normalizeRewardScheme(body);
  if (!scheme) {
    return res.status(400).json({
      success: false, code: 'INVALID_REWARD',
      error: `Choose a number of visits from 2 to ${MAX_VISITS_BETWEEN}, and say what the guest gets (up to ${REWARD_TEXT_MAX} characters).`
    });
  }
  hubConfig.saveConfig({ ...hubConfig.getPairingInfo(), rewards: { every_n_visits: scheme.every_n_visits, text: scheme.text } });
  console.log(`🎁 Reward set: every ${scheme.every_n_visits} visits, "${scheme.text}".`);
  res.json({ success: true, enabled: true, every_n_visits: scheme.every_n_visits, text: scheme.text });
});

app.post('/admin/bookings/:id/reward', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.giveReward(pairing.restaurant_id, req.params.id, pairing.rewards);
  if (!result.ok) return bookingRefusal(res, result);
  res.json({ success: true, already: result.meta.already === true, reservation: withContact(result.meta.reservation, bookingMessage(result.meta.reservation, restaurantName())) });
});

app.delete('/admin/bookings/:id/reward', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.takeBackReward(pairing.restaurant_id, req.params.id);
  if (!result.ok) return bookingRefusal(res, result);
  res.json({ success: true, reservation: withContact(result.meta.reservation, bookingMessage(result.meta.reservation, restaurantName())) });
});

// Who to remind of tomorrow's table. The hub sends nothing: it lists the bookings, builds the WhatsApp link with the words
// in it, and records that a person says they sent it (when, and who), so two people do not ring the same guest.
app.get('/admin/bookings/reminders', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const asked = req.query.hours === undefined ? undefined : Number(req.query.hours);
  const due = reservationStore.remindersDue(pairing.restaurant_id, { withinHours: asked });
  const name = restaurantName();
  res.json({
    success: true,
    window_hours: Number.isFinite(asked) && asked > 0 ? Math.min(asked, 24 * 14) : 24,
    reminders: due.map(r => withContact(r, reminderMessage(r, name)))
  });
});

app.post('/admin/bookings/:id/reminded', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.markReminded(pairing.restaurant_id, req.params.id, { by: req.body?.by });
  if (!result.ok) return bookingRefusal(res, result);
  res.json({ success: true, already: result.meta.already === true, reservation: withContact(result.meta.reservation, reminderMessage(result.meta.reservation, restaurantName())) });
});

app.delete('/admin/bookings/:id/reminded', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.unmarkReminded(pairing.restaurant_id, req.params.id);
  if (!result.ok) return bookingRefusal(res, result);
  res.json({ success: true, reservation: withContact(result.meta.reservation, bookingMessage(result.meta.reservation, restaurantName())) });
});

// Change a booking that is still to come. Only the fields a person may change are read from the body (lib/reservations.js), `force` among
// them being a plain true that says the restaurant knows it is overbooking.
app.put('/admin/bookings/:id', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.updateBooking(pairing.restaurant_id, req.params.id, req.body, { force: req.body?.force === true });
  if (!result.ok) return bookingRefusal(res, result);
  res.json({
    success: true,
    unchanged: result.meta.unchanged === true,
    revision: result.data.revision,
    reservation: withContact(result.meta.reservation, bookingMessage(result.meta.reservation, restaurantName())),
    ...(result.meta.availability ? { availability: result.meta.availability } : {})
  });
});

app.put('/admin/bookings/:id/status', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.setReservationStatus(pairing.restaurant_id, req.params.id, req.body?.status);
  if (!result.ok) return bookingRefusal(res, result);
  res.json({ success: true, reservation: withContact(result.meta.reservation, bookingMessage(result.meta.reservation, restaurantName())) });
});

app.post('/admin/waitlist', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.addWalkIn(pairing.restaurant_id, req.body);
  if (!result.ok) return bookingRefusal(res, result);
  res.status(201).json({ success: true, revision: result.data.revision, entry: withContact(result.meta.entry, readyMessage(result.meta.entry, restaurantName())) });
});

// The same reward, for a guest in the queue who has been here before (they have to have left a number to be recognised).
app.post('/admin/waitlist/:id/reward', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.giveWalkInReward(pairing.restaurant_id, req.params.id, pairing.rewards);
  if (!result.ok) return bookingRefusal(res, result);
  res.json({ success: true, already: result.meta.already === true, entry: withContact(result.meta.entry, readyMessage(result.meta.entry, restaurantName())) });
});

app.delete('/admin/waitlist/:id/reward', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.takeBackWalkInReward(pairing.restaurant_id, req.params.id);
  if (!result.ok) return bookingRefusal(res, result);
  res.json({ success: true, entry: withContact(result.meta.entry, readyMessage(result.meta.entry, restaurantName())) });
});

// ----- Guests' requests for a table, and the public page they come from (§4.6). ------------------------------
//
// A guest asks on a page served by the operator service; the request waits in the cloud until this hub collects it. It is only ever a
// QUESTION: accepting it books the table through the same check as any booking, declining it books nothing, and a person tells the guest
// from their own phone. The hub collects the inbox in the background and when asked, and clears from the cloud what staff have answered.
const operatorUrl = () => normalizeOperatorUrl(process.env.OPERATOR_SERVICE_URL);
const CLOUD_READ_MS = 4000;      // a read that has to wait for the internet must not hold up a screen

/** The hub's own cloud session, or null while it has none (offline, or not set up). */
const hubCloud = async () => {
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const auth = await authenticateHubStaff(rid);   // answers "no" by itself when there is no restaurant yet or no cloud
  return auth?.success ? { rid, client: supabase } : null;
};

/** Collect the inbox, now and on a timer: one at a time, and never throws (lib/bookingInboxRunner.js). */
const inbox = createInboxRunner({ cloudSession: hubCloud, pull: cloud => pullInbox(cloud.client, cloud.rid, reservationStore) });
const pullBookingInbox = inbox.run;

// The hub's report on itself (lib/heartbeat.js): every few minutes it tells the cloud it is alive and how its sync is doing, which is what
// the operator console shows. Counts and times only; asked afresh each time, so a queue that grew is reported as grown.
const HUB_STARTED_AT = new Date().toISOString();
const HUB_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version ?? null; } catch { return null; }
})();
const heartbeat = createHeartbeatRunner({
  cloudSession: hubCloud,
  collect: makeCollector({ startedAt: HUB_STARTED_AT, version: HUB_VERSION, syncQueue, deviceAuth, waiterStore })
});

/** What a screen is shown of a request: nothing that identifies the guest to the cloud or to loyalty. */
const publicRequest = ({ phone_key, cloud_id, ...request }) => request;

app.get('/admin/booking-requests', requireReception, async (req, res) => {
  if (req.query.refresh === '1') await withinMs(pullBookingInbox(), CLOUD_READ_MS);
  const rid = hubConfig.getPairingInfo().restaurant_id;
  const words = requestMessages(restaurantName());
  res.json({
    success: true,
    requests: reservationStore.pendingRequests(rid).map(r => ({
      ...withContact(publicRequest(r), words.asked(r)),
      availability: reservationStore.availability(rid, { at: r.at, party_size: r.party_size })
    })),
    checked_at: inbox.last().at,
    inbox_ok: inbox.last().ok
  });
});

app.post('/admin/booking-requests/:id/accept', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.acceptRequest(pairing.restaurant_id, req.params.id, { force: req.body?.force === true });
  if (!result.ok) return bookingRefusal(res, result);
  setImmediate(() => pullBookingInbox());   // clears the answered request from the cloud without making anyone wait
  const request = result.meta.request;
  res.status(201).json({
    success: true,
    reservation: withContact(result.meta.reservation, bookingMessage(result.meta.reservation, restaurantName())),
    availability: result.meta.availability,
    request: publicRequest(request),
    reply_whatsapp: whatsappLink(request.phone, requestMessages(restaurantName()).confirmed(request))
  });
});

app.post('/admin/booking-requests/:id/decline', requireReception, (req, res) => {
  const result = reservationStore.declineRequest(hubConfig.getPairingInfo().restaurant_id, req.params.id);
  if (!result.ok) return bookingRefusal(res, result);
  setImmediate(() => pullBookingInbox());
  const request = result.meta.request;
  res.json({ success: true, request: publicRequest(request), reply_whatsapp: whatsappLink(request.phone, requestMessages(restaurantName()).declined(request)) });
});

// The page itself: on or off, and its address (lib/bookingPageRoutes.js). The hub remembers what it last saw, so the screen still says
// something with the internet down.
app.use(bookingPageRoutes({
  guard: requireReception,
  cloudSession: hubCloud,
  operatorUrl,
  memory: pageMemory(hubConfig)
}));

// Change someone still waiting: a new wait to tell them, a bigger party, a number they gave later. They keep their place.
app.put('/admin/waitlist/:id', requireReception, (req, res) => {
  const result = reservationStore.updateWalkIn(hubConfig.getPairingInfo().restaurant_id, req.params.id, req.body);
  if (!result.ok) return bookingRefusal(res, result);
  res.json({
    success: true,
    unchanged: result.meta.unchanged === true,
    entry: withContact(result.meta.entry, readyMessage(result.meta.entry, restaurantName()))
  });
});

app.put('/admin/waitlist/:id/status', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  const result = reservationStore.setWaitlistStatus(pairing.restaurant_id, req.params.id, req.body?.status);
  if (!result.ok) return bookingRefusal(res, result);
  res.json({ success: true, entry: withContact(result.meta.entry, readyMessage(result.meta.entry, restaurantName())) });
});

// ----- Staff and devices (§4.4). Reception only: this is who may take money in the restaurant. --
//
// The handset's own /waiters routes below are unchanged. These are the managing half: who is on
// the list, what they are, how they get a PIN, and which devices may talk to this hub at all.
const staffRefusal = (res, result) =>
  res.status({ NOT_FOUND: 404, DUPLICATE_NAME: 409, ALREADY_SET_UP: 409 }[result.code] || 400)
    .json({ success: false, error: result.error, code: result.code });

app.get('/admin/staff', requireReception, (req, res) => {
  res.json({
    success: true,
    staff: waiterStore.listAll(),
    devices: deviceAuth.listDevicesPublic(),
    roles: ROLES.map(id => ({ id, label: ROLE_LABEL[id] }))
  });
});

// Creates the person and returns their invite code ONCE. Reception reads it to them; it is
// stored only as a hash, so this screen is the only place it ever exists in full.
app.post('/admin/staff', requireReception, (req, res) => {
  const result = waiterStore.invite({ name: req.body?.name, role: req.body?.role });
  if (!result.ok) return staffRefusal(res, result);
  res.status(201).json({ success: true, ...result });
});

app.post('/admin/staff/:id/reinvite', requireReception, (req, res) => {
  const result = waiterStore.reinvite(req.params.id);
  if (!result.ok) return staffRefusal(res, result);
  res.json({ success: true, ...result });
});

app.post('/admin/staff/:id/pin', requireReception, (req, res) => {
  const result = waiterStore.rotatePin(req.params.id, req.body?.pin);
  if (!result.ok) return staffRefusal(res, result);
  res.json({ success: true, waiter: result.waiter });
});

app.put('/admin/staff/:id/role', requireReception, (req, res) => {
  const result = waiterStore.setRole(req.params.id, req.body?.role);
  if (!result.ok) return staffRefusal(res, result);
  res.json({ success: true, waiter: result.waiter });
});

app.delete('/admin/staff/:id', requireReception, (req, res) => {
  const result = waiterStore.deactivate(req.params.id);
  if (!result.ok) return staffRefusal(res, result);
  res.json({ success: true });
});

// Revoking one device refuses that handset on its very next request. Rotating the enrollment
// code instead revokes EVERY device, which is the right answer for a leaked code and the wrong
// one for a lost phone -- it makes every other handset re-enrol mid-service.
app.delete('/admin/devices/:id', requireReception, (req, res) => {
  const result = deviceAuth.revokeDevice(req.params.id);
  if (!result.ok) return res.status(404).json({ success: false, error: result.error, code: result.code });
  console.warn(`🔒 Device revoked: ${result.device.label} (${result.device.id}).`);
  res.json({ success: true, device: result.device });
});

app.post('/admin/devices/prune', requireReception, (req, res) => {
  res.json({ success: true, ...deviceAuth.pruneExpiredDevices() });
});

// Every handset must enrol again with the new code. Deliberately separate from revoking one.
app.post('/admin/devices/rotate-code', requireReception, (req, res) => {
  const revoked = deviceAuth.listDevices().length;
  deviceAuth.rotateEnrollmentCode();
  console.warn(`🔒 Enrollment code rotated; ${revoked} device(s) must enrol again.`);
  res.json({ success: true, revoked });
});

// The one staff route a handset may call without being reception: redeeming an invite. It needs
// a device token (so only an enrolled handset can try) and is rate-limited by the same bucket as
// enrollment, because it is a second place a short code is guessed at.
app.post('/waiters/redeem-invite', requireDevice, (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (deviceAuth.isRateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Wait a minute and try again.', code: 'RATE_LIMITED' });
  }
  const result = waiterStore.redeemInvite(req.body?.code, req.body?.pin);
  if (!result.ok) {
    if (result.code === 'INVALID_INVITE') deviceAuth.recordFailure(ip);
    return res.status(result.code === 'INVALID_INVITE' ? 401 : 400).json({ success: false, error: result.error, code: result.code });
  }
  res.json({ success: true, waiter: result.waiter });
});

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
//
// Reception only. It used to need nothing but a device token, so any enrolled phone could create a
// waiter with a PIN of its own choosing; the comment above said reception and the guard did not.
// Reception's own Staff tab goes through /admin/staff, which sends an invite rather than a typed PIN.
app.post('/waiters', requireReceptionFor('Adding staff'), (req, res) => {
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
// Reception only, for the same reason: a handset could lock another waiter out in the middle of a shift.
app.delete('/waiters/:id', requireReceptionFor('Removing staff'), (req, res) => {
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
app.post('/invoices/:id/refund', requireDevice, requireReceptionFor('Refunding a bill'), requireFeature(FEATURES.REFUNDS), (req, res) => {
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
app.post('/invoices/:id/split-by-seats', requireDevice, requireReceptionFor('Splitting a bill'), requireFeature(FEATURES.SPLIT_BILL), (req, res) => {
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
app.post('/invoices/:id/split-by-items', requireDevice, requireReceptionFor('Splitting a bill'), requireFeature(FEATURES.SPLIT_BILL), (req, res) => {
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
app.post('/invoices/:id/split-by-amounts', requireDevice, requireReceptionFor('Splitting a bill'), requireFeature(FEATURES.SPLIT_BILL), (req, res) => {
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
app.delete('/invoices/:id/splits', requireDevice, requireReceptionFor('Undoing a split'), (req, res) => {
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
app.post('/invoices/:id/splits/:index/mark-paid', requireDevice, requireReceptionFor('Settling a split'), (req, res) => {
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

/** True when a close-the-table body tries to change what the bill comes to (any discount, or a service-charge override). */
function setsPrice(adjustments) {
  if (!adjustments) return false;
  const discounts = adjustments.discounts;
  const hasDiscount = Array.isArray(discounts) ? discounts.length > 0 : discounts !== undefined && discounts !== null;
  return hasDiscount || (adjustments.service_charge_percent !== undefined && adjustments.service_charge_percent !== null);
}

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

  // A handset closes a table at the price on the screen. A discount or a service-charge override is a
  // money decision, so it is reception's alone -- and refused before anything is billed or cleared.
  if (setsPrice(adjustments) && !isReceptionRequest(req)) {
    return res.status(403).json({
      success: false,
      error: 'Discounts and service-charge changes are only available on the reception laptop.',
      code: 'RECEPTION_ONLY'
    });
  }

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
      syncQueue.enqueueStatusUpdate(t.ticket_number || t.id, 'completed', pairing.restaurant_id, undefined, { requestId: t.order_request_id || t.id });
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
      syncQueue.enqueueStatusUpdate(t.ticket_number || t.id, 'completed', pairing.restaurant_id, undefined, { requestId: t.order_request_id || t.id });
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
// Starting, changing and cancelling the subscription (§4.4). Reception only; the hub forwards to the operator service, which is
// the only thing that holds the Razorpay keys, and proves who it is with its own cloud sign-in. Unconfigured unless
// OPERATOR_SERVICE_URL names the service.
const billingClient = createBillingClient({
  baseUrl: process.env.OPERATOR_SERVICE_URL,
  getToken: async () => {
    const auth = await authenticateHubStaff(hubConfig.getPairingInfo().restaurant_id);
    if (!auth?.success) return null;
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token ?? null;
  }
});
app.use(billingRoutes({
  client: billingClient,
  guard: requireReceptionFor('Billing'),
  refreshPlan: () => hubConfig.syncPlanFromCloud()
}));

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
    // Whether this hub has told the cloud it is alive, and when it last did (lib/heartbeat.js).
    heartbeat: heartbeat.last(),
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

/**
 * Text going into server-rendered HTML. Table names are the restaurant's own, typed in the admin
 * console, so this is not guarding against an attacker so much as against an apostrophe in
 * "Chef's Table" quietly breaking the page it is printed on.
 */
const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// GET /qr/diner/sheet — every table's code on one printable page, for reception.
//
// Server-rendered rather than another React entry: its whole job is to come out of a printer
// correctly, and the laptop that prints it is the only thing that may see it.
app.get('/qr/diner/sheet', async (req, res) => {
  if (!isReceptionRequest(req)) {
    return res.status(403).json({ error: 'Table QR codes are only available on the reception laptop.', code: 'RECEPTION_ONLY' });
  }
  const pairing = hubConfig.getPairingInfo();
  const layout = restaurantCache.getTablesCache(pairing.restaurant_id);
  const tables = Array.isArray(layout?.tables) ? layout.tables : [];

  try {
    const cards = await Promise.all(tables.map(async t => {
      const label = String(t.name ?? t.id ?? '');
      const url = `${SERVER_URL}/diner?t=${encodeURIComponent(label)}`;
      const qr = await QRCode.toDataURL(url, { width: 420, margin: 1, errorCorrectionLevel: 'M' });
      return `
        <figure class="card">
          <img src="${qr}" alt="QR code for table ${escapeHtml(label)}">
          <figcaption>
            <strong>${escapeHtml(label)}</strong>
            <span>${escapeHtml(t.section || '')}</span>
          </figcaption>
          <p class="hint">Scan for the menu</p>
        </figure>`;
    }));

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Table codes — ${escapeHtml(pairing.name || 'Restaurant')}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 1.5rem; background: #fff; color: #111;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { margin-bottom: 1.25rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.25rem; }
  .muted { color: #666; font-size: .875rem; margin: 0; }
  .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 1rem; }
  .card { margin: 0; border: 1px dashed #bbb; border-radius: .5rem; padding: .75rem; text-align: center; }
  .card img { width: 100%; height: auto; display: block; }
  figcaption { display: flex; flex-direction: column; margin-top: .4rem; }
  figcaption strong { font-size: 1.05rem; }
  figcaption span { color: #666; font-size: .8rem; }
  .hint { margin: .3rem 0 0; font-size: .75rem; color: #444; }
  .empty { color: #666; }
  @media print {
    /* The dashed border is the cut line, so it has to survive the printer's colour dropping. */
    body { padding: 0; }
    header { display: none; }
    .card { break-inside: avoid; page-break-inside: avoid; border-color: #999; }
  }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(pairing.name || 'Restaurant')} — table codes</h1>
    <p class="muted">Print, cut along the dashed lines and put one on each table. A guest scans it to read the menu; they must be on the restaurant's wifi.</p>
  </header>
  ${tables.length ? `<div class="sheet">${cards.join('')}</div>` : '<p class="empty">This hub has no tables yet, so there is nothing to print.</p>'}
</body>
</html>`);
  } catch {
    res.status(500).json({ success: false, error: 'Failed to generate the table codes' });
  }
});

// GET /qr/diner?table=4 — the code that goes on a table, for reception to print or display.
//
// Reception-only even though what it points at is public: the code embeds this hub's LAN
// address, and handing that to anything that asks would be telling a stranger where the hub
// lives. The menu behind it is public; the directions to it are not advertised.
app.get('/qr/diner', async (req, res) => {
  if (!isReceptionRequest(req)) {
    return res.status(403).json({ error: 'Table QR codes are only available on the reception laptop.', code: 'RECEPTION_ONLY' });
  }
  // Carried through to the page so a guest can see they scanned their own table's code.
  // Nothing is decided by it, so an odd value is harmless -- but it still has to survive a URL.
  const raw = req.query.table === undefined ? '' : String(req.query.table).trim().slice(0, 20);
  const table = /^[A-Za-z0-9 _-]*$/.test(raw) ? raw : '';
  const dinerUrl = `${SERVER_URL}/diner${table ? `?t=${encodeURIComponent(table)}` : ''}`;

  try {
    res.json({
      success: true,
      table: table || null,
      diner_url: dinerUrl,
      // Bigger and more error-tolerant than the pairing QR: this one gets printed small, stuck
      // to a table, and scanned in low light by whatever phone a guest happens to own.
      qr_code: await QRCode.toDataURL(dinerUrl, { width: 512, margin: 2, errorCorrectionLevel: 'M' })
    });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to generate QR code' });
  }
});

// GET /qr/station/:station -- the code a tablet scans to become that station's screen.
//
// The same enrollment code the waiters' QR carries, in the page's address fragment, so the tablet
// is enrolled as a device and told which station it is in one scan. Reception only: it hands out
// the hub's enrollment code.
app.get('/qr/station/:station', async (req, res) => {
  if (!isReceptionRequest(req)) {
    return res.status(403).json({ success: false, error: 'Station screen codes are only available on the reception laptop.', code: 'RECEPTION_ONLY' });
  }
  const station = String(req.params.station).toLowerCase();
  if (!STATION_IDS.includes(station)) {
    return res.status(404).json({ success: false, error: `Station must be one of ${STATION_IDS.join(', ')}.`, code: 'UNKNOWN_STATION' });
  }
  const stationUrl = `${SERVER_URL}/station/${station}`;
  try {
    res.json({
      success: true,
      station,
      label: STATION_LABELS[station],
      station_url: stationUrl,
      enrollment_code: deviceAuth.getEnrollmentCode(),
      qr_code: await QRCode.toDataURL(`${stationUrl}#e=${deviceAuth.getEnrollmentCode()}`, { width: 384, margin: 2, errorCorrectionLevel: 'M' })
    });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to generate QR code' });
  }
});

// GET /kds/screens -- for reception: per station, how many screens are up and what is waiting.
// The point is the case where a station has work and nobody looking at it.
app.get('/kds/screens', requireReception, (req, res) => {
  const pairing = hubConfig.getPairingInfo();
  res.json({
    success: true,
    stations: stationSnapshot(stationScreens, ticketStore.getActiveTickets(pairing.restaurant_id)),
    screens: stationScreens.list()
  });
});

// The page a station tablet opens. Static, like /waiter: everything it shows comes through the
// authenticated routes, so the page itself carries nothing.
app.get('/station/:station', (req, res) => {
  const station = String(req.params.station).toLowerCase();
  if (!STATION_IDS.includes(station)) return res.status(404).type('text/plain').send(`No such station. Use one of: ${STATION_IDS.join(', ')}.`);
  const page = path.join(distPath, 'station.html');
  if (!fs.existsSync(page)) return res.status(404).type('text/plain').send('The station screen has not been built yet (run npm run build).');
  res.sendFile(page);
});

// The admin page is reception-only. A person in a browser gets a plain-text 403 (the JSON API under
// /admin answers RECEPTION_ONLY as JSON). The static handler below would also serve dist/admin.html as
// a file, so that path gets the same answer.
const refuseNonReception = (res) => res.status(403).type('text/plain').send('Reception only');
app.get('/admin.html', (req, res, next) => (isReceptionRequest(req) ? next() : refuseNonReception(res)));

// Serve static built frontend files if dist folder exists
// Where the built frontend lives. Overridable so the route that renders its own fallback page when
// there is no build (GET /) can be exercised against a real hub without deleting the real dist/.
const distPath = process.env.HUB_DIST_DIR || path.join(__dirname, '../dist');
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
// The page a table QR opens. Public, like the menu it reads.
app.get('/diner', (req, res) => {
  const dinerHtml = path.join(distPath, 'diner.html');
  if (fs.existsSync(dinerHtml)) {
    return res.sendFile(dinerHtml);
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

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

  // Everything below is this page rendering for itself, with no build to serve. Unlike the built
  // KDS -- a static bundle that fetches through authenticated routes -- it prints the pairing code
  // and the live kitchen tickets directly into the HTML, so it is reception's to see. /pairing-info
  // withholds the pairing code from anyone else on the LAN on purpose; this page used to hand the
  // same code, and every open ticket, to any caller that asked.
  if (!isReceptionRequest(req)) return refuseNonReception(res);

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
    <title>Reception Local Hub — ${escapeHtml(pairing.name || 'POS Server')}</title>
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
            Paired Tenant: <strong>${escapeHtml(pairing.name)}</strong> (${escapeHtml(pairing.pairing_code)})
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
                <strong style="font-family: var(--mono); color: var(--amber)">Ticket #${t.ticket_number}</strong> — Table ${escapeHtml(t.table_name)}
                <div style="font-size: 12px; color: var(--muted)">${escapeHtml(t.items.map(i => i.qty + 'x ' + i.name).join(', '))}</div>
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
  // With PORT=0 the OS chose; adopt what it actually gave us before anything reports a URL.
  PORT = server.address().port;
  SERVER_URL = `http://${LAN_IP}:${PORT}`;
  // Machine-readable and first, for whatever supervises this process -- the test fixture today,
  // a Windows service wrapper later. The decorated banner below is for a human.
  console.log(`HUB_LISTENING_PORT=${PORT}`);
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
      // A hub reinstalled while the internet was down would otherwise sit on an empty ledger
      // until someone restarted it. Cheap to repeat: it short-circuits once the ledger is there.
      syncQueue.restoreLedgerFromCloud(pairingInfo.restaurant_id)
        .catch(err => console.warn('⚠️ Ledger restore on reconnect failed:', err.message));
      syncQueue.restoreInventoryFromCloud(pairingInfo.restaurant_id)
        .catch(err => console.warn('⚠️ Stock restore on reconnect failed:', err.message))
        .finally(() => syncQueue.enqueueInventoryIfBehind(pairingInfo.restaurant_id));
    });
    // Refresh the subscription plan now and every 15 min. Fail-soft: offline
    // keeps the last synced plan, so LAN-only service is never interrupted.
    const syncPlan = () => hubConfig.syncPlanFromCloud().then(r => {
      if (r.ok && r.changed) console.log(`💳 Plan updated from cloud: ${r.effective.plan} (${r.effective.status})`);
    }).catch(() => {});
    syncPlan();
    setInterval(syncPlan, 15 * 60 * 1000).unref();

    // Collect what guests have asked for through the public booking page, now and every two minutes. Fail-soft like the plan: with no
    // internet the requests simply wait in the cloud, and nothing else on the hub is affected.
    setTimeout(pullBookingInbox, Number(process.env.HUB_BOOKING_INBOX_FIRST_MS) || 5000).unref();
    setInterval(pullBookingInbox, Number(process.env.HUB_BOOKING_INBOX_MS) || 2 * 60 * 1000).unref();

    // Tell the cloud this hub is alive, now and every five minutes. Fail-soft: a report that does not get through is shown as one on
    // /sync-status and tried again, and nothing else on the hub is affected.
    setTimeout(heartbeat.run, Number(process.env.HUB_HEARTBEAT_FIRST_MS) || 15 * 1000).unref();
    setInterval(heartbeat.run, Number(process.env.HUB_HEARTBEAT_MS) || 5 * 60 * 1000).unref();

    // Restore first, then backfill. A hub with an empty ledger (a reinstalled or replaced
    // reception laptop) pulls its financial history back from the cloud; everything restored
    // arrives already marked as replicated, so the backfill that follows correctly finds
    // nothing to push. Reversing the order would queue the whole restored ledger straight back.
    syncQueue.restoreLedgerFromCloud(pairingInfo.restaurant_id)
      .catch(err => console.warn('⚠️ Ledger restore failed:', err.message))
      .finally(() => {
        // Carry up anything the cloud has not confirmed. Pushes are triggered by a record
        // changing, so anything settled before migrations 005/006 has nothing coming for it.
        syncQueue.enqueueUnsyncedInvoices(pairingInfo.restaurant_id);
        syncQueue.enqueueUnsyncedReconciliations(pairingInfo.restaurant_id);
        // A ledger the restore refused because it was not empty may still be SHORT. Counting is
        // cheap and is the only way anyone would find out; filling the gap stays reception's call.
        syncQueue.checkLedgerGap(pairingInfo.restaurant_id)
          .catch(err => console.warn('⚠️ Ledger gap check failed:', err.message));
      });

    // Stock the same way: a replacement laptop starts empty and rebuilds from the cloud, then whatever
    // the cloud has not confirmed is carried up. Restore first, or the backfill would push nothing
    // and the restore would then find a store that already had a revision.
    syncQueue.restoreInventoryFromCloud(pairingInfo.restaurant_id)
      .catch(err => console.warn('⚠️ Stock restore failed:', err.message))
      .finally(() => syncQueue.enqueueInventoryIfBehind(pairingInfo.restaurant_id));

    // Guest feedback the same way: a replacement laptop gets its ratings back, then whatever the cloud has not
    // confirmed is carried up.
    syncQueue.restoreFeedbackFromCloud(pairingInfo.restaurant_id)
      .catch(err => console.warn('⚠️ Guest feedback restore failed:', err.message))
      .finally(() => syncQueue.enqueueUnsyncedFeedback(pairingInfo.restaurant_id));

    // The booking diary the same way: a replacement laptop rebuilds it, then anything the cloud has
    // not confirmed is carried up.
    syncQueue.restoreReservationsFromCloud(pairingInfo.restaurant_id)
      .catch(err => console.warn('⚠️ Booking diary restore failed:', err.message))
      .finally(() => syncQueue.enqueueReservationsIfBehind(pairingInfo.restaurant_id));
  }

  // Start background sync retry loop
  syncQueue.startSyncLoop(12000);
});

