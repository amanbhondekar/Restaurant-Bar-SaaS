import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { reservePort, startHub, RESTAURANT_ID } from './helpers/spawnHub.mjs';

const MENU = { restaurant_id: RESTAURANT_ID, categories: ['Starters'], items: [] };
const TABLES = { restaurant_id: RESTAURANT_ID, tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 4 }] };

// A hub left over from an earlier run answers /pairing-info just like the one startHub spawns.
// If the helper took that answer as "ready", a whole suite would silently run against the wrong
// hub (and the freshly spawned one would be dying of EADDRINUSE in the background).
test('startHub refuses to run against a stale listener already holding its port, and fails fast', async () => {
  const port = await reservePort();
  const stale = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ paired: true, name: 'Stale Hub' }));
  });
  await new Promise(resolve => stale.listen(port, '0.0.0.0', resolve));

  try {
    const started = Date.now();
    const outcome = await startHub({ port, trustLoopback: true, menu: MENU, tables: TABLES })
      .then(hub => { hub.stop(); return null; }, err => err);

    assert.ok(outcome instanceof Error, 'startHub must not report ready while a stale listener holds the port');
    assert.match(outcome.message, new RegExp(String(port)), 'the error must name the port');
    assert.ok(Date.now() - started < 15000, `must fail as soon as the spawned hub exits, not after the 20 s deadline (took ${Date.now() - started} ms)`);
  } finally {
    stale.closeAllConnections?.();
    await new Promise(resolve => stale.close(resolve));
  }
});
