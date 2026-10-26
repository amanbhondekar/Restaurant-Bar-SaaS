import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readConfig } from './src/lib/config.js';

// The admin console's page is its own build, on its own host (invariant I10): `npm run build:admin` makes admin_web/dist, which holds the console and
// the product's fonts and nothing else. It reuses the product's design tokens and a few screens from ../src, so it looks like the same product.
//
// The build refuses to start when its three public settings are missing or unsafe, or when anything that looks like a service key is among them
// (invariant I2), and it writes a content-security policy into the page that names exactly the two places the page may talk to.

const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.resolve(here, '..', 'public', 'fonts');
// The fonts the product's stylesheet names, and no others: the console does not carry the rest of the product's public folder.
const FONTS = [
  'CabinetGrotesk-Variable.woff2', 'CabinetGrotesk-Variable.woff', 'CabinetGrotesk-Variable.ttf',
  'InstrumentSans-Variable.ttf', 'InstrumentSans-Italic-Variable.ttf',
  'JetBrainsMono-Regular.woff2', 'JetBrainsMono-Medium.woff2', 'JetBrainsMono-Bold.woff2', 'JetBrainsMono-ExtraBold.woff2'
];

function fonts() {
  return {
    name: 'admin-web-fonts',
    // While developing, the fonts are served from the product's folder.
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const name = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '');
        if (!FONTS.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'font/ttf');
        return res.end(fs.readFileSync(path.join(fontsDir, name)));
      });
    },
    generateBundle() {
      for (const name of FONTS) this.emitFile({ type: 'asset', fileName: `fonts/${name}`, source: fs.readFileSync(path.join(fontsDir, name)) });
    }
  };
}

function policy(config) {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",   // data: is for the QR code Supabase draws for the second factor
    `connect-src 'self' ${config.apiUrl} ${config.supabaseUrl}`,
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');
  return {
    name: 'admin-web-policy',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }]
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, here, 'VITE_');
  const plugins = [tailwindcss(), react(), fonts()];
  if (command === 'build') {
    const settings = readConfig(env);
    if (!settings.ok) throw new Error(`The admin console cannot be built: ${settings.problems.join(' ')}`);
    plugins.push(policy(settings.config));
  }
  return {
    root: here,
    plugins,
    publicDir: false,
    resolve: { alias: { '@': path.resolve(here, '..', 'src') } },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
    server: { port: 5174, host: true, fs: { allow: [path.resolve(here, '..')] } }
  };
});
