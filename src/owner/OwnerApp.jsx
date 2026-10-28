import React, { useCallback, useEffect, useState } from 'react';
import { ChefHat, LogOut, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Field, ListSkeleton, Notice, TextInput } from '@/admin/ui';
import { dishLine, hourRows, kpis, methodLine, money, moreDishes } from '@/admin/lib/sales';
import { formatWhen, planLabel } from '@/admin/lib/plan';
import { freshness, loadOwnerSnapshot } from './lib/ownerData';

// The owner's view of the restaurant from anywhere (§3 owner console): sales, the till, stock, what guests said. It is
// READ-ONLY, and the database makes it so: an owner's login can read their restaurant and change nothing (migration
// 015), so nothing on this screen has a way to write and nothing here could be talked into one.
//
// It shows what the hub last sent the cloud, and says how long ago that was. A hub that is off, or has no internet,
// leaves this page as old as its last upload, and the page says so rather than showing yesterday as today.

const PERIODS = [{ id: 'today', label: 'Today' }, { id: 'week', label: 'This week' }, { id: 'month', label: 'This month' }];

function Shell({ children, onSignOut, name }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
              <ChefHat size={20} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="typography-display-sm truncate" style={{ color: 'var(--color-ink)' }}>{name || 'Your restaurant'}</h1>
              <p className="text-xs text-muted-foreground">Owner view · read-only</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle className="size-10" />
            {onSignOut && (
              <Button variant="outline" className="h-10" onClick={onSignOut}>
                <LogOut className="size-4" aria-hidden="true" /> Sign out
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 py-4 sm:px-6">{children}</main>
    </div>
  );
}

function Section({ title, aside, children }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="typography-heading-sm font-semibold">{title}</h2>
        {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const TONE = { good: 'var(--status-green-text)', bad: 'var(--status-rust-text)', neutral: 'var(--muted-foreground)' };

function Login({ client, onError }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setProblem('');
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setProblem(/invalid login/i.test(error.message) ? 'That email or password is not right.' : error.message);
    } catch {
      setProblem('Could not reach the service. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <form className="mx-auto flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-card px-5 py-6" onSubmit={submit}>
        <h2 className="typography-heading-sm font-semibold">Sign in</h2>
        <p className="text-sm text-muted-foreground">With the email your restaurant's account was set up for.</p>
        <Field label="Email" htmlFor="owner-email">
          <TextInput id="owner-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="owner-password" error={problem}>
          <TextInput id="owner-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} invalid={Boolean(problem)} required />
        </Field>
        <Button type="submit" className="h-10" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </Shell>
  );
}

function Dashboard({ client, onSignOut }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState('today');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnap(await loadOwnerSnapshot(client));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [client]);
  useEffect(() => { load(); }, [load]);

  if (error && !snap) {
    return (
      <Shell onSignOut={onSignOut}>
        <Notice tone="error" title="Could not load your restaurant" action={<Button className="h-10" onClick={load}>Try again</Button>}>{error.message}</Notice>
      </Shell>
    );
  }
  if (!snap) return <Shell onSignOut={onSignOut}><ListSkeleton rows={4} /></Shell>;

  if (!snap.restaurant) {
    return (
      <Shell onSignOut={onSignOut}>
        {snap.attached === false ? (
          <Notice tone="warning" title="This login is not attached to a restaurant">Ask whoever set up your account to add you as an owner. Nothing is wrong with your password.</Notice>
        ) : (
          <Notice tone="error" title="Could not load your restaurant" action={<Button className="h-10" onClick={load}>Try again</Button>}>{snap.errors.restaurant}</Notice>
        )}
      </Shell>
    );
  }

  const { restaurant, currency, errors } = snap;
  const fresh = freshness(snap.syncedAt);
  const report = snap.sales?.[period];

  return (
    <Shell onSignOut={onSignOut} name={restaurant.name}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {restaurant.city && `${restaurant.city} · `}{planLabel(restaurant.plan)} plan, {restaurant.plan_status}
          {restaurant.plan_status === 'trialing' && restaurant.trial_ends_at ? ` until ${formatWhen(restaurant.trial_ends_at)}` : ''}
        </p>
        <Button variant="outline" className="h-10" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" /> Refresh
        </Button>
      </div>

      {fresh ? (
        <Notice tone={fresh.stale ? 'warning' : 'info'} title={fresh.stale ? `The restaurant last sent anything ${fresh.text}` : `Updated ${fresh.text}`}>
          {fresh.stale
            ? 'What follows is as old as that. If the restaurant is open, its laptop may be off or without internet; your figures catch up when it reconnects.'
            : 'This is what the restaurant\'s laptop last sent. It sends changes as they happen whenever it has internet.'}
        </Notice>
      ) : (
        !errors.sales && <Notice tone="info" title="Nothing has arrived from the restaurant yet">Figures appear here once its laptop has connected to the internet.</Notice>
      )}

      {errors.sales ? (
        <Notice tone="error" title="Sales could not be loaded">{errors.sales}</Notice>
      ) : report && (
        <Section title="Sales" aside={`${report.period.label}, set against ${report.period.previous_label}`}>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Period">
            {PERIODS.map(p => (
              <Button key={p.id} type="button" variant={period === p.id ? 'default' : 'outline'} className="h-10" aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            {kpis(report, currency).map(row => (
              <div key={row.id} className="flex min-w-40 flex-1 flex-col gap-1 rounded-lg border border-border px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{row.label}</div>
                <div className="text-2xl font-bold tabular-nums">{row.value}</div>
                {row.change && <div className="text-xs" style={{ color: TONE[row.tone] }}>{row.change}</div>}
              </div>
            ))}
          </div>
          {methodLine(report.current.takings.by_method, currency) && <p className="text-sm text-muted-foreground">Taken by: {methodLine(report.current.takings.by_method, currency)}</p>}
          {snap.salesPartial && <Notice tone="warning">There are more bills than this page reads at once, so these figures may be short.</Notice>}
          {report.current.top_dishes.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Best sellers {moreDishes(report.current) && <span className="font-normal text-muted-foreground">({moreDishes(report.current)})</span>}</h3>
              <ol className="flex flex-col gap-1">
                {report.current.top_dishes.map((d, i) => (
                  <li key={d.name} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate"><span className="mr-2 tabular-nums text-muted-foreground">{i + 1}.</span>{d.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{dishLine(d, currency)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {hourRows(report.current.by_hour, currency).length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="Bills by hour">
              {hourRows(report.current.by_hour, currency).map(h => (
                <li key={h.hour} className="flex items-center gap-2 text-xs">
                  <span className="w-10 shrink-0 tabular-nums text-muted-foreground">{h.label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className="block h-full rounded-full" style={{ width: `${h.percent}%`, background: 'var(--color-primary)' }} /></span>
                  <span className="w-40 shrink-0 text-right tabular-nums text-muted-foreground">{h.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="The till" aside="the last closed shifts">
          {errors.cashups ? <Notice tone="error">{errors.cashups}</Notice> : !snap.cashups?.length ? (
            <p className="text-sm text-muted-foreground">No shift has been closed yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {snap.cashups.map(c => (
                <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span><strong>{c.number}</strong> <span className="text-muted-foreground">· {formatWhen(c.period_end)}{c.closed_by ? ` · ${c.closed_by}` : ''}</span></span>
                  <span className="tabular-nums" style={{ color: c.has_variance ? TONE.bad : undefined }}>
                    {c.has_variance ? `${money(Math.abs(c.cash_variance), currency)} ${c.cash_variance < 0 ? 'short' : 'over'}` : 'Balanced'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Stock">
          {errors.stock ? <Notice tone="error">{errors.stock}</Notice> : !snap.stock ? null : snap.stock.out.length + snap.stock.low.length === 0 ? (
            <p className="text-sm text-muted-foreground">{snap.stock.items.length ? 'Nothing is out or running low.' : 'No stock is tracked yet.'}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {[...snap.stock.out, ...snap.stock.low].map(i => (
                <li key={i.hub_ref} className="flex items-baseline justify-between gap-3 text-sm">
                  <span>{i.name}</span>
                  <span className="tabular-nums" style={{ color: i.level === 'out' ? TONE.bad : undefined }}>{i.level === 'out' ? 'Out' : `Low: ${i.on_hand} ${i.unit} left`}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="What guests said">
        {errors.feedback ? <Notice tone="error">{errors.feedback}</Notice> : !snap.feedback ? null : snap.feedback.count === 0 ? (
          <p className="text-sm text-muted-foreground">No feedback yet.</p>
        ) : (
          <>
            <p className="text-sm"><span className="text-2xl font-bold tabular-nums">{snap.feedback.average}</span> <span className="text-muted-foreground">average from {snap.feedback.count}{snap.feedback.capped ? ' (the latest 500)' : ''} ratings</span></p>
            {snap.feedback.low.length > 0 && (
              <ul className="flex flex-col gap-2">
                {snap.feedback.low.map(f => (
                  <li key={f.hub_ref} className={cn('rounded-lg border px-3 py-2 text-sm')} style={{ borderColor: 'var(--status-rust-border)' }}>
                    <span style={{ color: 'var(--status-rust-text)' }}>{f.rating} ★</span>
                    <span className="text-muted-foreground"> · {f.table_label || 'the floor'} · {formatWhen(f.created_at)}</span>
                    {f.comment && <p className="mt-1 whitespace-pre-wrap break-words">{f.comment}</p>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>
    </Shell>
  );
}

/**
 * `client` is a supabase-js client, or null when the page has not been given a project to talk to.
 */
export function OwnerApp({ client }) {
  const [session, setSession] = useState(undefined);   // undefined: not known yet

  useEffect(() => {
    if (!client) return undefined;
    let live = true;
    client.auth.getSession().then(({ data }) => { if (live) setSession(data?.session ?? null); }).catch(() => { if (live) setSession(null); });
    const { data } = client.auth.onAuthStateChange((_event, next) => { if (live) setSession(next ?? null); });
    return () => { live = false; data?.subscription?.unsubscribe?.(); };
  }, [client]);

  if (!client) {
    return (
      <Shell>
        <Notice tone="warning" title="This page is not connected to your restaurant's account yet">
          It needs the address and public key of the cloud project it should read from. Ask whoever set it up.
        </Notice>
      </Shell>
    );
  }
  if (session === undefined) return <Shell><ListSkeleton rows={3} /></Shell>;
  if (!session) return <Login client={client} />;
  return <Dashboard client={client} onSignOut={() => client.auth.signOut()} />;
}
