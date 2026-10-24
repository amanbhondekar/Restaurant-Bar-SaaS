import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/admin/ui';
import { Shell } from './parts';

// The console's one way in: its token. It is kept in memory by the app and nowhere else: not in storage, not in an address. A browser is asked
// not to remember it (`autocomplete="off"`), and a refresh asks for it again; that is the price of there being nothing to steal from a tab.

export function SignIn({ onSubmit, notice }) {
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async event => {
    event.preventDefault();
    if (busy || !token.trim()) return;
    setBusy(true);
    setProblem('');
    try {
      await onSubmit(token.trim());
    } catch (error) {
      setProblem(error?.message || 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  const shown = problem || notice;
  return (
    <Shell>
      <form className="mx-auto flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-card px-5 py-6" onSubmit={submit}>
        <h2 className="typography-heading-sm font-semibold">Sign in</h2>
        <p className="text-sm text-muted-foreground">A read-only view of every restaurant. It needs the console token that was set where the operator service runs.</p>
        <Field label="Console token" htmlFor="ops-token" error={shown ? <span role="alert">{shown}</span> : undefined}>
          <TextInput
            id="ops-token"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={token}
            onChange={e => setToken(e.target.value)}
            invalid={Boolean(shown)}
            required
          />
        </Field>
        <Button type="submit" className="h-10" disabled={busy || !token.trim()}>{busy ? 'Opening…' : 'Open console'}</Button>
      </form>
    </Shell>
  );
}
