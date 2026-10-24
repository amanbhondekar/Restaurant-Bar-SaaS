import React, { useMemo } from 'react';
import { CheckCircle2, Search } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Notice, TextInput } from '@/admin/ui';
import { planLabel } from '@/admin/lib/plan';
import { billingLine, countViews, eventLabel, filterTenants, hubLabel, hubTone, relative, severityLabel, severityTone, statusLabel, statusTone, VIEWS } from './lib/format';
import { Chip, NameButton, Section, Tile } from './parts';

// Every restaurant at once (§4.9): how many are doing what, the ones that need a call, and a table to look through. Everything shown is what
// the service sent, as text; a figure it did not have is shown as not known, never as zero.

const queued = hub => (hub.queued === null ? '—' : String(hub.queued));

function Summary({ summary }) {
  const overdue = summary.by_status.past_due + summary.by_status.suspended;
  const need = summary.attention.high + summary.attention.medium;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Tile label="Restaurants" value={summary.tenants} />
      <Tile label="Active" value={summary.by_status.active} />
      <Tile label="On trial" value={summary.by_status.trialing} />
      <Tile label="Overdue or suspended" value={overdue} tone={overdue > 0 ? 'bad' : undefined} />
      <Tile label="Hubs live" value={summary.hubs.live} sub={`of ${summary.tenants}`} />
      <Tile label="Need attention" value={need} sub={summary.attention.high > 0 ? `${summary.attention.high} high` : undefined} tone={summary.attention.high > 0 ? 'bad' : need > 0 ? 'warning' : undefined} />
    </div>
  );
}

function Attention({ items, onOpen }) {
  return (
    <Section id="ops-attention" title="Needs attention">
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4" style={{ color: 'var(--status-green-text)' }} aria-hidden="true" />
          <span>Nothing needs attention.</span>
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map(item => (
            <li key={`${item.restaurant_id}-${item.code}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
              <Chip tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Chip>
              <NameButton onClick={() => onOpen(item.restaurant_id, item.name)}>{item.name}</NameButton>
              <span className="min-w-0 text-sm text-muted-foreground">{item.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Row({ tenant, now, onOpen }) {
  const { hub, activity } = tenant;
  return (
    <TableRow>
      <TableCell className="min-w-44 align-top">
        <NameButton onClick={() => onOpen(tenant.id, tenant.name)}>{tenant.name}</NameButton>
        {tenant.severity && <span className="sr-only">Needs attention ({tenant.severity})</span>}
        <div className="text-xs text-muted-foreground">{tenant.city ?? '—'}</div>
      </TableCell>
      <TableCell className="align-top">
        <div>{planLabel(tenant.plan) ?? '—'}</div>
        <Chip tone={statusTone(tenant.plan_status)}>{statusLabel(tenant.plan_status)}</Chip>
      </TableCell>
      <TableCell className="align-top text-sm">{billingLine(tenant, now)}</TableCell>
      <TableCell className="align-top">
        <Chip tone={hubTone(hub.state)}>{hubLabel(hub.state)}</Chip>
        {hub.state !== 'never' && <div className="text-xs text-muted-foreground">{relative(hub.seen_at, now)}</div>}
        {hub.version && <div className="text-xs text-muted-foreground">v{hub.version}</div>}
      </TableCell>
      <TableCell className="align-top">
        <div>{queued(hub)}</div>
        {hub.quarantined > 0 && <div className="text-xs" style={{ color: 'var(--status-rust-text)' }}>{hub.quarantined} shelved</div>}
      </TableCell>
      <TableCell className="align-top">
        <div>{activity.invoices_7d}</div>
        <div className="text-xs text-muted-foreground">{activity.last_invoice_at ? `last ${relative(activity.last_invoice_at, now)}` : 'no bills yet'}</div>
      </TableCell>
    </TableRow>
  );
}

function Restaurants({ tenants, now, filters, onFilters, onOpen }) {
  const counts = useMemo(() => countViews(tenants), [tenants]);
  const shown = useMemo(() => filterTenants(tenants, filters), [tenants, filters]);

  if (tenants.length === 0) {
    return (
      <Section id="ops-restaurants" title="Restaurants">
        <EmptyState title="No restaurants have signed up yet." />
      </Section>
    );
  }
  return (
    <Section id="ops-restaurants" title="Restaurants" aside={`${shown.length} of ${tenants.length}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <TextInput
            aria-label="Search restaurants"
            placeholder="Name, city or phone"
            className="pl-9"
            value={filters.text}
            onChange={e => onFilters({ ...filters, text: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {VIEWS.map(view => {
            const on = filters.view === view.id;
            return (
              <button
                key={view.id}
                type="button"
                aria-pressed={on}
                onClick={() => onFilters({ ...filters, view: view.id })}
                className={cn('h-9 rounded-full border px-3 text-sm transition-colors', on ? 'border-transparent bg-[var(--color-primary)] text-[var(--color-on-primary)]' : 'border-border bg-background hover:bg-secondary')}
              >
                {view.label} <span className={on ? undefined : 'text-muted-foreground'}>{counts[view.id]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState title="No restaurants match." action={<Button variant="outline" className="h-9" onClick={() => onFilters({ text: '', view: 'all' })}>Clear filters</Button>} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Restaurant</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead>Hub</TableHead>
              <TableHead>Queue</TableHead>
              <TableHead>Bills (7 days)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map(tenant => <Row key={tenant.id} tenant={tenant} now={now} onOpen={onOpen} />)}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function Events({ events, now, onOpen }) {
  return (
    <Section id="ops-events" title="Recent events" aside="Subscription changes across every restaurant">
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {events.map(event => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
              <span className="text-sm font-medium">{eventLabel(event.event)}</span>
              {event.restaurant_id
                ? <NameButton className="text-sm" onClick={() => onOpen(event.restaurant_id, event.restaurant_name)}>{event.restaurant_name}</NameButton>
                : <span className="text-sm text-muted-foreground">Unknown restaurant</span>}
              {event.applied_plan_status && <Chip tone={statusTone(event.applied_plan_status)}>{statusLabel(event.applied_plan_status)}</Chip>}
              <span className="ml-auto text-xs text-muted-foreground">{relative(event.received_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function FleetView({ fleet, filters, onFilters, onOpen }) {
  const now = Date.parse(fleet.generated_at);
  return (
    <>
      {fleet.truncated && <Notice tone="warning">Showing the first {fleet.tenants.length} restaurants. There may be more than one answer can hold.</Notice>}
      <Summary summary={fleet.summary} />
      <Attention items={fleet.attention} onOpen={onOpen} />
      <Restaurants tenants={fleet.tenants} now={now} filters={filters} onFilters={onFilters} onOpen={onOpen} />
      <Events events={fleet.events} now={now} onOpen={onOpen} />
    </>
  );
}
