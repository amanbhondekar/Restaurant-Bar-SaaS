import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Notice } from '@/admin/ui';
import { planLabel } from '@/admin/lib/plan';
import { clockSkew, day, eventLabel, hubLabel, hubTone, relative, severityLabel, severityTone, statusLabel, statusTone } from './lib/format';
import { Chip, Facts, Section } from './parts';

// One restaurant: what is wrong with it, how it pays, what its hub says, how busy it is, and the history of its subscription. What the fleet
// already knew is shown at once; the history is read when the page opens, and can be read again.

const dash = '—';
const count = n => (n === null || n === undefined ? dash : String(n));
const phoneHref = phone => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

function Billing({ tenant, now }) {
  const rows = [
    ['Plan', planLabel(tenant.plan) ?? dash],
    ['State', statusLabel(tenant.plan_status)]
  ];
  if (tenant.plan_status === 'trialing' && tenant.trial_ends_at) rows.push(['Trial ends', `${relative(tenant.trial_ends_at, now)} (${day(tenant.trial_ends_at)})`]);
  if (tenant.current_period_end) rows.push([Date.parse(tenant.current_period_end) < now ? 'Period ended' : 'Period ends', `${relative(tenant.current_period_end, now)} (${day(tenant.current_period_end)})`]);
  rows.push(['Signed up', `${relative(tenant.created_at, now)} (${day(tenant.created_at)})`]);
  return (
    <Section id="ops-billing" title="Billing" level={3}>
      <Facts rows={rows} />
    </Section>
  );
}

function HubFacts({ tenant, now }) {
  const hub = tenant.hub;
  const skew = clockSkew(hub);
  const rows = [
    ['Last heard', (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Chip tone={hubTone(hub.state)}>{hubLabel(hub.state)}</Chip>
        {hub.state !== 'never' && <span>{relative(hub.seen_at, now)}</span>}
      </span>
    )],
    ...(skew ? [['Clock', skew]] : []),
    ['Version', hub.version ?? dash],
    ['Running since', relative(hub.started_at, now)],
    ['Last synced', relative(hub.last_synced_at, now)],
    ['Waiting to sync', count(hub.queued)],
    ['Shelved', count(hub.quarantined)],
    ['Handsets', count(hub.devices)],
    ['Waiters', count(hub.waiters)]
  ];
  return (
    <Section id="ops-hub" title="Hub" level={3}>
      <Facts rows={rows} />
    </Section>
  );
}

function Subscriptions({ list, now }) {
  return (
    <Section id="ops-subscriptions" title="Subscriptions" level={3}>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No subscription has been started.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subscription</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Period ends</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map(s => {
              const notes = [
                s.plan_change_to ? `changing to ${planLabel(s.plan_change_to)}` : null,
                s.cancel_requested_at ? `asked to cancel ${relative(s.cancel_requested_at, now)}` : null
              ].filter(Boolean);
              return (
                <TableRow key={s.razorpay_subscription_id}>
                  <TableCell className="align-top font-mono text-xs">{s.razorpay_subscription_id}</TableCell>
                  <TableCell className="align-top">{s.status}</TableCell>
                  <TableCell className="align-top">{planLabel(s.plan) ?? dash}</TableCell>
                  <TableCell className="align-top">{s.current_end ? `${relative(s.current_end, now)} (${day(s.current_end)})` : dash}</TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">{notes.join('; ') || dash}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function History({ events, now }) {
  return (
    <Section id="ops-tenant-events" title="Events for this restaurant" level={3}>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has happened to this restaurant's subscription.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {events.map(event => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
              <span className="text-sm font-medium">{eventLabel(event.event)}</span>
              {event.applied_plan_status && <Chip tone={statusTone(event.applied_plan_status)}>{statusLabel(event.applied_plan_status)}</Chip>}
              <span className="ml-auto text-xs text-muted-foreground">{relative(event.received_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function TenantView({ api, token, target, known, fallbackNow, nonce, onBack, onLeave }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setState(prev => ({ loading: true, data: prev.data?.tenant?.id === target.id ? prev.data : null, error: null }));
    api.tenant(token, target.id).then(
      data => { if (current && live.current) setState({ loading: false, data, error: null }); },
      error => {
        if (!current || !live.current) return;
        if (error?.kind === 'denied') { onLeave('The console token was not accepted any more. Sign in again.'); return; }
        setState(prev => ({ loading: false, data: prev.data, error }));
      }
    );
    return () => { current = false; };
  }, [api, token, target.id, nonce, attempt, onLeave]);

  const tenant = state.data?.tenant ?? known ?? null;
  const now = state.data ? Date.parse(state.data.generated_at) : fallbackNow;

  return (
    <>
      <div>
        <Button variant="outline" className="h-9" onClick={onBack}><ArrowLeft className="size-4" aria-hidden="true" /> All restaurants</Button>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="typography-display-sm">{tenant?.name ?? target.name ?? 'Restaurant'}</h2>
        {tenant && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <p>{tenant.city ?? dash}</p>
            {tenant.phone && (
              <a className="inline-flex items-center gap-1 underline underline-offset-2" href={phoneHref(tenant.phone)}>
                <Phone className="size-3.5" aria-hidden="true" />{tenant.phone}
              </a>
            )}
            <Chip tone={statusTone(tenant.plan_status)}>{statusLabel(tenant.plan_status)}</Chip>
            <Chip tone={hubTone(tenant.hub.state)}>Hub: {hubLabel(tenant.hub.state)}</Chip>
          </div>
        )}
      </div>

      {state.error && (
        <Notice tone="error" action={<Button variant="outline" className="h-9" onClick={() => setAttempt(n => n + 1)}>Try again</Button>}>
          {state.error.message}
        </Notice>
      )}

      {tenant && tenant.attention.length > 0 && (
        <Section id="ops-why" title="Why this needs attention" level={3}>
          <ul className="flex flex-col gap-1.5">
            {tenant.attention.map(item => (
              <li key={item.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Chip tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Chip>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {tenant && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Billing tenant={tenant} now={now} />
          <HubFacts tenant={tenant} now={now} />
          <Section id="ops-activity" title="Activity" level={3}>
            <Facts rows={[
              ['Bills in 7 days', String(tenant.activity.invoices_7d)],
              ['Last bill', relative(tenant.activity.last_invoice_at, now)]
            ]} />
          </Section>
        </div>
      )}

      {state.data ? (
        <>
          <Subscriptions list={state.data.subscriptions} now={now} />
          <History events={state.data.events} now={now} />
        </>
      ) : !state.error && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading the subscriptions and events…
        </p>
      )}
    </>
  );
}
