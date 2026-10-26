import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Field, NativeSelect, Notice, TextInput } from '@/admin/ui';
import { Chip, Section } from '@/ops/parts';
import { asOf, plainRequestId, when } from '../lib/format';

// The audit log: every event the console has recorded, filtered and paged, with the people and restaurants named, exportable as a file, and with the
// integrity of its history checkable. Everything shown is what the API sent, as text. A search that is superseded by a newer one is dropped when
// it arrives; a verdict about the history is dropped the moment the question it answered changes.

const SOURCES = [['', 'All sources'], ['hub', 'Hub'], ['razorpay', 'Razorpay'], ['admin', 'Admin'], ['system', 'System'], ['support', 'Support']];
const ACTORS = { hub: 'Hub', webhook: 'Razorpay', system: 'System', admin: 'An administrator' };
const EMPTY = { restaurant: '', type: '', source: '', from: '', to: '' };
const ENDED = 'Your session ended. Sign in again.';

/** What the form asks for, as the API wants it: empty things left out, and the last day included. */
function filtersOf(draft) {
  const filters = {};
  if (draft.restaurant) filters.restaurant = draft.restaurant;
  if (draft.type.trim()) filters.type = draft.type.trim();
  if (draft.source) filters.source = draft.source;
  if (draft.from) filters.from = draft.from;
  if (draft.to) {
    const [y, m, d] = draft.to.split('-').map(Number);
    filters.to = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  return filters;
}

function Row({ event, timeZone }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-sm">{when(event.occurred_at, timeZone)}</TableCell>
      <TableCell className="text-sm">{event.restaurant_name ?? (event.restaurant_id ? 'A restaurant' : 'The console')}</TableCell>
      <TableCell className="text-sm">{event.source}</TableCell>
      <TableCell className="font-mono text-xs">{event.type}</TableCell>
      <TableCell className="text-sm">{event.actor_email ?? ACTORS[event.actor_type] ?? event.actor_type}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{plainRequestId(event.request_id)}</TableCell>
      <TableCell className="text-sm">
        <details>
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <pre className="mt-1 max-w-[28rem] overflow-x-auto whitespace-pre-wrap break-words rounded bg-secondary p-2 font-mono text-xs">{JSON.stringify(event.payload, null, 2)}</pre>
        </details>
      </TableCell>
    </TableRow>
  );
}

function Verdict({ verdict, nameOf, timeZone, now }) {
  if (!verdict || verdict.busy) return null;
  if (verdict.error) return <Notice tone="error">{verdict.error.message}</Notice>;
  const { result, scope } = verdict;
  return (
    <div data-verify className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm" role="status">
      <p className="flex items-center gap-2 font-medium">
        <Chip tone={result.ok ? 'good' : 'bad'}>{result.ok ? 'History is intact' : 'History is broken'}</Chip>
      </p>
      <p>{scope ? nameOf(scope) : 'The console\'s own history'}</p>
      <p className="text-muted-foreground">
        {result.ok
          ? `${result.checked} events checked, ${asOf(result.generated_at, timeZone, now)}`
          : `Broken at event ${result.broken_at}: ${result.reason} (${asOf(result.generated_at, timeZone, now)})`}
      </p>
    </div>
  );
}

export function AuditPage({ api, tenants, clock, timeZone, download, onLeave }) {
  const [draft, setDraft] = useState(EMPTY);
  const [applied, setApplied] = useState({});
  const [view, setView] = useState({ status: 'loading' });
  const [rows, setRows] = useState([]);
  const [next, setNext] = useState(null);
  const [readAt, setReadAt] = useState(null);
  const [more, setMore] = useState({ busy: false, error: null });
  const [exporting, setExporting] = useState({ busy: false, error: null });
  const [verdict, setVerdict] = useState(null);
  const generation = useRef(0);
  const checking = useRef(0);
  const live = useRef(true);
  const busyMore = useRef(false);
  const busyExport = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const leave = useCallback(error => {
    if (error?.kind === 'denied') { onLeave(ENDED); return true; }
    return false;
  }, [onLeave]);

  const search = useCallback(async filters => {
    const mine = ++generation.current;
    setApplied(filters);
    setView({ status: 'loading' });
    setMore({ busy: false, error: null });
    try {
      const page = await api.audit(filters);
      if (!live.current || mine !== generation.current) return;
      setRows(page.events);
      setNext(page.next_before ?? null);
      setReadAt(page.generated_at);
      setView({ status: 'ready' });
    } catch (error) {
      if (!live.current || mine !== generation.current || leave(error)) return;
      setView({ status: 'error', error });
    }
  }, [api, leave]);

  useEffect(() => { search({}); }, [search]);

  const older = async () => {
    if (busyMore.current || next === null) return;
    busyMore.current = true;
    const mine = generation.current;
    setMore({ busy: true, error: null });
    try {
      const page = await api.audit({ ...applied, before: next });
      if (!live.current || mine !== generation.current) return;
      setRows(current => {
        const seen = new Set(current.map(e => e.id));
        return [...current, ...page.events.filter(e => !seen.has(e.id))];
      });
      setNext(page.next_before ?? null);
      setReadAt(page.generated_at);
      setMore({ busy: false, error: null });
    } catch (error) {
      if (!live.current || mine !== generation.current || leave(error)) return;
      setMore({ busy: false, error });
    } finally {
      busyMore.current = false;
    }
  };

  const exportCsv = async () => {
    if (busyExport.current) return;
    busyExport.current = true;
    setExporting({ busy: true, error: null });
    try {
      const file = await api.auditCsv(applied);
      if (!live.current) return;
      download(file.blob, file.filename);
      setExporting({ busy: false, error: null });
    } catch (error) {
      if (!live.current || leave(error)) return;
      setExporting({ busy: false, error });
    } finally {
      busyExport.current = false;
    }
  };

  const choose = restaurant => {
    checking.current += 1;      // a verdict still on its way no longer answers the question being asked
    setVerdict(null);
    setDraft(d => ({ ...d, restaurant }));
  };

  const verify = async () => {
    const mine = ++checking.current;
    const scope = draft.restaurant || null;
    setVerdict({ busy: true, scope });
    try {
      const result = await api.verify(scope);
      if (!live.current || mine !== checking.current) return;
      setVerdict({ result, scope });
    } catch (error) {
      if (!live.current || mine !== checking.current || leave(error)) return;
      setVerdict({ error, scope });
    }
  };

  const sorted = useMemo(() => [...tenants].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })), [tenants]);
  const nameOf = id => tenants.find(t => t.id === id)?.name ?? 'This restaurant';
  const now = clock();
  const submit = event => { event.preventDefault(); search(filtersOf(draft)); };
  const clear = () => { setDraft(EMPTY); checking.current += 1; setVerdict(null); search({}); };

  return (
    <Section id="audit-log" title="Audit log" aside={view.status === 'ready' ? `${rows.length} ${rows.length === 1 ? 'event' : 'events'}, ${asOf(readAt, timeZone, now)}` : undefined}>
      <form aria-label="Filter the audit log" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={submit}>
        <Field label="Restaurant" htmlFor="audit-restaurant">
          <NativeSelect id="audit-restaurant" value={draft.restaurant} onChange={e => choose(e.target.value)}>
            <option value="">All restaurants</option>
            {sorted.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Event type" htmlFor="audit-type">
          <TextInput id="audit-type" placeholder="admin.signin" autoComplete="off" spellCheck={false} value={draft.type} onChange={e => setDraft(d => ({ ...d, type: e.target.value }))} />
        </Field>
        <Field label="Source" htmlFor="audit-source">
          <NativeSelect id="audit-source" value={draft.source} onChange={e => setDraft(d => ({ ...d, source: e.target.value }))}>
            {SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="From" htmlFor="audit-from">
          <TextInput id="audit-from" type="date" value={draft.from} onChange={e => setDraft(d => ({ ...d, from: e.target.value }))} />
        </Field>
        <Field label="To" htmlFor="audit-to">
          <TextInput id="audit-to" type="date" value={draft.to} onChange={e => setDraft(d => ({ ...d, to: e.target.value }))} />
        </Field>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-5">
          <Button type="submit" className="h-10">Search</Button>
          <Button type="button" variant="outline" className="h-10" onClick={clear}>Clear</Button>
          <Button type="button" variant="outline" className="h-10" onClick={exportCsv} disabled={exporting.busy || view.status !== 'ready'}>
            <Download className="size-4" aria-hidden="true" /> {exporting.busy ? 'Exporting…' : 'Export CSV'}
          </Button>
          <Button type="button" variant="outline" className="h-10 sm:ml-auto" onClick={verify} disabled={verdict?.busy}>
            <ShieldCheck className="size-4" aria-hidden="true" /> {verdict?.busy ? 'Checking…' : 'Check history integrity'}
          </Button>
        </div>
      </form>

      <Verdict verdict={verdict} nameOf={nameOf} timeZone={timeZone} now={now} />
      {exporting.error && <Notice tone="error">{exporting.error.message}</Notice>}

      {view.status === 'loading' && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Reading the audit log…</p>
      )}
      {view.status === 'error' && (
        <Notice tone="error" action={<Button variant="outline" className="h-9" onClick={() => search(applied)}>Try again</Button>}>{view.error.message}</Notice>
      )}
      {view.status === 'ready' && rows.length === 0 && <EmptyState title="No events match." />}
      {view.status === 'ready' && rows.length > 0 && (
        <>
          <Table aria-label="Audit events">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead><TableHead>Restaurant</TableHead><TableHead>Source</TableHead><TableHead>Event</TableHead>
                <TableHead>Who</TableHead><TableHead>Request</TableHead><TableHead>Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{rows.map(e => <Row key={e.id} event={e} timeZone={timeZone} />)}</TableBody>
          </Table>
          {more.error && <Notice tone="error">{more.error.message}</Notice>}
          {next !== null && (
            <div>
              <Button variant="outline" className="h-10" onClick={older} disabled={more.busy}>{more.busy ? 'Reading…' : 'Load older events'}</Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
