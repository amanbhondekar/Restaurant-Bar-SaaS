import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { explainError, hubGet } from './api';
import { Field, ListSkeleton, NativeSelect, Notice } from './ui';
import { StationScreensPanel } from './StationScreensPanel';

// Kitchen performance: how long dishes take, measured from the moment a course is sent to the kitchen
// until the station says it is ready. The hub keeps these timestamps on every ticket already; this page
// only reads them.

const PERIODS = [
  { id: '1h', label: 'Last hour', ms: 60 * 60 * 1000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 }
];

const STATION_LABEL = { hot: 'Hot line', cold: 'Cold line', bar: 'Bar' };

/** 754 -> "12m 34s"; 45 -> "45s"; null -> a dash. */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function Tile({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function PerformanceReport() {
  const [period, setPeriod] = useState('24h');
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ms = PERIODS.find(p => p.id === period).ms;
      const from = new Date(Date.now() - ms).toISOString();
      setReport(await hubGet(`/telemetry/prep?from=${encodeURIComponent(from)}`));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  if (error && !report) {
    return <Notice tone="error" title="Could not load kitchen performance" action={<Button className="h-10" onClick={load}>Try again</Button>}>{explainError(error)}</Notice>;
  }
  if (!report) return <ListSkeleton rows={5} className="pt-2" />;

  const o = report.overall;
  const stations = Object.entries(report.by_station);

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Period" htmlFor="k-period" className="w-52">
          <NativeSelect id="k-period" value={period} onChange={e => setPeriod(e.target.value)}>
            {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </NativeSelect>
        </Field>
        <Button variant="outline" className="h-10" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />Refresh
        </Button>
      </div>

      {o.n === 0 ? (
        <Notice tone="info" title="No finished orders in this period">
          Times appear once the kitchen marks tickets ready. Orders still cooking are not counted.
        </Notice>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Courses served" value={o.n} hint="fired to ready" />
            <Tile label="Average" value={formatDuration(o.avg)} hint="from fire to ready" />
            <Tile label="Slowest 1 in 10" value={formatDuration(o.p90)} hint="90th percentile" />
            <Tile label="Recalled" value={report.recalls} hint="sent back to the kitchen" />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="by-station-h">
              <h2 id="by-station-h" className="typography-title-md mb-2">By station</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-2 font-medium">Station</th>
                    <th className="py-2 pr-2 text-right font-medium">Orders</th>
                    <th className="py-2 pr-2 text-right font-medium">Average</th>
                    <th className="py-2 text-right font-medium">Slowest 1 in 10</th>
                  </tr>
                </thead>
                <tbody>
                  {stations.map(([st, s]) => (
                    <tr key={st} className="border-b border-border/60">
                      <td className="py-2 pr-2 font-medium">{STATION_LABEL[st] || st}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{s.n}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatDuration(s.avg)}</td>
                      <td className="py-2 text-right tabular-nums">{formatDuration(s.p90)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="by-item-h">
              <h2 id="by-item-h" className="typography-title-md mb-2">Slowest dishes</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-2 font-medium">Dish</th>
                      <th className="py-2 pr-2 font-medium">Station</th>
                      <th className="py-2 pr-2 text-right font-medium">Orders</th>
                      <th className="py-2 pr-2 text-right font-medium">Average</th>
                      <th className="py-2 text-right font-medium">Slowest 1 in 10</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.by_item.slice(0, 15).map(i => (
                      <tr key={`${i.name}|${i.station}`} className="border-b border-border/60">
                        <td className="py-2 pr-2 font-medium">{i.name}</td>
                        <td className="py-2 pr-2 text-muted-foreground">{STATION_LABEL[i.station] || i.station}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{i.n}</td>
                        <td className="py-2 pr-2 text-right font-semibold tabular-nums">{formatDuration(i.avg)}</td>
                        <td className="py-2 text-right tabular-nums">{formatDuration(i.p90)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.by_item.length > 15 && <p className="mt-2 text-xs text-muted-foreground">Showing the 15 slowest of {report.by_item.length} dishes.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// The station screens come first and stand on their own: they must show even while the report below
// is loading or has failed, since "nobody is looking at the bar" is the more urgent of the two.
export function KitchenTab() {
  return (
    <div className="flex flex-col gap-4 pt-2">
      <StationScreensPanel />
      <PerformanceReport />
    </div>
  );
}
