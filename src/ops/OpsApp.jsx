import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/admin/ui';
import { createOpsApi } from './lib/api';
import { relative } from './lib/format';
import { Shell } from './parts';
import { SignIn } from './SignIn';
import { FleetView } from './FleetView';
import { TenantView } from './TenantView';

// The operator console (§4.9): every restaurant at once, read-only. The token is held here, in memory, and goes to the service as a header on each
// read: never into storage, a cookie or an address. A refresh of the page asks for it again.
//
// What is shown is what the service last sent, and the page says how long ago that was. It reads again every minute; a read that fails keeps what
// is on the screen and says so, rather than blanking it or pretending it is current.

const defaultApi = createOpsApi();
const WEIGHTS = { signedOut: 'The console token was not accepted any more. Sign in again.' };

function Console({ api, token, first, onLeave, pollMs, tickMs, clock }) {
  const [fleet, setFleet] = useState(first);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const [filters, setFilters] = useState({ text: '', view: 'all' });
  const [open, setOpen] = useState(null);
  const [nonce, setNonce] = useState(0);
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
      const next = await api.fleet(token);
      if (!live.current) return;
      setFleet(next);
      setProblem(null);
    } catch (error) {
      if (!live.current) return;
      if (error?.kind === 'denied') onLeave(WEIGHTS.signedOut);
      else setProblem(error);
    } finally {
      reading.current = false;
      if (live.current) setBusy(false);
    }
  }, [api, token, onLeave]);

  useEffect(() => {
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  // So that "updated 5 min ago" keeps ageing between reads.
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  const reload = () => (open ? setNonce(n => n + 1) : refresh());
  const now = clock();
  const known = open ? fleet.tenants.find(t => t.id === open.id) : null;

  return (
    <Shell
      status={<span className="text-xs text-muted-foreground">Updated {relative(fleet.generated_at, now)}</span>}
      actions={(
        <>
          <Button variant="outline" className="h-10" onClick={reload} disabled={busy}>
            <RefreshCw className={busy ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" /> Refresh
          </Button>
          <Button variant="outline" className="h-10" onClick={() => onLeave('')}>
            <LogOut className="size-4" aria-hidden="true" /> Sign out
          </Button>
        </>
      )}
    >
      {problem && (
        <Notice tone="warning" title="Could not refresh">
          {problem.message} Showing what was read {relative(fleet.generated_at, now)}.
        </Notice>
      )}
      {open ? (
        <TenantView
          api={api}
          token={token}
          target={open}
          known={known}
          fallbackNow={Date.parse(fleet.generated_at)}
          nonce={nonce}
          onBack={() => setOpen(null)}
          onLeave={onLeave}
        />
      ) : (
        <FleetView fleet={fleet} filters={filters} onFilters={setFilters} onOpen={(id, name) => setOpen({ id, name })} />
      )}
    </Shell>
  );
}

export function OpsApp({ api = defaultApi, pollMs = 60000, tickMs = 15000, clock = Date.now }) {
  const [session, setSession] = useState(null);
  const [notice, setNotice] = useState('');

  const signIn = useCallback(async token => {
    const first = await api.fleet(token);
    setSession({ token, first });
  }, [api]);

  const leave = useCallback(reason => {
    setSession(null);
    setNotice(reason);
  }, []);

  if (!session) return <SignIn onSubmit={signIn} notice={notice} />;
  return <Console api={api} token={session.token} first={session.first} onLeave={leave} pollMs={pollMs} tickMs={tickMs} clock={clock} />;
}
