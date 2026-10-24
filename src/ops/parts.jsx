import React from 'react';
import { ChefHat } from 'lucide-react';
import { cn } from 'cn';

// Small pieces the console's screens share. Everything sits on the product's design tokens, so the console reads as part of the same product.

const TONES = {
  good: ['--status-green-bg', '--status-green-text', '--status-green-border'],
  bad: ['--status-rust-bg', '--status-rust-text', '--status-rust-border'],
  warning: ['--status-amber-bg', '--status-amber-text', '--status-amber-border'],
  info: ['--status-blue-bg', '--status-blue-text', '--status-blue-border']
};

/** A small coloured label. Tones are good, bad, warning, info; anything else is plain. */
export function Chip({ tone = 'muted', children, className }) {
  const [bg, fg, border] = TONES[tone] ?? [];
  return (
    <span
      data-tone={bg ? tone : 'muted'}
      className={cn('inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', !bg && 'border-border bg-secondary text-muted-foreground', className)}
      style={bg ? { background: `var(${bg})`, color: `var(${fg})`, borderColor: `var(${border})` } : undefined}
    >
      {children}
    </span>
  );
}

/** The page: a header with the console's name and whatever sits on the right, and a column of content. */
export function Shell({ children, actions, status }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
              <ChefHat size={20} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="typography-display-sm truncate" style={{ color: 'var(--color-ink)' }}>Operator console</h1>
              <p className="text-xs text-muted-foreground">Read-only</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status}
            {actions}
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-4 sm:px-6">{children}</main>
    </div>
  );
}

/** A card with a heading. The heading names the region, so a screen reader can jump to it. */
export function Section({ id, title, aside, level = 2, children }) {
  const Heading = `h${level}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading id={id} className="typography-heading-sm font-semibold">{title}</Heading>
        {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A figure with its label. */
export function Tile({ label, value, sub, tone }) {
  const [, fg] = TONES[tone] ?? [];
  return (
    <div role="group" aria-label={label} data-tone={fg ? tone : 'none'} className="flex flex-col gap-0.5 rounded-xl border border-border bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground" aria-hidden="true">{label}</span>
      <span className="typography-display-sm" style={fg ? { color: `var(${fg})` } : undefined}>{value}</span>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : <span className="text-xs">&nbsp;</span>}
    </div>
  );
}

/** Labels and what they say, in two columns. */
export function Facts({ rows }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** A restaurant's name that opens it. */
export function NameButton({ onClick, children, className }) {
  return (
    <button type="button" onClick={onClick} className={cn('rounded text-left font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]', className)}>
      {children}
    </button>
  );
}
