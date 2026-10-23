import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BookingsTab } from '@/admin/BookingsTab';
import { bookingTime, today, shiftDay, dayLabel, waitedMins, formatWait, overdue, checkBooking, checkWalkIn, bookingsSummary, defaultBookingTime, ordinal, checkReward } from '@/admin/lib/bookings';
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

const REWARDS_OFF = { body: { success: true, enabled: false, limits: { max_visits: 50, max_text: 80 } } };
const NO_REMINDERS = { body: { success: true, window_hours: 24, reminders: [] } };
const DUE = [
  { ...ASHA, id: 'res_1', whatsapp: 'https://wa.me/919876543210?text=A%20reminder%20from%20Mejwani', at: new Date(Date.now() + 3 * 3600000).toISOString() },
  { ...ASHA, id: 'res_2', guest_name: 'Ravi', phone: '919811122233', whatsapp: 'https://wa.me/919811122233?text=reminder', tel: 'tel:+919811122233', at: new Date(Date.now() + 20 * 3600000).toISOString() }
];
const reminders = list => ({ body: { success: true, window_hours: 24, reminders: list } });

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
  const hub = fakeHub({ 'GET /admin/bookings': answer(), 'GET /admin/bookings/reminders': NO_REMINDERS, 'GET /admin/rewards': REWARDS_OFF, 'GET /admin/guests': { body: { success: true, guests: [] } }, ...routes });
  render(<BookingsTab notify={notify} />);
  return { hub, notify };
};

describe('reward wording and checks', () => {
  it('numbers read the way they are said', () => {
    expect([1, 2, 3, 4, 5, 10, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal)).toEqual(
      ['1st', '2nd', '3rd', '4th', '5th', '10th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th']);
  });

  it('a rule needs a number of visits from 2 to 50 and some words that fit', () => {
    expect(checkReward({ every_n_visits: '5', text: 'a free dessert' })).toEqual({ ok: true, errors: {} });
    expect(checkReward({ every_n_visits: '1', text: 'x' }).errors.every_n_visits).toMatch(/2 to 50/);
    expect(checkReward({ every_n_visits: '51', text: 'x' }).errors.every_n_visits).toMatch(/2 to 50/);
    expect(checkReward({ every_n_visits: '2.5', text: 'x' }).errors.every_n_visits).toMatch(/whole number/);
    expect(checkReward({ every_n_visits: '', text: 'x' }).errors.every_n_visits).toMatch(/How many visits/);
    expect(checkReward({ every_n_visits: 'lots', text: 'x' }).errors.every_n_visits).toMatch(/whole number/);
    expect(checkReward({ every_n_visits: '5', text: '   ' }).errors.text).toMatch(/What does the guest get/);
    expect(checkReward({ every_n_visits: '5', text: 'x'.repeat(81) }).errors.text).toMatch(/80/);
    expect(checkReward({ every_n_visits: '5', text: 'x'.repeat(80) }).ok).toBe(true);
    expect(checkReward({ every_n_visits: '50', text: 'x' }).ok).toBe(true);
    expect(checkReward({ every_n_visits: '2', text: 'x' }).ok).toBe(true);
    expect(checkReward({ every_n_visits: '9', text: 'x' }, { max_visits: 8 }).errors.every_n_visits).toBe('From 2 to 8 visits.');
  });
});

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

  it('a returning guest is recognised while the number is typed, before the booking is taken', async () => {
    setup({
      'GET /admin/guests/lookup': { body: { success: true, guest: { guest_name: 'Asha Deshmukh', visits: 4 }, recognised: { visits: 4, line: '4th visit, last 3 weeks ago' } } }
    });
    await userEvent.click(await screen.findByRole('button', { name: /Take a booking/ }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Phone'), '98765 43210');

    expect(await within(form).findByText(/has been here before/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(form).getByText('Asha Deshmukh')).toBeInTheDocument();
    expect(within(form).getByText(/4th visit, last 3 weeks ago/)).toBeInTheDocument();
  });

  it('a first-time guest is not announced -- a note on every new booking is noise', async () => {
    setup({
      'GET /admin/guests/lookup': { body: { success: true, guest: null, recognised: null } }
    });
    await userEvent.click(await screen.findByRole('button', { name: /Take a booking/ }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Phone'), '98765 43210');
    await new Promise(r => setTimeout(r, 600));
    expect(within(form).queryByText(/has been here before/)).not.toBeInTheDocument();
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

  describe('reminders', () => {
    it('shows no reminder section when nobody is due, rather than an empty box', async () => {
      setup();
      await screen.findByRole('listitem', { name: /Asha at/ });
      expect(screen.queryByRole('heading', { name: /Reminders to send/ })).not.toBeInTheDocument();
    });

    it('lists who is due a reminder with a link that already carries the reminder, and a way to ring', async () => {
      setup({ 'GET /admin/bookings/reminders': reminders(DUE) });
      expect(await screen.findByRole('heading', { name: 'Reminders to send (2)' })).toBeInTheDocument();
      const asha = screen.getByRole('listitem', { name: 'Remind Asha' });
      expect(within(asha).getByRole('link', { name: 'Remind Asha on WhatsApp' })).toHaveAttribute('href', 'https://wa.me/919876543210?text=A%20reminder%20from%20Mejwani');
      expect(within(asha).getByRole('link', { name: 'Remind Asha on WhatsApp' })).toHaveAttribute('target', '_blank');
      expect(within(asha).getByRole('link', { name: 'Call Asha' })).toHaveAttribute('href', 'tel:+919876543210');
      expect(within(asha).getByText(/Today|Tomorrow/)).toBeInTheDocument();
      expect(screen.getByRole('listitem', { name: 'Remind Ravi' })).toBeInTheDocument();
    });

    it('opening the link does not count as sending: a person says "I sent it", and the hub is told', async () => {
      const { hub, notify } = setup({
        'GET /admin/bookings/reminders': ({ call }) => (call === 1 ? reminders(DUE) : reminders([DUE[1]])),
        'POST /admin/bookings/res_1/reminded': { body: { success: true, reservation: { ...ASHA, reminded_at: new Date().toISOString() } } }
      });
      const asha = await screen.findByRole('listitem', { name: 'Remind Asha' });
      await userEvent.click(within(asha).getByRole('link', { name: 'Remind Asha on WhatsApp' }));
      expect(hub.calls('POST /admin/bookings/res_1/reminded')).toHaveLength(0);

      await userEvent.click(within(asha).getByRole('button', { name: 'I sent it' }));
      expect(hub.calls('POST /admin/bookings/res_1/reminded')).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith('Asha marked as reminded.');
      expect(await screen.findByRole('heading', { name: 'Reminders to send (1)' })).toBeInTheDocument();
      expect(screen.queryByRole('listitem', { name: 'Remind Asha' })).not.toBeInTheDocument();
    });

    it("a mark the hub refuses is said in the hub's words, and the reminder stays on the list", async () => {
      const { notify } = setup({
        'GET /admin/bookings/reminders': reminders(DUE),
        'POST /admin/bookings/res_1/reminded': { status: 409, body: { success: false, code: 'NOT_BOOKED', error: "Asha's booking is no longer booked, so there is nothing to remind them of." } }
      });
      const asha = await screen.findByRole('listitem', { name: 'Remind Asha' });
      await userEvent.click(within(asha).getByRole('button', { name: 'I sent it' }));
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('no longer booked')));
      expect(screen.getByRole('listitem', { name: 'Remind Asha' })).toBeInTheDocument();
    });

    it('a booking already reminded says so on its row, and the mark can be taken back', async () => {
      const reminded = { ...ASHA, reminded_at: new Date(2026, 9, 21, 10, 5).toISOString(), reminded_by: 'Meera' };
      const { hub, notify } = setup({
        'GET /admin/bookings': answer({ reservations: [reminded] }),
        'DELETE /admin/bookings/res_1/reminded': { body: { success: true, reservation: ASHA } }
      });
      const row = await screen.findByRole('listitem', { name: /Asha at/ });
      expect(within(row).getByText(/Reminded 10:05/)).toBeInTheDocument();
      expect(within(row).getByText(/Meera/)).toBeInTheDocument();
      await userEvent.click(within(row).getByRole('button', { name: 'Not sent' }));
      expect(hub.calls('DELETE /admin/bookings/res_1/reminded')).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith("Asha's reminder mark taken back.");
    });

    it('a booking that has not been reminded shows no reminded badge, and a cancelled one offers no undo', async () => {
      setup({ 'GET /admin/bookings': answer({ reservations: [ASHA, { ...ASHA, id: 'res_9', guest_name: 'Gone', status: 'cancelled', reminded_at: new Date().toISOString() }] }) });
      const row = await screen.findByRole('listitem', { name: /Asha at/ });
      expect(within(row).queryByText(/Reminded/)).not.toBeInTheDocument();
      const gone = screen.getByRole('listitem', { name: /Gone at/ });
      expect(within(gone).queryByRole('button', { name: 'Not sent' })).not.toBeInTheDocument();
    });

    it('if the reminders cannot be read the diary is still there, and the reminders are simply not offered', async () => {
      setup({ 'GET /admin/bookings/reminders': new TypeError('Failed to fetch') });
      expect(await screen.findByRole('listitem', { name: /Asha at/ })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: /Reminders to send/ })).not.toBeInTheDocument();
      expect(screen.queryByText('Could not load the diary')).not.toBeInTheDocument();
    });
  });

  describe('rewards for coming back', () => {
    const EARNED = { ...ASHA, reward_due: { visit_number: 5, text: 'a free dessert' } };
    const GIVEN = { ...ASHA, reward_given_at: new Date(2026, 9, 21, 20, 0).toISOString(), reward_given_text: 'a free dessert', reward_visit: 5 };

    it('says on the booking that this is the guest\'s 5th visit and what the restaurant gives', async () => {
      setup({ 'GET /admin/bookings': answer({ reservations: [EARNED] }) });
      const row = await screen.findByRole('listitem', { name: /Asha at/ });
      expect(within(row).getByText('5th visit: a free dessert')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Reward given' })).toBeInTheDocument();
    });

    it('says nothing on a booking that earns nothing', async () => {
      setup();
      const row = await screen.findByRole('listitem', { name: /Asha at/ });
      expect(within(row).queryByText(/visit:/)).not.toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Reward given' })).not.toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Take back' })).not.toBeInTheDocument();
    });

    it('recording it tells the hub, says so, and reads the diary again', async () => {
      const { hub, notify } = setup({
        'GET /admin/bookings': ({ call }) => answer({ reservations: [call === 1 ? EARNED : GIVEN] }),
        'POST /admin/bookings/res_1/reward': { body: { success: true, reservation: GIVEN } }
      });
      const row = await screen.findByRole('listitem', { name: /Asha at/ });
      await userEvent.click(within(row).getByRole('button', { name: 'Reward given' }));
      expect(hub.calls('POST /admin/bookings/res_1/reward')).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith('Reward recorded for Asha: a free dessert.');
      expect(await screen.findByText('Reward given: a free dessert')).toBeInTheDocument();
      expect(screen.queryByText('5th visit: a free dessert')).not.toBeInTheDocument();
    });

    it('a reward already given says so, with the words that were promised, and can be taken back', async () => {
      const { hub, notify } = setup({
        'GET /admin/bookings': answer({ reservations: [GIVEN] }),
        'DELETE /admin/bookings/res_1/reward': { body: { success: true, reservation: ASHA } }
      });
      const row = await screen.findByRole('listitem', { name: /Asha at/ });
      expect(within(row).getByText('Reward given: a free dessert')).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Reward given' })).not.toBeInTheDocument();
      await userEvent.click(within(row).getByRole('button', { name: 'Take back' }));
      expect(hub.calls('DELETE /admin/bookings/res_1/reward')).toHaveLength(1);
      expect(notify).toHaveBeenCalledWith("Asha's reward taken back.");
    });

    it('a refusal is said in the hub\'s words and nothing changes on the row', async () => {
      const { notify } = setup({
        'GET /admin/bookings': answer({ reservations: [EARNED] }),
        'POST /admin/bookings/res_1/reward': { status: 409, body: { success: false, code: 'NOT_DUE', error: 'This is not a visit that earns a reward for Asha.' } }
      });
      const row = await screen.findByRole('listitem', { name: /Asha at/ });
      await userEvent.click(within(row).getByRole('button', { name: 'Reward given' }));
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('This is not a visit that earns a reward for Asha.'));
      expect(screen.getByText('5th visit: a free dessert')).toBeInTheDocument();
    });

    it('changing the rule reads the diary again, since what each booking earns has changed', async () => {
      const { hub } = setup({
        'GET /admin/rewards': { body: { success: true, enabled: true, every_n_visits: 5, text: 'a free dessert', limits: { max_visits: 50, max_text: 80 } } },
        'PUT /admin/rewards': { body: { success: true, enabled: false } }
      });
      await screen.findByRole('listitem', { name: /Asha at/ });
      const reads = hub.calls('GET /admin/bookings').length;
      await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
      await vi.waitFor(() => expect(hub.calls('GET /admin/bookings').length).toBeGreaterThan(reads));
    });
  });

  it('an unreachable hub says so rather than showing an empty diary', async () => {
    const { hub } = setup({ 'GET /admin/bookings': ({ call }) => (call === 1 ? new TypeError('Failed to fetch') : answer()) });
    expect(await screen.findByText('Could not load the diary')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listitem', { name: /Asha at/ })).toBeInTheDocument();
    expect(hub.calls('GET /admin/bookings')).toHaveLength(2);
  });
});
