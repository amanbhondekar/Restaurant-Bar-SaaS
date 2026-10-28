// Imported first by server.js, so that logging is wrapped before any other module prints at load time.
// A hub started without HUB_LOG_FORMAT or OTEL_EXPORTER_OTLP_ENDPOINT is untouched. See lib/log.js.
import { installLogging } from './log.js';

installLogging();
