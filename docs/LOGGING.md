# Logging and OpenTelemetry export

By default the hub prints the same human-readable lines it always has. Two environment variables change that; neither is needed
for a hub to work, and neither changes any call site: the console is wrapped (`hub_server/lib/log.js`).

| Variable | Effect |
|---|---|
| `HUB_LOG_FORMAT=json` | Every log line becomes one line of JSON on stdout: `time`, `level`, `service`, `msg`, plus attributes. The plain text is not also printed. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Records are also sent to an OpenTelemetry collector, as OTLP over HTTP with JSON, to `<endpoint>/v1/logs`. The console keeps printing as before unless JSON was also asked for. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | The full logs URL, used as given instead of the above. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key2=value2`, sent on every export (an API key, a tenant). |
| `OTEL_SERVICE_NAME` | Defaults to `kullina-hub`. Set it per restaurant to tell hubs apart (`service.instance.id` is the machine's host name). |
| `HUB_LOG_REQUESTS` | A record per answered request. On when JSON or a collector is on; `0` turns it off, `1` turns it on by itself. |
| `HUB_LOG_EXPORT_INTERVAL_MS` | How often a quiet hub sends what it has (default 5000). |

Asking for something the hub does not do (a gRPC or protobuf collector, or an address that is not http/https) is refused with a
warning at start-up, not guessed at.

## What a line looks like

```json
{"time":"2026-10-23T09:30:15.250Z","level":"warn","service":"kullina-hub","msg":"GET /menu 401","http.method":"GET","http.target":"/menu","http.status_code":401,"duration_ms":2}
```

Errors carry `exception.message` and `exception.stacktrace`. The request log records the route pattern (`http.route`,
`/orders/:id/ready`) so one busy dish is not a thousand different paths, and skips `/pairing-info`, which every handset asks every
few seconds.

## What never leaves the machine

Records are redacted as they are made, before they are printed or sent: bearer tokens, device tokens (long hex), JWTs, and the
values of `token`, `device_token`, `enrollment_code`, `pin`, `password`, `secret`, `api_key` and `authorization`, in JSON or as
`key=value`. The request log never records a query string, which is where the live feed's token travels. This is a safety net for
what the hub might print, not a licence to print secrets: do not log them.

## If the collector is down

The exporter can never hurt the hub. It buffers up to 2,000 records and drops the oldest beyond that; sends one request at a time;
drops a batch that fails rather than retrying for ever; and says so on stderr once a minute (never through the log it ships, which
would feed itself). Nothing waits for it.

## Not done

Only logs, only OTLP/HTTP with JSON. There is no gRPC or protobuf exporter, no traces and no metrics.
