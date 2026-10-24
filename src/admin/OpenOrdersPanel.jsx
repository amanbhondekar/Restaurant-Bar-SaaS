import React, { useCallback, useEffect, useState } from 'react';
import { Ban, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { explainError, hubGet, hubSend } from './api';
import { EmptyState, Field, NativeSelect, Notice, TextInput } from './ui';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CANCEL_REASONS, ageLabel, cancelConsequence, cancelledMessage, itemsLine, minutesSince, oldestFirst } from './lib/openOrders';

// The orders still on the board, with a way to withdraw one. Cancelling is for an order that was never
// going to be eaten (the guest left, the wrong table); a bill that has already been issued is reversed by
// voiding the bill, and the hub says so if someone tries.

const REFRESH_MS = 5000;
const OTHER = '__other__';

function CancelDialog({ ticket, onClose, onCancelled }) {
  const [choice, setChoice] = useState(CANCEL_REASONS[0]);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const reason = choice === OTHER ? other.trim() : choice;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await hubSend('POST', `/orders/${encodeURIComponent(ticket.id)}/cancel`, { reason, by: 'Reception' });
      onCancelled(result);
    } catch (e) {
      setError(explainError(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Cancel order #{ticket.ticket_number}?</DialogTitle>
          <DialogDescription>
            {ticket.table_name} · {itemsLine(ticket)}. {cancelConsequence(ticket)}
          </DialogDescription>
        </DialogHeader>
        <Field label="Why" htmlFor="cancel-reason">
          <NativeSelect id="cancel-reason" value={choice} onChange={e => setChoice(e.target.value)}>
            {CANCEL_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            <option value={OTHER}>Something else…</option>
          </NativeSelect>
        </Field>
        {choice === OTHER && (
          <Field label="Say what happened" htmlFor="cancel-other">
            <TextInput id="cancel-other" value={other} onChange={e => setOther(e.target.value)} maxLength={140} autoComplete="off" />
          </Field>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <DialogFooter>
          <Button variant="outline" className="h-10" onClick={onClose} disabled={busy}>Keep the order</Button>
          <Button variant="destructive" className="h-10" onClick={confirm} disabled={busy || (choice === OTHER && !other.trim())}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Cancel order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OpenOrdersPanel({ notify }) {
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const body = await hubGet('/orders/active');
      setTickets(body.tickets || []);
      setError(null);
    } catch (e) {
      setError(e);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const cancelled = async (ticket, result) => {
    setCancelling(null);
    notify(cancelledMessage(ticket, result));
    await load();
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="open-orders-h">
      <div>
        <h2 id="open-orders-h" className="typography-title-md">Open orders</h2>
        <p className="text-xs text-muted-foreground">Orders still on the board. Cancel one that was never going to be eaten; a bill already issued is voided instead.</p>
      </div>

      {error && !tickets && <Notice tone="error" title="Could not load the open orders">{explainError(error)}</Notice>}
      {tickets && tickets.length === 0 && <EmptyState icon={Ban} title="Nothing on the board">Orders appear here as they are sent to the kitchen.</EmptyState>}

      {tickets && tickets.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {oldestFirst(tickets).map(t => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" aria-label={`Order ${t.ticket_number}, ${t.table_name}`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold tabular-nums">#{t.ticket_number}</span>
                  <span className="font-semibold">{t.table_name}</span>
                  <Badge variant="outline">{t.status === 'ready' ? 'Ready' : 'In the kitchen'}</Badge>
                  <span className="text-xs text-muted-foreground">{ageLabel(minutesSince(t.created_at, now))}</span>
                </div>
                <div className="text-sm text-muted-foreground">{itemsLine(t)}{t.created_by_waiter ? ` · ${t.created_by_waiter}` : ''}</div>
              </div>
              <Button variant="outline" className="h-9" onClick={() => setCancelling(t)} aria-label={`Cancel order ${t.ticket_number}`}>
                <Ban className="size-4" aria-hidden="true" />Cancel
              </Button>
            </li>
          ))}
        </ul>
      )}

      {cancelling && <CancelDialog ticket={cancelling} onClose={() => setCancelling(null)} onCancelled={result => cancelled(cancelling, result)} />}
    </section>
  );
}
