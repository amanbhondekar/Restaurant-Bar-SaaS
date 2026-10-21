import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BookingsTab } from '@/admin/BookingsTab';
import { bookingTime, today, shiftDay, dayLabel, waitedMins, formatWait, overdue, checkBooking, checkWalkIn, bookingsSummary, defaultBookingTime } from '@/admin/lib/bookings';
import { fakeHub } from '../helpers/fakeHub';

// The front-of-house diary. Rules first, then the screen.

describe('booking wording and checks', () => {
  it('steps through days and names them the way staff say them', () => {
    const now = new Date(2026, 9, 21, 12);
    expect(today(now)).toBe('2026-10-21');
    expect(shiftDay('2026-10-21', 1)).toBe('2026-10-22');
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30', 'across a month boundary');
    expect(dayLabel('2026-10-21', now)).toBe('Today');
    expect(dayLabel('2026-10-22', now)).toBe('Tomorrow');
    expect(dayLabel('2026-10-25', now)).toMatch(/25/);
  });

  it('the time field opens on a time that can actually be booked', () => {
    // Dinner service on the day being looked at...
    expect(defaultBookingTime('2026-10-22', new Date(2026, 9, 21, 12))).toBe('2026-10-22T19:00');
    // ...unless it has already gone by, because a form that opens on a time it then refuses cannot
    // be submitted at all.
    expect(defaultBookingTime('2026-10-21', new Date(2026, 9, 21, 21, 10))).toBe('2026-10-21T21:30');
    expect(defaultBookingTime('2026-10-21', new Date(2026, 9, 21, 21, 45))).toBe('2026-10-21T22:00');
  });

  it('a booking time reads as it is said out loud', () => {
    expect(bookingTime(new Date(2026, 9, 21, 19, 30).toISOString())).toMatch(/7:30/);
    expect(bookingTime('not a time')).toBe('');
  });

  it('how long someone has waited, worded for a glance', () => {
    const now = new Date(2026, 9, 21, 12, 40);
    expect(waitedMins({ created_at: new Date(2026, 9, 21, 12, 15).toISOString() }, now)).toBe(25);
    expect(waitedMins({ created_at: 'nonsense' }, now)).toBeNull();
    expect(formatWait(0)).toBe('just now');
    expect(formatWait(25)).toBe('25 min');
    expect(formatWait(75)).toBe('1 h 15 min');
  });

  it('a party waiting longer than they were told is flagged -- it is invisible otherwise', () => {
    const now = new Date(2026, 9, 21, 12, 40);
    const waiting = { status: 'waiting', created_at: new Date(2026, 9, 21, 12, 0).toISOString() };
    expect(overdue({ ...waiting, quoted_wait_mins: 20 }, now)).toBe(true);
    expect(overdue({ ...waiting, quoted_wait_mins: 60 }, now)).toBe(false);
    expect(overdue({ ...waiting }, now)).toBe(false, 'nothing was promised');
    expect(overdue({ ...waiting, quoted_wait_mins: 20, status: 'seated' }, now)).toBe(false, 'they are sitting down');
  });

  it('a booking needs a name, a whole number, a party and a time that has not passed', () => {
    const now = new Date(2026, 9, 21, 12);
    const good = { guest_name: 'Asha', phone: '98765 43210', party_size: '2', at: new Date(2026, 9, 21, 19).toISOString() };
    expect(checkBooking(good, { now }).ok).toBe(true);
    expect(checkBooking({ ...good, guest_name: ' ' }, { now }).errors.guest_name).toMatch(/Whose booking/);
    expect(checkBooking({ ...good, phone: '' }, { now }).errors.phone).toMatch(/needed to confirm/);
    expect(checkBooking({ ...good, phone: '98765' }, { now }).errors.phone).toMatch(/whole number/);
    expect(checkBooking({ ...good, party_size: '0' }, { now }).errors.party_size).toMatch(/Between 1 and 40/);
    expect(checkBooking({ ...good, at: new Date(2026, 9, 21, 9).toISOString() }, { now }).errors.at).toMatch(/already passed/);
  });

  it('a walk-in needs less, because they are standing in front of you', () => {
    expect(checkWalkIn({ guest_name: 'Rahul', party_size: '3' }).ok).toBe(true, 'no number required');
    expect(checkWalkIn({ guest_name: '', party_size: '3' }).errors.guest_name).toMatch(/name shall we call/);
    expect(checkWalkIn({ guest_name: 'R', party_size: '3', quoted_wait_mins: 'soon' }).errors.quoted_wait_mins).toMatch(/number of minutes/);
    expect(checkWalkIn({ guest_name: 'R', party_size: '3', phone: '98765' }).errors.phone).toMatch(/whole number/);
  });

  it('the header says what the evening looks like', () => {
    expect(bookingsSummary({ booked: 0, seated: 0, covers: 0, no_show: 0, waiting: 0 })).toBe('Nothing booked yet.');
    expect(bookingsSummary({ booked: 6, seated: 2, covers: 14, no_show: 1, waiting: 2 })).toBe('6 booked · 2 seated · 14 covers · 1 no-show · 2 waiting');
    expect(bookingsSummary({ booked: 1, seated: 0, covers: 1, no_show: 0, waiting: 0 })).toBe('1 booked · 1 cover');
  });
});

const ASHA = {
  id: 'res_1', guest_name: 'Asha', party_size: 2, at: new Date(2026, 9, 21, 19, 30).toISOString(), status: 'booked',
  phone: '919876543210', phone_display: '+91 98765 43210',
  whatsapp: 'https://wa.me/919876543210?text=Hello%20Asha', tel: 'tel:+919876543210', note: 'Window table'
};
const RAHUL = { id: 'wl_1', guest_name: 'Rahul', party_size: 3, status: 'waiting', created_at: new Date(Date.now() - 25 * 60000).toISOString(), quoted_wait_mins: 20, phone: '919876511111', phone_display: '+91 98765 11111', whatsapp: 'https://wa.me/919876511111?text=ready', tel: 'tel:+919876511111' };
const NO_PHONE = { id: 'wl_2', guest_name: 'Quiet', party_size: 2, status: 'waiting', created_at: new Date().toISOString() };

const answer = (over = {}) => ({
  body: {
    success: true, day: today(), revision: 3,
    reservations: [ASHA], waitlist: [RAHUL, NO_PHONE],
    summary: { booked: 1, seated: 0, no_show: 0, covers: 2, waiting: 2, seated_walk_ins: 0 },
    ...over
  }
});
const setup = (routes = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({ 'GET /admin/bookings': answer(), ...routes });
  render(<BookingsTab notify={notify} />);
  return { hub, notify };
};

describe('bookings tab', () => {
  it('shows tonight: who is booked, who is at the door, and how long they have waited', async () => {
    setup();
    expect(await screen.findByText('1 booked · 2 covers · 2 waiting')).toBeInTheDocument();

    const booking = screen.getByRole('listitem', { name: /Asha at/ });
    expect(within(booking).getByText(/7:30/)).toBeInTheDocument();
    expect(within(booking).getByText('Window table')).toBeInTheDocument();

    const rahul = screen.getByRole('listitem', { name: 'Rahul' });
    expect(within(rahul).getByText(/Waiting 25 min of the 20 min they were told/)).toBeInTheDocument();
    expect(within(rahul).getByText('Over the wait they were told')).toBeInTheDocument();
  });

  it('a guest is reached by a link the hub built, with the message already written', async () => {
    setup();
    const rahul = await screen.findByRole('listitem', { name: 'Rahul' });
    const whatsapp = within(rahul).getByRole('link', { name: /Message Rahul on WhatsApp/ });
    expect(whatsapp).toHaveAttribute('href', 'https://wa.me/919876511111?text=ready');
    expect(whatsapp).toHaveAttribute('target', '_blank');
    expect(within(rahul).getByRole('link', { name: 'Call Rahul' })).toHaveAttribute('href', 'tel:+919876511111');
  });

  it('someone who left no number shows no way to message them, rather than a link that does nothing', async () => {
    setup();
    const quiet = await screen.findByRole('listitem', { name: 'Quiet' });
    expect(within(quiet).getByText('No number')).toBeInTheDocument();
    expect(within(quiet).queryByRole('link', { name: /WhatsApp/ })).not.toBeInTheDocument();
    expect(within(quiet).queryByRole('button', { name: 'Mark messaged' })).not.toBeInTheDocument();
    expect(within(quiet).getByRole('button', { name: 'Seat' })).toBeInTheDocument();
  });

  it('taking a booking sends what the hub expects, as an instant', async () => {
    const { hub, notify } = setup({
      'POST /admin/bookings': { status: 201, body: { success: true, revision: 4, reservation: { ...ASHA, guest_name: 'Divya' } } }
    });
    await userEvent.click(await screen.findByRole('button', { name: /Take a booking/ }));

    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Name'), 'Divya');
    await userEvent.type(within(form).getByLabelText('Phone'), '98765 43210');
    await userEvent.click(within(form).getByRole('button', { name: 'Take the booking' }));

    const sent = hub.calls('POST /admin/bookings')[0].body;
    expect(sent.guest_name).toBe('Divya');
    expect(sent.phone).toBe('98765 43210');
    expect(sent.party_size).toBe(2);
    expect(sent.duration_mins).toBe(90);
    expect(() => new Date(sent.at).toISOString()).not.toThrow();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Divya booked for'));
  });

  it('a clash is not a dead end: it says what is free and offers to book anyway', async () => {
    const { hub } = setup({
      'POST /admin/bookings': ({ body }) => (body.force
        ? { status: 201, body: { success: true, revision: 4, reservation: { ...ASHA, guest_name: 'Big party', overbooked: true } } }
        : { status: 409, body: { success: false, code: 'FULLY_BOOKED', error: 'Every table that size is already booked then.', availability: { fitting: 1, taken: 1, free: 0 } } })
    });
    await userEvent.click(await screen.findByRole('button', { name: /Take a booking/ }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Name'), 'Big party');
    await userEvent.type(within(form).getByLabelText('Phone'), '98765 43210');
    await userEvent.click(within(form).getByRole('button', { name: 'Take the booking' }));

    expect(await within(form).findByText('No table free then')).toBeInTheDocument();
    expect(within(form).getByText(/All 1 table\(s\) that size are taken/)).toBeInTheDocument();

    await userEvent.click(within(form).getByRole('button', { name: 'Book it anyway' }));
    expect(hub.calls('POST /admin/bookings')[1].body.force).toBe(true);
  });

  it('a party too big for the room says so plainly', async () => {
    setup({
      'POST /admin/bookings': { status: 409, body: { success: false, code: 'NO_TABLE_THAT_SIZE', error: 'No table here seats 20.', availability: { fitting: 0, taken: 0, free: 0 } } }
    });
    await userEvent.click(await screen.findByRole('button', { name: /Take a booking/ }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Name'), 'Huge');
    await userEvent.type(within(form).getByLabelText('Phone'), '98765 43210');
    await userEvent.clear(within(form).getByLabelText('People'));
    await userEvent.type(within(form).getByLabelText('People'), '20');
    await userEvent.click(within(form).getByRole('button', { name: 'Take the booking' }));
    expect(await within(form).findByText('No table here seats 20.')).toBeInTheDocument();
  });

  it('nothing is sent while the form is wrong', async () => {
    const { hub } = setup();
    await userEvent.click(await screen.findByRole('button', { name: /Take a booking/ }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Name'), 'Asha');
    expect(within(form).getByText(/needed to confirm/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Take the booking' })).toBeDisabled();
    expect(hub.calls('POST /admin/bookings')).toHaveLength(0);
  });

  it('a walk-in can be added without a number at all', async () => {
    const { hub, notify } = setup({ 'POST /admin/waitlist': { status: 201, body: { success: true, revision: 4, entry: { ...NO_PHONE, guest_name: 'Sara' } } } });
    await userEvent.click(await screen.findByRole('button', { name: /Add to the queue/ }));

    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Name'), 'Sara');
    await userEvent.type(within(form).getByLabelText('Told them (minutes)'), '15');
    await userEvent.click(within(form).getByRole('button', { name: 'Add to the queue' }));

    expect(hub.calls('POST /admin/waitlist')[0].body).toEqual({ guest_name: 'Sara', party_size: 2, quoted_wait_mins: 15 });
    expect(notify).toHaveBeenCalledWith('Sara added to the queue.');
  });

  it('a booking is seated, no-showed or cancelled from the row', async () => {
    const { hub, notify } = setup({ 'PUT /admin/bookings/res_1/status': { body: { success: true, reservation: { ...ASHA, status: 'seated' } } } });
    const booking = await screen.findByRole('listitem', { name: /Asha at/ });
    await userEvent.click(within(booking).getByRole('button', { name: 'Seat' }));
    expect(hub.calls('PUT /admin/bookings/res_1/status')[0].body).toEqual({ status: 'seated' });
    expect(notify).toHaveBeenCalledWith('Asha seated.');
  });

  it('the queue is worked from the row: messaged, seated, or gone', async () => {
    const { hub } = setup({ 'PUT /admin/waitlist/wl_1/status': { body: { success: true, entry: { ...RAHUL, status: 'notified' } } } });
    const rahul = await screen.findByRole('listitem', { name: 'Rahul' });
    await userEvent.click(within(rahul).getByRole('button', { name: 'Mark messaged' }));
    expect(hub.calls('PUT /admin/waitlist/wl_1/status')[0].body).toEqual({ status: 'notified' });
  });

  it('stepping to another day asks the hub for that day', async () => {
    const { hub } = setup();
    await screen.findByText(/booked/);
    await userEvent.click(screen.getByRole('button', { name: 'The day after' }));

    const asked = hub.calls('GET /admin/bookings').at(-1).url.searchParams.get('day');
    expect(asked).toBe(shiftDay(today(), 1));
    expect(await screen.findByText('Tomorrow')).toBeInTheDocument();
  });

  it('with nothing booked, says so for the day being looked at', async () => {
    setup({ 'GET /admin/bookings': answer({ reservations: [], waitlist: [], summary: { booked: 0, seated: 0, no_show: 0, covers: 0, waiting: 0 } }) });
    expect(await screen.findByText('Nothing booked for today')).toBeInTheDocument();
    expect(screen.getByText('Nobody waiting.')).toBeInTheDocument();
  });

  it('an unreachable hub says so rather than showing an empty diary', async () => {
    const { hub } = setup({ 'GET /admin/bookings': ({ call }) => (call === 1 ? new TypeError('Failed to fetch') : answer()) });
    expect(await screen.findByText('Could not load the diary')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listitem', { name: /Asha at/ })).toBeInTheDocument();
    expect(hub.calls('GET /admin/bookings')).toHaveLength(2);
  });
});
