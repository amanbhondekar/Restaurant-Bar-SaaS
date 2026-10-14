import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js');
export const RESTAURANT_ID = '11111111-1111-1111-1111-111111111111';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A free port, picked by the operating system.
 *
 * Fixtures used to hardcode one each, which collided two ways: two test files sharing a number
 * (the runner runs files in parallel), and a number still held in TIME_WAIT by the previous run.
 * Asking for port 0 fixes both -- the OS does not hand out a port that is in TIME_WAIT.
 *
 * Reserved on 0.0.0.0 because that is what the hub binds: a port free only on 127.0.0.1 could
 * still be taken on another interface. The listener is closed before the hub starts, so there is
 * a small window where something else could take it; `startHub` retries on a fresh port for that.
 */
export function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address();
      probe.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

/** A hub that never came up because something else holds the port -- worth another try. */
const looksLikeATakenPort = err => /already in use|exited during startup/i.test(err?.message || '');

/**
 * Boots a real hub against a throwaway data directory. `trustLoopback: true`
 * makes requests from 127.0.0.1 act as the reception laptop; `false` makes them
 * act as a remote handset that must present a token.
 *
 * Omit `port` and one is reserved per attempt, retrying if the port is taken in the gap between
 * reserving it and the hub binding it. Pass `port` to pin it, and the failure is reported as-is:
 * a caller naming a port is testing that port.
 *
 * `config` adds or overrides fields in hub_config.json; `files` writes extra files into the data
 * directory (`{ 'invoices.json': [...] }`), both for fixtures that need more than the defaults.
 */
export async function startHub(options = {}) {
  if (options.port) return bootHub({ ...options, port: options.port });

  let lastError;
  // Eight rather than five: the suite now starts ten hubs at once, and a lost race is cheap to
  // retry but expensive to debug as a one-in-fifteen red build.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await bootHub({ ...options, port: await reservePort() });
    } catch (err) {
      if (!looksLikeATakenPort(err)) throw err;
      lastError = err;
      // A whole suite starts its hubs at once, so a lost race usually means several are racing.
      // Backing off spreads the retries out instead of replaying the same pile-up.
      await sleep(100 * (attempt + 1));
    }
  }
  throw lastError;
}

async function bootHub({ port, trustLoopback, menu, tables, enrollmentCode = 'TESTCODE', config, files }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-catalog-'));
  // Unique per start and served by /pairing-info. The readiness check below only accepts an
  // answer carrying it, so a stale hub already holding the port can never pass for this one.
  const hubName = `Test Kitchen ${crypto.randomUUID()}`;
  fs.writeFileSync(path.join(dataDir, 'menu_cache.json'), JSON.stringify(menu));
  fs.writeFileSync(path.join(dataDir, 'tables_cache.json'), JSON.stringify(tables));
  fs.writeFileSync(path.join(dataDir, 'tickets.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'sync_queue.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'hub_config.json'), JSON.stringify({
    paired: true,
    restaurant_id: RESTAURANT_ID,
    pairing_code: 'TST-0001',
    city: 'Nagpur',
    enrollment_code: enrollmentCode,
    devices: [],
    ...config,
    // Last, so a fixture's `config` cannot clobber it: the readiness probe below matches on this
    // name, and that is the only thing stopping another hub on the same port passing for this one.
    name: hubName
  }));
  for (const [name, contents] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dataDir, name), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HUB_DATA_DIR: dataDir,
      HUB_TRUST_LOOPBACK: trustLoopback ? 'true' : 'false',
      SUPABASE_URL: 'https://example.supabase.co'
    },
    // stdout is ignored; the last 2 KB of stderr is kept so a hub that dies at startup can say why.
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderrTail = '';
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-2000); });
  let closed = false;
  child.once('close', () => { closed = true; });
  let spawnError = null;
  child.once('error', err => { spawnError = err; });

  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  const fail = async reason => {
    if (hasExited()) for (let i = 0; i < 10 && !closed; i++) await sleep(50); // let stderr drain
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw new Error(`hub server on port ${port} ${reason}${stderrTail.trim() ? `\n--- hub stderr ---\n${stderrTail.trim()}` : ''}`);
  };

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (spawnError) await fail(`could not be started: ${spawnError.message}`);
    // The hub is gone and will never answer. A taken port looks like this (exit code 0 included):
    // the hub's crash handler swallows the EADDRINUSE, so the process just runs out of work and exits.
    if (hasExited()) {
      await fail(`exited during startup (exit code ${child.exitCode ?? child.signalCode}). Is the port already in use?`);
    }
    try {
      // The timeout covers the body too, so a listener that accepts the connection but never
      // answers cannot hang this loop past its own deadline.
      const info = await (await fetch(`${base}/pairing-info`, { signal: AbortSignal.timeout(1000) })).json();
      if (info?.name === hubName) break;
    } catch {
      // Nothing is listening yet, what answers is not a hub, or it did not answer within a second.
    }
    if (Date.now() > deadline) await fail('did not start within 20 s');
    await sleep(200);
  }

  return {
    base,
    port,
    dataDir,
    // The per-start name in hub_config.json, for tests that assert on what /pairing-info serves.
    name: hubName,
    stop() {
      child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

/** JSON fetch helper: `call(hub, '/path', { method, body, token })`. */
export function call(hub, pathname, { method = 'GET', body, token } = {}) {
  return fetch(`${hub.base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
