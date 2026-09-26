import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const CRASH_FILE = path.join(DATA_DIR, 'crash_log.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Rolling crash log for the hub and its two React clients.
 *
 * Sources:
 *   - 'hub'    — uncaughtException / unhandledRejection from server.js
 *   - 'kds'    — kitchen_main.jsx window.onerror / unhandledrejection
 *   - 'waiter' — waiter PWA window.onerror / unhandledrejection
 *
 * Kept on-disk to survive a hub restart (that's exactly the window
 * reception cares about — "we crashed once at 2pm"). Capped at
 * MAX_ENTRIES so the file can't grow without bound if a client is
 * stuck in a crash loop.
 */

const MAX_ENTRIES = 200;
const MAX_MESSAGE_LEN = 1000;
const MAX_STACK_LEN = 6000;
const SOURCES = new Set(['hub', 'kds', 'waiter']);

function trimField(raw, cap) {
  if (raw == null) return null;
  const str = String(raw);
  return str.length > cap ? str.slice(0, cap) : str;
}

class CrashReporter {
  constructor() {
    this.entries = this.load();
  }

  load() {
    try {
      if (fs.existsSync(CRASH_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(CRASH_FILE, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch (err) {
      console.warn('⚠️  Could not load crash_log.json:', err.message);
    }
    return [];
  }

  save() {
    fs.promises
      .writeFile(CRASH_FILE, JSON.stringify(this.entries, null, 2), 'utf-8')
      .catch(err => console.error('❌ Async save crash log error:', err));
  }

  /**
   * Record a crash. `source` is one of 'hub' / 'kds' / 'waiter';
   * anything else is coerced to 'hub'. Returns the persisted entry
   * so callers can log or forward it.
   */
  report({ source, message, stack, url, user_agent, extra } = {}) {
    const entry = {
      id: 'crash_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      source: SOURCES.has(source) ? source : 'hub',
      message: trimField(message, MAX_MESSAGE_LEN) || '(no message)',
      stack: trimField(stack, MAX_STACK_LEN),
      url: trimField(url, 500),
      user_agent: trimField(user_agent, 300),
      extra: extra && typeof extra === 'object' ? extra : null,
      reported_at: new Date().toISOString()
    };
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    this.save();
    return entry;
  }

  list({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 50));
    return this.entries.slice(0, n);
  }

  clear() {
    this.entries = [];
    this.save();
  }
}

export const crashReporter = new CrashReporter();

/**
 * Wire up process-level handlers on the hub. Called once from server.js at
 * boot. Uncaught exceptions and unhandled promise rejections are logged to
 * the rolling file so a crashed hub leaves a trail, not just a stderr blip.
 */
export function attachHubProcessHandlers() {
  process.on('uncaughtException', (err) => {
    try {
      crashReporter.report({
        source: 'hub',
        message: err?.message || String(err),
        stack: err?.stack,
        extra: { kind: 'uncaughtException' }
      });
    } catch {}
    // Same behaviour Node's default handler had before we hooked in — one
    // more log line and then we stay alive if we can. The op should still
    // notice from the log; we shouldn't die on every JS error.
    console.error('💥 uncaughtException:', err);
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    try {
      crashReporter.report({
        source: 'hub',
        message: err.message,
        stack: err.stack,
        extra: { kind: 'unhandledRejection' }
      });
    } catch {}
    console.error('💥 unhandledRejection:', err);
  });
}
