import { createClient } from '@supabase/supabase-js';

// How the admin console's page signs a founder in with Supabase Auth and gets a second factor out of them. The session lives in this page's memory
// and nowhere else: not storage, not a cookie, not the address (see createAuthClient). A refresh asks for the password and the code again; that is the
// price of there being nothing to steal from a tab.
//
// The page is never "ready" on a first-factor session: ready is the second level (aal2) and nothing less, and anything this module cannot read is
// "signed out", not a guess.

export class AuthError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'AuthError';
    this.kind = kind;
  }
}

const WORDS = {
  credentials: 'That email and password were not accepted.',
  code: 'That code was not accepted. Check your authenticator app and try again.',
  locked: 'Too many tries. Wait a few minutes and try again.',
  offline: 'Could not reach the sign-in service. Check your connection and try again.',
  other: 'Something went wrong. Try again in a moment.',
  signed_out: 'You are not signed in.',
  enrol: 'Could not set up a second factor. Try again in a moment.'
};
const fail = (kind, message) => new AuthError(kind, message ?? WORDS[kind]);

const isOffline = e => e?.name === 'AuthRetryableFetchError' || e?.status === 0 || /failed to fetch|network/i.test(String(e?.message ?? ''));

/** What a failure from Supabase is called. `rejected` is the kind for a refusal (a wrong password, a wrong code). */
function classify(error, rejected) {
  if (isOffline(error)) return fail('offline');
  if (error?.status === 429) return fail('locked');
  if ([400, 401, 403, 422].includes(error?.status)) return fail(rejected);
  return fail('other');
}

/** A six-digit code, written with or without a space in the middle; anything else is not one. */
const cleanCode = code => {
  const text = String(code ?? '').replace(/\s+/g, '');
  return /^\d{6}$/.test(text) ? text : null;
};

/** The client the page uses: nothing kept, nothing read from the address, the project's own public key. */
export function createAuthClient({ supabaseUrl, anonKey }, createClientImpl = createClient) {
  return createClientImpl(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false }
  });
}

export function createAuth(client) {
  const auth = client.auth;

  async function state() {
    const { data: sessionData } = await auth.getSession();
    const session = sessionData?.session;
    if (!session) return { status: 'signed_out' };
    const email = session.user?.email ?? '';

    const { data: level, error } = await auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !level) return { status: 'signed_out' };
    if (level.currentLevel === 'aal2') return { status: 'ready', email };

    const { data: factors } = await auth.mfa.listFactors();
    const verified = (factors?.totp ?? []).find(f => f.status === 'verified');
    if (level.nextLevel === 'aal2' && verified) return { status: 'needs_challenge', email, factorId: verified.id };
    return { status: 'needs_enrolment', email };
  }

  return {
    state,

    async signIn(email, password) {
      const address = String(email ?? '').trim();
      if (!address || !password) throw fail('credentials');
      const { error } = await auth.signInWithPassword({ email: address, password });
      if (error) throw classify(error, 'credentials');
      return state();
    },

    /** Makes a new factor and returns what to show: its id, the picture to scan and the key to type if scanning is not possible. */
    async startEnrolment() {
      const { data: factors } = await auth.mfa.listFactors();
      for (const factor of factors?.all ?? []) {
        if (factor.factor_type === 'totp' && factor.status === 'unverified') await auth.mfa.unenroll({ factorId: factor.id });
      }
      const { data, error } = await auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Kullina admin ${new Date().toISOString().slice(0, 10)} ${Math.random().toString(36).slice(2, 7)}`
      });
      if (error || !data?.totp) throw fail('other', WORDS.enrol);
      return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
    },

    async verifyEnrolment(factorId, code) {
      return this.challenge(factorId, code);
    },

    async challenge(factorId, code) {
      const clean = cleanCode(code);
      if (!clean) throw fail('code');
      const { error } = await auth.mfa.challengeAndVerify({ factorId, code: clean });
      if (error) throw classify(error, 'code');
      return state();
    },

    async token() {
      const { data } = await auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw fail('signed_out');
      return token;
    },

    /** Ends the session here even if the server could not be told. */
    async signOut() {
      try { await auth.signOut(); } catch { /* the session is gone from this page either way */ }
    },

    /** Tells the page when the session ends somewhere else. Returns the way to stop listening. */
    onChange(callback) {
      const { data } = auth.onAuthStateChange(event => {
        if (event === 'SIGNED_OUT') callback({ status: 'signed_out' });
      });
      return () => data.subscription.unsubscribe();
    }
  };
}
