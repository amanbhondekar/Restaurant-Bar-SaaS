import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, MessageCircle, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { Button, buttonVariants } from '@/components/ui/button';
import { explainError, hubGet, hubSend } from './api';
import {
  PERIODS, customRange, dishLine, guestLine, hourRows, kpis, methodLine, monthLabel, moreDishes,
  retentionLine, showPhone
} from './lib/sales';
import { formatWhen } from './lib/plan';
import { EmptyState, Field, ListSkeleton, Notice, TextInput } from './ui';

// How the restaurant is doing (§3 analytics), for reception. Read-only apart from the owner's number and
// marking a summary as opened in WhatsApp. The hub does the sums, from the same ledger the cash screen
// uses, in the restaurant's local time; this shows them next to the same stretch of the period before, so
// "today so far" is never set against all of yesterday. All wording lives in ./lib/sales.

const RECENT = 6;   // the hub keeps months of summaries; the newest are the ones anyone wants to send

const TONE = {
  good: { color: 'var(--status-green-text)' },
  bad: { color: 'var(--status-rust-text)' },
  neutral: { color: 'var(--muted-foreground)' }
};

function Kpi({ row }) {
  return (
    <div className="flex min-w-40 flex-1 flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{row.label}</div>
      <div className="text-2xl font-bold tabular-nums">{row.value}</div>
      {row.change && <div className="text-xs" style={TONE[row.tone]}>{row.change}</div>}
    </div>
  );
}

function Section({ title, children, aside }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="typography-heading-sm font-semibold">{title}</h3>
        {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Sales({ report, currency }) {
  const c = report.current;
  const empty = c.bills.count === 0 && c.takings.payments === 0 && c.takings.refunds === 0 && c.voided.count === 0;
  const methods = methodLine(c.takings.by_method, currency);
  const hours = hourRows(c.by_hour, currency);
  const more = moreDishes(c);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">{kpis(report, currency).map(row => <Kpi key={row.id} row={row} />)}</div>
      {methods && <p className="text-sm text-muted-foreground">Taken by: {methods}</p>}

      {empty ? (
        <EmptyState icon={BarChart3} title="No sales in this period">
          Bills raised and money taken will appear here as they happen.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Best sellers" aside={more}>
            {c.top_dishes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No dishes sold.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {c.top_dishes.map((d, i) => (
                  <li key={d.name} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate"><span className="mr-2 tabular-nums text-muted-foreground">{i + 1}.</span>{d.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{dishLine(d, currency)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Busy hours" aside="by the time the bill was raised">
            {hours.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bills raised.</p>
            ) : (
              <ul className="flex flex-col gap-1.5" aria-label="Bills by hour">
                {hours.map(h => (
                  <li key={h.hour} className="flex items-center gap-2 text-xs">
                    <span className="w-10 shrink-0 tabular-nums text-muted-foreground">{h.label}</span>
                    {/* The bar repeats the words beside it, so it is hidden from screen readers. */}
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <span className="block h-full rounded-full" style={{ width: `${h.percent}%`, background: 'var(--color-primary)' }} />
                    </span>
                    <span className="w-40 shrink-0 text-right tabular-nums text-muted-foreground">{h.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

function Guests({ guests, cohorts }) {
  const retention = retentionLine(guests);
  return (
    <Section title="Guests" aside="from seated bookings and walk-ins">
      <p className="text-sm">{guestLine(guests)}</p>
      {retention && <p className="text-sm text-muted-foreground">{retention}</p>}
      {cohorts.length > 0 && (
        <table className="w-full text-sm">
          <caption className="sr-only">Guests by the month of their first visit</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-1 font-medium">First visit</th>
              <th scope="col" className="py-1 text-right font-medium">Guests</th>
              <th scope="col" className="py-1 text-right font-medium">Came back</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map(row => (
              <tr key={row.month} className="border-t border-border">
                <th scope="row" className="py-1.5 text-left font-normal">{monthLabel(row.month)}</th>
                <td className="py-1.5 text-right tabular-nums">{row.guests}</td>
                <td className="py-1.5 text-right tabular-nums">{row.returned} ({row.returned_pct}%)</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function Summaries({ data, error, onReload, onContact, onOpened, busy }) {
  const [phone, setPhone] = useState('');
  const [problem, setProblem] = useState('');
  const [showAll, setShowAll] = useState(false);
  const saved = data?.contact ?? '';
  useEffect(() => { setPhone(saved ? showPhone(saved) : ''); }, [saved]);

  const save = async event => {
    event.preventDefault();
    setProblem('');
    const result = await onContact(phone);
    if (result) setProblem(result);
  };

  if (error && !data) {
    return (
      <Notice tone="error" title="Could not load the summaries" action={<Button className="h-10" onClick={onReload}>Try again</Button>}>
        {explainError(error)}
      </Notice>
    );
  }
  if (!data) return <ListSkeleton rows={3} />;

  return (
    <Section title="Daily and weekly summaries" aside="prepared by the hub; you send them">
      <p className="text-sm text-muted-foreground">
        The hub writes yesterday's summary each morning and last week's each Monday. It cannot send them itself: tapping Send opens WhatsApp with the message written, ready for you to send.
      </p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={save}>
        <Field label="Owner's WhatsApp number" htmlFor="owner-phone" error={problem} hint={saved ? undefined : 'Without a number, WhatsApp asks who to send it to.'} className="w-64">
          <TextInput id="owner-phone" inputMode="tel" autoComplete="off" placeholder="98765 43210" value={phone} invalid={Boolean(problem)} onChange={e => { setPhone(e.target.value); setProblem(''); }} />
        </Field>
        <Button type="submit" variant="outline" className="h-10" disabled={busy}>{phone.trim() === '' && saved ? 'Remove number' : 'Save number'}</Button>
      </form>

      {data.summaries.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">Nothing to summarise yet. The first one appears the morning after a day with sales.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {(showAll ? data.summaries : data.summaries.slice(0, RECENT)).map(s => (
            <li key={s.id} className="rounded-lg border border-border px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{s.title}</div>
                  <div className="text-xs text-muted-foreground">{s.sent_at ? `Opened in WhatsApp · ${formatWhen(s.sent_at)}` : 'Not sent yet'}</div>
                </div>
                <a
                  href={s.whatsapp}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(buttonVariants({ variant: s.sent_at ? 'outline' : 'default' }), 'h-10')}
                  aria-label={`${s.sent_at ? 'Send again' : 'Send'} ${s.title} on WhatsApp`}
                  onClick={() => onOpened(s.id)}
                >
                  <MessageCircle className="size-4" aria-hidden="true" />
                  {s.sent_at ? 'Send again' : 'Send on WhatsApp'}
                </a>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">Read it</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{s.text}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
      {data.summaries.length > RECENT && (
        <Button type="button" variant="outline" className="h-10 self-start" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show fewer' : `Show ${data.summaries.length - RECENT} older`}
        </Button>
      )}
    </Section>
  );
}

export function SalesTab({ notify }) {
  const [period, setPeriod] = useState('today');
  const [days, setDays] = useState({ from: '', to: '' });
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [summaries, setSummaries] = useState(null);
  const [summariesError, setSummariesError] = useState(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const range = period === 'custom' ? customRange(days.from, days.to) : null;
  const rangeKey = range?.ok ? `${range.from}|${range.to}` : '';

  const load = useCallback(async () => {
    if (period === 'custom' && !rangeKey) { setReport(null); setError(null); return; }
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const query = period === 'custom' ? `period=custom&from=${encodeURIComponent(rangeKey.split('|')[0])}&to=${encodeURIComponent(rangeKey.split('|')[1])}` : `period=${period}`;
      const next = await hubGet(`/admin/sales?${query}`);
      if (ticket !== latest.current) return;   // a newer question has been asked since
      setReport(next);
      setError(null);
    } catch (e) {
      if (ticket !== latest.current) return;
      setError(e);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [period, rangeKey]);

  useEffect(() => { load(); }, [load]);

  const loadSummaries = useCallback(async () => {
    try {
      setSummaries(await hubGet('/admin/reports'));
      setSummariesError(null);
    } catch (e) {
      setSummariesError(e);
    }
  }, []);
  useEffect(() => { loadSummaries(); }, [loadSummaries]);

  const saveContact = async phone => {
    setBusy(true);
    try {
      const result = await hubSend('PUT', '/admin/reports/contact', { phone });
      await loadSummaries();
      notify?.(result.contact ? 'Number saved. New links go straight to it.' : 'Number removed.');
      return '';
    } catch (e) {
      return e.code === 'INVALID_PHONE' ? e.error : explainError(e);
    } finally {
      setBusy(false);
    }
  };

  // Tapping Send opens WhatsApp whatever happens here; marking it is a note for later, not a gate.
  const opened = async id => {
    try {
      const { sent_at: sentAt } = await hubSend('POST', `/admin/reports/${encodeURIComponent(id)}/sent`);
      setSummaries(prev => prev && { ...prev, summaries: prev.summaries.map(s => (s.id === id ? { ...s, sent_at: sentAt } : s)) });
    } catch {
      notify?.('WhatsApp opened, but the hub could not note that it was sent.', 'error');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Period">
          {PERIODS.map(p => (
            <Button key={p.id} type="button" variant={period === p.id ? 'default' : 'outline'} className="h-10" aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>
              {p.label}
            </Button>
          ))}
        </div>
        <Button variant="outline" className="h-10" onClick={() => { load(); loadSummaries(); }} disabled={loading}>
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {period === 'custom' && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From" htmlFor="sales-from"><TextInput id="sales-from" type="date" value={days.from} onChange={e => setDays(d => ({ ...d, from: e.target.value }))} /></Field>
          <Field label="To (including this day)" htmlFor="sales-to"><TextInput id="sales-to" type="date" value={days.to} onChange={e => setDays(d => ({ ...d, to: e.target.value }))} /></Field>
          {range && !range.ok && (days.from || days.to) && <p className="pb-2 text-sm text-muted-foreground">{range.error}</p>}
        </div>
      )}

      {report && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{report.period.label}</span>, set against {report.period.previous_label}.
        </p>
      )}

      {error && !report ? (
        <Notice tone="error" title="Could not load the figures" action={<Button className="h-10" onClick={load}>Try again</Button>}>
          {error.code === 'INVALID_RANGE' || error.code === 'INVALID_PERIOD' ? error.error : explainError(error)}
        </Notice>
      ) : !report ? (
        period === 'custom' && !rangeKey ? <p className="py-6 text-center text-sm text-muted-foreground">Choose the first and last day to see the figures.</p> : <ListSkeleton rows={4} />
      ) : (
        <>
          <Sales report={report} currency={report.currency} />
          <Guests guests={report.guests} cohorts={report.cohorts} />
        </>
      )}
      {error && report && <Notice tone="warning">{explainError(error)} Showing the last answer from the hub.</Notice>}

      <Summaries data={summaries} error={summariesError} onReload={loadSummaries} onContact={saveContact} onOpened={opened} busy={busy} />
    </div>
  );
}
