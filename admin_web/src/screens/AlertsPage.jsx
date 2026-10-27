import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BellOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState, Field, NativeSelect, Notice } from '@/admin/ui';
import { Chip } from '@/ops/parts';
import { relative } from '@/ops/lib/format';
import { asOf, when } from '../lib/format';

// The alerts inbox: what is waiting for an answer, what somebody has taken on, and what is closed. Each alert names its restaurant and says what is wrong in
// words, and a person can do one of two things about it: acknowledge it ("I know", which stops the paging) or resolve it ("it is dealt with"), each with
// a reason in their own words (at least ten characters, the console's rule for every write).
//
// Everything shown is what the API sent, as text, in the order the API ranked it. A read that fails never leaves an old list looking current; a search
// that is superseded by a newer one is dropped when it arrives; a write is sent once however many times the button is tapped, and when it is refused
// the words the person typed are kept.

const ENDED = 'Your session ended. Sign in again.';
const REASON = { min: 10, max: 500 };
const FILTERS = [['active', 'Waiting and taken on'], ['open', 'Waiting'], ['acked', 'Taken on'], ['resolved', 'Closed']];
const SEVERITY = { P1: 'bad', P2: 'warning', P3: 'muted' };
const STATE = { open: ['warning', 'Waiting'], acked: ['info', 'Taken on'], resolved: ['muted', 'Closed'] };
const EMPTY = {
  active: ['Nothing needs a look', 'No alert is open right now.'],
  open: ['Nothing needs a look', 'No alert is waiting for an answer.'],
  acked: ['Nothing taken on', 'Nobody has taken an alert on.'],
  resolved: ['Nothing closed yet', 'No alert has been closed.']
};
// What the worker writes when it closes an alert because the problem went away, said as a person would.
const REASONS = { condition_cleared: 'the problem cleared on its own' };

const ACTIONS = {
  ack: {
    name: 'Acknowledge', done: 'Acknowledged', question: 'Why are you acknowledging this?',
    effect: 'Stops the paging for this alert and records who and why. It does not fix anything at the restaurant, and it does not close the alert: it closes by itself when the problem clears.'
  },
  resolve: {
    name: 'Resolve', done: 'Resolved', question: 'Why is this dealt with?',
    effect: 'Closes this alert now and records who and why. If the problem is still there, a new alert opens within a minute or so. Use Acknowledge to say you know about it instead.'
  }
};

const length = text => [...text.trim()].length;

function Paging({ alert, now }) {
  if (alert.state !== 'open') return null;
  if (alert.severity === 'P3') return <p className="text-xs text-muted-foreground">Shown here only; never sent to anyone.</p>;
  if (!alert.last_notified_at) return <p className="text-xs text-muted-foreground">Not paged yet.</p>;
  const when_ = relative(alert.last_notified_at, now);
  return (
    <p className="text-xs text-muted-foreground">
      {alert.escalation_level > 0 ? `Paged ${when_} (reminder ${alert.escalation_level} of ${alert.reminders}).` : `Paged ${when_}.`}
    </p>
  );
}

function Outcome({ alert, now }) {
  if (alert.state === 'acked') {
    return <p className="text-sm">{`Acknowledged by ${alert.acked_by_email ?? 'a founder'} ${relative(alert.acked_at, now)}: “${alert.ack_reason ?? ''}”`}</p>;
  }
  if (alert.state === 'resolved') {
    const reason = REASONS[alert.resolve_reason] ?? alert.resolve_reason ?? '';
    return <p className="text-sm">{`Closed by ${alert.resolved_by === 'person' ? 'a person' : 'the system'} ${relative(alert.resolved_at, now)}: “${reason}”`}</p>;
  }
  return null;
}

function Row({ alert, now, timeZone, acting, onAct }) {
  const [tone, label] = STATE[alert.state] ?? ['muted', alert.state];
  const where = alert.restaurant_name ?? 'a restaurant';
  return (
    <article aria-label={`${alert.what} at ${where}`} className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={SEVERITY[alert.severity] ?? 'muted'}>{alert.severity}</Chip>
        <span className="font-semibold">{alert.restaurant_name ?? 'A restaurant'}</span>
        <Chip tone={tone}>{label}</Chip>
        {alert.state === 'open' && alert.unattended_at && <Chip tone="bad">Nobody has answered</Chip>}
      </div>
      <p className="text-sm">{alert.text}</p>
      <p className="text-xs text-muted-foreground">{`Opened ${when(alert.opened_at, timeZone)} (${relative(alert.opened_at, now)})`}</p>
      <Paging alert={alert} now={now} />
      <Outcome alert={alert} now={now} />
      {alert.state !== 'resolved' && !acting && (
        <div className="flex flex-wrap gap-2 pt-1">
          {alert.state === 'open' && (
            <Button type="button" variant="outline" className="h-9" aria-label={`Acknowledge ${alert.what} at ${where}`} onClick={() => onAct(alert.id, 'ack')}>Acknowledge</Button>
          )}
          <Button type="button" variant="outline" className="h-9" aria-label={`Resolve ${alert.what} at ${where}`} onClick={() => onAct(alert.id, 'resolve')}>Resolve</Button>
        </div>
      )}
    </article>
  );
}

function ReasonForm({ alert, action, state, onChange, onSubmit, onCancel }) {
  const words = ACTIONS[action];
  const count = length(state.reason);
  const valid = count >= REASON.min && count <= REASON.max;
  const id = `reason-${alert.id}`;
  return (
    <form
      aria-label={`${words.name}: ${alert.what} at ${alert.restaurant_name ?? 'a restaurant'}`}
      onSubmit={e => { e.preventDefault(); if (valid) onSubmit(); }}
      className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/40 px-4 py-3"
    >
      <p className="text-sm text-muted-foreground">{words.effect}</p>
      <Field label={words.question} htmlFor={id} hint="At least 10 characters, in your own words.">
        <textarea
          id={id}
          autoFocus
          rows={3}
          value={state.reason}
          disabled={state.busy}
          onChange={e => onChange(e.target.value)}
          aria-invalid={count > REASON.max ? true : undefined}
          className="w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
        <span className={count > REASON.max ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {count < REASON.min ? `${count} of at least ${REASON.min}` : `${count}/${REASON.max}`}
        </span>
      </Field>
      {state.error && <Notice tone="error">{state.error.message}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-10" disabled={!valid || state.busy}>
          {state.busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{words.name}
        </Button>
        <Button type="button" variant="outline" className="h-10" disabled={state.busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function AlertsPage({ api, clock, timeZone, pollMs = 60000, nonce = 0, onLeave }) {
  const [filter, setFilter] = useState('active');
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState(null);
  const [note, setNote] = useState(null);
  const [form, setForm] = useState(null);   // { id, action, reason, busy, error }
  const generation = useRef(0);
  const reading = useRef(false);
  const sending = useRef(false);
  const live = useRef(true);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const firstNonce = useRef(nonce);
  // The latest of each, kept where reading can reach it without depending on it: a parent that hands over a new function every time it draws must not make
  // this page read again, empty its list or close a form somebody is writing in.
  const apiRef = useRef(api);
  apiRef.current = api;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const leave = useCallback(error => {
    if (error?.kind === 'denied') { onLeaveRef.current(ENDED); return true; }
    return false;
  }, []);

  const read = useCallback(async state => {
    const mine = ++generation.current;
    reading.current = true;
    try {
      const next = await apiRef.current.alerts({ state });
      if (!live.current || mine !== generation.current) return;
      setData(next);
      setProblem(null);
    } catch (error) {
      if (!live.current || mine !== generation.current || leave(error)) return;
      setProblem(error);
    } finally {
      if (mine === generation.current) reading.current = false;
    }
  }, [leave]);

  // One read at a time for the ones that come by themselves; choosing something else always starts its own and drops the one before.
  const poll = useCallback(() => { if (!reading.current) read(filterRef.current); }, [read]);

  useEffect(() => {
    setData(null); setProblem(null); setNote(null); setForm(null);
    read(filter);
  }, [filter, read]);

  useEffect(() => {
    const id = setInterval(poll, pollMs);
    return () => clearInterval(id);
  }, [poll, pollMs]);

  useEffect(() => {
    if (nonce !== firstNonce.current) { firstNonce.current = nonce; poll(); }
  }, [nonce, poll]);

  const submit = async () => {
    if (sending.current || !form) return;
    sending.current = true;
    const { id, action, reason } = form;
    setForm(f => ({ ...f, busy: true, error: null }));
    try {
      const done = await (action === 'ack' ? api.acknowledgeAlert : api.resolveAlert)(id, reason.trim());
      if (!live.current) return;
      setForm(null);
      setNote({ tone: 'info', text: done.event_id === null || done.event_id === undefined ? `${ACTIONS[action].done}. Nothing new was recorded: it already was.` : `${ACTIONS[action].done}. Recorded as event ${done.event_id}.` });
      read(filterRef.current);
    } catch (error) {
      if (!live.current || leave(error)) return;
      if (error?.kind === 'conflict' || error?.kind === 'missing') {
        // The alert changed under them: nothing was recorded, and what is true now is what the list says.
        setForm(null);
        setNote({ tone: 'warning', text: error.message });
        read(filterRef.current);
      } else {
        setForm(f => (f ? { ...f, busy: false, error } : f));
      }
    } finally {
      sending.current = false;
    }
  };

  const now = clock();
  const open = form ? data?.alerts.find(a => a.id === form.id) : null;

  let body;
  if (!data) {
    body = problem ? (
      <Notice tone="error" action={<Button variant="outline" className="h-9" onClick={() => read(filter)}>Try again</Button>}>{problem.message}</Notice>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Reading the alerts…</p>
    );
  } else {
    const counts = data.counts ?? { open: 0, acked: 0, unattended: 0 };
    const [emptyTitle, emptyText] = EMPTY[filter];
    body = (
      <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm font-medium">{asOf(data.generated_at, timeZone, now)}</p>
          {filter !== 'resolved' && (
            <>
              <p className="text-sm text-muted-foreground">{`${counts.open} waiting · ${counts.acked} taken on`}</p>
              {counts.unattended > 0 && <Chip tone="bad">{`${counts.unattended} nobody has answered`}</Chip>}
            </>
          )}
        </div>
        {problem && <Notice tone="warning" title="Could not refresh">{problem.message} What is shown below is {asOf(data.generated_at, timeZone, now)}.</Notice>}
        {data.truncated && <Notice tone="warning">There are more alerts than this page shows. The ones shown are the most urgent.</Notice>}
        {data.alerts.length === 0 ? (
          <EmptyState icon={BellOff} title={emptyTitle}>{emptyText}</EmptyState>
        ) : (
          <ul role="list" className="flex flex-col gap-3">
            {data.alerts.map(alert => (
              <li key={alert.id} className="flex flex-col gap-2">
                <Row alert={alert} now={now} timeZone={timeZone} acting={Boolean(open && open.id === alert.id)} onAct={(id, action) => setForm({ id, action, reason: '', busy: false, error: null })} />
                {open && open.id === alert.id && (
                  <ReasonForm
                    alert={alert}
                    action={form.action}
                    state={form}
                    onChange={reason => setForm(f => ({ ...f, reason }))}
                    onSubmit={submit}
                    onCancel={() => setForm(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="typography-heading-sm font-semibold">Alerts</h2>
        <Field label="Show" htmlFor="alerts-filter" className="w-56">
          <NativeSelect id="alerts-filter" value={filter} onChange={e => setFilter(e.target.value)}>
            {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect>
        </Field>
      </div>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {body}
    </div>
  );
}
