import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { explainError, hubGet, hubSend } from './api';
import { ConfirmDialog, Notice } from './ui';

// The switch for the public booking page (§4.6), and its address. A guest opens the address, fills in a short form and asks for a table;
// the request comes to the Bookings tab, and reception accepts or declines it. The page is served by the operator service and lives in the
// cloud, so without the first this can only say what is missing, and without the internet it shows what the hub last knew and changes
// nothing: switching a page on or off is a change to the cloud, and says so plainly when the cloud cannot be reached.

const NEEDS_OPERATOR = 'Online booking needs the operator service. Set OPERATOR_SERVICE_URL on this hub, then come back.';

export function OnlineBookingPanel({ notify, onCheck }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const addressRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setView(await hubGet('/admin/booking-page'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // The hub answers a change with the page as it now is, so what is shown is what the cloud was left holding.
  const change = async (send, done) => {
    setBusy(true);
    try {
      const next = await send();
      setView(next);
      notify(done);
    } catch (e) {
      notify(explainError(e));
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.url);
      notify('Address copied.');
    } catch {
      addressRef.current?.select();
      notify('The address is selected. Copy it by hand.');
    }
  };

  if (error && !view) {
    return (
      <Notice tone="error" title="Could not read the booking page settings" action={<Button className="h-10" onClick={load}>Try again</Button>}>
        {explainError(error)}
      </Notice>
    );
  }
  if (!view) return <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />;

  const canChange = view.reachable !== false;
  const hasPage = Boolean(view.code);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="online-h">
      <div>
        <h2 id="online-h" className="typography-title-md">Online booking requests</h2>
        <p className="text-sm text-muted-foreground">
          Guests can ask for a table from a page of your own. Guests ask; you decide. Nothing is booked until you accept.
        </p>
      </div>

      {view.reachable === false && view.message && <Notice tone="warning">{view.message}</Notice>}

      {!view.configured && !view.enabled ? (
        <p className="text-sm">{NEEDS_OPERATOR}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{view.enabled ? 'On' : 'Off'}</Badge>
            {!view.enabled && (
              <Button className="h-9" disabled={busy || !canChange} onClick={() => change(() => hubSend('PUT', '/admin/booking-page', { enabled: true }), 'Online booking is on.')}>Turn on</Button>
            )}
            {view.enabled && (
              <>
                <Button variant="outline" className="h-9" onClick={onCheck}>Check for new requests</Button>
                <Button variant="outline" className="h-9" disabled={busy || !canChange} onClick={() => change(() => hubSend('PUT', '/admin/booking-page', { enabled: false }), 'Online booking is off.')}>Turn off</Button>
                {view.url && <Button variant="outline" className="h-9" disabled={busy || !canChange} onClick={() => setAsking(true)}>New address</Button>}
              </>
            )}
          </div>

          {view.enabled && view.needs_operator_url && <p className="text-sm">{NEEDS_OPERATOR}</p>}

          {view.enabled && view.url && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={addressRef}
                readOnly
                aria-label="Address of the booking page"
                value={view.url}
                onFocus={e => e.target.select()}
                className="h-10 min-w-0 flex-1 basis-64 rounded-lg border border-input bg-background px-2.5 text-sm"
              />
              <Button variant="outline" className="h-10" onClick={copy}><Copy className="size-4" aria-hidden="true" />Copy</Button>
            </div>
          )}
          {view.enabled && hasPage && !view.needs_operator_url && (
            <p className="text-xs text-muted-foreground">Put this address on a card, a table sign or your menu. Guests open it on their own phone.</p>
          )}
        </>
      )}

      <ConfirmDialog
        open={asking}
        title="Give the page a new address?"
        confirmLabel="New address"
        cancelLabel="Keep this one"
        busy={busy}
        onConfirm={() => change(() => hubSend('POST', '/admin/booking-page/new-address', {}), 'New address made. The old one no longer works.')}
        onCancel={() => setAsking(false)}
      >
        The old address stops working at once. Anyone who has it, on a card or a screen, will be told the page is not available. Use this if the
        address has gone somewhere it should not.
      </ConfirmDialog>
    </section>
  );
}
