import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  redact, makeRecord, toJsonLine, otlpPayload, OtlpShipper, resolveLoggingConfig, installLogging, requestLogger, SEVERITY
} from '../lib/log.js';
import { startHub, call } from './helpers/spawnHub.mjs';

// Structured logging, and an optional export to an OpenTelemetry collector. The hub's own log lines are for the person
// at the laptop; these are for someone reading them somewhere else, which is why the first thing tested is what must
// never leave the machine.

const T = Date.parse('2026-10-23T09:30:15.250Z');

// --- redaction -------------------------------------------------------------------------------------------------------

test('a bearer token, a device token and a token in a query string never survive', () => {
  const hex = 'a1b2c3d4'.repeat(8);
  assert.equal(redact('Authorization: Bearer abc.def-123'), 'Authorization: Bearer [redacted]');
  assert.equal(redact(`device ${hex} enrolled`), 'device [redacted] enrolled');
  assert.equal(redact('GET /live?station=bar&token=SECRET123&label=Bar'), 'GET /live?station=bar&token=[redacted]&label=Bar');
  assert.equal(redact('enrollment_code=KITCHEN42 pin=1234 password=hunter2 secret=s3 api_key=k apikey=k2'),
    'enrollment_code=[redacted] pin=[redacted] password=[redacted] secret=[redacted] api_key=[redacted] apikey=[redacted]');
});

test('the same keys inside JSON, and a JWT, are redacted', () => {
  assert.equal(redact('{"device_token":"abc","pin":"4321","name":"Asha","enrollment_code":"X1"}'),
    '{"device_token":"[redacted]","pin":"[redacted]","name":"Asha","enrollment_code":"[redacted]"}');
  assert.equal(redact('jwt eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4 ok'), 'jwt [redacted] ok');
});

test('ordinary text, ids and numbers are left exactly as they were', () => {
  for (const text of [
    '📱 Guest order from T4: ticket #142.',
    'Ticket t_1792748763306_xqmqc ready',
    'Grand total 483 for INV-000009',
    'listening on 4000',
    '9876543210'
  ]) assert.equal(redact(text), text);
});

test('a value that is not text is turned into text first, never thrown on', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact(42), '42');
});

// --- a record --------------------------------------------------------------------------------------------------------

test('a console call becomes a record: time, level, the message with its arguments, and the service', () => {
  const r = makeRecord('warn', ['Could not reach', { host: 'cloud', n: 3 }, 7], T, 'kullina-hub');
  assert.equal(r.time, '2026-10-23T09:30:15.250Z');
  assert.equal(r.level, 'warn');
  assert.equal(r.service, 'kullina-hub');
  assert.match(r.msg, /^Could not reach \{ host: 'cloud', n: 3 \} 7$/);
});

test('an Error keeps its message and its stack, as attributes', () => {
  const err = new Error('boom');
  const r = makeRecord('error', ['Sync failed:', err], T);
  assert.match(r.msg, /Sync failed: .*boom/);
  assert.equal(r.attrs['exception.message'], 'boom');
  assert.match(r.attrs['exception.stacktrace'], /Error: boom/);
});

test('a record is redacted when it is made, so nothing downstream can forget to', () => {
  const r = makeRecord('info', ['joined with token=SECRET99 and Bearer zzz'], T);
  assert.equal(r.msg, 'joined with token=[redacted] and Bearer [redacted]');
  const withErr = makeRecord('error', [Object.assign(new Error('bad pin=1234'), {})], T);
  assert.doesNotMatch(withErr.attrs['exception.message'], /1234/);
  assert.doesNotMatch(withErr.attrs['exception.stacktrace'], /pin=1234/);
});

test('an unknown level is treated as info', () => {
  assert.equal(makeRecord('shout', ['x'], T).level, 'info');
});

test('the JSON line is one line of valid JSON, however many lines the message had', () => {
  const line = toJsonLine(makeRecord('error', ['first\nsecond\n"quoted"'], T, 'svc'));
  assert.equal(line.includes('\n'), false);
  assert.equal(JSON.parse(line).msg, 'first\nsecond\n"quoted"');
  assert.deepEqual(Object.keys(JSON.parse(line)).slice(0, 4), ['time', 'level', 'service', 'msg']);
});

test('attributes are flattened onto the line, and never overwrite its own fields', () => {
  const r = makeRecord('info', ['x'], T, 'svc', { 'http.method': 'GET', level: 'spoofed', msg: 'spoofed' });
  const parsed = JSON.parse(toJsonLine(r));
  assert.equal(parsed['http.method'], 'GET');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'x');
});

// --- the OpenTelemetry payload ------------------------------------------------------------------------------------------

test('the payload is OTLP/HTTP JSON: a resource naming the service, one scope, and typed log records', () => {
  const records = [
    makeRecord('error', ['boom'], T, 'kullina-hub', { 'http.status_code': 500, 'http.target': '/orders', ok: false, ratio: 0.5 })
  ];
  const p = otlpPayload(records, { service: 'kullina-hub', instance: 'SCR-0001' });
  const resource = p.resourceLogs[0].resource.attributes;
  assert.deepEqual(resource.find(a => a.key === 'service.name'), { key: 'service.name', value: { stringValue: 'kullina-hub' } });
  assert.deepEqual(resource.find(a => a.key === 'service.instance.id'), { key: 'service.instance.id', value: { stringValue: 'SCR-0001' } });

  const rec = p.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(rec.timeUnixNano, String(BigInt(T) * 1000000n));
  assert.equal(rec.severityNumber, 17);
  assert.equal(rec.severityText, 'ERROR');
  assert.deepEqual(rec.body, { stringValue: 'boom' });
  const attr = k => rec.attributes.find(a => a.key === k)?.value;
  assert.deepEqual(attr('http.status_code'), { intValue: '500' });
  assert.deepEqual(attr('http.target'), { stringValue: '/orders' });
  assert.deepEqual(attr('ok'), { boolValue: false });
  assert.deepEqual(attr('ratio'), { doubleValue: 0.5 });
});

test('severities follow the OpenTelemetry numbers', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SEVERITY).map(([k, v]) => [k, v.n])), { debug: 5, info: 9, warn: 13, error: 17 });
});

// --- what is configured -------------------------------------------------------------------------------------------------

test('nothing changes unless it is asked for', () => {
  const c = resolveLoggingConfig({});
  assert.deepEqual([c.json, c.otlp, c.requests], [false, null, false]);
});

test('HUB_LOG_FORMAT=json turns on JSON lines and the request log; anything else leaves the hub as it was', () => {
  const on = resolveLoggingConfig({ HUB_LOG_FORMAT: 'json' });
  assert.deepEqual([on.json, on.requests], [true, true]);
  assert.equal(resolveLoggingConfig({ HUB_LOG_FORMAT: ' JSON ' }).json, true);
  assert.equal(resolveLoggingConfig({ HUB_LOG_FORMAT: 'text' }).json, false);
  assert.equal(resolveLoggingConfig({ HUB_LOG_FORMAT: 'json', HUB_LOG_REQUESTS: '0' }).requests, false);
  assert.equal(resolveLoggingConfig({ HUB_LOG_REQUESTS: '1' }).requests, true);
});

test('a collector on its own also turns the request log on, since that is who reads it', () => {
  assert.equal(resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }).requests, true);
  assert.equal(resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', HUB_LOG_REQUESTS: 'off' }).requests, false);
  assert.equal(resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://nonsense' }).requests, false, 'a collector that was refused is not a reason');
});

test('the collector address: the logs endpoint as given, or the base address with /v1/logs on it', () => {
  assert.equal(resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }).otlp.url, 'http://collector:4318/v1/logs');
  assert.equal(resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.example/otlp/' }).otlp.url, 'https://c.example/otlp/v1/logs');
  assert.equal(resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4318', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://b:9/custom' }).otlp.url, 'http://b:9/custom');
});

test('headers, service name and a bad address', () => {
  const c = resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_EXPORTER_OTLP_HEADERS: 'api-key=abc, x-tenant = mejwani ,broken', OTEL_SERVICE_NAME: 'hub-mejwani' });
  assert.deepEqual(c.otlp.headers, { 'api-key': 'abc', 'x-tenant': 'mejwani' });
  assert.equal(c.service, 'hub-mejwani');
  assert.equal(resolveLoggingConfig({}).service, 'kullina-hub');
  const bad = resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' });
  assert.equal(bad.otlp, null);
  assert.match(bad.problems[0], /OTEL_EXPORTER_OTLP_ENDPOINT/);
  assert.equal(resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://c/' }).otlp, null);
});

test('only HTTP with JSON is spoken: grpc and protobuf are refused, said once, not guessed at', () => {
  for (const protocol of ['grpc', 'http/protobuf']) {
    const c = resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_EXPORTER_OTLP_PROTOCOL: protocol });
    assert.equal(c.otlp, null, protocol);
    assert.match(c.problems[0], new RegExp(protocol.replace('/', '\\/')));
  }
  assert.ok(resolveLoggingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }).otlp);
});

// --- the shipper ---------------------------------------------------------------------------------------------------------

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false, unref() { return this; } }; timers.push(t); return t; },
    clearInterval: t => { t.cleared = true; },
    tick() { timers.filter(t => !t.cleared).forEach(t => t.fn()); }
  };
}
const rec = (msg, level = 'info') => makeRecord(level, [msg], T, 'svc');
const tick = () => new Promise(r => setImmediate(r));

function shipperWith(over = {}) {
  const posts = [];
  const timers = fakeTimers();
  const shipper = new OtlpShipper({
    url: 'http://collector:4318/v1/logs', headers: { 'api-key': 'abc' }, service: 'svc', instance: 'SCR-1',
    batchSize: 3, maxBuffered: 5, intervalMs: 5000, timers,
    fetchImpl: async (url, init) => { posts.push({ url, init, body: JSON.parse(init.body) }); return over.response ?? { ok: true, status: 200 }; },
    ...over
  });
  return { shipper, posts, timers };
}

test('records are sent in batches: nothing until the batch is full, then one POST with all of them', async () => {
  const { shipper, posts } = shipperWith();
  shipper.add(rec('a')); shipper.add(rec('b'));
  await tick();
  assert.equal(posts.length, 0);
  shipper.add(rec('c'));
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://collector:4318/v1/logs');
  assert.equal(posts[0].init.method, 'POST');
  assert.equal(posts[0].init.headers['Content-Type'], 'application/json');
  assert.equal(posts[0].init.headers['api-key'], 'abc');
  assert.deepEqual(posts[0].body.resourceLogs[0].scopeLogs[0].logRecords.map(r => r.body.stringValue), ['a', 'b', 'c']);
});

test('a quiet hub still sends what it has, on a timer', async () => {
  const { shipper, posts, timers } = shipperWith();
  shipper.add(rec('lonely'));
  assert.equal(posts.length, 0);
  assert.equal(timers.timers[0].ms, 5000);
  timers.tick();
  await tick();
  assert.equal(posts.length, 1);
  timers.tick();
  await tick();
  assert.equal(posts.length, 1, 'and nothing is sent when there is nothing to send');
});

test('the buffer is bounded: when the collector is down the oldest records go, and the count of lost ones is kept', async () => {
  let up = false;
  const { shipper, posts } = shipperWith({ batchSize: 1000, fetchImpl: async () => { if (!up) throw new Error('down'); return { ok: true, status: 200 }; } });
  for (let i = 1; i <= 8; i++) shipper.add(rec(`m${i}`));
  assert.equal(shipper.buffered(), 5);
  assert.equal(shipper.dropped, 3);
  up = true;
  const sent = [];
  shipper.fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  await shipper.flush();
  assert.deepEqual(sent[0].resourceLogs[0].scopeLogs[0].logRecords.map(r => r.body.stringValue), ['m4', 'm5', 'm6', 'm7', 'm8']);
  void posts;
});

test('a collector that is down, or says no, never throws, never loops, and the batch is dropped and counted', async () => {
  for (const fetchImpl of [async () => { throw new Error('ECONNREFUSED'); }, async () => ({ ok: false, status: 503 })]) {
    const { shipper } = shipperWith({ fetchImpl, batchSize: 2 });
    shipper.add(rec('a')); shipper.add(rec('b'));
    await tick();
    await shipper.flush();
    assert.equal(shipper.buffered(), 0);
    assert.equal(shipper.failedBatches, 1);
  }
});

test('only one request is in flight at a time, so a slow collector cannot pile requests up', async () => {
  let inFlight = 0; let peak = 0;
  const { shipper } = shipperWith({
    batchSize: 1,
    fetchImpl: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 20)); inFlight--; return { ok: true, status: 200 }; }
  });
  for (let i = 0; i < 6; i++) shipper.add(rec(`m${i}`));
  await shipper.flush();
  await new Promise(r => setTimeout(r, 200));
  assert.equal(peak, 1);
});

test('stopping flushes what is left and stops the timer', async () => {
  const { shipper, posts, timers } = shipperWith();
  shipper.add(rec('last words'));
  await shipper.stop();
  assert.equal(posts.length, 1);
  assert.equal(timers.timers[0].cleared, true);
});

test('the shipper reports its own trouble without using the log it ships, so it cannot feed itself', async () => {
  const said = [];
  const { shipper } = shipperWith({ fetchImpl: async () => { throw new Error('nope'); }, batchSize: 1, report: m => said.push(m) });
  shipper.add(rec('a'));
  await tick(); await tick();
  assert.equal(said.length, 1);
  assert.match(said[0], /could not reach the collector/i);
  shipper.add(rec('b'));
  await tick(); await tick();
  assert.equal(said.length, 1, 'once, not on every failure');
});

// --- installing it -------------------------------------------------------------------------------------------------------

function fakeConsole() {
  const calls = [];
  const c = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) c[m] = (...a) => calls.push([m, ...a]);
  return { c, calls };
}

test('by default the console is left alone', () => {
  const { c, calls } = fakeConsole();
  const original = c.log;
  const installed = installLogging({ env: {}, console: c, stdout: { write() { throw new Error('must not write'); } } });
  assert.equal(c.log, original);
  c.log('hello');
  assert.deepEqual(calls, [['log', 'hello']]);
  assert.equal(installed.json, false);
});

test('in JSON mode every console method writes one JSON line with its own level, and the plain text is not also printed', () => {
  const { c, calls } = fakeConsole();
  const out = [];
  const installed = installLogging({ env: { HUB_LOG_FORMAT: 'json' }, console: c, stdout: { write: s => out.push(s) }, now: () => T });
  c.log('listening'); c.info('i'); c.warn('careful'); c.error('bad', new Error('x')); c.debug('d');
  const lines = out.map(s => { assert.ok(s.endsWith('\n')); return JSON.parse(s); });
  assert.deepEqual(lines.map(l => l.level), ['info', 'info', 'warn', 'error', 'debug']);
  assert.equal(lines[0].msg, 'listening');
  assert.equal(lines[0].time, '2026-10-23T09:30:15.250Z');
  assert.deepEqual(calls, []);
  installed.uninstall();
});

test('uninstalling puts the console back', () => {
  const { c, calls } = fakeConsole();
  const original = c.warn;
  const installed = installLogging({ env: { HUB_LOG_FORMAT: 'json' }, console: c, stdout: { write() {} } });
  assert.notEqual(c.warn, original);
  installed.uninstall();
  assert.equal(c.warn, original);
  c.warn('back');
  assert.deepEqual(calls, [['warn', 'back']]);
});

test('it never installs twice over itself', () => {
  const { c } = fakeConsole();
  const out = [];
  const env = { HUB_LOG_FORMAT: 'json' };
  const first = installLogging({ env, console: c, stdout: { write: s => out.push(s) } });
  const second = installLogging({ env, console: c, stdout: { write: s => out.push(s) } });
  c.log('once');
  assert.equal(out.length, 1);
  assert.equal(second, first);
  first.uninstall();
});

test('with a collector configured the records are also shipped, and the text stays on the console unless JSON was asked for', async () => {
  const { c, calls } = fakeConsole();
  const posts = [];
  const installed = installLogging({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }, console: c, stdout: { write() { throw new Error('no json requested'); } },
    fetchImpl: async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }, timers: fakeTimers(), instance: 'SCR-9'
  });
  c.warn('shipped and printed');
  await installed.shipper.flush();
  assert.deepEqual(calls, [['warn', 'shipped and printed']]);
  assert.equal(posts[0].resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'shipped and printed');
  installed.uninstall();
});

test('configuration problems are said on the console once, at install', () => {
  const { c, calls } = fakeConsole();
  installLogging({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, console: c, stdout: { write() {} } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'warn');
  assert.match(String(calls[0][1]), /grpc/);
});

// --- the request log -----------------------------------------------------------------------------------------------------

async function withApp(setup, fn) {
  const records = [];
  const app = express();
  app.use(requestLogger({ emit: (level, msg, attrs) => records.push({ level, msg, attrs }), now: (() => { let t = 1000; return () => (t += 25); })() }));
  setup(app);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`, records); } finally { server.close(); }
}

test('every request is logged once it has been answered: method, path without its query, status and how long', async () => {
  await withApp(app => { app.get('/menu', (req, res) => res.json({ ok: true })); }, async (base, records) => {
    await fetch(`${base}/menu?token=SECRET&x=1`, { headers: { Authorization: 'Bearer SECRET' } });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(records.length, 1);
    const { level, attrs } = records[0];
    assert.equal(level, 'info');
    assert.equal(attrs['http.method'], 'GET');
    assert.equal(attrs['http.target'], '/menu');
    assert.equal(attrs['http.status_code'], 200);
    assert.equal(typeof attrs.duration_ms, 'number');
    assert.ok(attrs.duration_ms >= 0);
    assert.doesNotMatch(JSON.stringify(records), /SECRET/);
  });
});

test('a refused request is a warning and a failed one is an error', async () => {
  await withApp(app => {
    app.get('/nope', (req, res) => res.status(403).json({}));
    app.get('/broken', (req, res) => res.status(500).json({}));
  }, async (base, records) => {
    await fetch(`${base}/nope`); await fetch(`${base}/broken`);
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(records.map(r => [r.attrs['http.status_code'], r.level]), [[403, 'warn'], [500, 'error']]);
  });
});

test('the route pattern is logged rather than the id in it, so one dish of logs is not a thousand', async () => {
  await withApp(app => { app.get('/orders/:id/ready', (req, res) => res.json({})); }, async (base, records) => {
    await fetch(`${base}/orders/t_999/ready`);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(records[0].attrs['http.route'], '/orders/:id/ready');
  });
});

test('the request log is not noisy about the hub\'s own heartbeat', async () => {
  await withApp(app => { app.get('/pairing-info', (req, res) => res.json({})); }, async (base, records) => {
    await fetch(`${base}/pairing-info`); await fetch(`${base}/pairing-info`);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(records.length, 0);
  });
});

// --- a real hub -----------------------------------------------------------------------------------------------------------

const received = [];
const collector = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }); res.writeHead(200).end('{}'); });
});
await new Promise(r => collector.listen(0, '127.0.0.1', r));
after(() => collector.close());

const MENU = { restaurant_id: '11111111-1111-1111-1111-111111111111', categories: ['M'], items: [{ id: 'm1', name: 'Dal', price: 100, category: 'M', isVeg: true, available: true }] };
const TABLES = { restaurant_id: '11111111-1111-1111-1111-111111111111', tables: [{ id: 1, name: 'T1', section: 'M', capacity: 4 }] };

test('a real hub in JSON mode writes JSON lines, logs requests without their secrets, and ships them to a collector', async () => {
  const hub = await startHub({
    trustLoopback: false, menu: MENU, tables: TABLES, enrollmentCode: 'LOGCODE',
    env: {
      HUB_LOG_FORMAT: 'json',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
      OTEL_EXPORTER_OTLP_HEADERS: 'x-test=yes',
      OTEL_SERVICE_NAME: 'hub-under-test',
      HUB_LOG_EXPORT_INTERVAL_MS: '200'
    }
  });
  try {
    await call(hub, '/menu?token=SECRETQUERY', { token: 'SECRETBEARER' });                 // refused: a stranger
    await call(hub, '/auth/device', { method: 'POST', body: { enrollment_code: 'WRONG' } });
    await new Promise(r => setTimeout(r, 700));

    const lines = hub.output().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(lines.length > 3, 'the hub spoke');
    for (const l of lines) assert.ok(l.time && l.level && l.msg !== undefined, `a record: ${JSON.stringify(l)}`);
    const access = lines.find(l => l['http.target'] === '/menu');
    assert.ok(access, 'the request was logged');
    assert.equal(access['http.status_code'], 401);
    assert.equal(access.level, 'warn');
    assert.ok(lines.some(l => /HUB_LISTENING_PORT=\d+/.test(l.msg)), 'the port line the tests and the launcher read is still there');

    const everything = hub.output() + JSON.stringify(received);
    assert.doesNotMatch(everything, /SECRETQUERY|SECRETBEARER/, 'no secret reached the log or the collector');

    const mine = received.filter(r => r.body?.resourceLogs?.[0]?.resource?.attributes?.some(a => a.key === 'service.name' && a.value.stringValue === 'hub-under-test'));
    assert.ok(mine.length > 0, 'the collector received OTLP from this hub');
    assert.equal(mine[0].url, '/v1/logs');
    assert.equal(mine[0].headers['x-test'], 'yes');
    const bodies = mine.flatMap(r => r.body.resourceLogs[0].scopeLogs[0].logRecords).map(r => r.body.stringValue);
    assert.ok(bodies.some(b => /Device enrollment refused/.test(b)), 'what the hub said about the refused enrolment was shipped');
  } finally {
    hub.stop();
  }
});

test('a real hub left alone prints what it always did and sends nothing anywhere', async () => {
  const before = received.length;
  const hub = await startHub({ trustLoopback: false, menu: MENU, tables: TABLES, enrollmentCode: 'LOGCODE2' });
  try {
    await call(hub, '/menu');
    await new Promise(r => setTimeout(r, 300));
    const out = hub.output();
    assert.ok(out.includes('HUB_LISTENING_PORT='));
    assert.equal(out.split('\n').filter(l => l.startsWith('{"time"')).length, 0, 'no JSON lines');
    assert.equal(received.length, before);
  } finally {
    hub.stop();
  }
});
