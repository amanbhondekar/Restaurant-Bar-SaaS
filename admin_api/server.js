// The admin API's entry point (Phase 1, P1-3). Run it where the operator service does NOT run: it is its own deploy with its own credentials
// (invariant I10), and it must never hold the Supabase service key (invariant I2; it refuses to start if one is in its environment).
//
//   ADMIN_DATABASE_URL   postgresql://kullina_admin:...@host:5432/postgres   (the dedicated role; see migration 023 for how it gets a password)
//   ADMIN_JWT_SECRET     the project's JWT secret, or
//   ADMIN_JWKS_URL       https://<project>.supabase.co/auth/v1/.well-known/jwks.json
//   ADMIN_WEB_ORIGIN     https://admin.example.com   (the one web page allowed to call it)
//   ADMIN_IP_ALLOWLIST   optional, comma separated addresses or IPv4 ranges
//   ADMIN_TRUST_PROXY    optional, how many proxies sit in front (0-3)
//   PORT                 default 4600

import { loadConfig } from './lib/config.js';
import { createAdminApp } from './lib/app.js';
import { hsKeys, remoteJwks, anyOf } from './lib/keys.js';
import { makeAdminDb, poolTransaction, assertDedicatedRole } from './lib/db.js';

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  console.error('[admin_api] It will not start:');
  for (const problem of loaded.problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const { config } = loaded;

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, idleTimeoutMillis: 30000, ssl: process.env.ADMIN_DATABASE_SSL === 'off' ? false : { rejectUnauthorized: true } });
pool.on('error', err => console.error('[admin_api] a database connection failed:', err.message));

try {
  await assertDedicatedRole((sql, params) => pool.query(sql, params));
} catch (err) {
  console.error(`[admin_api] It will not start: ${err.message}`);
  process.exit(1);
}

const keys = anyOf(
  ...(config.jwtSecret ? [hsKeys(config.jwtSecret)] : []),
  ...(config.jwksUrl ? [remoteJwks({ url: config.jwksUrl })] : [])
);
const app = createAdminApp({ db: makeAdminDb({ transaction: poolTransaction(pool) }), keys, config });

app.listen(config.port, () => {
  console.log(`[admin_api] listening on :${config.port} as kullina_admin. Web origin: ${config.webOrigins.join(', ')}.`);
});
