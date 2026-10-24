import React, { useState } from 'react';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CANCEL_REASONS, cancelConsequence, itemsLine } from '../admin/lib/openOrders';

// A table's orders that are still on the board, with a way to withdraw one. A waiter takes the wrong table's
// order or the guest leaves; this is for that, and it asks before it does anything, because the kitchen
// is already cooking it. What happens to the ingredients is said BEFORE the tap, not discovered after.
//
// `onCancel(ticket, reason)` resolves to { ok, message } or { ok: false, error }.

export function SentOrders({ tickets, onCancel }) {
  const [asking, setAsking] = useState(null);    // ticket id being confirmed
  const [reason, setReason] = useState(CANCEL_REASONS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const confirm = async ticket => {
    setBusy(true);
    setError('');
    const result = await onCancel(ticket, reason);
    setBusy(false);
    if (result?.ok) { setAsking(null); setDone(result.message || 'Order cancelled.'); } else setError(result?.error || 'Could not cancel that order.');
  };

  if ((!tickets || tickets.length === 0) && !done) return null;

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border px-3 py-2.5" style={{ borderColor: 'var(--color-border)' }} aria-label="Orders sent to the kitchen">
      {done && <span className="text-xs" role="status" style={{ color: 'var(--status-green-text)' }}>{done}</span>}
      {(tickets || []).map(ticket => (
        <div key={ticket.id} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs">
              <strong>#{ticket.ticket_number}</strong> · {itemsLine(ticket, 2)} · {ticket.status === 'ready' ? 'Ready' : 'In the kitchen'}
            </span>
            {asking !== ticket.id && (
              <Button size="sm" variant="outline" className="h-9 shrink-0" onClick={() => { setAsking(ticket.id); setError(''); setDone(''); }} aria-label={`Cancel order ${ticket.ticket_number}`}>
                <Ban size={14} aria-hidden="true" /> Cancel
              </Button>
            )}
          </div>
          {asking === ticket.id && (
            <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border px-2 py-2" style={{ borderColor: 'var(--status-amber-border)', background: 'var(--status-amber-bg)' }}>
              <span className="text-xs" style={{ color: 'var(--status-amber-text)' }}>{cancelConsequence(ticket)}</span>
              <select aria-label="Why" value={reason} onChange={e => setReason(e.target.value)} className="h-10 rounded-md border px-2 text-sm">
                {CANCEL_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {error && <span className="text-xs" role="alert" style={{ color: 'var(--color-error-text)' }}>{error}</span>}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-9 flex-1" onClick={() => setAsking(null)} disabled={busy}>Keep it</Button>
                <Button size="sm" variant="destructive" className="h-9 flex-1" onClick={() => confirm(ticket)} disabled={busy}>
                  {busy ? 'Cancelling…' : `Cancel order ${ticket.ticket_number}`}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
