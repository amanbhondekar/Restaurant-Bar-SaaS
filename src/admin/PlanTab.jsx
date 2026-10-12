import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { explainError, hubGet } from './api';
import { featureRows, formatWhen, limitRows, planBanner, planLabel } from './lib/plan';
import { ListSkeleton, Notice } from './ui';

// The owner's view of the subscription (M3 · PR 18). Read-only, and served from GET /plan, which the
// hub answers out of its own config -- so this page keeps working during an internet outage and
// simply reports how stale the plan is. All the wording and the arithmetic live in ./lib/plan.

function LimitRow({ row }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{row.label}</span>
        <span className="text-sm tabular-nums text-muted-foreground">{row.text}</span>
      </div>
      {/* Decoration over the numbers above, so it is hidden from screen readers. */}
      {row.counted && !row.unlimited && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className="h-full rounded-full" style={{ width: `${row.percent}%`, background: `var(--status-${row.tone}-text)` }} />
        </div>
      )}
      {!row.counted && <div className="mt-1 text-xs text-muted-foreground">Checked when the restaurant is set up, not on this hub.</div>}
    </div>
  );
}

function FeatureRow({ row }) {
  const tone = row.on ? 'green' : 'rust';
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-1 py-2.5 last:border-b-0">
      <span className="text-sm">{row.label}</span>
      <span
        className="inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium"
        style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` }}
      >
        {row.text}
      </span>
    </div>
  );
}

export function PlanTab() {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPlan(await hubGet('/plan'));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error && !plan) {
    return (
      <Notice tone="error" title="Could not load the subscription" action={<Button className="h-10" onClick={load}>Try again</Button>}>
        {explainError(error)}
      </Notice>
    );
  }
  if (!plan) return <ListSkeleton rows={4} className="pt-2" />;

  const banner = planBanner(plan);

  return (
    <div className="flex flex-col gap-4">
      {banner && <Notice tone={banner.tone} title={banner.title}>{banner.body}</Notice>}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Current plan</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold">{planLabel(plan.plan)}</span>
            <span className="text-sm text-muted-foreground">{plan.status}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">Checked with the cloud: {formatWhen(plan.synced_at)}</span>
          <Button variant="outline" className="h-10" onClick={load} disabled={loading}>
            <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">What this plan allows</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {limitRows(plan).map(row => <LimitRow key={row.key} row={row} />)}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Features</h2>
        <div className="rounded-xl border border-border bg-card px-3 py-1">
          {featureRows(plan).map(row => <FeatureRow key={row.key} row={row} />)}
        </div>
      </section>

      {error && <Notice tone="warning">{explainError(error)} Showing the last answer from the hub.</Notice>}
    </div>
  );
}
