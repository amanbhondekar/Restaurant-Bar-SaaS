import React, { useCallback, useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { explainError, hubGet, hubSend } from './api';
import { Notice } from './ui';

// Whether guests may send orders to the kitchen from the code on their table (§4.5).
//
// It sits beside the table QR codes because that is the thing it is about. It is OFF until a
// restaurant turns it on, and the wording says plainly what turning it on means: tickets arriving in
// the kitchen without a member of staff having seen them.

export function GuestOrderingSwitch({ notify }) {
  const [ordering, setOrdering] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const body = await hubGet('/public/ordering');
      setOrdering(body.ordering === true);
    } catch {
      // The layout editor around this already reports a hub it cannot reach; a second message would
      // only be noise.
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (ordering === null) return null;

  const toggle = async () => {
    const next = !ordering;
    setBusy(true);
    setError(null);
    try {
      await hubSend('PUT', '/admin/guest-ordering', { ordering: next });
      setOrdering(next);
      notify(next
        ? 'Guests can now order from the code on their table.'
        : 'Guest ordering is off. Orders come from staff only.');
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <label className="flex cursor-pointer items-start gap-3">
        <Switch checked={ordering} disabled={busy} onCheckedChange={toggle} aria-label="Let guests order from the table QR code" />
        <span className="text-sm">
          <span className="font-medium">Let guests order from the table code</span>
          <span className="block text-muted-foreground">
            {ordering
              ? 'Orders scanned at a table go straight to the kitchen, marked "Guest (QR)". Guests still settle the bill with staff.'
              : 'Off. The code shows the menu only, and orders are taken by staff.'}
          </span>
        </span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
