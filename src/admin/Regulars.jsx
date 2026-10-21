import React, { useCallback, useEffect, useState } from 'react';
import { Phone, Users } from 'lucide-react';
import { cn } from 'cn';
import { buttonVariants } from '@/components/ui/button';
import { explainError, hubGet } from './api';
import { Notice } from './ui';

// The people who come back (§4.5).
//
// Built from the booking diary rather than a list anyone maintains, so it cannot drift from what
// actually happened: a visit is a booking or a queue entry that was SEATED. Someone who booked and
// never arrived is not a regular.
//
// It says how many visits and how long ago, and nothing else. No spend, no rank, no "VIP" badge:
// the hub does not know which bill belonged to which booking, and a number presented as a guest's
// worth would be a number staff would act on.

const visitLine = guest => {
  const when = guest.days_since === null ? null
    : guest.days_since === 0 ? 'today'
      : guest.days_since === 1 ? 'yesterday'
        : guest.days_since < 14 ? `${guest.days_since} days ago`
          : guest.days_since < 60 ? `${Math.round(guest.days_since / 7)} weeks ago`
            : `${Math.round(guest.days_since / 30)} months ago`;
  return `${guest.visits} visits${when ? `, last ${when}` : ''}`;
};

/** `refreshKey` changes when something was seated, which is the only thing that adds a visit. */
export function Regulars({ refreshKey = 0 }) {
  const [guests, setGuests] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const body = await hubGet('/admin/guests');
      setGuests(body.guests || []);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [refreshKey]);
  useEffect(() => { load(); }, [load]);

  if (error) return <Notice tone="error" title="Could not load the regulars">{explainError(error)}</Notice>;
  if (!guests) return null;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="regulars-h">
      <h2 id="regulars-h" className="typography-title-md">Regulars</h2>
      {guests.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody has been here twice yet. This fills in as bookings and queue entries are seated.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {guests.map(guest => (
            <li key={guest.phone_key} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  <Users className="size-4 text-muted-foreground" aria-hidden="true" />
                  {guest.guest_name}
                </div>
                <div className="text-xs text-muted-foreground">{visitLine(guest)}</div>
              </div>
              {guest.phone ? (
                <a href={`tel:+${guest.phone}`} className={cn(buttonVariants({ variant: 'outline' }), 'h-9')} aria-label={`Call ${guest.guest_name}`}>
                  <Phone className="size-4" aria-hidden="true" />
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">No number</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
