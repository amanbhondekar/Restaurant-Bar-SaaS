import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/admin/ui';
import { FleetView } from '@/ops/FleetView';
import { TenantView } from '@/ops/TenantView';
import { relative } from '@/ops/lib/format';
import { asOf } from '../lib/format';
import { AuditPage } from './AuditPage';
import { ConsoleShell } from './parts';

// The console once someone is in: the fleet (read again every minute), one restaurant, and the audit log. It can change nothing.
//
// Every figure says when it was read. When a read fails the page says so and marks what is still on screen as older, with the time it was read; it is
// never left looking current. When the very first read fails there is nothing to show, and nothing is shown.

const ENDED = 'Your session ended. Sign in again.';
const PLACES = [['fleet', 'Fleet'], ['audit', 'Audit log']];

export function Console({ api, me, clock, pollMs, tickMs, timeZone, download, onSignOut, onLeave }) {
  const [place, setPlace] = useState('fleet');
  const [fleet, setFleet] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [filters, setFilters] = useState({ text: '', view: 'all' });
  const [nonce, setNonce] = useState(0);
  const [, setTick] = useState(0);
  const live = useRef(true);
  const reading = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // One read at a time: on a slow line the next tick must not stack another on top of one that has not come back.
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    setBusy(true);
    try {
      const next = await api.fleet();
      if (!live.current) return;
      setFleet(next);
      setProblem(null);
    } catch (error) {
      if (!live.current) return;
      if (error?.kind === 'denied') onLeave(ENDED);
      else setProblem(error);
    } finally {
      reading.current = false;
      if (live.current) setBusy(false);
    }
  }, [api, onLeave]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);
  // So that "updated 5 min ago" keeps ageing between reads.
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  // The restaurant views were written for the operator console, which asked with a token; this one's client already holds the session.
  const tenantApi = useMemo(() => ({ tenant: (_token, id) => api.tenant(id) }), [api]);

  const now = clock();
  const known = open && fleet ? fleet.tenants.find(t => t.id === open.id) : null;
  const reload = () => (place === 'fleet' && open ? setNonce(n => n + 1) : refresh());
  const go = id => { setPlace(id); setOpen(null); };

  const nav = (
    <nav aria-label="Console" className="flex gap-1 pt-1">
      {PLACES.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-current={place === id ? 'page' : undefined}
          onClick={() => go(id)}
          className="rounded-t-md border-b-2 px-3 py-2 text-sm font-medium aria-[current=page]:border-[var(--color-primary)] aria-[current=page]:text-foreground border-transparent text-muted-foreground hover:text-foreground"
        >
          {label}
        </button>
      ))}
    </nav>
  );

  const status = fleet ? <span className="text-xs text-muted-foreground">Updated {relative(fleet.generated_at, now)}</span> : null;

  let body;
  if (place === 'audit') {
    body = <AuditPage api={api} tenants={fleet?.tenants ?? []} clock={clock} timeZone={timeZone} download={download} onLeave={onLeave} />;
  } else if (!fleet) {
    body = problem ? (
      <Notice tone="error" action={<Button variant="outline" className="h-9" onClick={refresh}>Try again</Button>}>{problem.message}</Notice>
    ) : (
      <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Reading the fleet…</p>
    );
  } else {
    body = (
      <>
        <p className="text-sm font-medium">{asOf(fleet.generated_at, timeZone, now)}</p>
        {problem && (
          <Notice tone="warning" title="Could not refresh">
            {problem.message} What is shown below is {asOf(fleet.generated_at, timeZone, now)}.
          </Notice>
        )}
        {fleet.truncated && (
          <Notice tone="warning">Only the first {fleet.tenants.length} restaurants are shown. There are more than this page can hold.</Notice>
        )}
        {open ? (
          <TenantView
            api={tenantApi}
            token=""
            target={open}
            known={known}
            fallbackNow={Date.parse(fleet.generated_at)}
            nonce={nonce}
            onBack={() => setOpen(null)}
            onLeave={() => onLeave(ENDED)}
          />
        ) : (
          <FleetView fleet={fleet} filters={filters} onFilters={setFilters} onOpen={(id, name) => setOpen({ id, name })} />
        )}
      </>
    );
  }

  return (
    <ConsoleShell
      nav={nav}
      status={<>{status}<span className="text-xs text-muted-foreground">{me.user.email}</span></>}
      actions={(
        <>
          <Button variant="outline" className="h-10" onClick={reload} disabled={busy}>
            <RefreshCw className={busy ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" /> Refresh
          </Button>
          <Button variant="outline" className="h-10" onClick={onSignOut}>
            <LogOut className="size-4" aria-hidden="true" /> Sign out
          </Button>
        </>
      )}
    >
      {body}
    </ConsoleShell>
  );
}
