import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, MessageCircle, Phone, Plus, UserPlus } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from 'cn';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { explainError, hubGet, hubSend } from './api';
import { EmptyState, Field, ListSkeleton, NativeSelect, Notice, TextInput } from './ui';
import {
  RESERVATION_LABEL, RESERVATION_TONE, WAITLIST_LABEL, WAITLIST_TONE,
  bookingTime, bookingsSummary, checkBooking, checkWalkIn, dayLabel, defaultBookingTime, formatWait, overdue, shiftDay, today, waitedMins
} from './lib/bookings';

// The front-of-house diary (§4.6): tonight's bookings and who is waiting at the door.
//
// Guests are reached by WhatsApp click-to-chat: the hub builds a link with the message already
// written, and a member of staff taps it to send from their own phone. No provider, no approval, no
// per-message fee -- and it works on a hub with no internet at all.

const toneStyle = tone => (tone === 'muted'
  ? undefined
  : { background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` });

/** The two ways to reach a guest, or nothing at all when they left no number. */
function ContactButtons({ row, label }) {
  if (!row.phone) return <span className="text-xs text-muted-foreground">No number</span>;
  return (
    <>
      <a href={row.whatsapp} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'outline' }), 'h-9')} aria-label={`Message ${row.guest_name} on WhatsApp${label ? ` — ${label}` : ''}`}>
        <MessageCircle className="size-4" aria-hidden="true" />WhatsApp
      </a>
      <a href={row.tel} className={cn(buttonVariants({ variant: 'outline' }), 'h-9')} aria-label={`Call ${row.guest_name}`}>
        <Phone className="size-4" aria-hidden="true" />
      </a>
    </>
  );
}

function FormDialog({ open, title, description, confirmLabel, busy, canConfirm = true, onConfirm, onCancel, children }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onCancel(); }}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <form onSubmit={e => { e.preventDefault(); if (canConfirm && !busy) onConfirm(); }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="flex flex-col gap-3 py-3">{children}</div>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button type="submit" className="h-10" disabled={busy || !canConfirm}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BookingDialog({ day, onSave, onCancel, busy, serverError, conflict }) {
  const [form, setForm] = useState(() => ({ guest_name: '', phone: '', party_size: '2', at: defaultBookingTime(day), duration_mins: '90', note: '' }));
  const [touched, setTouched] = useState(false);
  const check = checkBooking({ ...form, at: form.at });
  const set = key => e => { setForm(f => ({ ...f, [key]: e.target.value })); setTouched(true); };
  const err = key => (touched ? check.errors[key] : undefined);

  return (
    <FormDialog
      open
      title="Take a booking"
      description="The hub checks there is a table that size free at that time before it accepts."
      confirmLabel={conflict ? 'Book it anyway' : 'Take the booking'}
      busy={busy}
      canConfirm={check.ok}
      onCancel={onCancel}
      onConfirm={() => onSave({
        guest_name: form.guest_name.trim(),
        phone: form.phone.trim(),
        party_size: Number(form.party_size),
        at: new Date(form.at).toISOString(),
        duration_mins: Number(form.duration_mins),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
        ...(conflict ? { force: true } : {})
      })}
    >
      <Field label="Name" htmlFor="b-name" error={err('guest_name')}>
        <TextInput id="b-name" autoFocus value={form.guest_name} onChange={set('guest_name')} invalid={Boolean(err('guest_name'))} />
      </Field>
      <Field label="Phone" htmlFor="b-phone" error={err('phone')} hint="So you can confirm, or chase them if they are late.">
        <TextInput id="b-phone" inputMode="tel" value={form.phone} onChange={set('phone')} invalid={Boolean(err('phone'))} placeholder="98765 43210" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="People" htmlFor="b-party" error={err('party_size')}>
          <TextInput id="b-party" inputMode="numeric" value={form.party_size} onChange={set('party_size')} invalid={Boolean(err('party_size'))} />
        </Field>
        <Field label="Hold the table for" htmlFor="b-duration" hint="Minutes.">
          <NativeSelect id="b-duration" value={form.duration_mins} onChange={set('duration_mins')}>
            {['60', '90', '120', '150', '180'].map(m => <option key={m} value={m}>{m} minutes</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field label="When" htmlFor="b-at" error={err('at')}>
        <TextInput id="b-at" type="datetime-local" value={form.at} onChange={set('at')} invalid={Boolean(err('at'))} />
      </Field>
      <Field label="Note (optional)" htmlFor="b-note" hint="Allergies, a birthday, a preferred table.">
        <TextInput id="b-note" value={form.note} onChange={set('note')} maxLength={200} />
      </Field>
      {conflict && (
        <Notice tone="warning" title="No table free then">
          {conflict.fitting === 0
            ? `No table here seats ${form.party_size}.`
            : `All ${conflict.fitting} table(s) that size are taken at that time. Booking anyway is recorded as an overbooking.`}
        </Notice>
      )}
      {/* A clash is already explained above in more useful words; saying it twice reads as two faults. */}
      {serverError && !conflict && <Notice tone="error">{serverError}</Notice>}
    </FormDialog>
  );
}

function WalkInDialog({ onSave, onCancel, busy, serverError }) {
  const [form, setForm] = useState({ guest_name: '', phone: '', party_size: '2', quoted_wait_mins: '' });
  const [touched, setTouched] = useState(false);
  const check = checkWalkIn(form);
  const set = key => e => { setForm(f => ({ ...f, [key]: e.target.value })); setTouched(true); };
  const err = key => (touched ? check.errors[key] : undefined);

  return (
    <FormDialog
      open
      title="Add to the queue"
      description="A number is optional — but without one there is no way to tell them their table is ready."
      confirmLabel="Add to the queue"
      busy={busy}
      canConfirm={check.ok}
      onCancel={onCancel}
      onConfirm={() => onSave({
        guest_name: form.guest_name.trim(),
        party_size: Number(form.party_size),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(form.quoted_wait_mins.trim() ? { quoted_wait_mins: Number(form.quoted_wait_mins) } : {})
      })}
    >
      <Field label="Name" htmlFor="w-name" error={err('guest_name')}>
        <TextInput id="w-name" autoFocus value={form.guest_name} onChange={set('guest_name')} invalid={Boolean(err('guest_name'))} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="People" htmlFor="w-party" error={err('party_size')}>
          <TextInput id="w-party" inputMode="numeric" value={form.party_size} onChange={set('party_size')} invalid={Boolean(err('party_size'))} />
        </Field>
        <Field label="Told them (minutes)" htmlFor="w-quoted" error={err('quoted_wait_mins')} hint="Optional.">
          <TextInput id="w-quoted" inputMode="numeric" value={form.quoted_wait_mins} onChange={set('quoted_wait_mins')} invalid={Boolean(err('quoted_wait_mins'))} />
        </Field>
      </div>
      <Field label="Phone (optional)" htmlFor="w-phone" error={err('phone')}>
        <TextInput id="w-phone" inputMode="tel" value={form.phone} onChange={set('phone')} invalid={Boolean(err('phone'))} placeholder="98765 43210" />
      </Field>
      {serverError && <Notice tone="error">{serverError}</Notice>}
    </FormDialog>
  );
}

export function BookingsTab({ notify }) {
  const [day, setDay] = useState(() => today());
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      setData(await hubGet(`/admin/bookings?day=${encodeURIComponent(day)}`));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [day]);
  useEffect(() => { load(); }, [load]);

  // The queue's waits move on by themselves; without this a screen left open quietly lies.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const close = () => { setDialog(null); setServerError(null); setConflict(null); };

  const run = async (send, done) => {
    setBusy(true);
    setServerError(null);
    try {
      const result = await send();
      close();
      if (done) notify(done(result));
      await load();
      return result;
    } catch (e) {
      // A clash is not a failure: it is the hub asking whether reception means it.
      if (e?.code === 'FULLY_BOOKED' || e?.code === 'NO_TABLE_THAT_SIZE') setConflict(e.body?.availability ?? { fitting: 0 });
      setServerError(explainError(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return <Notice tone="error" title="Could not load the diary" action={<Button className="h-10" onClick={load}>Try again</Button>}>{explainError(error)}</Notice>;
  }
  if (!data) return <ListSkeleton rows={5} className="pt-2" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" className="size-10" aria-label="The day before" onClick={() => setDay(d => shiftDay(d, -1))}><ChevronLeft className="size-4" aria-hidden="true" /></Button>
          <div className="min-w-32 text-center">
            <div className="font-semibold">{dayLabel(day)}</div>
            <div className="text-xs text-muted-foreground" aria-live="polite">{bookingsSummary(data.summary)}</div>
          </div>
          <Button variant="outline" className="size-10" aria-label="The day after" onClick={() => setDay(d => shiftDay(d, 1))}><ChevronRight className="size-4" aria-hidden="true" /></Button>
          {day !== today() && <Button variant="outline" className="h-10" onClick={() => setDay(today())}>Today</Button>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-10" onClick={() => setDialog({ type: 'walkin' })}><UserPlus className="size-4" aria-hidden="true" />Add to the queue</Button>
          <Button className="h-10" onClick={() => setDialog({ type: 'booking' })}><Plus className="size-4" aria-hidden="true" />Take a booking</Button>
        </div>
      </div>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="queue-h">
        <h2 id="queue-h" className="typography-title-md">At the door</h2>
        {data.waitlist.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody waiting.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.waitlist.map(entry => {
              const late = overdue(entry, now);
              return (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" aria-label={entry.guest_name}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold">{entry.guest_name}</span>
                      <Badge variant="outline">{entry.party_size}</Badge>
                      <Badge variant="outline" style={toneStyle(WAITLIST_TONE[entry.status])}>{WAITLIST_LABEL[entry.status]}</Badge>
                      {late && <Badge variant="outline" style={toneStyle('rust')}>Over the wait they were told</Badge>}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Waiting {formatWait(waitedMins(entry, now))}{entry.quoted_wait_mins ? ` of the ${entry.quoted_wait_mins} min they were told` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ContactButtons row={entry} label="their table is ready" />
                    {entry.phone && entry.status === 'waiting' && (
                      <Button variant="outline" className="h-9" disabled={busy} onClick={() => run(() => hubSend('PUT', `/admin/waitlist/${encodeURIComponent(entry.id)}/status`, { status: 'notified' }), () => `${entry.guest_name} marked as messaged.`)}>
                        Mark messaged
                      </Button>
                    )}
                    <Button className="h-9" disabled={busy} onClick={() => run(() => hubSend('PUT', `/admin/waitlist/${encodeURIComponent(entry.id)}/status`, { status: 'seated' }), () => `${entry.guest_name} seated.`)}>Seat</Button>
                    <Button variant="outline" className="h-9" disabled={busy} onClick={() => run(() => hubSend('PUT', `/admin/waitlist/${encodeURIComponent(entry.id)}/status`, { status: 'left' }), () => `${entry.guest_name} left.`)}>Left</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="diary-h">
        <h2 id="diary-h" className="typography-title-md">Bookings</h2>
        {data.reservations.length === 0 ? (
          <EmptyState icon={CalendarDays} title={`Nothing booked for ${dayLabel(day).toLowerCase()}`}>
            Bookings taken here are checked against the real table layout, so the same table cannot be sold twice.
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.reservations.map(r => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" aria-label={`${r.guest_name} at ${bookingTime(r.at)}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold tabular-nums">{bookingTime(r.at)}</span>
                    <span className="truncate font-semibold">{r.guest_name}</span>
                    <Badge variant="outline">{r.party_size}</Badge>
                    <Badge variant="outline" style={toneStyle(RESERVATION_TONE[r.status])}>{RESERVATION_LABEL[r.status]}</Badge>
                    {r.overbooked && <Badge variant="outline" style={toneStyle('rust')}>Overbooked</Badge>}
                  </div>
                  {r.note && <div className="text-sm text-muted-foreground">{r.note}</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ContactButtons row={r} label="their booking" />
                  {r.status === 'booked' && (
                    <>
                      <Button className="h-9" disabled={busy} onClick={() => run(() => hubSend('PUT', `/admin/bookings/${encodeURIComponent(r.id)}/status`, { status: 'seated' }), () => `${r.guest_name} seated.`)}>Seat</Button>
                      <Button variant="outline" className="h-9" disabled={busy} onClick={() => run(() => hubSend('PUT', `/admin/bookings/${encodeURIComponent(r.id)}/status`, { status: 'no_show' }), () => `${r.guest_name} marked a no-show.`)}>No show</Button>
                      <Button variant="outline" className="h-9" disabled={busy} onClick={() => run(() => hubSend('PUT', `/admin/bookings/${encodeURIComponent(r.id)}/status`, { status: 'cancelled' }), () => `${r.guest_name}'s booking cancelled.`)}>Cancel</Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dialog?.type === 'booking' && (
        <BookingDialog
          day={day}
          busy={busy}
          serverError={serverError}
          conflict={conflict}
          onCancel={close}
          onSave={body => run(() => hubSend('POST', '/admin/bookings', body), r => `${r.reservation.guest_name} booked for ${bookingTime(r.reservation.at)}.`)}
        />
      )}
      {dialog?.type === 'walkin' && (
        <WalkInDialog
          busy={busy}
          serverError={serverError}
          onCancel={close}
          onSave={body => run(() => hubSend('POST', '/admin/waitlist', body), r => `${r.entry.guest_name} added to the queue.`)}
        />
      )}
    </div>
  );
}
