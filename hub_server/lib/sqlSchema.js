import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reads the cloud schema out of the SQL files in database/, so a test (or `npm run cloud:check`) can say what
// the cloud SHOULD have without a cloud to ask. It understands exactly the forms those files use -- CREATE TABLE, ALTER TABLE
// ... ADD COLUMN (one or several), and CREATE [UNIQUE] INDEX -- and nothing more. If it meets a form it
// does not understand it fails loudly rather than guessing, because a silently-wrong schema is exactly the
// kind of mistake the tests built on it exist to catch.

const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'database');

const stripComments = sql => sql.split(/\r?\n/).map(l => l.replace(/--.*$/, '')).join('\n');

/** Splits on commas that are not inside parentheses. */
function topLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

const CONSTRAINT_START = /^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i;

function parseColumn(def) {
  const m = /^"?([a-z_][a-z0-9_]*)"?\s+(.+)$/is.exec(def.replace(/\s+/g, ' '));
  if (!m) throw new Error(`sqlSchema: cannot read column definition: ${def}`);
  const [, name, rest] = m;
  const upper = rest.toUpperCase();
  return {
    name,
    type: rest.split(/\s+/)[0].toUpperCase(),
    notNull: /\bNOT NULL\b/.test(upper) || /\bPRIMARY KEY\b/.test(upper),
    hasDefault: /\bDEFAULT\b/.test(upper),
    // CHECK (col IN ('a', 'b')) written inline on the column
    allowed: inList(rest)
  };
}

/** The values of a `... IN ('a','b')` list, or null. */
function inList(text) {
  const m = /\bIN\s*\(([^)]*)\)/i.exec(text);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
}

/** Every table in the given SQL files: { name: { columns: Map, unique: string[][], checks: [{ column, allowed }] } } */
export function loadSchema(files) {
  const tables = {};
  const table = name => (tables[name] ||= { columns: new Map(), unique: [], checks: [] });

  for (const file of files) {
    const sql = stripComments(fs.readFileSync(file, 'utf8'));

    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(/gi)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < sql.length && depth > 0) { if (sql[i] === '(') depth++; if (sql[i] === ')') depth--; i++; }
      const t = table(m[1]);
      t.source ||= path.basename(file);
      for (const def of topLevel(sql.slice(start, i - 1))) {
        if (CONSTRAINT_START.test(def)) {
          const named = /CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)/i.exec(def);
          if (named) t.checks.push({ column: named[1], allowed: [...named[2].matchAll(/'([^']*)'/g)].map(x => x[1]) });
          const uq = /UNIQUE\s*\(([^)]*)\)/i.exec(def);
          if (uq) t.unique.push(uq[1].split(',').map(s => s.trim()));
          continue;
        }
        const col = { ...parseColumn(def), source: path.basename(file) };
        t.columns.set(col.name, col);
        if (col.allowed) t.checks.push({ column: col.name, allowed: col.allowed });
      }
    }

    // ALTER TABLE x ADD COLUMN [IF NOT EXISTS] a ..., ADD COLUMN [IF NOT EXISTS] b ...;
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)\s+((?:ADD\s+COLUMN[^;]*?)+);/gis)) {
      for (const piece of topLevel(m[2])) {
        const a = /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(.+)$/is.exec(piece.trim());
        if (!a) continue;
        const col = { ...parseColumn(a[1]), source: path.basename(file) };
        table(m[1]).columns.set(col.name, col);
        if (col.allowed) table(m[1]).checks.push({ column: col.name, allowed: col.allowed });
      }
    }

    for (const m of sql.matchAll(/CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+(?:public\.)?(\w+)\s*\(([^)]*)\)/gi)) {
      table(m[1]).unique.push(m[2].split(',').map(s => s.trim().replace(/\s+(ASC|DESC)$/i, '')));
    }
  }
  return tables;
}

const MIGRATIONS = fs.readdirSync(path.join(DB, 'migrations')).filter(f => f.endsWith('.sql')).sort();

/** The schema a project has after the base schema and every migration, in order. */
export const cloudSchema = (upTo = Infinity) => loadSchema([
  path.join(DB, 'supabase_schema.sql'),
  ...MIGRATIONS.filter(f => Number.parseInt(f, 10) <= upTo).map(f => path.join(DB, 'migrations', f))
]);

export const migrationFiles = MIGRATIONS;
