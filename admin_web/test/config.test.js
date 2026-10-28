import { describe, expect, it } from 'vitest';

import { readConfig } from '../src/lib/config.js';
import { asOf, when, plainRequestId } from '../src/lib/format.js';

// What the page is built with, and how it says when something was read.

const jwt = role => `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ role })).replace(/=+$/, '')}.sig`;
const good = (over = {}) => ({
  VITE_ADMIN_API_URL: 'https://admin-api.kullina.example',
  VITE_SUPABASE_URL: 'https://abc.supabase.co',
  VITE_SUPABASE_ANON_KEY: jwt('anon'),
  ...over
});

describe('the page\'s configuration', () => {
  it('reads the three public settings and tidies the addresses', () => {
    const r = readConfig(good({ VITE_ADMIN_API_URL: 'https://admin-api.kullina.example/', VITE_SUPABASE_URL: 'https://abc.supabase.co/' }));
    expect(r.problems).toEqual([]);
    expect(r.config).toEqual({ apiUrl: 'https://admin-api.kullina.example', supabaseUrl: 'https://abc.supabase.co', anonKey: jwt('anon') });
  });

  it('is not ready if any of them is missing, and says which', () => {
    for (const name of ['VITE_ADMIN_API_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
      const r = readConfig(good({ [name]: '' }));
      expect(r.ok).toBe(false);
      expect(r.problems.join(' ')).toContain(name);
      expect(r.problems.join(' ')).toMatch(/is not set/);
      expect(r.config).toBeUndefined();
    }
  });

  it('wants https for both addresses, except the API on this machine', () => {
    expect(readConfig(good({ VITE_ADMIN_API_URL: 'http://admin-api.kullina.example' })).ok).toBe(false);
    expect(readConfig(good({ VITE_SUPABASE_URL: 'http://abc.supabase.co' })).ok).toBe(false);
    expect(readConfig(good({ VITE_ADMIN_API_URL: 'http://localhost:4600' })).ok).toBe(true);
    expect(readConfig(good({ VITE_ADMIN_API_URL: 'javascript:alert(1)' })).ok).toBe(false);
    expect(readConfig(good({ VITE_ADMIN_API_URL: 'not a url' })).ok).toBe(false);
  });

  it('wants addresses with no path, no query and no credentials in them', () => {
    for (const bad of ['https://admin-api.kullina.example/app', 'https://admin-api.kullina.example?x=1', 'https://user:pw@admin-api.kullina.example']) {
      expect(readConfig(good({ VITE_ADMIN_API_URL: bad })).ok, bad).toBe(false);
    }
  });

  it('(I2) refuses a service key in the one place a browser can see it, by what the key says it is', () => {
    const r = readConfig(good({ VITE_SUPABASE_ANON_KEY: jwt('service_role') }));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/service/i);
    expect(JSON.stringify(r)).not.toContain(jwt('service_role'));
  });

  it('refuses a service key given another name, and any variable that looks like one', () => {
    expect(readConfig(good({ VITE_SUPABASE_SERVICE_ROLE_KEY: 'whatever' })).ok).toBe(false);
    expect(readConfig(good({ VITE_SERVICE_KEY: 'whatever' })).ok).toBe(false);
    expect(readConfig(good({ VITE_SOMETHING: jwt('service_role') })).ok).toBe(false);
    expect(readConfig(good({ VITE_SOMETHING: jwt('anon') })).ok).toBe(true);
  });

  it('does not count a setting that is empty, whatever it is called', () => {
    expect(readConfig(good({ VITE_SUPABASE_SERVICE_ROLE_KEY: '', VITE_SERVICE_KEY: '   ' })).ok).toBe(true);
  });

  it('reads the role in a token written the web way, with - and _ in it', () => {
    const payload = Buffer.from('{"role":"service_role","pad":"??>>??>>~~"}').toString('base64url');
    expect(payload).toMatch(/[-_]/);
    const token = `${btoa('{"alg":"HS256"}')}.${payload}.sig`;
    expect(readConfig(good({ VITE_SUPABASE_ANON_KEY: token })).ok).toBe(false);
  });

  it('never repeats a key in a problem', () => {
    const r = readConfig(good({ VITE_SUPABASE_ANON_KEY: '', VITE_ADMIN_API_URL: 'https://user:hunter2@x.example' }));
    expect(JSON.stringify(r)).not.toMatch(/hunter2/);
  });
});

describe('how a time is said', () => {
  it('says "as of" with the time of day in the viewer\'s zone', () => {
    expect(asOf('2026-10-26T10:02:00.000Z', 'UTC')).toBe('as of 10:02');
    expect(asOf('2026-10-26T10:02:00.000Z', 'Asia/Kolkata')).toBe('as of 15:32');
  });

  it('adds the day when it is not today, so an old reading is not mistaken for a recent one', () => {
    const now = Date.parse('2026-10-26T12:00:00.000Z');
    expect(asOf('2026-10-26T10:02:00.000Z', 'UTC', now)).toBe('as of 10:02');
    expect(asOf('2026-10-24T10:02:00.000Z', 'UTC', now)).toBe('as of 24 Oct, 10:02');
  });

  it('says when it does not know, rather than showing a time that never was', () => {
    for (const bad of [null, undefined, '', 'yesterday', 5, {}]) expect(asOf(bad, 'UTC')).toBe('time not known');
  });

  it('writes the time of an event with its date, to the minute', () => {
    expect(when('2026-10-26T10:02:45.000Z', 'UTC')).toBe('26 Oct 2026, 10:02');
    expect(when(null, 'UTC')).toBe('—');
  });

  it('keeps only a short, plain request id for display', () => {
    expect(plainRequestId('3f2b8c1e-aaaa-bbbb-cccc-1234567890ab')).toBe('3f2b8c1e');
    expect(plainRequestId('req-42')).toBe('req-42');
    expect(plainRequestId(null)).toBe('—');
    expect(plainRequestId('')).toBe('—');
    for (const unsafe of ['has space', '<script>', 'a/b', 'x;y']) expect(plainRequestId(unsafe)).toBe('—');
  });
});
