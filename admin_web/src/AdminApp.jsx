import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/admin/ui';
import { downloadBlob } from './lib/download';
import { Console } from './screens/Console';
import { Frame } from './screens/parts';
import { ChallengeScreen, EnrolScreen, NotAdminScreen, SignInScreen } from './screens/AuthScreens';

// The admin console's page: who is looking, what they have still to do before they may look, and, once they may, the console.
//
// Nobody sees anything until all of it is done: a password, a second factor, the API agreeing that they are an administrator, and the sign-in recorded.
// An unrecorded sign-in is not a sign-in. If the session ends anywhere, for any reason, the page returns to the beginning and says so.

const ENDED = 'Your session ended. Sign in again.';

/** After the page is sure of who this is: ask the API who they are (is it an administrator?), record the sign-in once, and only then show the console. */
function Gate({ auth, api, email, onNotAdmin, onState, onEnded, children }) {
  const [phase, setPhase] = useState({ name: 'checking' });
  const started = useRef(false);
  const live = useRef(true);

  const run = useCallback(async () => {
    setPhase({ name: 'checking' });
    try {
      const me = await api.me();
      await api.recordSession();
      if (live.current) setPhase({ name: 'in', me });
    } catch (error) {
      if (!live.current) return;
      if (error?.kind === 'not_admin') { onNotAdmin(); return; }
      if (error?.kind === 'mfa') { onState(await auth.state()); return; }
      if (error?.kind === 'denied') { await auth.signOut(); onEnded(); return; }
      setPhase({ name: 'error', error });
    }
  }, [api, auth, onNotAdmin, onState, onEnded]);

  useEffect(() => {
    live.current = true;
    if (!started.current) { started.current = true; run(); }
    return () => { live.current = false; };
  }, [run]);

  if (phase.name === 'in') return children(phase.me);
  if (phase.name === 'error') {
    return (
      <Frame title="Could not open the console">
        <Notice tone="error">{phase.error?.message ?? 'Something went wrong. Try again in a moment.'}</Notice>
        <div><Button type="button" className="h-10" onClick={run}>Try again</Button></div>
      </Frame>
    );
  }
  return (
    <Frame title="Opening the console">
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking {email}…</p>
    </Frame>
  );
}

export function AdminApp({ auth, api, clock = Date.now, pollMs = 60000, tickMs = 15000, timeZone, download = downloadBlob }) {
  const [view, setView] = useState({ status: 'loading' });
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    auth.state().then(
      state => { if (live) setView(state); },
      () => { if (live) setView({ status: 'signed_out' }); }   // if the session cannot be read, nobody is signed in
    );
    const stop = auth.onChange(state => {
      if (!live) return;
      setView(state);
      if (state.status === 'signed_out') setNotice(ENDED);
    });
    return () => { live = false; stop?.(); };
  }, [auth]);

  const signIn = useCallback(async (email, password) => {
    setView(await auth.signIn(email, password));
  }, [auth]);

  const signOut = useCallback(async () => {
    await auth.signOut();
    setNotice('');
    setView({ status: 'signed_out' });
  }, [auth]);

  const ended = useCallback(() => { setNotice(ENDED); setView({ status: 'signed_out' }); }, []);
  const leave = useCallback(async reason => {
    await auth.signOut();
    setNotice(reason || ENDED);
    setView({ status: 'signed_out' });
  }, [auth]);

  const email = view.email ?? '';
  const notAdmin = useCallback(() => setView(v => ({ status: 'not_admin', email: v.email ?? '' })), []);

  switch (view.status) {
    case 'signed_out':
      return <SignInScreen onSubmit={signIn} notice={notice} />;
    case 'needs_enrolment':
      return (
        <EnrolScreen
          email={email}
          onStart={() => auth.startEnrolment()}
          onConfirm={async (factorId, code) => setView(await auth.verifyEnrolment(factorId, code))}
          onSignOut={signOut}
        />
      );
    case 'needs_challenge':
      return <ChallengeScreen email={email} onVerify={async code => setView(await auth.challenge(view.factorId, code))} onSignOut={signOut} />;
    case 'not_admin':
      return <NotAdminScreen email={email} onSignOut={signOut} />;
    case 'ready':
      return (
        <Gate auth={auth} api={api} email={email} onNotAdmin={notAdmin} onState={setView} onEnded={ended}>
          {me => (
            <Console api={api} me={me} clock={clock} pollMs={pollMs} tickMs={tickMs} timeZone={timeZone} download={download} onSignOut={signOut} onLeave={leave} />
          )}
        </Gate>
      );
    default:
      return (
        <Frame title="Opening the console">
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking your session…</p>
        </Frame>
      );
  }
}
