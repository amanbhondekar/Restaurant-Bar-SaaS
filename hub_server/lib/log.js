// Structured logging, and an optional export to an OpenTelemetry collector (§4.8).
//
// The hub's log lines are written for the person at the laptop. Someone looking after several restaurants reads them
// somewhere else, and wants lines a machine can split (`HUB_LOG_FORMAT=json`) or a collector they already run
// (`OTEL_EXPORTER_OTLP_ENDPOINT`). Both are off unless asked for, and neither changes a single call site: the console
// itself is wrapped, so the 180-odd existing log lines become records without being edited.
//
// Because these lines leave the machine, the rule that matters most is what must not: every record is redacted when it
// is made (tokens, enrolment codes, PINs, passwords, JWTs), and the request log never records a query string, which is
// where a live-feed token travels. Redacting at the source means nothing downstream can forget to.
//
// What this is not: it speaks OTLP over HTTP with JSON, for logs only. There is no gRPC or protobuf exporter, no traces and
// no metrics; asking for them is refused out loud rather than guessed at.

import os from 'node:os';
import util from 'node:util';

export const SEVERITY = {
  debug: { n: 5, text: 'DEBUG' },
  info: { n: 9, text: 'INFO' },
  warn: { n: 13, text: 'WARN' },
  error: { n: 17, text: 'ERROR' }
};

const DEFAULT_SERVICE = 'kullina-hub';
const SECRET_KEYS = 'token|access_token|device_token|enrollment_code|enrolment_code|pin|password|secret|api_key|apikey|authorization';

/** Text with anything that is a credential replaced. Never throws, whatever it is given. */
export function redact(value) {
  let text = value === undefined || value === null ? '' : String(value);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  // JSON: "device_token":"abc", also with single quotes as util.inspect prints them.
  text = text.replace(new RegExp(`(["']?(?:${SECRET_KEYS})["']?\\s*:\\s*)(["'])[^"']*\\2`, 'gi'), '$1$2[redacted]$2');
  // key=value, as in a query string or a log line.
  text = text.replace(new RegExp(`\\b((?:${SECRET_KEYS})=)[^\\s&"',;]+`, 'gi'), '$1[redacted]');
  // A JWT: three base64url parts.
  text = text.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted]');
  // A device token: a long run of hex.
  text = text.replace(/\b[a-f0-9]{40,}\b/gi, '[redacted]');
  return text;
}

/** One log record. `attrs` are extra fields (flat); the message and the Error details are redacted here. */
export function makeRecord(level, args, nowMs = Date.now(), service = DEFAULT_SERVICE, attrs = {}) {
  const known = Object.prototype.hasOwnProperty.call(SEVERITY, level) ? level : 'info';
  const record = {
    time: new Date(nowMs).toISOString(),
    level: known,
    service,
    msg: redact(util.format(...args)),
    attrs: { ...attrs }
  };
  const err = args.find(a => a instanceof Error);
  if (err) {
    record.attrs['exception.message'] = redact(err.message);
    record.attrs['exception.stacktrace'] = redact(err.stack || '');
  }
  return record;
}

/** The record as one line of JSON. Attributes are flattened on, and never overwrite the record's own fields. */
export function toJsonLine(record) {
  const { attrs, ...own } = record;
  return JSON.stringify({ ...attrs, ...own });
}

const attributeValue = v => {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number' && Number.isInteger(v)) return { intValue: String(v) };
  if (typeof v === 'number') return { doubleValue: v };
  return { stringValue: String(v) };
};

/** An OTLP/HTTP JSON body for logs: one resource naming the service, one scope, a log record each. */
export function otlpPayload(records, { service = DEFAULT_SERVICE, instance } = {}) {
  const resource = [{ key: 'service.name', value: { stringValue: service } }];
  if (instance) resource.push({ key: 'service.instance.id', value: { stringValue: String(instance) } });
  return {
    resourceLogs: [{
      resource: { attributes: resource },
      scopeLogs: [{
        scope: { name: DEFAULT_SERVICE },
        logRecords: records.map(r => ({
          timeUnixNano: String(BigInt(Date.parse(r.time)) * 1000000n),
          severityNumber: SEVERITY[r.level].n,
          severityText: SEVERITY[r.level].text,
          body: { stringValue: r.msg },
          attributes: Object.entries(r.attrs || {}).map(([key, v]) => ({ key, value: attributeValue(v) }))
        }))
      }]
    }]
  };
}

const flag = (v, fallback) => {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase());
};

/** What the environment asks for. Everything is off by default; `problems` lists what was asked for and refused. */
export function resolveLoggingConfig(env = process.env) {
  const problems = [];
  const json = String(env.HUB_LOG_FORMAT ?? '').trim().toLowerCase() === 'json';

  let otlp = null;
  const base = String(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
  const logsUrl = String(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? '').trim();
  if (base || logsUrl) {
    const candidate = logsUrl || `${base.replace(/\/+$/, '')}/v1/logs`;
    const protocol = String(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/json').trim().toLowerCase();
    let parsed = null;
    try { parsed = new URL(candidate); } catch { /* reported below */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      problems.push(`OTEL_EXPORTER_OTLP_ENDPOINT is not an http(s) address (${redact(logsUrl || base)}); logs are not being exported.`);
    } else if (protocol !== 'http/json') {
      problems.push(`OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported: this hub exports logs as OTLP over HTTP with JSON (http/json) only; logs are not being exported.`);
    } else {
      const headers = {};
      for (const pair of String(env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) {
        const at = pair.indexOf('=');
        if (at <= 0) continue;
        const key = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        if (key) headers[key] = value;
      }
      otlp = { url: parsed.toString(), headers };
    }
  }

  const interval = Number(env.HUB_LOG_EXPORT_INTERVAL_MS);
  return {
    json,
    otlp,
    // The request log goes with JSON or a collector (that is the audience for it), and can be switched either way.
    requests: flag(env.HUB_LOG_REQUESTS, json || Boolean(otlp)),
    service: String(env.OTEL_SERVICE_NAME ?? '').trim() || DEFAULT_SERVICE,
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval : 5000,
    problems
  };
}

/**
 * Sends records to an OTLP/HTTP collector in batches, off the hot path.
 *
 * It must never hurt the hub: the buffer is bounded (when the collector is down the oldest records go, and the number
 * lost is kept), one request is in flight at a time, a failure drops its batch rather than retrying forever, and its own
 * trouble is reported straight to stderr, once a minute, never through the log it ships (which would feed itself).
 */
export class OtlpShipper {
  constructor({
    url, headers = {}, service = DEFAULT_SERVICE, instance, batchSize = 100, maxBuffered = 2000, intervalMs = 5000,
    fetchImpl = globalThis.fetch, timers = { setInterval, clearInterval }, report = message => process.stderr.write(`${message}\n`)
  }) {
    Object.assign(this, { url, headers, service, instance, batchSize, maxBuffered, fetchImpl, report, timers });
    this.buffer = [];
    this.dropped = 0;
    this.failedBatches = 0;
    this.chain = Promise.resolve();
    this._lastReport = 0;
    this.timer = timers.setInterval(() => { void this.flush(); }, intervalMs);
    this.timer?.unref?.();
  }

  buffered() { return this.buffer.length; }

  add(record) {
    this.buffer.push(record);
    while (this.buffer.length > this.maxBuffered) { this.buffer.shift(); this.dropped += 1; }
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  /** Sends what is buffered. Calls are queued, so only one request is ever in flight. */
  flush() {
    this.chain = this.chain.then(() => this._send());
    return this.chain;
  }

  async _send() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(otlpPayload(batch, { service: this.service, instance: this.instance }))
      });
      if (!res.ok) throw new Error(`the collector answered ${res.status}`);
    } catch (err) {
      this.failedBatches += 1;
      const now = Date.now();
      if (now - this._lastReport > 60000 || this._lastReport === 0) {
        this._lastReport = now;
        this.report(`⚠️ Log export: could not reach the collector at ${redact(this.url)} (${redact(err.message)}); ${batch.length} log record(s) dropped.`);
      }
    }
  }

  async stop() {
    this.timers.clearInterval(this.timer);
    await this.flush();
  }
}

const LEVEL_OF_METHOD = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
let current = null;

/** The logging in force, or null when the hub is running as it always did. */
export function activeLogging() { return current; }

/**
 * Wrap the console per the environment. Returns what was installed, with `uninstall()`. Asking for nothing installs
 * nothing, so a hub with neither variable set prints exactly what it always has.
 */
export function installLogging({
  env = process.env, console: target = console, stdout = process.stdout, now = Date.now, fetchImpl, timers, instance = os.hostname()
} = {}) {
  if (current) return current;
  const config = resolveLoggingConfig(env);
  for (const problem of config.problems) target.warn(problem);
  if (!config.json && !config.otlp) return { json: false, otlp: false, requests: false, shipper: null, uninstall() {} };

  const originals = {};
  for (const method of Object.keys(LEVEL_OF_METHOD)) originals[method] = target[method];

  const shipper = config.otlp
    ? new OtlpShipper({ ...config.otlp, service: config.service, instance, intervalMs: config.intervalMs, ...(fetchImpl ? { fetchImpl } : {}), ...(timers ? { timers } : {}) })
    : null;

  const sink = record => {
    if (config.json) stdout.write(`${toJsonLine(record)}\n`);
    shipper?.add(record);
  };

  for (const [method, level] of Object.entries(LEVEL_OF_METHOD)) {
    target[method] = (...args) => {
      const record = makeRecord(level, args, now(), config.service);
      sink(record);
      // With a collector but no JSON the console keeps printing as before: only the shipping is added.
      if (!config.json) originals[method].apply(target, args);
    };
  }

  current = {
    json: config.json,
    otlp: Boolean(config.otlp),
    requests: config.requests,
    shipper,
    emit(level, msg, attrs = {}) { sink(makeRecord(level, [msg], now(), config.service, attrs)); },
    uninstall() {
      for (const [method, original] of Object.entries(originals)) target[method] = original;
      shipper?.stop();
      current = null;
    }
  };
  return current;
}

/** Log a record with attributes through whatever is installed; falls back to the console when nothing is. */
export function emit(level, msg, attrs = {}) {
  if (current) current.emit(level, msg, attrs);
  else console[level === 'warn' || level === 'error' ? level : 'log'](msg, attrs);
}

/** Paths that are the hub's own heartbeat (handsets ask every few seconds); logging each would bury everything else. */
const QUIET_PATHS = new Set(['/pairing-info']);

/**
 * Express middleware: one record per answered request, with the method, the path WITHOUT its query string (that is where
 * a live-feed token travels), the route pattern rather than the ids in it, the status, and how long it took.
 */
export function requestLogger({ emit: send = emit, now = Date.now, quiet = QUIET_PATHS } = {}) {
  return (req, res, next) => {
    const started = now();
    res.on('finish', () => {
      const target = String(req.originalUrl || req.url || '').split('?')[0];
      if (quiet.has(target)) return;
      const status = res.statusCode;
      const attrs = {
        'http.method': req.method,
        'http.target': redact(target),
        'http.status_code': status,
        duration_ms: now() - started
      };
      if (req.route?.path) attrs['http.route'] = `${req.baseUrl || ''}${req.route.path}`;
      send(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', `${req.method} ${redact(target)} ${status}`, attrs);
    });
    next();
  };
}
