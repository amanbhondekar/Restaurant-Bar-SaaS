import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { explainError, hubGet, hubSend } from './api';
import { ConfirmDialog, Notice } from './ui';

// Filling the gaps in a ledger that is missing bills the cloud still has (§4.1).
//
// The hub's restore refuses a ledger that holds anything, because a hub with bills is the authority
// on them. That is right, and it leaves a hub that is merely SHORT -- restored from an old backup,
// or missing part of its data directory -- short for good, with nobody to tell.
//
// So: the hub counts both sides at boot and says if the cloud has more, and reception can always run
// the real comparison from here. Nothing is ever changed without being shown first.

export function LedgerRepair({ notify }) {
  const [gap, setGap] = useState(null);          // the cheap boot-style check
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState(null);      // the real comparison, before applying
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState(null);

  const loadGap = useCallback(async () => {
    try {
      setGap(await hubGet('/reconciliation/ledger-gap'));
    } catch {
      // Not knowing is not worth a message of its own: the button below still works, and the cash
      // screen already reports a hub it cannot reach.
    }
  }, []);

  useEffect(() => { loadGap(); }, [loadGap]);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setFound(await hubSend('POST', '/reconciliation/ledger-repair', { apply: false }));
    } catch (e) {
      setError(explainError(e));
    } finally {
      setChecking(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      const result = await hubSend('POST', '/reconciliation/ledger-repair', { apply: true });
      notify(`Added ${result.added.invoices} bill(s) and ${result.added.cashups} cash-up(s) from the cloud.`);
      setFound(null);
      await loadGap();
    } catch (e) {
      setError(explainError(e));
    } finally {
      setApplying(false);
    }
  };

  const short = gap?.short === true;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="repair-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="repair-h" className="typography-title-md">Ledger check</h2>
          <p className="text-xs text-muted-foreground">
            Compares this hub&rsquo;s bills with the cloud&rsquo;s copy. Anything already on the hub is left exactly as it is.
          </p>
        </div>
        <Button variant="outline" className="h-10" onClick={check} disabled={checking || applying}>
          {checking ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Stethoscope className="size-4" aria-hidden="true" />}
          Check against the cloud
        </Button>
      </div>

      {short && !found && (
        <Notice tone="warning" title="This hub may be missing bills">
          The cloud holds {gap.invoices} bill{gap.invoices === 1 ? '' : 's'} and {gap.cashups} cash-up{gap.cashups === 1 ? '' : 's'} that are not on this hub. Check to see which.
        </Notice>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      {found && (
        <Notice
          tone={found.changed ? 'warning' : 'success'}
          action={found.changed ? <Button className="h-10" onClick={() => setFound({ ...found, confirming: true })}>Add them</Button> : undefined}
        >
          {found.summary}
        </Notice>
      )}

      <ConfirmDialog
        open={Boolean(found?.confirming)}
        title="Add the missing records?"
        confirmLabel="Add them"
        destructive={false}
        busy={applying}
        onConfirm={apply}
        onCancel={() => setFound(f => ({ ...f, confirming: false }))}
      >
        {found?.summary} They are already settled in the cloud, so they arrive as history rather than as takings to collect.
      </ConfirmDialog>
    </section>
  );
}
