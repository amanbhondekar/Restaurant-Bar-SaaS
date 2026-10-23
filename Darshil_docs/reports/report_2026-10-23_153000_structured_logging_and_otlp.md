# Structured logging and an optional OpenTelemetry export

**Date:** 2026-10-23T15:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY
Roadmap §4.8 listed "structured logging + optional OpenTelemetry export from the hub". The hub prints about 180 human-readable lines;
someone looking after several restaurants reads them elsewhere and wants lines a machine can split, or a collector they already run.
Because these lines leave the machine, the thing to get right is what must not leave it.

## WHAT CHANGED
- `hub_server/lib/log.js` (new) and `lib/logInstall.js` (new, imported first by `server.js` so it wraps the console before any module
  prints at load time).
  - **Off unless asked.** `HUB_LOG_FORMAT=json` makes every log line one line of JSON on stdout; `OTEL_EXPORTER_OTLP_ENDPOINT` (or
    `..._LOGS_ENDPOINT`) also ships records as OTLP/HTTP JSON; a hub with neither prints exactly what it always did. No call site was
    edited: the console methods are wrapped, so the existing lines become records.
  - **Redacted at the source**, when the record is made, so nothing downstream can forget: bearer tokens, 40+ hex (device tokens), JWTs,
    and the values of token / device_token / enrollment_code / pin / password / secret / api_key / authorization, in JSON or `key=value`.
    Error messages and stack traces too.
  - **A request log** (on with JSON or a collector): method, path **without its query string** (where a live-feed token travels), the
    route pattern (`/orders/:id/ready`, not one path per dish), status (4xx warn, 5xx error) and duration. `/pairing-info`, which every
    handset asks every few seconds, is skipped.
  - **The exporter cannot hurt the hub:** bounded buffer (2,000; the oldest are dropped and counted), one request in flight, a failed
    batch dropped not retried for ever, and its own trouble reported straight to stderr once a minute, never through the log it ships.
  - **Refused out loud:** gRPC, protobuf, or a non-http(s) address are warned about at start-up rather than guessed at.
- `docs/LOGGING.md`: the variables, what a line looks like, what never leaves, what happens when the collector is down, what is not done.
- `test/helpers/spawnHub.mjs`: `hub.output()` returns what the hub printed, for tests about its logging.

## TESTS (`hub_server/test/structuredLog.test.mjs`, 37)
Unit: redaction (each key and form, JWT, hex, and that ordinary text, ids and numbers are untouched); records (levels, Errors, redaction at
creation, one-line JSON, attributes never overwrite the record's own fields); the OTLP payload shape and typed attributes; configuration
(off by default, each address form, headers, bad and unsupported settings); the shipper with fake timers (batching, timed flush, bounded
buffer, failures, one in flight, stop, report-once); installing (default leaves the console alone, JSON mode, uninstall, no double
install, collector without JSON keeps the text, problems warned once); the request log (query stripped, levels, route pattern, heartbeat
skipped). Real hubs: one in JSON mode with a local collector (JSON lines, the request logged with its 401, **no secret from the query or
the bearer header in the output or at the collector**, the OTLP arrives with the service name and header, and what the hub said about a
refused enrolment is shipped) and one left alone (no JSON, nothing sent).

**Mutation check:** 55 mutations of the module and its wiring. 54 caught first time; the survivor was real (a collector on its own did
not turn the request log on, and nothing tested it) and now has a test. The JSON-key redaction branch was confirmed by its own mutation.

## COUNTS
Hub **1292 passing** across 65 files (1255 before). Frontend unchanged at 841.

## NOT DONE
- Logs only, and only OTLP/HTTP with JSON. No gRPC or protobuf exporter, no traces, no metrics.
- Not run against a real OpenTelemetry collector: a local HTTP server stands in for one and checks the request it receives. A real
  collector may want a different path or header; the address and headers are configurable.
- In JSON mode `console.error` and `console.warn` also go to stdout (a record has a level, so the stream stays uniform). A supervisor
  that treats stderr as the error log will not see them there.
- Redaction is pattern-based. It will not catch a secret that has no recognisable name or shape.
