import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// The page GET / renders for itself when there is no frontend build.
//
// Two separate problems were fixed in it, and they are tested separately:
//
// 1. It interpolated the restaurant name, pairing code, table name and item names straight into
//    HTML. Each is text a person typed -- the first two in the admin console or cloud, the table
//    name straight off an order body from a handset, the item name in the menu editor.
// 2. It printed the pairing code and every open kitchen ticket to ANY caller, while /pairing-info
//    withholds the pairing code on purpose. It is now reception's to see.

const HOSTILE_NAME = '</title><script>window.__pwn_name=1</script>';
const HOSTILE_CODE = '<img src=x onerror=window.__pwn_code=1>';
const HOSTILE_TABLE = '<script>window.__pwn_table=1</script>';
const HOSTILE_ITEM = '<b onmouseover=window.__pwn_item=1>Dal</b> & "Co"';

const MENU = items => ({ restaurant_id: RESTAURANT_ID, categories: ['Mains'], items });
const TABLES = { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] };
const dish = name => ({ id: 'm1', name, price: 200, category: 'Mains', isVeg: true, available: true });

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const post = (hub, route, body, token) => fetch(`${hub.base}${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});

const cleanup = [];
test.after(() => {
  for (const fn of cleanup) fn();
});

// --- escaping: fetched as reception, who is the one entitled to see the page -------------------

let html;

test.before(async () => {
  // An empty directory standing in for dist/, so GET / has no index.html and renders its fallback.
  const emptyDist = tempDir('hub-empty-dist-');
  const hub = await startHub({
    // The reception laptop. (A stranger is refused the page now; that is tested further down.)
    trustLoopback: true,
    env: { HUB_DIST_DIR: emptyDist },
    nameSuffix: HOSTILE_NAME,
    config: { pairing_code: HOSTILE_CODE },
    menu: MENU([dish(HOSTILE_ITEM)]),
    tables: TABLES
  });
  cleanup.push(() => { hub.stop(); fs.rmSync(emptyDist, { recursive: true, force: true }); });

  // The order body is how a handset's table_name reaches the page: the handler stores it exactly as
  // sent, with no sanitising.
  const ordered = await post(hub, '/orders', { table_id: 1, table_name: HOSTILE_TABLE, items: [{ id: 'm1', qty: 2 }] });
  assert.equal(ordered.status, 201, 'the fixture order must be accepted for this test to mean anything');

  const res = await fetch(`${hub.base}/`);
  assert.equal(res.status, 200, 'reception must still get the page');
  html = await res.text();
});

test('fallback page: it really is the server-rendered fallback this test is about', () => {
  // Guards the whole group: if GET / served a built index.html instead, every assertion below
  // would pass for the wrong reason.
  assert.match(html, /Reception Local Hub/);
  assert.match(html, /Live Active Kitchen Tickets/);
});

test('fallback page: a hostile restaurant name cannot break out of the title', () => {
  assert.ok(!html.includes('</title><script>'), 'the title must not be closeable from the name');
  assert.equal((html.match(/<\/title>/g) || []).length, 1, 'exactly one closing title tag');
  // The text is allowed to appear -- escaped, it is just words on the page. What must not exist
  // is a <script> element carrying it, which is what an executable payload would be.
  assert.ok(!/<script[^>]*>[^<]*__pwn_name/.test(html), 'the payload must not be inside a script element');
});

test('fallback page: the restaurant name is escaped where it is printed as the paired tenant', () => {
  assert.match(html, /Paired Tenant: <strong>Test Kitchen [0-9a-f-]+&lt;\/title&gt;&lt;script&gt;/);
});

test('fallback page: a hostile pairing code is shown as text, not as a tag', () => {
  assert.ok(!html.includes('<img src=x'), 'no injected image element');
  assert.match(html, /&lt;img src=x onerror=window\.__pwn_code=1&gt;/);
});

test('fallback page: a table name chosen by a handset cannot inject script', () => {
  assert.ok(!html.includes('<script>window.__pwn_table'), 'no injected script element');
  assert.match(html, /Table &lt;script&gt;window\.__pwn_table=1&lt;\/script&gt;/);
});

test('fallback page: an item name cannot inject markup or an event handler', () => {
  assert.ok(!html.includes('<b onmouseover'), 'no injected element carrying a handler');
  // Ampersand and quotes in an ordinary name are escaped too, not just angle brackets.
  assert.match(html, /2x &lt;b onmouseover=window\.__pwn_item=1&gt;Dal&lt;\/b&gt; &amp; &quot;Co&quot;/);
});

test('fallback page: an ordinary page is not mangled -- real content still renders', () => {
  // Escaping everything blindly would show "&amp;lt;" or drop the markup the page is made of.
  assert.match(html, /<div class="title">/);
  assert.match(html, /Ticket #\d+/);
  assert.ok(!html.includes('&amp;lt;'), 'nothing may be escaped twice');
  assert.ok(!html.includes('&lt;div'), 'the page\'s own markup must stay markup');
});

test('fallback page: only the typed values are escaped -- the numbers and flags it prints stay readable', () => {
  assert.match(html, /Local WiFi Only|Online Sync/);
  assert.match(html, /http:\/\/[\d.]+:\d+/, 'the hub address is intact');
});

// --- the gate: a stranger on the wifi is not shown what reception is --------------------------

test('fallback page: a stranger on the wifi is refused, and learns neither the pairing code nor the tickets', async () => {
  const emptyDist = tempDir('hub-empty-dist-');
  const hub = await startHub({
    // Treated as someone other than the reception laptop.
    trustLoopback: false,
    env: { HUB_DIST_DIR: emptyDist },
    config: { pairing_code: 'SECRET-PAIR-1234' },
    menu: MENU([dish('Dal Tadka')]),
    tables: TABLES
  });
  cleanup.push(() => { hub.stop(); fs.rmSync(emptyDist, { recursive: true, force: true }); });

  // Put something real on the page that could leak: an enrolled handset places an order.
  const enrolled = await (await post(hub, '/auth/device', { enrollment_code: 'TESTCODE', device_label: 'Handset' })).json();
  const ordered = await post(hub, '/orders', { table_id: 1, table_name: 'T1', items: [{ id: 'm1', qty: 2 }] }, enrolled.device_token);
  assert.equal(ordered.status, 201);

  // The ticket genuinely exists -- an authorised handset can see it -- so a refusal below means
  // the page held back something real, not that there was nothing to show.
  const active = await (await fetch(`${hub.base}/orders/active`, { headers: { Authorization: `Bearer ${enrolled.device_token}` } })).json();
  assert.ok(active.tickets.length >= 1, 'there is a live ticket that could have leaked');

  const res = await fetch(`${hub.base}/`);
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.ok(!body.includes('SECRET-PAIR-1234'), 'the pairing code must not be disclosed');
  assert.ok(!body.includes('Dal Tadka'), 'no item from a live ticket');
  assert.ok(!/Ticket #\d+/.test(body), 'no ticket at all');

  // And it agrees with the endpoint that already made this decision.
  const info = await (await fetch(`${hub.base}/pairing-info`)).json();
  assert.equal('pairing_code' in info, false, '/pairing-info withholds it for the same reason');
});

test('fallback page: a built frontend is still public -- only the self-rendered page is gated', async () => {
  // The KDS bundle is static and fetches through authenticated routes, so serving it to anyone is
  // fine and has always been the behaviour. This guards against the gate being placed too early
  // and quietly locking handsets out of the real app.
  const builtDist = tempDir('hub-built-dist-');
  fs.writeFileSync(path.join(builtDist, 'index.html'), '<!doctype html><title>Built KDS</title><div id="root"></div>');
  const hub = await startHub({
    trustLoopback: false,
    env: { HUB_DIST_DIR: builtDist },
    menu: MENU([dish('Dal Tadka')]),
    tables: TABLES
  });
  cleanup.push(() => { hub.stop(); fs.rmSync(builtDist, { recursive: true, force: true }); });

  const res = await fetch(`${hub.base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Built KDS/);
});
