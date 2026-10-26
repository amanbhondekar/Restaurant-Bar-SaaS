import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// The admin console's page as it is SHIPPED, not as its unit tests see it. The unit tests run without CSS, so they cannot notice a page that
// builds unstyled (a past split of a file dropped the stylesheet import with every test green), a policy that allows a script to run, a
// bundle that carries something it should not, or a build that quietly includes the product's other pages. This builds the real thing and
// looks at what comes out.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const web = path.join(root, 'admin_web');
const API = 'https://admin-api.kullina.example';
const SUPABASE = 'https://abcdefgh.supabase.co';
const ENV = {
  VITE_ADMIN_API_URL: API,
  VITE_SUPABASE_URL: SUPABASE,
  VITE_SUPABASE_ANON_KEY: `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"anon"}').toString('base64url')}.sig`
};

let out;
let html;
let css;
let js;
const read = file => fs.readFileSync(path.join(out, file), 'utf8');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

async function buildWith(env, outDir) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    await build({ configFile: path.join(web, 'vite.config.js'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

before(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-web-build-'));
  await buildWith(ENV, out);
  html = read('index.html');
  const assets = walk(path.join(out, 'assets')).map(f => path.relative(out, f).replace(/\\/g, '/'));
  css = assets.filter(a => a.endsWith('.css')).map(read).join('\n');
  js = assets.filter(a => a.endsWith('.js')).map(read).join('\n');
});
after(() => { if (out) fs.rmSync(out, { recursive: true, force: true }); });

// --- the page ----------------------------------------------------------------------------------------------------------------------------

test('the page names itself, asks search engines to keep away and sends no referrer', () => {
  assert.match(html, /<title>Kullina admin<\/title>/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(html, /<meta name="referrer" content="no-referrer"/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /<meta name="viewport"/);
});

test('it loads one script and one stylesheet, and nothing runs inline', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'one script');
  assert.match(scripts[0][1], /type="module"/);
  assert.match(scripts[0][1], /src="\/assets\/[^"]+\.js"/);
  assert.equal(scripts[0][2].trim(), '', 'and it has no inline body');
  const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
  assert.equal(links.length, 1, 'the stylesheet is linked: without it the page is unstyled');
  assert.match(links[0][0], /href="\/assets\/[^"]+\.css"/);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.doesNotMatch(html, /javascript:/i);
});

test('it is styled: the stylesheet carries the design tokens, the product\'s two fonts and the classes the screens use', () => {
  assert.ok(css.length > 20000, `the stylesheet is real (${css.length} bytes)`);
  assert.match(css, /--color-primary\s*:/, 'the design tokens');
  assert.match(css, /font-family:\s*["']?Cabinet Grotesk/i);
  assert.match(css, /font-family:\s*["']?Instrument Sans/i);
  assert.match(css, /\.min-h-screen\b/, 'a class the shell uses');
  assert.match(css, /grid-cols-\\\[minmax\\\(7rem/, 'a class that only the reused restaurant views use: the build looked in src/ too');
});

test('the fonts the stylesheet names are in the build, and are the product\'s own, not a download from anywhere', () => {
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/["']/g, '')).filter(u => !u.startsWith('data:'));
  assert.ok(urls.some(u => /CabinetGrotesk/.test(u)));
  assert.ok(urls.some(u => /InstrumentSans/.test(u)));
  for (const u of urls) {
    assert.ok(u.startsWith('/'), `${u} is from this site`);
    assert.doesNotMatch(u, /^\/\//);
    assert.ok(fs.existsSync(path.join(out, u.split('?')[0])), `${u} is in the build`);
  }
  assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic/);
});

test('the policy lets nothing but this site\'s own files run, and lets the page talk to exactly two places', () => {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(m, 'the policy is in the page');
  m[1] = m[1].replaceAll('&#39;', "'").replaceAll('&amp;', '&');   // how the page writes it; a browser reads it back as plain quotes
  const csp = Object.fromEntries(m[1].split(';').map(s => s.trim()).filter(Boolean).map(s => { const [k, ...v] = s.split(/\s+/); return [k, v]; }));
  assert.deepEqual(csp['default-src'], ["'none'"]);
  assert.deepEqual(csp['script-src'], ["'self'"]);
  assert.deepEqual(csp['style-src'], ["'self'"]);
  assert.deepEqual(csp['font-src'], ["'self'"]);
  assert.deepEqual(csp['img-src'].sort(), ["'self'", 'data:'].sort(), 'data: is for the QR code Supabase draws');
  assert.deepEqual(csp['connect-src'].sort(), ["'self'", API, SUPABASE].sort());
  assert.deepEqual(csp['base-uri'], ["'none'"]);
  assert.deepEqual(csp['form-action'], ["'none'"]);
  assert.doesNotMatch(m[1], /unsafe-inline|unsafe-eval|\*|http:/);
});

// --- what is in the build ---------------------------------------------------------------------------------------------------------------------

test('it is the console and only the console: no other page of the product, no service worker, no manifest, no source maps', () => {
  const files = walk(out).map(f => path.relative(out, f).replace(/\\/g, '/'));
  const html_ = files.filter(f => f.endsWith('.html'));
  assert.deepEqual(html_, ['index.html']);
  for (const banned of ['sw.js', 'manifest.json', 'waiter.html', 'admin.html', 'ops.html', 'owner.html']) assert.ok(!files.includes(banned), banned);
  assert.ok(!files.some(f => f.endsWith('.map')), 'no source maps');
  assert.ok(!files.some(f => /^(icons|logos)\//.test(f)), 'none of the product\'s other assets');
  assert.ok(files.some(f => f.startsWith('fonts/')));
});

test('the script holds the console and none of the product\'s other screens', () => {
  assert.ok(js.length > 100000);
  assert.match(js, /Kullina admin/);
  for (const other of ['KitchenHubApp', 'Kitchen Display', 'serviceWorker.register', 'Operator console']) assert.ok(!js.includes(other), `the bundle mentions ${other}`);
});

test('the script has no key in it but the public one, and names no service key', () => {
  assert.ok(js.includes(ENV.VITE_SUPABASE_ANON_KEY) || js.includes(SUPABASE), 'the public settings are in the bundle, as they must be');
  assert.doesNotMatch(js, /SERVICE_ROLE_KEY|SUPABASE_SERVICE/);
  assert.doesNotMatch(js, /"role"\s*:\s*"service_role"/);
});

// --- refusing to build something unsafe -------------------------------------------------------------------------------------------------------

test('the build refuses a service key in the page\'s settings, whatever it is called', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-web-refuse-'));
  try {
    for (const bad of [
      { VITE_SUPABASE_SERVICE_ROLE_KEY: 'whatever' },
      { VITE_SERVICE_KEY: 'whatever' },
      { VITE_SUPABASE_ANON_KEY: `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.sig` }
    ]) {
      await assert.rejects(() => buildWith({ ...ENV, ...bad }, dir), /service/i, JSON.stringify(Object.keys(bad)));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the build refuses to put the page on addresses it cannot vouch for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-web-refuse-'));
  try {
    await assert.rejects(() => buildWith({ ...ENV, VITE_ADMIN_API_URL: 'http://admin-api.kullina.example' }, dir), /https|VITE_ADMIN_API_URL/);
    await assert.rejects(() => buildWith({ ...ENV, VITE_SUPABASE_URL: '' }, dir), /VITE_SUPABASE_URL/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- the host's own headers --------------------------------------------------------------------------------------------------------------------

test('the host is told to send the headers a page like this needs', () => {
  const config = JSON.parse(fs.readFileSync(path.join(web, 'vercel.json'), 'utf8'));
  const all = config.headers.find(h => h.source === '/(.*)');
  assert.ok(all, 'headers for every path');
  const h = Object.fromEntries(all.headers.map(x => [x.key.toLowerCase(), x.value]));
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.match(h['strict-transport-security'], /max-age=\d{7,}/);
  assert.match(h['permissions-policy'], /camera=\(\)/);
  assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(h['content-security-policy'], /unsafe-inline|unsafe-eval|\*/);
  assert.match(h['x-robots-tag'], /noindex/);
  const page = config.headers.find(x => /index|^\/$/.test(x.source));
  assert.ok(page && page.headers.some(x => x.key.toLowerCase() === 'cache-control' && /no-store/.test(x.value)), 'the page itself is never cached');
  assert.equal(config.outputDirectory ?? 'dist', 'dist');
});

test('the entry point imports the stylesheet, which is what the unit tests cannot see', () => {
  const main = fs.readFileSync(path.join(web, 'src', 'main.jsx'), 'utf8');
  assert.match(main, /import\s+['"]\.\/styles\.css['"]/);
});

test('the page sets light or dark from the viewer\'s system without an inline script, as the operator console does', () => {
  const main = fs.readFileSync(path.join(web, 'src', 'main.jsx'), 'utf8');
  assert.match(main, /prefers-color-scheme: dark/);
});
