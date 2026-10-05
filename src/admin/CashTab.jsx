import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from 'cn';
import { explainError, hubBase, hubGet, hubSend } from './api';
import { ConfirmDialog, Field, ListSkeleton, Notice, TextInput, formatPrice } from './ui';

// Cash & payments: what the system says was taken since the last close, what the drawer and the
// card/UPI statements say, and the stored record of each closed shift. The hub does all the
// arithmetic when a shift is closed; the figures here are a live preview so reception can see the
// difference before committing.

const METHOD_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', other: 'Other' };
const num = v => (v === '' || v === null || v === undefined ? null : Number(v));
const money = n => (n === null || n === undefined || Number.isNaN(n) ? '–' : formatPrice(n));
const when = iso => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–');

function VarianceBadge({ value }) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const v = Math.round(value * 100) / 100;
  const tone = v === 0 ? 'green' : 'rust';
  return (
    <span
      className="inline-flex h-6 items-center rounded-full border px-2 text-xs font-semibold"
      style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` }}
    >
      {v === 0 ? 'Balanced' : `${v > 0 ? 'Over' : 'Short'} ${formatPrice(Math.abs(v))}`}
    </span>
  );
}

export function CashTab({ notify }) {
  const [preview, setPreview] = useState(null);
  const [records, setRecords] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState(null); // { code, message, errors }
  const [form, setForm] = useState({ opening_float: '', counted_cash: '', cash_removed: '', upi: '', card: '', notes: '', closed_by: '' });

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([hubGet('/reconciliation/preview'), hubGet('/reconciliations?limit=30')]);
      setPreview(p);
      setRecords(r.records);
      setError(null);
      // Offer last close's drawer float as this shift's opening float, but never overwrite what was typed.
      setForm(f => (f.opening_float === '' ? { ...f, opening_float: String(p.suggested_opening_float ?? 0) } : f));
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = key => e => { setForm(f => ({ ...f, [key]: e.target.value })); setProblem(null); };

  const cashNet = preview?.by_method?.cash?.net ?? 0;
  const expectedCash = (num(form.opening_float) ?? 0) + cashNet;
  const counted = num(form.counted_cash);
  const cashVariance = counted === null ? null : Math.round((counted - expectedCash) * 100) / 100;
  const variances = useMemo(() => {
    const out = [];
    if (cashVariance !== null) out.push(cashVariance);
    for (const m of ['upi', 'card']) {
      const rep = num(form[m]);
      if (rep !== null && preview) out.push(Math.round((rep - preview.by_method[m].net) * 100) / 100);
    }
    return out;
  }, [cashVariance, form, preview]);
  const hasVariance = variances.some(v => v !== 0);

  const fieldError = name => problem?.errors?.find(e => e.field === name)?.error
    || (name === 'notes' && problem?.code === 'NOTES_REQUIRED_FOR_VARIANCE' ? problem.message : undefined);

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const reported = {};
      if (num(form.upi) !== null) reported.upi = num(form.upi);
      if (num(form.card) !== null) reported.card = num(form.card);
      const { record } = await hubSend('POST', '/reconciliation/close', {
        opening_float: num(form.opening_float) ?? 0,
        counted_cash: counted,
        cash_removed: num(form.cash_removed) ?? 0,
        reported,
        notes: form.notes,
        closed_by: form.closed_by
      });
      setConfirming(false);
      notify(`${record.number} closed${record.has_variance ? ' with a difference' : ': everything balanced'}.`, record.has_variance ? 'warning' : 'success');
      setForm({ opening_float: '', counted_cash: '', cash_removed: '', upi: '', card: '', notes: '', closed_by: form.closed_by });
      await load();
    } catch (e) {
      setConfirming(false);
      setProblem({ code: e.code, message: explainError(e), errors: e.errors });
    } finally {
      setBusy(false);
    }
  };

  if (error && !preview) {
    return <Notice tone="error" title="Could not load the cash screen" action={<Button className="h-10" onClick={load}>Try again</Button>}>{explainError(error)}</Notice>;
  }
  if (!preview || !records) return <ListSkeleton rows={6} className="pt-2" />;

  const ledgerHref = `${hubBase()}/reconciliation/ledger.csv`;

  return (
    <div className="grid gap-4 pt-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="period-h">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="period-h" className="typography-title-md">This shift</h2>
            <p className="text-xs text-muted-foreground">
              {preview.since_last_close ? `Since ${preview.last_record.number}, closed ${when(preview.last_record.closed_at)}` : preview.period_start ? `Since the first payment, ${when(preview.period_start)}` : 'No payments recorded yet'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="h-10" onClick={load}><RefreshCw className="size-4" aria-hidden="true" />Refresh</Button>
            <a href={ledgerHref} className={cn(buttonVariants({ variant: 'outline' }), 'h-10')}><Download className="size-4" aria-hidden="true" />Ledger CSV</a>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-2 font-medium">Method</th>
                <th className="py-2 pr-2 text-right font-medium">Payments</th>
                <th className="py-2 pr-2 text-right font-medium">Refunds</th>
                <th className="py-2 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.by_method).map(([m, v]) => (
                <tr key={m} className="border-b border-border/60">
                  <td className="py-2 pr-2 font-medium">{METHOD_LABEL[m]}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{money(v.payments_total)} <span className="text-xs text-muted-foreground">({v.payments_count})</span></td>
                  <td className="py-2 pr-2 text-right tabular-nums">{v.refunds_total ? `−${money(v.refunds_total)}` : '–'} {v.refunds_count ? <span className="text-xs text-muted-foreground">({v.refunds_count})</span> : null}</td>
                  <td className="py-2 text-right font-semibold tabular-nums">{money(v.net)}</td>
                </tr>
              ))}
              <tr>
                <td className="pt-2 font-semibold">Total</td>
                <td className="pt-2 text-right tabular-nums">{money(preview.totals.payments_total)}</td>
                <td className="pt-2 text-right tabular-nums">{preview.totals.refunds_total ? `−${money(preview.totals.refunds_total)}` : '–'}</td>
                <td className="pt-2 text-right text-base font-bold tabular-nums">{money(preview.totals.net)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {preview.unpaid.count > 0 && (
          <Notice tone="warning" title={`${preview.unpaid.count} bill${preview.unpaid.count > 1 ? 's' : ''} not paid yet (${money(preview.unpaid.total)})`}>
            Unpaid bills are not in these totals. Settle or void them first if the shift is really over.
          </Notice>
        )}
        {preview.voided.count > 0 && (
          <p className="text-xs text-muted-foreground">{preview.voided.count} bill{preview.voided.count > 1 ? 's' : ''} voided this shift ({money(preview.voided.total)}), not counted as payments.</p>
        )}

        <h3 className="mt-2 typography-title-md">Close the shift</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Opening float" htmlFor="c-open" error={fieldError('opening_float')} hint="Cash in the drawer when the shift began.">
            <TextInput id="c-open" inputMode="decimal" value={form.opening_float} onChange={set('opening_float')} invalid={Boolean(fieldError('opening_float'))} />
          </Field>
          <Field label="Cash counted now" htmlFor="c-counted" error={fieldError('counted_cash')} hint="Everything in the drawer, notes and coins.">
            <TextInput id="c-counted" inputMode="decimal" value={form.counted_cash} onChange={set('counted_cash')} invalid={Boolean(fieldError('counted_cash'))} />
          </Field>
          <Field label="Cash taken out" htmlFor="c-removed" error={fieldError('cash_removed')} hint="Banked or moved to the safe. What stays is next shift's float.">
            <TextInput id="c-removed" inputMode="decimal" value={form.cash_removed} onChange={set('cash_removed')} invalid={Boolean(fieldError('cash_removed'))} />
          </Field>
          <Field label="Closed by" htmlFor="c-by" hint="Your name, for the record.">
            <TextInput id="c-by" value={form.closed_by} onChange={set('closed_by')} maxLength={60} />
          </Field>
          <Field label="UPI total on your statement" htmlFor="c-upi" error={fieldError('reported.upi')} hint="Optional. Compared with the system's UPI total.">
            <TextInput id="c-upi" inputMode="decimal" value={form.upi} onChange={set('upi')} invalid={Boolean(fieldError('reported.upi'))} />
          </Field>
          <Field label="Card total on the terminal" htmlFor="c-card" error={fieldError('reported.card')} hint="Optional. Compared with the system's card total.">
            <TextInput id="c-card" inputMode="decimal" value={form.card} onChange={set('card')} invalid={Boolean(fieldError('reported.card'))} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-muted px-3 py-2 text-sm">
          <span>Expected in drawer: <strong className="tabular-nums">{money(expectedCash)}</strong></span>
          <span>Counted: <strong className="tabular-nums">{money(counted)}</strong></span>
          <VarianceBadge value={cashVariance} />
        </div>

        <Field label={hasVariance ? 'Note: explain the difference (required)' : 'Note (optional)'} htmlFor="c-notes" error={fieldError('notes')}>
          <TextInput id="c-notes" value={form.notes} onChange={set('notes')} maxLength={500} invalid={Boolean(fieldError('notes'))} />
        </Field>

        {problem && !problem.errors && problem.code !== 'NOTES_REQUIRED_FOR_VARIANCE' && <Notice tone="error">{problem.message}</Notice>}

        <div className="flex justify-end">
          <Button className="h-11 px-6" disabled={busy || counted === null} onClick={() => setConfirming(true)}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Close shift
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="history-h">
        <h2 id="history-h" className="typography-title-md">Closed shifts</h2>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shift has been closed yet. The first close starts the record.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {records.map(r => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{r.number}</span>
                    <VarianceBadge value={r.cash_variance} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {when(r.period_end)}{r.closed_by ? ` · ${r.closed_by}` : ''} · expected {money(r.expected_cash)}, counted {money(r.counted_cash)}
                  </div>
                  {r.notes && <div className="mt-0.5 text-xs italic text-muted-foreground">“{r.notes}”</div>}
                </div>
                <a
                  href={`${ledgerHref}?${new URLSearchParams({ ...(r.period_start ? { from: r.period_start } : {}), to: r.period_end })}`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-9')}
                  aria-label={`Download the ledger for ${r.number}`}
                >
                  <Download className="size-4" aria-hidden="true" />CSV
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirming}
        title="Close this shift?"
        confirmLabel="Close shift"
        destructive={false}
        busy={busy}
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
      >
        {hasVariance
          ? 'The counts do not match the system. The difference is saved in the record, and a closed shift cannot be changed.'
          : 'Everything balances. A closed shift is saved as a permanent record and cannot be changed.'}
      </ConfirmDialog>
    </div>
  );
}
