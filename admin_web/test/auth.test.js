import { describe, expect, it, vi } from 'vitest';

import { AuthError, createAuth, createAuthClient } from '../src/lib/auth.js';

// How the console's page signs a founder in with Supabase Auth, and gets a second factor out of them. The Supabase client is a fake shaped like the
// real one; what is checked is which of its calls are made, in what order, what each failure is called, and that the session lives in memory only.

const SESSION = { access_token: 'access-1', user: { id: 'u1', email: 'aman@example.test' } };

function fakeClient(over = {}) {
  const calls = [];
  const log = name => (...args) => { calls.push([name, ...args]); };
  const state = {
    session: SESSION,
    aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
    factors: { all: [], totp: [] },
    ...over
  };
  const listeners = [];
  const client = {
    calls,
    emit: (event, session) => listeners.forEach(l => l(event, session)),
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      signInWithPassword: async args => {
        log('signInWithPassword')(args);
        if (state.signInError) return { data: { session: null }, error: state.signInError };
        state.session = SESSION;
        return { data: { session: SESSION }, error: null };
      },
      signOut: async () => { log('signOut')(); state.session = null; if (state.signOutThrows) throw new Error('offline'); return { error: state.signOutError ?? null }; },
      onAuthStateChange: cb => { listeners.push(cb); return { data: { subscription: { unsubscribe: () => listeners.splice(listeners.indexOf(cb), 1) } } }; },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: state.aal, error: state.aalError ?? null }),
        listFactors: async () => ({ data: state.factors, error: state.factorsError ?? null }),
        enroll: async args => {
          log('enroll')(args);
          if (state.enrollError) return { data: null, error: state.enrollError };
          return { data: { id: 'factor-new', type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } }, error: null };
        },
        unenroll: async args => { log('unenroll')(args); return { data: {}, error: null }; },
        challengeAndVerify: async args => {
          log('challengeAndVerify')(args);
          if (state.verifyError) return { data: null, error: state.verifyError };
          state.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
          return { data: {}, error: null };
        }
      }
    }
  };
  return client;
}

describe('where a person is in signing in', () => {
  it('is signed out with no session', async () => {
    const auth = createAuth(fakeClient({ session: null }));
    expect(await auth.state()).toEqual({ status: 'signed_out' });
  });

  it('has to set up a second factor when there is none', async () => {
    const auth = createAuth(fakeClient({ aal: { currentLevel: 'aal1', nextLevel: 'aal1' } }));
    expect(await auth.state()).toEqual({ status: 'needs_enrolment', email: 'aman@example.test' });
  });

  it('has to answer the second factor they already have', async () => {
    const auth = createAuth(fakeClient({
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      factors: { all: [{ id: 'f-old', factor_type: 'totp', status: 'verified' }], totp: [{ id: 'f-old', factor_type: 'totp', status: 'verified' }] }
    }));
    expect(await auth.state()).toEqual({ status: 'needs_challenge', email: 'aman@example.test', factorId: 'f-old' });
  });

  it('is ready only at the second level', async () => {
    const auth = createAuth(fakeClient({ aal: { currentLevel: 'aal2', nextLevel: 'aal2' } }));
    expect(await auth.state()).toEqual({ status: 'ready', email: 'aman@example.test' });
  });

  it('is never "ready" on a first-factor session, however it got there', async () => {
    for (const aal of [{ currentLevel: 'aal1', nextLevel: 'aal2' }, { currentLevel: 'aal1', nextLevel: 'aal1' }, { currentLevel: null, nextLevel: null }]) {
      const auth = createAuth(fakeClient({ aal, factors: { all: [], totp: [{ id: 'f', status: 'verified' }] } }));
      expect((await auth.state()).status).not.toBe('ready');
    }
  });

  it('treats a level it cannot read as signed out rather than guessing', async () => {
    const auth = createAuth(fakeClient({ aalError: { message: 'boom' } }));
    expect((await auth.state()).status).toBe('signed_out');
    const auth2 = createAuth(fakeClient({ aal: null }));
    expect((await auth2.state()).status).toBe('signed_out');
  });

  it('has to set up a factor, not answer one, when the project says no second level is waiting', async () => {
    const auth = createAuth(fakeClient({ aal: { currentLevel: 'aal1', nextLevel: 'aal1' }, factors: { all: [], totp: [{ id: 'f', status: 'verified' }] } }));
    expect((await auth.state()).status).toBe('needs_enrolment');
  });

  it('has to set up a factor when a second level is waiting but there is no verified factor to answer', async () => {
    const auth = createAuth(fakeClient({ aal: { currentLevel: 'aal1', nextLevel: 'aal2' }, factors: { all: [], totp: [{ id: 'half', status: 'unverified' }] } }));
    expect(await auth.state()).toEqual({ status: 'needs_enrolment', email: 'aman@example.test' });
    const none = createAuth(fakeClient({ aal: { currentLevel: 'aal1', nextLevel: 'aal2' }, factors: { all: [], totp: [] } }));
    expect((await none.state()).status).toBe('needs_enrolment');
  });

  it('picks the verified factor, not an abandoned one', async () => {
    const auth = createAuth(fakeClient({
      aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
      factors: { all: [], totp: [{ id: 'f-half', status: 'unverified' }, { id: 'f-verified', status: 'verified' }] }
    }));
    expect((await auth.state()).factorId).toBe('f-verified');
  });
});

describe('signing in with a password', () => {
  it('sends exactly the email and the password, the email trimmed', async () => {
    const client = fakeClient({ session: null });
    const auth = createAuth(client);
    await auth.signIn('  aman@example.test ', 'correct horse');
    expect(client.calls[0]).toEqual(['signInWithPassword', { email: 'aman@example.test', password: 'correct horse' }]);
  });

  it('returns where they have got to', async () => {
    const auth = createAuth(fakeClient({ session: null }));
    expect((await auth.signIn('a@b.test', 'pw')).status).toBe('needs_enrolment');
  });

  it('says the same thing whether the email or the password was wrong', async () => {
    const wrong = { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' };
    const unknown = { status: 400, code: 'user_not_found', message: 'User not found' };
    const messages = [];
    for (const signInError of [wrong, unknown, { status: 400, message: 'Email not confirmed' }]) {
      const e = await createAuth(fakeClient({ session: null, signInError })).signIn('a@b.test', 'pw').catch(x => x);
      expect(e).toBeInstanceOf(AuthError);
      expect(e.kind).toBe('credentials');
      messages.push(e.message);
    }
    expect(new Set(messages).size).toBe(1);
  });

  it('calls every refusal a wrong password, whatever status the service gives it', async () => {
    for (const status of [400, 401, 403, 422]) {
      const e = await createAuth(fakeClient({ session: null, signInError: { status, message: 'no' } })).signIn('a@b.test', 'pw').catch(x => x);
      expect(e.kind, String(status)).toBe('credentials');
    }
  });

  it('names a rate limit and a lost connection for what they are', async () => {
    const limited = await createAuth(fakeClient({ session: null, signInError: { status: 429, message: 'Too many requests' } })).signIn('a@b.test', 'pw').catch(x => x);
    expect(limited.kind).toBe('locked');
    const offline = await createAuth(fakeClient({ session: null, signInError: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } })).signIn('a@b.test', 'pw').catch(x => x);
    expect(offline.kind).toBe('offline');
    const odd = await createAuth(fakeClient({ session: null, signInError: { status: 500, message: 'database exploded with stack trace' } })).signIn('a@b.test', 'pw').catch(x => x);
    expect(odd.kind).toBe('other');
    expect(odd.message).not.toMatch(/exploded|stack/);
  });

  it('does not call Supabase at all for an empty email or password', async () => {
    const client = fakeClient({ session: null });
    const auth = createAuth(client);
    await expect(auth.signIn('', 'pw')).rejects.toMatchObject({ kind: 'credentials' });
    await expect(auth.signIn('a@b.test', '')).rejects.toMatchObject({ kind: 'credentials' });
    expect(client.calls).toEqual([]);
  });
});

describe('setting up a second factor', () => {
  it('clears out an abandoned attempt first, then enrols a fresh one and hands back what to show', async () => {
    const client = fakeClient({ factors: { all: [{ id: 'half', factor_type: 'totp', status: 'unverified' }, { id: 'done', factor_type: 'totp', status: 'verified' }], totp: [{ id: 'done', status: 'verified' }] } });
    const out = await createAuth(client).startEnrolment();
    expect(client.calls[0]).toEqual(['unenroll', { factorId: 'half' }]);
    expect(client.calls.some(c => c[0] === 'unenroll' && c[1].factorId === 'done')).toBe(false);
    expect(client.calls[1][0]).toBe('enroll');
    expect(client.calls[1][1]).toMatchObject({ factorType: 'totp' });
    expect(client.calls[1][1].friendlyName).toMatch(/\S/);
    expect(out).toEqual({ factorId: 'factor-new', qr: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXP' });
  });

  it('reports a failure to start as one, not as a half-made factor', async () => {
    const e = await createAuth(fakeClient({ enrollError: { message: 'internal detail' } })).startEnrolment().catch(x => x);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).not.toMatch(/internal/);
  });

  it('confirms the first code and arrives at the second level', async () => {
    const client = fakeClient();
    const auth = createAuth(client);
    const state = await auth.verifyEnrolment('factor-new', '123456');
    expect(client.calls[0]).toEqual(['challengeAndVerify', { factorId: 'factor-new', code: '123456' }]);
    expect(state).toEqual({ status: 'ready', email: 'aman@example.test' });
  });

  it('answers a challenge the same way', async () => {
    const client = fakeClient({ aal: { currentLevel: 'aal1', nextLevel: 'aal2' }, factors: { all: [], totp: [{ id: 'f1', status: 'verified' }] } });
    const state = await createAuth(client).challenge('f1', '654321');
    expect(client.calls[0]).toEqual(['challengeAndVerify', { factorId: 'f1', code: '654321' }]);
    expect(state).toEqual({ status: 'ready', email: 'aman@example.test' });
  });

  it('calls every refusal of a code a wrong code, whatever status the service gives it', async () => {
    for (const status of [400, 401, 403, 422]) {
      const e = await createAuth(fakeClient({ verifyError: { status, message: 'no' } })).challenge('f', '000000').catch(x => x);
      expect(e.kind, String(status)).toBe('code');
    }
    const other = await createAuth(fakeClient({ verifyError: { status: 500, message: 'broke' } })).challenge('f', '000000').catch(x => x);
    expect(other.kind).toBe('other');
  });

  it('calls a wrong code a wrong code, and a lost connection a lost connection', async () => {
    const wrong = await createAuth(fakeClient({ verifyError: { status: 400, code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' } })).challenge('f', '000000').catch(x => x);
    expect(wrong.kind).toBe('code');
    const limited = await createAuth(fakeClient({ verifyError: { status: 429, message: 'rate limit' } })).challenge('f', '000000').catch(x => x);
    expect(limited.kind).toBe('locked');
    const offline = await createAuth(fakeClient({ verifyError: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } })).challenge('f', '000000').catch(x => x);
    expect(offline.kind).toBe('offline');
  });

  it('does not send a code that cannot be one', async () => {
    const client = fakeClient();
    const auth = createAuth(client);
    for (const code of ['', '12345', '1234567', 'abcdef', '12 3456x']) await expect(auth.challenge('f', code)).rejects.toMatchObject({ kind: 'code' });
    expect(client.calls).toEqual([]);
  });

  it('accepts a code written with a space in the middle, as authenticator apps show it', async () => {
    const client = fakeClient();
    await createAuth(client).challenge('f', '123 456');
    expect(client.calls[0][1].code).toBe('123456');
  });
});

describe('the session', () => {
  it('hands out the current access token, and says so when there is none', async () => {
    expect(await createAuth(fakeClient()).token()).toBe('access-1');
    await expect(createAuth(fakeClient({ session: null })).token()).rejects.toMatchObject({ kind: 'signed_out' });
  });

  it('signs out, and a failure to say so to the server still ends the session here', async () => {
    const client = fakeClient();
    await createAuth(client).signOut();
    expect(client.calls[0][0]).toBe('signOut');
    const failing = fakeClient({ signOutError: { message: 'offline' } });
    await expect(createAuth(failing).signOut()).resolves.toBeUndefined();
    const throwing = fakeClient({ signOutThrows: true });
    await expect(createAuth(throwing).signOut()).resolves.toBeUndefined();
  });

  it('tells the page when the session ends somewhere else, and stops when asked', async () => {
    const client = fakeClient();
    const seen = [];
    const stop = createAuth(client).onChange(s => seen.push(s));
    client.emit('TOKEN_REFRESHED', SESSION);
    client.emit('SIGNED_IN', SESSION);
    expect(seen).toEqual([]);
    client.emit('SIGNED_OUT', null);
    expect(seen).toEqual([{ status: 'signed_out' }]);
    stop();
    client.emit('SIGNED_OUT', null);
    expect(seen).toHaveLength(1);
  });
});

describe('the real client', () => {
  it('is made to keep nothing: no stored session, no address parsing, and the project\'s own address and public key', () => {
    const createClientImpl = vi.fn(() => ({ auth: {} }));
    createAuthClient({ supabaseUrl: 'https://abc.supabase.co', anonKey: 'anon-public-key' }, createClientImpl);
    const [url, key, options] = createClientImpl.mock.calls[0];
    expect([url, key]).toEqual(['https://abc.supabase.co', 'anon-public-key']);
    expect(options.auth).toMatchObject({ persistSession: false, autoRefreshToken: true, detectSessionInUrl: false });
    expect(options.auth.storage).toBeUndefined();
  });

  it('writes nothing to the browser\'s storage or cookies, checked against the real library', async () => {
    const client = createAuthClient({ supabaseUrl: 'https://abc.supabase.co', anonKey: 'anon-public-key' });
    try {
      const before = [localStorage.length, sessionStorage.length, document.cookie];
      await client.auth.getSession();
      await client.auth.signOut().catch(() => {});
      expect([localStorage.length, sessionStorage.length, document.cookie]).toEqual(before);
      expect(localStorage.length).toBe(0);
    } finally {
      // The real client starts a token-refresh timer; left running it fires after this file's browser is gone.
      await client.auth.stopAutoRefresh();
    }
  });
});
