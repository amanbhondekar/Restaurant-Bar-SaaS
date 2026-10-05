import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  usbDeps, sendToUsbPrinter, sendToDevice, listSystemPrinters, isValidSystemPrinterName, isValidDevicePath,
  WINDOWS_RAW_SCRIPT, encodePowerShell, parseWindowsPrinterList, parseLpstatList, cleanStderr
} from '../lib/usbPrinter.js';
import { sendToPrinter, renderTestPage } from '../lib/printer.js';
import { parsePrinter } from '../lib/hubConfig.js';

// ---------------------------------------------------------------------------
// M1 completion — USB thermal printing, printer setup, and per-station routing.
// ---------------------------------------------------------------------------

const realDeps = { ...usbDeps };
function fakeOs(platform, run) {
  usbDeps.platform = () => platform;
  usbDeps.run = run;
}
function restoreOs() { Object.assign(usbDeps, realDeps); }

test('usb: printer names are validated (no control characters, bounded length)', () => {
  assert.equal(isValidSystemPrinterName('EPSON TM-T82 Receipt'), true);
  assert.equal(isValidSystemPrinterName('  POS-80  '), true);
  assert.equal(isValidSystemPrinterName(''), false);
  assert.equal(isValidSystemPrinterName('   '), false);
  assert.equal(isValidSystemPrinterName('a\nb'), false);
  assert.equal(isValidSystemPrinterName('a\u0000b'), false);
  assert.equal(isValidSystemPrinterName('x'.repeat(121)), false);
  assert.equal(isValidSystemPrinterName(undefined), false);
  assert.equal(isValidSystemPrinterName({ toString: () => 'POS' }), false);
});

test('usb: device paths are limited to printer device nodes', () => {
  assert.equal(isValidDevicePath('/dev/usb/lp0'), true);
  assert.equal(isValidDevicePath('/dev/lp1'), true);
  assert.equal(isValidDevicePath('/dev/ttyUSB0'), true);
  assert.equal(isValidDevicePath('/etc/passwd'), false);
  assert.equal(isValidDevicePath('/dev/usb/lp0/../../../etc/passwd'), false);
  assert.equal(isValidDevicePath('/dev/sda'), false);
  assert.equal(isValidDevicePath('C:\\Windows\\win.ini'), false);
});

test('usb (windows): constant script, name and file travel in the environment — never in the script', async () => {
  const calls = [];
  fakeOs('win32', async (cmd, args, opts) => {
    calls.push({ cmd, args, opts, fileExists: fs.existsSync(opts.env.KULLINA_FILE), fileBytes: fs.readFileSync(opts.env.KULLINA_FILE) });
    return { code: 0, stdout: '', stderr: '' };
  });
  try {
    const evil = 'POS"; Remove-Item C:\\ -Recurse; "';
    const data = Buffer.from([0x1b, 0x40, 0x48, 0x69]);
    const r = await sendToUsbPrinter(data, evil);
    assert.equal(r.ok, true);
    assert.equal(r.sent_bytes, 4);

    assert.equal(calls.length, 1);
    const { cmd, args, opts, fileExists, fileBytes } = calls[0];
    assert.equal(cmd, 'powershell.exe');
    assert.ok(args.includes('-EncodedCommand') && args.includes('-NonInteractive'));
    // The script that runs is exactly the constant one; the hostile name appears nowhere in it.
    const decoded = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    assert.equal(decoded, WINDOWS_RAW_SCRIPT);
    assert.ok(!decoded.includes('Remove-Item'));
    assert.ok(!args.join(' ').includes('Remove-Item'));
    assert.match(decoded, /OpenPrinterA/);
    assert.match(decoded, /"RAW"/);
    assert.equal(opts.env.KULLINA_PRINTER, evil);
    // The spool file held the exact bytes while the script ran, and is gone afterwards.
    assert.equal(fileExists, true);
    assert.deepEqual([...fileBytes], [...data]);
    assert.equal(fs.existsSync(opts.env.KULLINA_FILE), false, 'spool file is removed');
  } finally { restoreOs(); }
});

test('usb (windows): a failing script, a timeout and a missing powershell all return clean errors and remove the spool file', async () => {
  let lastFile;
  const cases = [
    [{ code: 2, stdout: '', stderr: '#< CLIXML\r\nOpenPrinter failed (error 1801): printer not found\r\n<Objs Version="1.1">x</Objs>' }, 'USB_SPOOL_FAILED', /OpenPrinter failed/],
    [{ code: null, stdout: '', stderr: '', timedOut: true }, 'USB_TIMEOUT', /did not accept/],
    [{ code: -1, stdout: '', stderr: 'spawn powershell.exe ENOENT', spawnError: true }, 'USB_SPOOL_FAILED', /Could not start/]
  ];
  for (const [result, code, pattern] of cases) {
    fakeOs('win32', async (cmd, args, opts) => { lastFile = opts.env.KULLINA_FILE; return result; });
    try {
      const r = await sendToUsbPrinter(Buffer.from('x'), 'POS-80');
      assert.equal(r.ok, false);
      assert.equal(r.code, code);
      assert.match(r.error, pattern);
      assert.doesNotMatch(r.error, /CLIXML|<Objs/);
      assert.equal(fs.existsSync(lastFile), false);
    } finally { restoreOs(); }
  }
});

test('usb (linux/macOS): lp gets the name as a single argv entry and the bytes on stdin', async () => {
  for (const platform of ['linux', 'darwin']) {
    let seen;
    fakeOs(platform, async (cmd, args, opts) => { seen = { cmd, args, input: opts.input }; return { code: 0, stdout: '', stderr: '' }; });
    try {
      const data = Buffer.from('hello');
      const r = await sendToUsbPrinter(data, 'My Printer; rm -rf /');
      assert.equal(r.ok, true);
      assert.equal(seen.cmd, 'lp');
      assert.deepEqual(seen.args, ['-d', 'My Printer; rm -rf /', '-o', 'raw']);
      assert.equal(seen.input, data);
    } finally { restoreOs(); }
  }
});

test('usb: unsupported platform, bad name and non-buffer job are refused without running anything', async () => {
  let ran = false;
  fakeOs('freebsd', async () => { ran = true; return { code: 0 }; });
  try {
    assert.equal((await sendToUsbPrinter(Buffer.from('x'), 'POS')).code, 'USB_UNSUPPORTED_PLATFORM');
    assert.equal((await sendToUsbPrinter(Buffer.from('x'), 'bad\nname')).code, 'INVALID_PRINTER_NAME');
    assert.equal((await sendToUsbPrinter('not a buffer', 'POS')).code, 'INVALID_JOB');
    assert.equal(ran, false);
  } finally { restoreOs(); }
});

test('usb: sendToDevice refuses anything that is not a printer device node', async () => {
  assert.equal((await sendToDevice(Buffer.from('x'), '/etc/passwd')).code, 'INVALID_DEVICE_PATH');
  assert.equal((await sendToDevice(Buffer.from('x'), '/dev/usb/lp0/..')).code, 'INVALID_DEVICE_PATH');
  // A valid-looking node that does not exist fails cleanly instead of throwing.
  const r = await sendToDevice(Buffer.from('x'), '/dev/usb/lp99');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'USB_SPOOL_FAILED');
});

test('usb: discovery parses Windows JSON (single, many, empty, garbage) and lpstat output', () => {
  assert.deepEqual(parseWindowsPrinterList('{"Name":"POS-80","DriverName":"Generic","PortName":"USB001"}'),
    [{ name: 'POS-80', driver: 'Generic', port: 'USB001' }]);
  assert.equal(parseWindowsPrinterList('[{"Name":"A"},{"Name":"B"},{"Name":"bad\\nname"},{"nope":1}]').length, 2);
  assert.deepEqual(parseWindowsPrinterList(''), []);
  assert.deepEqual(parseWindowsPrinterList('not json'), []);
  assert.deepEqual(parseLpstatList('Epson_TM\nStar_TSP\n\n').map(p => p.name), ['Epson_TM', 'Star_TSP']);
  assert.equal(cleanStderr('#< CLIXML\r\nreal problem\r\n<Objs>x</Objs>'), 'real problem');
});

test('usb: listSystemPrinters uses the right command per platform and reports failures', async () => {
  const seen = [];
  fakeOs('win32', async (cmd, args) => { seen.push(cmd); return { code: 0, stdout: '[{"Name":"POS-80"}]', stderr: '' }; });
  try {
    const r = await listSystemPrinters();
    assert.equal(r.ok, true);
    assert.deepEqual(r.printers.map(p => p.name), ['POS-80']);
  } finally { restoreOs(); }
  fakeOs('linux', async (cmd) => { seen.push(cmd); return { code: 1, stdout: '', stderr: 'lpstat: Scheduler is not running' }; });
  try {
    const r = await listSystemPrinters();
    assert.equal(r.ok, false);
    assert.match(r.error, /Scheduler is not running/);
  } finally { restoreOs(); }
  assert.deepEqual(seen, ['powershell.exe', 'lpstat']);
});

test('printer: sendToPrinter routes by transport and keeps the legacy host-only and preview behaviour', async () => {
  const job = { escpos: Buffer.from('abc') };
  assert.equal((await sendToPrinter(job, { mode: 'preview' })).preview, true);
  assert.equal((await sendToPrinter(job, {})).preview, true, 'no host and no transport stays preview');

  let usbCall;
  fakeOs('linux', async (cmd, args) => { usbCall = args; return { code: 0, stdout: '', stderr: '' }; });
  try {
    const r = await sendToPrinter(job, { transport: 'usb', system_name: 'POS-80' });
    assert.deepEqual({ ok: r.ok, preview: r.preview, sent_bytes: r.sent_bytes }, { ok: true, preview: false, sent_bytes: 3 });
    assert.deepEqual(usbCall, ['-d', 'POS-80', '-o', 'raw']);
  } finally { restoreOs(); }

  const bad = await sendToPrinter(job, { transport: 'device', device_path: '/etc/passwd' });
  assert.equal(bad.code, 'INVALID_DEVICE_PATH');
  assert.equal((await sendToPrinter({}, { host: 'x' })).code, 'INVALID_JOB');
});

test('printer: test page names the printer and the transport', () => {
  const usb = renderTestPage({ id: 'front', name: 'Front desk', role: 'receipt', transport: 'usb', system_name: 'POS-80' }, { name: 'Hotel X' });
  assert.match(usb.preview_text, /PRINTER TEST/);
  assert.match(usb.preview_text, /Front desk/);
  assert.match(usb.preview_text, /USB: POS-80/);
  assert.match(usb.preview_text, /Customer receipts/);
  assert.ok(Buffer.isBuffer(usb.escpos) && usb.escpos.length > 20);
  const net_ = renderTestPage({ id: 'k', role: 'kot', transport: 'tcp', host: '10.0.0.5', port: 9100 }, {});
  assert.match(net_.preview_text, /Network: 10\.0\.0\.5:9100/);
  assert.match(net_.preview_text, /Kitchen order tickets/);
});

test('config: parsePrinter validates each transport and keeps the station', () => {
  const tcp = parsePrinter({ id: 'k1', role: 'kot', host: '192.168.1.60', station: 'BAR' });
  assert.equal(tcp.ok, true);
  assert.deepEqual(tcp.printer, { id: 'k1', role: 'kot', transport: 'tcp', name: null, host: '192.168.1.60', port: 9100, station: 'bar' });
  assert.equal(parsePrinter({ role: 'receipt', transport: 'usb', system_name: 'POS-80' }).printer.id, 'receipt-POS-80');
  assert.equal(parsePrinter({ transport: 'device', device_path: '/dev/usb/lp0' }).ok, true);

  assert.equal(parsePrinter({ host: '' }).code, 'INVALID_HOST');
  assert.equal(parsePrinter({ host: 'a b' }).code, 'INVALID_HOST');
  assert.equal(parsePrinter({ host: '1.2.3.4', port: 70000 }).code, 'INVALID_PORT');
  assert.equal(parsePrinter({ transport: 'usb', system_name: 'bad\nname' }).code, 'INVALID_PRINTER_NAME');
  assert.equal(parsePrinter({ transport: 'device', device_path: '/etc/passwd' }).code, 'INVALID_DEVICE_PATH');
  assert.equal(parsePrinter({ host: '1.2.3.4', station: 'garnish' }).code, 'INVALID_STATION');
  assert.equal(parsePrinter(null).ok, false);
});

// ---------------------------------------------------------------------------
// Live hub: printer setup routes and per-station routing end to end.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 4591;
const BASE = `http://127.0.0.1:${PORT}`;
const RESTAURANT_ID = '11111111-1111-1111-1111-111111111111';

const MENU = {
  restaurant_id: RESTAURANT_ID,
  categories: ['Mains', 'Drinks'],
  items: [
    { id: 'h1', name: 'Dal Tadka', price: 190, category: 'Mains', isVeg: true, available: true, station: 'hot' },
    { id: 'b1', name: 'Masala Chaas', price: 50, category: 'Drinks', isVeg: true, available: true, station: 'bar' }
  ]
};

let child;
let dataDir;
const sinks = {};

function sink(name) {
  return new Promise(resolve => {
    const chunks = [];
    const server = net.createServer(sock => { sock.on('data', d => chunks.push(d)); });
    server.listen(0, '127.0.0.1', () => {
      sinks[name] = { server, port: server.address().port, text: () => Buffer.concat(chunks).toString('latin1') };
      resolve();
    });
  });
}

const call = (p, { method = 'GET', body } = {}) =>
  fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  await sink('hot');
  await sink('bar');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-printers-'));
  fs.writeFileSync(path.join(dataDir, 'menu_cache.json'), JSON.stringify(MENU));
  fs.writeFileSync(path.join(dataDir, 'tables_cache.json'), JSON.stringify({ restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main', capacity: 4 }] }));
  fs.writeFileSync(path.join(dataDir, 'tickets.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'sync_queue.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
    paired: true, restaurant_id: RESTAURANT_ID, name: 'Printer Test Kitchen', pairing_code: 'PRT-0001', city: 'Nagpur',
    enrollment_code: 'PRTCODE', devices: [],
    printers: [
      { id: 'hot-line', role: 'kot', host: '127.0.0.1', port: sinks.hot.port, station: 'hot' },
      { id: 'bar-line', role: 'kot', host: '127.0.0.1', port: sinks.bar.port, station: 'bar' },
      { id: 'broken', role: 'kot', host: '', port: 1 }
    ]
  }));
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), HUB_DATA_DIR: dataDir, HUB_TRUST_LOOPBACK: 'true', SUPABASE_URL: 'https://example.supabase.co' },
    stdio: 'ignore'
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { await fetch(`${BASE}/pairing-info`); break; } catch {
      if (Date.now() > deadline) throw new Error('printer-test hub did not start');
      await new Promise(r => setTimeout(r, 200));
    }
  }
});

after(() => {
  if (child) child.kill();
  for (const s of Object.values(sinks)) s.server.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('hub: GET /printers keeps each printer\'s station and drops invalid entries', async () => {
  const body = await (await call('/printers')).json();
  assert.deepEqual(body.printers.map(p => [p.id, p.station]), [['hot-line', 'hot'], ['bar-line', 'bar']]);
});

test('hub: a mixed order splits by station — each printer receives only its own station\'s KOT', async () => {
  const res = await call('/orders', {
    method: 'POST',
    body: { table_id: 1, table_name: 'T1', items: [{ id: 'h1', qty: 1 }, { id: 'b1', qty: 2 }] }
  });
  assert.equal(res.status, 201);
  await new Promise(r => setTimeout(r, 600));
  const hot = sinks.hot.text();
  const bar = sinks.bar.text();
  assert.match(hot, /Dal Tadka/);
  assert.doesNotMatch(hot, /Masala Chaas/, 'the hot-line printer must not get bar items');
  assert.match(bar, /Masala Chaas/);
  assert.doesNotMatch(bar, /Dal Tadka/, 'the bar printer must not get hot-line items');
  assert.match(hot, /KITCHEN ORDER . HOT LINE/i);
  assert.match(bar, /KITCHEN ORDER . BAR/i);
});

test('hub: printer setup — add network and USB printers, reject bad input, refuse duplicates, then delete', async () => {
  const added = await call('/printers', { method: 'POST', body: { id: 'front', role: 'receipt', transport: 'usb', system_name: 'POS-80' } });
  assert.equal(added.status, 201);
  assert.equal((await added.json()).printer.system_name, 'POS-80');

  assert.equal((await call('/printers', { method: 'POST', body: { id: 'front', role: 'receipt', transport: 'usb', system_name: 'POS-80' } })).status, 409);
  const bad = await call('/printers', { method: 'POST', body: { transport: 'usb', system_name: 'bad\nname' } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'INVALID_PRINTER_NAME');
  assert.equal((await call('/printers', { method: 'POST', body: { transport: 'device', device_path: '/etc/passwd' } })).status, 400);

  const list = await (await call('/printers')).json();
  assert.ok(list.printers.some(p => p.id === 'front'));
  assert.equal((await call('/printers/front', { method: 'DELETE' })).status, 200);
  assert.equal((await call('/printers/front', { method: 'DELETE' })).status, 404);
  // Persisted, not just in memory.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub_config.json'), 'utf-8'));
  assert.equal(onDisk.printers.some(p => p.id === 'front'), false);
});

test('hub: POST /printers/:id/test prints a test page to the printer, 404s on unknown ids', async () => {
  const before_ = sinks.bar.text().length;
  const res = await call('/printers/bar-line/test', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.preview_text, /PRINTER TEST/);
  await new Promise(r => setTimeout(r, 400));
  assert.match(sinks.bar.text().slice(before_), /PRINTER TEST/);
  assert.equal((await call('/printers/nope/test', { method: 'POST' })).status, 404);
});

test('hub: a failing USB printer reports 502 with a reason instead of crashing the hub', async () => {
  await call('/printers', { method: 'POST', body: { id: 'ghost', role: 'receipt', transport: 'usb', system_name: 'Definitely Not A Real Printer 9876' } });
  const res = await call('/printers/ghost/test', { method: 'POST' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(body.code && body.error);
  assert.equal((await fetch(`${BASE}/pairing-info`)).status, 200, 'hub is still serving');
});

test('hub: GET /printers/system answers with the OS printers (or a clear reason)', async () => {
  const res = await call('/printers/system');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.printers));
  assert.ok(typeof body.platform === 'string');
});
