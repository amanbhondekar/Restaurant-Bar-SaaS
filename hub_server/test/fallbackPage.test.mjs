import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

// The page GET / renders for itself when there is no frontend build. It interpolated the
// restaurant name, pairing code, table name and item names straight into HTML. Each of those is
// text a person typed -- the first two in the admin console or cloud, the table name straight off
// an order body from a handset, the item name in the menu editor -- so an apostrophe or an angle
// bracket in any of them could break or hijack a page that is shown on the reception laptop.

const HOSTILE_NAME = '</title><script>window.__pwn_name=1</script>';
const HOSTILE_CODE = '<img src=x onerror=window.__pwn_code=1>';
const HOSTILE_TABLE = '<script>window.__pwn_table=1</script>';
const HOSTILE_ITEM = '<b onmouseover=window.__pwn_item=1>Dal</b> & "Co"';

let hub;
let emptyDist;
let html;

test.before(async () => {
  // An empty directory standing in for dist/, so GET / has no index.html and renders its fallback.
  emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-empty-dist-'));

  hub = await startHub({
    // A stranger on the wifi, not the reception laptop.
    trustLoopback: false,
    env: { HUB_DIST_DIR: emptyDist },
    nameSuffix: HOSTILE_NAME,
    config: { pairing_code: HOSTILE_CODE },
    menu: {
      restaurant_id: RESTAURANT_ID,
      categories: ['Mains'],
      items: [{ id: 'm1', name: HOSTILE_ITEM, price: 200, category: 'Mains', isVeg: true, available: true }]
    },
    tables: { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }
  });

  // An enrolled handset places an order, and chooses its own table name -- nothing on the way in
  // sanitises it, which is what makes this reachable by staff rather than only by an admin.
  const enrolled = await (await fetch(`${hub.base}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollment_code: 'TESTCODE', device_label: 'Handset' })
  })).json();

  const ordered = await fetch(`${hub.base}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${enrolled.device_token}` },
    body: JSON.stringify({ table_id: 1, table_name: HOSTILE_TABLE, items: [{ id: 'm1', qty: 2 }] })
  });
  assert.equal(ordered.status, 201, 'the fixture order must be accepted for this test to mean anything');

  const res = await fetch(`${hub.base}/`);
  assert.equal(res.status, 200);
  html = await res.text();
});

test.after(() => {
  hub?.stop();
  if (emptyDist) fs.rmSync(emptyDist, { recursive: true, force: true });
});

test('fallback page: it really is the server-rendered fallback this test is about', () => {
  // Guards the whole file: if GET / served a built index.html instead, every assertion below
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

test('fallback page: only these four are untrusted -- the numbers and flags it prints stay readable', () => {
  assert.match(html, /Local WiFi Only|Online Sync/);
  assert.match(html, /http:\/\/[\d.]+:\d+/, 'the hub address is intact');
});
