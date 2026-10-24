import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { Regulars } from '@/admin/Regulars';
import { guestsFrom, recognise, regulars } from '../../../hub_server/lib/loyalty.js';
import { phoneKey } from '../../../hub_server/lib/guestContact.js';
import { fakeHub } from '../helpers/fakeHub';

// Recognising a guest who has been here before (§4.5). The counting rules first -- they decide what
// staff are told -- then reception's list.

const RID = 'rest_1';
const ago = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const seated = (phone, name, at, party = 2) => ({
  id: `r_${phone}_${at}`, guest_name: name, phone, phone_key: phoneKey(phone, RID),
  party_size: party, status: 'seated', seated_at: at
});

describe('counting visits', () => {
  it('a visit is someone who sat down -- a no-show and a party that left are not', () => {
    const state = {
      reservations: [
        seated('919000000001', 'Asha', ago(3)),
        { ...seated('919000000001', 'Asha', ago(5)), status: 'no_show' },
        { ...seated('919000000001', 'Asha', ago(9)), status: 'cancelled' }
      ],
      waitlist: [
        seated('919000000001', 'Asha', ago(20)),
        { ...seated('919000000001', 'Asha', ago(22)), status: 'left' }
      ]
    };
    const [asha] = guestsFrom(state);
    expect(asha.visits).toBe(2, 'one seated booking and one seated walk-in');
    expect(asha.days_since).toBe(3);
  });

  it('the name comes from the most recent visit, because people correct it', () => {
    const state = {
      reservations: [seated('919000000001', 'A. Rao', ago(30)), seated('919000000001', 'Asha Rao', ago(2))]
    };
    expect(guestsFrom(state)[0].guest_name).toBe('Asha Rao');
  });

  it('a first visit is not announced, a second is', () => {
    expect(recognise({ visits: 1, days_since: 0 })).toBeNull();
    expect(recognise(null)).toBeNull();
    expect(recognise({ visits: 3, days_since: 1 }).line).toBe('3rd visit, last yesterday');
    expect(recognise({ visits: 2, days_since: 40 }).line).toBe('2nd visit, last 6 weeks ago');
  });

  it('the regulars are those seen twice or more, most visits first', () => {
    const state = {
      reservations: [
        seated('919000000001', 'Asha', ago(2)), seated('919000000001', 'Asha', ago(9)), seated('919000000001', 'Asha', ago(40)),
        seated('919000000002', 'Dev', ago(1)), seated('919000000002', 'Dev', ago(8)),
        seated('919000000003', 'Once', ago(1))
      ]
    };
    expect(regulars(state).map(g => [g.guest_name, g.visits])).toEqual([['Asha', 3], ['Dev', 2]]);
  });

  it('two restaurants cannot tell they share a guest', () => {
    expect(phoneKey('919000000001', 'rest_1')).not.toBe(phoneKey('919000000001', 'rest_2'));
  });
});

const GUESTS = [
  { phone_key: 'k1', guest_name: 'Asha Rao', phone: '919876543210', visits: 4, days_since: 3, last_visit: ago(3), first_visit: ago(90), covers: 9 },
  { phone_key: 'k2', guest_name: 'Dev', phone: null, visits: 2, days_since: 45, last_visit: ago(45), first_visit: ago(70), covers: 4 }
];

describe('the regulars list', () => {
  it('names each regular with how often and how long ago, and offers to ring them', async () => {
    fakeHub({ 'GET /admin/guests': { body: { success: true, guests: GUESTS } } });
    render(<Regulars />);

    const asha = within((await screen.findByText('Asha Rao')).closest('li'));
    expect(asha.getByText('4 visits, last 3 days ago')).toBeInTheDocument();
    expect(asha.getByRole('link', { name: 'Call Asha Rao' })).toHaveAttribute('href', 'tel:+919876543210');

    const dev = within(screen.getByText('Dev').closest('li'));
    expect(dev.getByText('2 visits, last 6 weeks ago')).toBeInTheDocument();
    expect(dev.getByText('No number')).toBeInTheDocument();
  });

  it('shows no spend, rank or badge -- the hub does not know whose bill was whose', async () => {
    fakeHub({ 'GET /admin/guests': { body: { success: true, guests: GUESTS } } });
    render(<Regulars />);
    await screen.findByText('Asha Rao');
    expect(screen.queryByText(/VIP|₹|spend/i)).not.toBeInTheDocument();
  });

  it('an empty list says what fills it, rather than looking broken', async () => {
    fakeHub({ 'GET /admin/guests': { body: { success: true, guests: [] } } });
    render(<Regulars />);
    expect(await screen.findByText(/Nobody has been here twice yet/)).toBeInTheDocument();
  });

  it('a hub that refuses says so', async () => {
    fakeHub({ 'GET /admin/guests': new TypeError('Failed to fetch') });
    render(<Regulars />);
    expect(await screen.findByText('Could not load the regulars')).toBeInTheDocument();
  });
});
