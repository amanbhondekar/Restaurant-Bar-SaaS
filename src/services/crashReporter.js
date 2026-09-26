/**
 * Wire `window.onerror` and `unhandledrejection` to POST /crash-report
 * on the hub. Fire-and-forget with `keepalive: true` so a crash on
 * unload still gets its POST out.
 *
 * Rate-limited to at most 1 report / 500ms / (message+source), because
 * a component stuck in a render loop can otherwise fire hundreds of
 * identical errors before the browser tab freezes.
 *
 * Never throws — a broken crash reporter must not crash the client
 * *again* and defeat the whole point.
 */

const HUB_HOST_DEFAULT = typeof window !== 'undefined'
  ? (window.location.port === '4000'
      ? window.location.origin
      : `${window.location.protocol}//${window.location.hostname}:4000`)
  : 'http://localhost:4000';

const RATE_LIMIT_MS = 500;
const recentKeys = new Map(); // key → last-fired ts

let installed = false;

export function installCrashReporter({ source, hubUrl = HUB_HOST_DEFAULT } = {}) {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const post = (payload) => {
    const key = `${payload.source}|${payload.message}`;
    const now = Date.now();
    const last = recentKeys.get(key);
    if (last && now - last < RATE_LIMIT_MS) return;
    recentKeys.set(key, now);
    // Trim the map periodically so a long session doesn't leak.
    if (recentKeys.size > 200) {
      const cutoff = now - 60000;
      for (const [k, t] of recentKeys) if (t < cutoff) recentKeys.delete(k);
    }

    try {
      fetch(`${hubUrl.replace(/\/+$/, '')}/crash-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // keepalive lets the POST outlive the tab if the crash happens on unload.
        keepalive: true,
        body: JSON.stringify(payload)
      }).catch(() => {});
    } catch { /* never throw from the reporter */ }
  };

  window.addEventListener('error', (event) => {
    try {
      post({
        source,
        message: event?.message || 'window.onerror',
        stack: event?.error?.stack || null,
        url: event?.filename || window.location.href,
        user_agent: navigator.userAgent
      });
    } catch { /* noop */ }
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event?.reason;
      post({
        source,
        message: (reason && (reason.message || String(reason))) || 'unhandledrejection',
        stack: reason?.stack || null,
        url: window.location.href,
        user_agent: navigator.userAgent
      });
    } catch { /* noop */ }
  });
}
