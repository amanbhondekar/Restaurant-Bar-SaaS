import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Notice, TextInput } from '@/admin/ui';
import { Frame } from './parts';

// The screens before anyone is let in: a password, then a second factor (set up the first time, answered after that), or a plain "this is not for
// you". Whatever is typed here is held in this component only, and goes to Supabase and nowhere else. Anything unexpected is said in a sentence;
// the text of an error that was not written for a person is never shown.

const GENERIC = 'Something went wrong. Try again in a moment.';
const wordsFor = error => (error?.kind && typeof error.message === 'string' ? error.message : GENERIC);

export function SignInScreen({ onSubmit, notice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  const submit = async event => {
    event.preventDefault();
    if (working.current || !email.trim() || !password) return;
    working.current = true;
    setBusy(true);
    setProblem('');
    try {
      await onSubmit(email.trim(), password);
    } catch (error) {
      setProblem(wordsFor(error));
      setPassword('');
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <Frame title="Sign in to the admin console">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        {notice && !problem && <Notice tone="info">{notice}</Notice>}
        {problem && <Notice tone="error">{problem}</Notice>}
        <Field label="Email" htmlFor="admin-email">
          <TextInput id="admin-email" type="email" autoComplete="username" autoCapitalize="off" spellCheck={false} value={email} onChange={e => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="admin-password">
          <TextInput id="admin-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" className="h-10" disabled={busy || !email.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </Frame>
  );
}

function CodeField({ value, onChange }) {
  return (
    <Field label="6-digit code" htmlFor="admin-code">
      <TextInput
        id="admin-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={7}
        value={value}
        onChange={e => onChange(e.target.value)}
        required
      />
    </Field>
  );
}

const sixDigits = text => /^\d{6}$/.test(String(text).replace(/\s+/g, ''));

export function EnrolScreen({ email, onStart, onConfirm, onSignOut }) {
  const [factor, setFactor] = useState(null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const live = useRef(true);

  const start = async () => {
    setFactor(null);
    setCode('');
    setProblem('');
    try {
      const made = await onStart();
      if (live.current) setFactor(made);
    } catch (error) {
      if (live.current) setProblem(wordsFor(error));
    }
  };

  useEffect(() => {
    live.current = true;
    if (!started.current) { started.current = true; start(); }
    return () => { live.current = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async event => {
    event.preventDefault();
    if (busy || !factor) return;
    if (!sixDigits(code)) { setProblem('Enter the 6 digits your authenticator app shows.'); return; }
    setBusy(true);
    setProblem('');
    try {
      await onConfirm(factor.factorId, code.replace(/\s+/g, ''));
    } catch (error) {
      if (live.current) { setProblem(wordsFor(error)); setCode(''); }
    } finally {
      if (live.current) setBusy(false);
    }
  };

  // The picture comes from Supabase as a data: image; anything else is not drawn, and the key is still there to type.
  const drawable = factor && typeof factor.qr === 'string' && /^data:image\//.test(factor.qr);

  return (
    <Frame title="Set up your second factor">
      <p className="text-sm text-muted-foreground">Signed in as <span className="font-medium text-foreground">{email}</span>. The console needs a code from an authenticator app each time you sign in.</p>
      {problem && <Notice tone="error">{problem}</Notice>}
      {factor && (
        <form className="flex flex-col gap-3" onSubmit={confirm}>
          <p className="text-sm">Scan this with your authenticator app, then enter the 6 digits it shows.</p>
          {drawable && <img src={factor.qr} alt="QR code for your authenticator app" className="mx-auto size-44 rounded-lg border border-border bg-white p-2" />}
          <div className="text-sm">
            <p className="text-muted-foreground">Or type this setup key into the app</p>
            <code className="break-all font-mono text-sm">{factor.secret}</code>
          </div>
          <CodeField value={code} onChange={setCode} />
          <Button type="submit" className="h-10" disabled={busy}>{busy ? 'Checking…' : 'Confirm and continue'}</Button>
        </form>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-9" onClick={start} disabled={busy}>Start again</Button>
        <Button type="button" variant="outline" className="h-9" onClick={onSignOut}>Sign out</Button>
      </div>
    </Frame>
  );
}

export function ChallengeScreen({ email, onVerify, onSignOut }) {
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  const verify = async event => {
    event.preventDefault();
    if (working.current) return;
    if (!sixDigits(code)) { setProblem('Enter the 6 digits your authenticator app shows.'); return; }
    working.current = true;
    setBusy(true);
    setProblem('');
    try {
      await onVerify(code.replace(/\s+/g, ''));
    } catch (error) {
      setProblem(wordsFor(error));
      setCode('');
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <Frame title="Enter your code">
      <p className="text-sm text-muted-foreground">Signed in as <span className="font-medium text-foreground">{email}</span>. Enter the code your authenticator app shows.</p>
      <form className="flex flex-col gap-3" onSubmit={verify}>
        {problem && <Notice tone="error">{problem}</Notice>}
        <CodeField value={code} onChange={setCode} />
        <Button type="submit" className="h-10" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</Button>
      </form>
      <div>
        <Button type="button" variant="outline" className="h-9" onClick={onSignOut}>Sign out</Button>
      </div>
    </Frame>
  );
}

export function NotAdminScreen({ email, onSignOut }) {
  return (
    <Frame title="This account is not an administrator">
      <p className="text-sm text-muted-foreground">
        You are signed in as <span className="font-medium text-foreground">{email}</span>, but this account is not on the list of administrators, so nothing here is available to it.
        If it should be, ask one of the founders.
      </p>
      <div>
        <Button type="button" variant="outline" className="h-9" onClick={onSignOut}>Sign out</Button>
      </div>
    </Frame>
  );
}
