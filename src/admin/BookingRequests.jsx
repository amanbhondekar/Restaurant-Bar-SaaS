import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from 'cn';
import { explainError, hubGet, hubSend } from './api';
import { ConfirmDialog } from './ui';
import { bookingTime, dayLabel, today } from './lib/bookings';

// Guests' requests for a table, from the public booking page (§4.6). The hub collects them from the cloud and holds them; this lists what is
// waiting and lets reception answer.
//
// A request is only a QUESTION. Accepting it books the table through the hub's own check, and if there is no table free the hub says so and
// this asks whether to book anyway, exactly as taking a booking by phone does. Declining asks first. Neither sends the guest anything: after
// either, the words to tell them are kept in front of the host, to send from their own phone, until the host says it is done.

const POLL_MS = 60 * 1000;

const toneStyle = tone => ({ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` });

function Availability({ request }) {
  if (request.past) return <Badge variant="outline" style={toneStyle('rust')}>That time has passed</Badge>;
  const a = request.availability || {};
  if (a.ok) return <Badge variant="outline" style={toneStyle('green')}>A table is free</Badge>;
  if (a.code === 'NO_TABLE_THAT_SIZE') return <Badge variant="outline" style={toneStyle('rust')}>No table that size</Badge>;
  return <Badge variant="outline" style={toneStyle('rust')}>Fully booked then</Badge>;
}

export function BookingRequests({ notify, onBooked, refreshKey = 0 }) {
  const [data, setData] = useState({ requests: [], checked_at: null, inbox_ok: null });
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(null);
  const [overbook, setOverbook] = useState(null);
  const [told, setTold] = useState([]);
  const seen = useRef(null);

  // `refresh` asks the hub to look in the cloud first. Reading what the hub already holds is cheap and local; a failure to read it is not worth
  // a message, the diary beside it already says when the hub cannot be reached.
  const load = useCallback(async (refresh = false) => {
    try {
      const next = await hubGet(`/admin/booking-requests${refresh ? '?refresh=1' : ''}`);
      setData({ requests: next.requests || [], checked_at: next.checked_at ?? null, inbox_ok: next.inbox_ok ?? null });
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The first showing is not a check: only a later press of "Check for new requests" is.
  useEffect(() => {
    if (!refreshKey) return;
    const known = new Set(seen.current ?? []);
    load(true).then(next => {
      if (!next) return;
      if (next.inbox_ok === false) return notify('Could not reach the cloud. New requests will show when the internet is back.');
      const fresh = (next.requests || []).filter(r => !known.has(r.id)).length;
      return notify(fresh ? `${fresh} new request${fresh === 1 ? '' : 's'}.` : 'No new requests.');
    });
  }, [refreshKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { seen.current = data.requests.map(r => r.id); }, [data.requests]);

  const accept = async (request, { force = false } = {}) => {
    setBusy(true);
    try {
      const out = await hubSend('POST', `/admin/booking-requests/${encodeURIComponent(request.id)}/accept`, force ? { force: true } : {});
      setOverbook(null);
      notify(`${request.guest_name} booked for ${bookingTime(out.reservation.at)}.`);
      setTold(list => [...list, { id: request.id, name: request.guest_name, outcome: 'booked', whatsapp: out.reply_whatsapp }]);
      onBooked();
      await load();
    } catch (e) {
      if (e?.code === 'FULLY_BOOKED' || e?.code === 'NO_TABLE_THAT_SIZE') {
        setOverbook({ request, availability: e.body?.availability ?? { fitting: 0 } });
      } else {
        setOverbook(null);
        notify(explainError(e));
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const decline = async request => {
    setBusy(true);
    try {
      const out = await hubSend('POST', `/admin/booking-requests/${encodeURIComponent(request.id)}/decline`, {});
      notify(`${request.guest_name}'s request declined.`);
      setTold(list => [...list, { id: request.id, name: request.guest_name, outcome: 'declined', whatsapp: out.reply_whatsapp }]);
    } catch (e) {
      notify(explainError(e));
    } finally {
      setBusy(false);
      setDeclining(null);
    }
    await load();
  };

  const { requests } = data;
  if (!requests.length && !told.length) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="requests-h">
      {requests.length > 0 && (
        <>
          <div>
            <h2 id="requests-h" className="typography-title-md">Requests from the booking page ({requests.length})</h2>
            <p className="text-sm text-muted-foreground">Guests asked for these. Nothing is booked until you accept.</p>
            <p className="text-xs text-muted-foreground">
              {data.inbox_ok === false
                ? 'The last check with the cloud did not work. New requests will show when it does.'
                : data.checked_at ? `Checked with the cloud at ${bookingTime(data.checked_at)}.` : 'Not checked with the cloud yet.'}
            </p>
          </div>
          <ul className="flex flex-col divide-y divide-border">
            {requests.map(r => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" aria-label={`Request from ${r.guest_name}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold tabular-nums">{dayLabel(today(new Date(r.at)))} {bookingTime(r.at)}</span>
                    <span className="truncate font-semibold">{r.guest_name}</span>
                    <Badge variant="outline">{r.party_size}</Badge>
                    <Availability request={r} />
                  </div>
                  {r.note && <div className="text-sm text-muted-foreground">{r.note}</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={r.whatsapp} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'outline' }), 'h-9')} aria-label={`Message ${r.guest_name} on WhatsApp`}>
                    <MessageCircle className="size-4" aria-hidden="true" />WhatsApp
                  </a>
                  <a href={r.tel} className={cn(buttonVariants({ variant: 'outline' }), 'h-9')} aria-label={`Call ${r.guest_name}`}>
                    <Phone className="size-4" aria-hidden="true" />
                  </a>
                  <Button className="h-9" disabled={busy || r.past} onClick={() => accept(r)}>Accept</Button>
                  <Button variant="outline" className="h-9" disabled={busy} onClick={() => setDeclining(r)}>Decline</Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {told.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Guests to tell">
          {told.map(t => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2" aria-label={`Tell ${t.name}`}>
              <span className="text-sm">{t.outcome === 'booked' ? `${t.name}'s table is booked. Let them know.` : `Tell ${t.name} that you cannot take it.`}</span>
              <span className="flex gap-2">
                <a href={t.whatsapp} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'outline' }), 'h-9')} aria-label={`Tell ${t.name} on WhatsApp`}>
                  <MessageCircle className="size-4" aria-hidden="true" />Tell them on WhatsApp
                </a>
                <Button variant="outline" className="h-9" onClick={() => setTold(list => list.filter(x => x.id !== t.id))}>Done</Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(declining)}
        title={declining ? `Decline ${declining.guest_name}'s request?` : ''}
        confirmLabel="Decline"
        cancelLabel="Keep it"
        busy={busy}
        onConfirm={() => decline(declining)}
        onCancel={() => setDeclining(null)}
      >
        Nothing is booked. You can tell them on WhatsApp afterwards.
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(overbook)}
        title="No table free then"
        confirmLabel="Book it anyway"
        cancelLabel="Not now"
        destructive={false}
        busy={busy}
        onConfirm={() => accept(overbook.request, { force: true })}
        onCancel={() => setOverbook(null)}
      >
        {overbook && (overbook.availability.fitting === 0
          ? `No table here seats ${overbook.request.party_size}.`
          : `All ${overbook.availability.fitting} table(s) that size are taken at that time. Booking anyway is recorded as an overbooking.`)}
      </ConfirmDialog>
    </section>
  );
}
