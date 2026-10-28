import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState, Field, NativeSelect, Notice } from '@/admin/ui';
import { Chip } from '@/ops/parts';
import { describeEvent } from '../../../common/eventWords.js';
import { asOf, dayHeading, timeOf } from '../lib/format';

// One restaurant's timeline: what happened to it, in words, newest first, grouped by day. It is the spine's history of that restaurant (the same events as
// the audit log, said for a person), filtered by kind in the database, paged back in time, and read again as it changes.
//
// Everything shown is what the API sent, as text. A read that fails never leaves an old list looking current; an answer to an older question is dropped
// when it arrives; going back in time never shows an event twice and never loses the ones above; and a parent that hands this a new function each time
// it draws does not make it read again.

const ENDED = 'Your session ended. Sign in again.';
const FILTERS = [['', 'Everything'], ['billing', 'Billing'], ['hub', 'Hub'], ['alerts', 'Alerts'], ['admin', 'Admin actions']];
const KINDS = { billing: ['info', 'Billing'], hub: ['muted', 'Hub'], alerts: ['warning', 'Alerts'], admin: ['good', 'Admin'], other: ['muted', 'Other'] };
const EMPTY = {
  '': 'Nothing has happened to this restaurant yet.',
  billing: 'No billing events.', hub: 'No hub events.', alerts: 'No alert events.', admin: 'No admin actions.'
};

const filtersOf = (kind, extra = {}) => ({ ...(kind ? { kind } : {}), ...extra });
const fromPage = page => ({ events: page.events, nextBefore: page.next_before ?? null, generatedAt: page.generated_at });

/** What a read of the newest events adds to what is shown: the events above it, with what was loaded further back kept; unless a gap would be left. */
function withNewest(shown, page) {
  const topId = shown.events.reduce((top, e) => Math.max(top, e.id), 0);
  const oldest = page.events.length ? page.events[page.events.length - 1].id : null;
  if (oldest !== null && page.next_before !== null && oldest > topId) return fromPage(page);   // more than a page happened since: what is between is not known
  return { events: [...page.events.filter(e => e.id > topId), ...shown.events], nextBefore: shown.nextBefore, generatedAt: page.generated_at };
}

function Item({ event, timeZone }) {
  const said = describeEvent(event);
  const [tone, label] = KINDS[said.kind] ?? KINDS.other;
  return (
    <li data-event={event.id} className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{timeOf(event.occurred_at, timeZone)}</span>
        <Chip tone={tone}>{label}</Chip>
        <span data-title className="text-sm font-medium">{said.title}</span>
      </div>
      {said.text && <p className="text-sm text-muted-foreground">{said.text}</p>}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Details</summary>
        <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-secondary p-2 font-mono">{JSON.stringify(event.payload ?? {}, null, 2)}</pre>
      </details>
    </li>
  );
}

/** The events in the order given, a day at a time. */
function Days({ events, now, timeZone }) {
  const days = [];
  for (const event of events) {
    const heading = dayHeading(event.occurred_at, timeZone, now);
    if (days.length && days[days.length - 1].heading === heading) days[days.length - 1].events.push(event);
    else days.push({ heading, events: [event] });
  }
  return days.map(day => (
    <section key={`${day.heading}-${day.events[0].id}`} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-muted-foreground">{day.heading}</h3>
      <ul role="list" className="flex flex-col gap-2">
        {day.events.map(event => <Item key={event.id} event={event} timeZone={timeZone} />)}
      </ul>
    </section>
  ));
}

export function Timeline({ api, restaurantId, clock, timeZone, pollMs = 60000, nonce = 0, onLeave }) {
  // The kind belongs to the restaurant it was chosen for: another restaurant starts again at "everything", without a second read to get there.
  const [chosen, setChosen] = useState({ id: restaurantId, kind: '' });
  const kind = chosen.id === restaurantId ? chosen.kind : '';
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState(null);
  const [older, setOlder] = useState({ busy: false, error: null });
  const generation = useRef(0);
  const reading = useRef(false);
  const loadingOlder = useRef(false);
  const live = useRef(true);
  const firstNonce = useRef(nonce);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const dataRef = useRef(data);
  dataRef.current = data;
  // The latest of each, kept where reading can reach it without depending on it.
  const apiRef = useRef(api);
  apiRef.current = api;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  const restaurantRef = useRef(restaurantId);
  restaurantRef.current = restaurantId;

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const leave = useCallback(error => {
    if (error?.kind === 'denied') { onLeaveRef.current(ENDED); return true; }
    return false;
  }, []);

  // `merge`: a read that comes by itself puts what is new above what is shown; a read of something chosen starts the list again.
  const read = useCallback(async (merge) => {
    const mine = ++generation.current;
    reading.current = true;
    try {
      const page = await apiRef.current.timeline(restaurantRef.current, filtersOf(kindRef.current));
      if (!live.current || mine !== generation.current) return;
      setData(shown => (merge && shown ? withNewest(shown, page) : fromPage(page)));
      setProblem(null);
    } catch (error) {
      if (!live.current || mine !== generation.current || leave(error)) return;
      setProblem(error);
    } finally {
      if (mine === generation.current) reading.current = false;
    }
  }, [leave]);

  const poll = useCallback(() => { if (!reading.current && !loadingOlder.current) read(true); }, [read]);

  useEffect(() => {
    setData(null); setProblem(null); setOlder({ busy: false, error: null });
    loadingOlder.current = false;
    read(false);
  }, [restaurantId, kind, read]);

  useEffect(() => {
    const id = setInterval(poll, pollMs);
    return () => clearInterval(id);
  }, [poll, pollMs]);

  useEffect(() => {
    if (nonce !== firstNonce.current) { firstNonce.current = nonce; poll(); }
  }, [nonce, poll]);

  const showOlder = async () => {
    const shown = dataRef.current;
    if (loadingOlder.current || !shown || shown.nextBefore === null) return;
    loadingOlder.current = true;
    const mine = generation.current;
    setOlder({ busy: true, error: null });
    try {
      const page = await apiRef.current.timeline(restaurantRef.current, filtersOf(kindRef.current, { before: shown.nextBefore }));
      if (!live.current || mine !== generation.current) return;
      setData(now => {
        if (!now) return now;
        const have = new Set(now.events.map(e => e.id));
        return { ...now, events: [...now.events, ...page.events.filter(e => !have.has(e.id))], nextBefore: page.next_before ?? null };
      });
      setOlder({ busy: false, error: null });
    } catch (error) {
      if (!live.current || mine !== generation.current || leave(error)) return;
      setOlder({ busy: false, error });
    } finally {
      loadingOlder.current = false;
    }
  };

  const now = clock();
  let body;
  if (!data) {
    body = problem ? (
      <Notice tone="error" action={<Button variant="outline" className="h-9" onClick={() => read(false)}>Try again</Button>}>{problem.message}</Notice>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Reading the timeline…</p>
    );
  } else {
    body = (
      <>
        <p className="text-sm font-medium">{asOf(data.generatedAt, timeZone, now)}</p>
        {problem && <Notice tone="warning" title="Could not refresh">{problem.message} What is shown below is {asOf(data.generatedAt, timeZone, now)}.</Notice>}
        {data.events.length === 0 ? <EmptyState title={EMPTY[kind] ?? EMPTY['']} /> : <Days events={data.events} now={now} timeZone={timeZone} />}
        {older.error && <Notice tone="error">{older.error.message}</Notice>}
        {data.nextBefore !== null && (
          <div>
            <Button type="button" variant="outline" className="h-10" disabled={older.busy} onClick={showOlder}>
              {older.busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}Show older events
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="timeline-title" className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="timeline-title" className="typography-heading-sm font-semibold">Timeline</h2>
        <Field label="Show" htmlFor="timeline-kind" className="w-48">
          <NativeSelect id="timeline-kind" value={kind} onChange={e => setChosen({ id: restaurantId, kind: e.target.value })}>
            {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect>
        </Field>
      </div>
      {body}
    </section>
  );
}
