import React, { useCallback, useEffect, useState } from 'react';
import { Gift, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { explainError, hubGet, hubSend } from './api';
import { Field, Notice, TextInput } from './ui';
import { checkReward, ordinal } from './lib/bookings';

// The restaurant's own rule for rewarding a guest who comes back (§4.5).
//
// The product chooses nothing. How generous to be is a commercial decision, so this is off until the owner says "every Nth visit,
// <what the guest gets>". The hub then does the remembering: the Bookings tab says on a guest's Nth visit that it is one, and
// records that the reward was given. It does not touch the bill, and there are no points or tiers: applying the reward is a
// person's job, because the product does not know what a dessert costs.

export function RewardsPanel({ notify, onChange }) {
  const [state, setState] = useState(null);       // what the hub says the rule is
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ every_n_visits: '', text: '' });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);

  const load = useCallback(async () => {
    try {
      setState(await hubGet('/admin/rewards'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error && !state) return <Notice tone="error" title="Could not load the rewards">{explainError(error)}</Notice>;
  if (!state) return null;

  const check = checkReward(form, state.limits);
  const set = key => e => { setForm(f => ({ ...f, [key]: e.target.value })); setTouched(true); };
  const showForm = !state.enabled || editing;

  const save = async () => {
    setBusy(true);
    setServerError(null);
    try {
      const body = { every_n_visits: Number(form.every_n_visits), text: form.text.trim() };
      const saved = await hubSend('PUT', '/admin/rewards', body);
      notify(`Reward turned on: every ${ordinal(saved.every_n_visits)} visit, ${saved.text}.`);
      setEditing(false);
      setTouched(false);
      await load();
      onChange?.();
    } catch (e) {
      setServerError(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      await hubSend('PUT', '/admin/rewards', { enabled: false });
      notify('Rewards turned off.');
      await load();
      onChange?.();
    } catch (e) {
      notify(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="rewards-h">
      <div className="flex items-center gap-2">
        <Gift className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="rewards-h" className="typography-title-md">Rewards</h2>
      </div>

      {!showForm ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-semibold">Every {ordinal(state.every_n_visits)} visit: {state.text}</p>
          <div className="flex gap-2">
            <Button variant="outline" className="h-9" disabled={busy} onClick={() => { setForm({ every_n_visits: String(state.every_n_visits), text: state.text }); setTouched(false); setEditing(true); }}>Change</Button>
            <Button variant="outline" className="h-9" disabled={busy} onClick={turnOff}>Turn off</Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (check.ok && !busy) save(); }}>
          {!state.enabled && (
            <p className="text-sm text-muted-foreground">
              No reward is set up. You choose the rule: how many visits, and what the guest gets. On that visit the Bookings tab tells the
              host, and records that it was given. You apply it on the bill; nothing is taken off automatically.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label="Every … visits" htmlFor="rw-n" error={touched ? check.errors.every_n_visits : undefined} hint="2 to 50.">
              <TextInput id="rw-n" inputMode="numeric" value={form.every_n_visits} onChange={set('every_n_visits')} invalid={Boolean(touched && check.errors.every_n_visits)} />
            </Field>
            <Field label="The guest gets" htmlFor="rw-text" error={touched ? check.errors.text : undefined} hint="For example: a free dessert, or 10% off the bill.">
              <TextInput id="rw-text" value={form.text} onChange={set('text')} maxLength={(state.limits?.max_text ?? 80) + 20} invalid={Boolean(touched && check.errors.text)} />
            </Field>
          </div>
          {serverError && <Notice tone="error">{serverError}</Notice>}
          <div className="flex gap-2">
            <Button type="submit" className="h-10" disabled={!check.ok || busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{state.enabled ? 'Save' : 'Turn on'}
            </Button>
            {editing && <Button type="button" variant="outline" className="h-10" disabled={busy} onClick={() => { setEditing(false); setServerError(null); }}>Cancel</Button>}
          </div>
        </form>
      )}
    </section>
  );
}
