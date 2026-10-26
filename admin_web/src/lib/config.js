// What the admin console's page is built with, and what it will refuse to be built with. Three PUBLIC settings: where the admin API is, where the
// Supabase project is, and that project's public (anon) key. Nothing secret belongs in a browser, so a service key in any of them, by name or by what
// the value says it is, stops the build and stops the page (invariant I2). A problem names the setting, never its value.

const SERVICE_NAME = /SERVICE[_-]?(ROLE)?[_-]?KEY|SERVICE_ROLE/i;

/** The role a JWT-shaped value claims, or null if it is not one. Not a check of the signature: only of what it says it is. */
function claimedRole(value) {
  const parts = typeof value === 'string' ? value.trim().split('.') : [];
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const role = JSON.parse(json)?.role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

/** Names of settings that hold a service key. */
function serviceKeysIn(env) {
  const found = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    if (SERVICE_NAME.test(name) || claimedRole(value) === 'service_role') found.push(name);
  }
  return found;
}

/** An address with no path, query or credentials, as its origin: https, or http for this machine only when `localOk`. */
function origin(name, value, { localOk }, problems) {
  if (!value) { problems.push(`${name} is not set.`); return null; }
  let url;
  try { url = new URL(value); } catch { problems.push(`${name} is not an address.`); return null; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local && localOk))) {
    problems.push(`${name} must be an https address.`);
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    problems.push(`${name} must be an address with no path, query or credentials in it.`);
    return null;
  }
  return url.origin;
}

/** Reads the build settings (`import.meta.env`, or any object). `ok` is false when anything is wrong; `config` is only there when it is ok. */
export function readConfig(env) {
  const problems = [];
  const get = name => String(env?.[name] ?? '').trim();

  const apiUrl = origin('VITE_ADMIN_API_URL', get('VITE_ADMIN_API_URL'), { localOk: true }, problems);
  const supabaseUrl = origin('VITE_SUPABASE_URL', get('VITE_SUPABASE_URL'), { localOk: true }, problems);
  const anonKey = get('VITE_SUPABASE_ANON_KEY');
  if (!anonKey) problems.push('VITE_SUPABASE_ANON_KEY is not set.');

  for (const name of serviceKeysIn(env ?? {})) {
    problems.push(`${name} holds a Supabase service key. A browser must never be given one (invariant I2); remove it.`);
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, problems: [], config: { apiUrl, supabaseUrl, anonKey } };
}
