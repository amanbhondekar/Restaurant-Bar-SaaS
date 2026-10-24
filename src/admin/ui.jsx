import React, { useRef } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// Small building blocks shared by the admin page. Everything here sits on the existing shadcn
// components and the design tokens; controls are 40px tall (h-10) so they are easy to hit.

const TONES = {
  error: { bg: 'var(--status-rust-bg)', fg: 'var(--status-rust-text)', border: 'var(--status-rust-border)', Icon: AlertTriangle },
  warning: { bg: 'var(--status-amber-bg)', fg: 'var(--status-amber-text)', border: 'var(--status-amber-border)', Icon: AlertTriangle },
  success: { bg: 'var(--status-green-bg)', fg: 'var(--status-green-text)', border: 'var(--status-green-border)', Icon: CheckCircle2 },
  info: { bg: 'var(--status-blue-bg)', fg: 'var(--status-blue-text)', border: 'var(--status-blue-border)', Icon: Info }
};

/** A coloured message bar. `action` is a node (usually a Retry or Reload button). */
export function Notice({ tone = 'info', title, children, action, className }) {
  const { bg, fg, border, Icon } = TONES[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-sm', className)}
      style={{ background: bg, color: fg, borderColor: border }}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-60">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** A labelled form control with an optional hint and error line. */
export function Field({ label, htmlFor, error, hint, className, children }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && <Label htmlFor={htmlFor} className="text-sm font-medium">{label}</Label>}
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** The shadcn Input at 40px, flagged invalid when it has an error. */
export function TextInput({ className, invalid, ...props }) {
  return <Input className={cn('h-10', className)} aria-invalid={invalid ? true : undefined} {...props} />;
}

/** A native select styled like the inputs: keyboard and phone friendly, and the browser draws the list. */
export function NativeSelect({ className, invalid, children, ...props }) {
  return (
    <select
      aria-invalid={invalid ? true : undefined}
      className={cn(
        'h-10 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none transition-colors',
        'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

/** The last non-empty value it was given: lets a dialog keep its text while it fades out after `value` is cleared. */
export function useLastValue(value) {
  const last = useRef(value);
  if (value) last.current = value;
  return last.current;
}

/** A 40px close button for a dialog or sheet (the built-in one is 28px). Pass showCloseButton={false} to the content. */
export function CloseButton({ onClick, disabled }) {
  return (
    <Button type="button" variant="ghost" size="icon" className="absolute top-2 right-2 size-10" aria-label="Close" onClick={onClick} disabled={disabled}>
      <X aria-hidden="true" />
    </Button>
  );
}

/** A "are you sure" dialog. Render it inside another dialog or sheet to stack on top of it. */
export function ConfirmDialog({ open, title, children, confirmLabel = 'Delete', cancelLabel = 'Cancel', destructive = true, busy = false, onConfirm, onCancel }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{children}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" className="h-10" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button variant={destructive ? 'destructive' : 'default'} className="h-10" onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="spin" aria-hidden="true" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Grey placeholder bars while a read is in flight. */
export function ListSkeleton({ rows = 5, className }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}

/** Centered empty state with an optional action. */
export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="empty-state flex flex-col items-center gap-2">
      {Icon && <Icon className="size-8 text-muted-foreground" aria-hidden="true" />}
      <div className="empty-state-title">{title}</div>
      {children && <p className="max-w-md">{children}</p>}
      {action}
    </div>
  );
}

/** "₹280" or "₹49.50". */
export const formatPrice = n => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `₹${Number.isInteger(v) ? v : v.toFixed(2)}`;
};
