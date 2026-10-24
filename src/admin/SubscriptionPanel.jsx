import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from 'cn';
import { explainError, hubSend } from './api';
import { formatDay } from './lib/subscription';
import { planLabel } from './lib/plan';
import { ConfirmDialog, useLastValue } from './ui';

// Start, switch and cancel the subscription from the reception laptop (§4.4). The view -- what to say, which buttons exist -- is
// worked out in ./lib/subscription from one GET /admin/billing answer; this draws it and sends the three requests.
//
// Starting needs no question asked: it only opens a payment page, and nothing is charged until the owner authorises it there.
// Switching plan and cancelling are asked about first, and both take effect at the end of the paid period, never today.

const TONE_VARS = { good: 'green', warning: 'amber' };

const REQUESTS = {
  subscribe: { path: '/admin/billing/subscribe', done: 'Subscription started. Open the payment page to authorise payment.' },
  change: { path: '/admin/billing/change-plan', done: 'Plan change scheduled for the end of the period.' },
  cancel: { path: '/admin/billing/cancel', done: 'Cancelling: the plan runs to the end of the period.' }
};

function confirmationFor(action, view) {
  const sub = view.subscription || {};
  const current = planLabel(sub.plan || '');
  const until = formatDay(sub.current_end) || 'the end of the paid period';
  if (action.id === 'cancel') {
    return {
      title: 'Cancel the subscription?',
      body: `The subscription keeps ${current} until ${until}, then ends and this restaurant moves to Starter. Orders, billing and the kitchen display are never switched off.`,
      confirmLabel: 'Cancel at the end of the period',
      cancelLabel: 'Keep the subscription',
      destructive: true
    };
  }
  return {
    title: `Switch to ${planLabel(action.plan)}?`,
    body: `This restaurant will stay on ${current} until ${until}, and then move to ${planLabel(action.plan)}. Nothing changes today.`,
    confirmLabel: 'Switch plan',
    cancelLabel: 'Not now',
    destructive: false
  };
}

export function SubscriptionPanel({ view, onChanged, notify }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(null);

  // While a request is out every button is disabled, which is what stops a double press from sending it twice.
  const send = async action => {
    setBusy(true);
    const { path, done } = REQUESTS[action.id];
    let ok = false;
    try {
      // A cancellation has no plan, so this is sent as {}.
      await hubSend('POST', path, { plan: action.plan });
      ok = true;
    } catch (e) {
      notify(explainError(e), 'error');
    } finally {
      setBusy(false);
      setAsking(null);
    }
    if (ok) {
      notify(done);
      onChanged();
    }
  };

  const press = action => (action.id === 'subscribe' ? send(action) : setAsking(action));

  const dot = TONE_VARS[view.tone];
  // Kept after the dialog is closed, so its text does not empty out while it fades away.
  const confirmation = useLastValue(asking ? confirmationFor(asking, view) : null);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Subscription</h2>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div>
          <div className="flex items-center gap-2 font-medium">
            {dot && <span className="size-2 shrink-0 rounded-full" style={{ background: `var(--status-${dot}-text)` }} aria-hidden="true" />}
            {view.title}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{view.text}</p>
        </div>

        {(view.link || view.actions.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {view.link && (
              <a
                href={view.link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'default' }), 'h-10')}
              >
                {view.link.label}
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            )}
            {view.actions.map(action => (
              <Button
                key={`${action.id}:${action.plan || ''}`}
                variant={action.id === 'subscribe' ? 'default' : 'outline'}
                className="h-10"
                disabled={busy}
                onClick={() => press(action)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(asking)}
        title={confirmation?.title}
        confirmLabel={confirmation?.confirmLabel}
        cancelLabel={confirmation?.cancelLabel}
        destructive={confirmation?.destructive}
        busy={busy}
        onConfirm={() => send(asking)}
        onCancel={() => setAsking(null)}
      >
        {confirmation?.body}
      </ConfirmDialog>
    </section>
  );
}
