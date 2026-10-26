import React from 'react';
import { ShieldCheck } from 'lucide-react';

// The frames the console's screens sit in. Everything rests on the product's design tokens (Cabinet Grotesk and Instrument Sans, the Kullina light
// theme), so the console reads as part of the same product.

const MARK = (
  <div className="flex size-10 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
    <ShieldCheck size={20} aria-hidden="true" />
  </div>
);

/** A single card in the middle of the page: the screens before anyone is let in. */
export function Frame({ title, children }) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-background px-4 py-10 text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex items-center gap-3">
          {MARK}
          <p className="typography-display-sm" style={{ color: 'var(--color-ink)' }}>Kullina admin</p>
        </div>
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-6">
          <h2 className="typography-heading-sm font-semibold">{title}</h2>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The console proper: a header with the product's name and whatever sits on the right, a way to move around, and a column of content. */
export function ConsoleShell({ nav, status, actions, children }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {MARK}
            <div className="min-w-0">
              <h1 className="typography-display-sm truncate" style={{ color: 'var(--color-ink)' }}>Kullina admin</h1>
              <p className="text-xs text-muted-foreground">Every action here is recorded</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status}
            {actions}
          </div>
        </div>
        <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6">{nav}</div>
      </header>
      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-4 sm:px-6">{children}</main>
    </div>
  );
}
