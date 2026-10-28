import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Star } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { explainError, hubGet } from './api';
import {
  FILTERS, attentionCount, billLabel, distributionRows, filterEntries,
  needsAttention, ratingLabel, starsText, summaryLine, tableLabel
} from './lib/feedback';
import { formatWhen } from './lib/plan';
import { EmptyState, ListSkeleton, Notice } from './ui';

// What guests said, for reception (M4 · 4.5). Read-only: the hub keeps the feedback and this only
// shows it. All wording and arithmetic live in ./lib/feedback.
//
// Every comment here was typed by a stranger on their phone. It is rendered as plain text by
// React, never as markup, so a guest writing angle brackets sees angle brackets.

function Distribution({ summary }) {
  const rows = distributionRows(summary);
  if (rows.length === 0) return null;
  return (
    <ul className="flex min-w-48 flex-1 flex-col gap-1" aria-label="How the ratings split">
      {rows.map(row => (
        <li key={row.rating} className="flex items-center gap-2 text-xs">
          <span className="w-6 tabular-nums text-muted-foreground">{row.rating} ★</span>
          {/* Decoration over the number beside it, so it is hidden from screen readers. */}
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span className="block h-full rounded-full" style={{ width: `${row.percent}%`, background: 'var(--color-primary)' }} />
          </span>
          <span className="w-8 text-right tabular-nums text-muted-foreground">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}

function Entry({ entry }) {
  const attention = needsAttention(entry);
  return (
    <li
      className={cn('rounded-xl border bg-card px-4 py-3', attention ? 'border-l-4' : 'border-border')}
      style={attention ? { borderColor: 'var(--status-rust-border)', borderLeftColor: 'var(--status-rust-text)' } : undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-lg leading-none" style={{ color: 'var(--color-primary)' }} role="img" aria-label={ratingLabel(entry.rating)}>
          {starsText(entry.rating)}
        </span>
        <span className="text-xs text-muted-foreground">
          {tableLabel(entry)} · {billLabel(entry)} · {formatWhen(entry.created_at)}
        </span>
      </div>
      {entry.comment
        ? <p className="mt-2 whitespace-pre-wrap break-words text-sm">{entry.comment}</p>
        : <p className="mt-2 text-sm italic text-muted-foreground">No comment left.</p>}
    </li>
  );
}

export function FeedbackTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await hubGet('/feedback'));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error && !data) {
    return (
      <Notice tone="error" title="Could not load guest feedback" action={<Button className="h-10" onClick={load}>Try again</Button>}>
        {explainError(error)}
      </Notice>
    );
  }
  if (!data) return <ListSkeleton rows={4} className="pt-2" />;

  const entries = Array.isArray(data.entries) ? data.entries : [];
  const shown = filterEntries(entries, filter);
  const attention = attentionCount(entries);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Guest feedback</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums">{data.average ?? '–'}</span>
            <span className="text-sm text-muted-foreground">{summaryLine(data)}</span>
          </div>
        </div>
        <Distribution summary={data} />
        <Button variant="outline" className="h-10" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {entries.length === 0 ? (
        <EmptyState icon={Star} title="No feedback yet">
          Guests can rate their meal from the menu they open by scanning the code on their table. Print the codes from the Tables tab.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter feedback">
            {FILTERS.map(f => (
              <Button
                key={f.id}
                type="button"
                variant={filter === f.id ? 'default' : 'outline'}
                className="h-10"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}{f.id === 'attention' && attention > 0 ? ` (${attention})` : ''}
              </Button>
            ))}
          </div>

          {shown.length === 0
            ? <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches that filter.</p>
            : <ul className="flex flex-col gap-2">{shown.map(e => <Entry key={e.id} entry={e} />)}</ul>}

          {/* The list is capped; the average and split above are not. Say so rather than letting
              a long-running restaurant wonder why 130 ratings only shows 100 below. */}
          {data.count > entries.length && (
            <p className="text-center text-xs text-muted-foreground">
              Showing the latest {entries.length} of {data.count}. The average and split above cover all of them.
            </p>
          )}
        </>
      )}

      {error && <Notice tone="warning">{explainError(error)} Showing the last answer from the hub.</Notice>}
    </div>
  );
}
