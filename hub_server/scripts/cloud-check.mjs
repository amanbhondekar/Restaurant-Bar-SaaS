// npm run cloud:check            read-only: does the Supabase project have every table and column the migrations define?
// npm run cloud:check -- --probe <restaurant-uuid>
//                                 also writes ONE voided probe bill for that restaurant, reads it back through
//                                 the hub's restore path, and deletes it.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (or .env). It never prints the key.

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { checkTables, migrationsToRun, roundTrip } from '../lib/cloudCheck.js';
import { cloudSchema } from '../lib/sqlSchema.js';

dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || /example\.supabase\.co/.test(url) || !key) {
  console.error('cloud:check needs a real project: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Nothing was contacted.');
  process.exit(2);
}

const probeAt = process.argv.indexOf('--probe');
const probeFor = probeAt >= 0 ? process.argv[probeAt + 1] : null;
if (probeAt >= 0 && !/^[0-9a-f-]{36}$/i.test(probeFor ?? '')) {
  console.error('--probe needs the restaurant\'s UUID.');
  process.exit(2);
}

const client = createClient(url, key, { auth: { persistSession: false } });
const host = new URL(url).host;
console.log(`Checking ${host}\n`);

const findings = await checkTables(client, cloudSchema());
for (const f of findings) {
  if (f.ok) { console.log(`  ok       ${f.table}`); continue; }
  const p = f.problem;
  if (p.kind === 'table') console.log(`  MISSING  ${f.table}: the table is not there`);
  else if (p.kind === 'column') console.log(`  MISSING  ${f.table}: ${f.missing.map(m => `${m.column} (${m.migration})`).join(', ') || p.column}`);
  else if (p.kind === 'permission') console.log(`  DENIED   ${f.table}: this key may not read it`);
  else console.log(`  ERROR    ${f.table}: ${p.message}`);
}

const run = migrationsToRun(findings);
const missingTables = findings.filter(f => f.problem?.kind === 'table').length;
let failed = findings.some(f => !f.ok);
if (run.length) console.log(`\nRun: ${run.join(', ')}`);
if (missingTables) console.log('A missing table means the migration that creates it has not been run; see database/migrations/.');

if (probeFor) {
  console.log(`\nProbe for ${probeFor}`);
  const result = await roundTrip(client, probeFor);
  for (const s of result.steps) console.log(`  ${s.ok ? 'ok     ' : 'FAILED '} ${s.name}${s.ok ? '' : `: ${s.detail}`}`);
  failed ||= !result.ok;
}

console.log(failed ? '\nNot ready.' : '\nEvery table and column the hub writes is there.');
console.log('Not checked here: row-level security policies and unique indexes (PostgREST cannot see them). The unique indexes are checked against the SQL by the contract test; policies need a signed-in probe.');
process.exit(failed ? 1 : 0);
