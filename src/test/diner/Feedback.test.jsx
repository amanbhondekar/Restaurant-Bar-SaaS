import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Feedback } from '@/diner/Feedback';
import { DinerMenu } from '@/diner/DinerMenu';
import { deferred, fakeHub } from '../helpers/fakeHub';

// The guest's rating after a meal. This posts to the hub's only unauthenticated write, from a
// stranger's phone, so what it sends -- and that it sends it once -- matters more than how it looks.

// The submit button, under either of its labels: it reads "Sending…" while a request is open.
const send = () => screen.getByRole('button', { name: /^(send feedback|sending…)$/i });
const star = n => screen.getByRole('button', { name: `${n} ${n === 1 ? 'star' : 'stars'}` });

describe('guest feedback', () => {
  it('cannot be sent until the guest has picked a rating', async () => {
    const hub = fakeHub({});
    render(<Feedback table="T4" />);

    expect(send()).toBeDisabled();
    // Typing a comment alone is not a rating.
    await userEvent.type(screen.getByRole('textbox'), 'Lovely');
    expect(send()).toBeDisabled();
    expect(hub.fetch).not.toHaveBeenCalled();
  });

  it('lights every star up to the one tapped, and lets the guest change their mind', async () => {
    fakeHub({});
    render(<Feedback table="T4" />);

    await userEvent.click(star(4));
    expect([1, 2, 3, 4, 5].map(n => star(n).getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true', 'true', 'false']);

    await userEvent.click(star(2));
    expect([1, 2, 3, 4, 5].map(n => star(n).getAttribute('aria-pressed'))).toEqual(['true', 'true', 'false', 'false', 'false']);
  });

  it('sends exactly the table, rating and comment -- nothing that names a bill', async () => {
    const hub = fakeHub({ 'POST /public/feedback': { status: 201, body: { success: true } } });
    render(<Feedback table="T4" />);

    await userEvent.click(star(5));
    await userEvent.type(screen.getByRole('textbox'), 'Best dal in Nagpur');
    await userEvent.click(send());

    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
    const [call] = hub.calls('POST /public/feedback');
    // The hub decides which bill a rating belongs to. A page that let the guest name one would
    // hand the hub's only unauthenticated write a way to probe the ledger.
    expect(call.body).toEqual({ table: 'T4', rating: 5, comment: 'Best dal in Nagpur' });
    expect(call.init.headers['Content-Type']).toBe('application/json');
  });

  it('sends once, however impatiently the guest taps', async () => {
    const reply = deferred();
    const hub = fakeHub({ 'POST /public/feedback': () => reply.promise });
    render(<Feedback table="T4" />);

    await userEvent.click(star(3));
    await userEvent.click(send());
    expect(send()).toBeDisabled();
    expect(send()).toHaveTextContent('Sending…');
    await userEvent.click(send());
    await userEvent.click(send());

    reply.resolve({ status: 201, body: { success: true } });
    await screen.findByRole('heading', { name: 'Thank you' });
    expect(hub.calls('POST /public/feedback')).toHaveLength(1);
  });

  it('a table that has already rated is thanked, not shown an error', async () => {
    fakeHub({ 'POST /public/feedback': { status: 429, body: { code: 'ALREADY_SUBMITTED', error: 'This table has already left feedback.' } } });
    render(<Feedback table="T4" />);

    await userEvent.click(star(4));
    await userEvent.click(send());

    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the hub\'s reason when it refuses, keeps what the guest typed, and lets them retry', async () => {
    const hub = fakeHub({
      'POST /public/feedback': ({ call }) => (call === 1
        ? { status: 400, body: { code: 'INVALID_FEEDBACK', error: 'A rating must be between 1 and 5.' } }
        : { status: 201, body: { success: true } })
    });
    render(<Feedback table="T4" />);

    await userEvent.click(star(2));
    await userEvent.type(screen.getByRole('textbox'), 'Slow service');
    await userEvent.click(send());

    expect(await screen.findByRole('alert')).toHaveTextContent('A rating must be between 1 and 5.');
    expect(screen.getByRole('textbox')).toHaveValue('Slow service');
    expect(star(2)).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(send());
    expect(await screen.findByRole('heading', { name: 'Thank you' })).toBeInTheDocument();
    expect(hub.calls('POST /public/feedback')[1].body).toEqual({ table: 'T4', rating: 2, comment: 'Slow service' });
  });

  it('a refusal with no readable body still gives the guest a sentence, not a blank', async () => {
    fakeHub({ 'POST /public/feedback': { status: 500 } });
    render(<Feedback table="T4" />);
    await userEvent.click(star(1));
    await userEvent.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent('That could not be sent.');
  });

  it('off the restaurant wifi, says that is the likely reason', async () => {
    fakeHub({ 'POST /public/feedback': new TypeError('Failed to fetch') });
    render(<Feedback table="T4" />);
    await userEvent.click(star(5));
    await userEvent.click(send());
    expect(await screen.findByRole('alert')).toHaveTextContent(/off the restaurant's wifi/);
    expect(send()).toBeEnabled();
  });

  it('will not take a comment longer than the hub accepts', () => {
    fakeHub({});
    render(<Feedback table="T4" />);
    // Matches MAX_COMMENT in hub_server/lib/feedbackStore.js; the hub rejects anything longer.
    expect(screen.getByRole('textbox')).toHaveAttribute('maxLength', '500');
  });

  it('on the menu page, carries the table from the scanned code into the feedback it sends', async () => {
    window.history.replaceState(null, '', '/diner?t=T7');
    const hub = fakeHub({
      'GET /public/menu': { body: { restaurant: { name: 'Hotel Mejwani', currency: '₹' }, categories: [], item_count: 0 } },
      'POST /public/feedback': { status: 201, body: { success: true } }
    });
    render(<DinerMenu />);

    await screen.findByText('Table T7');
    await userEvent.click(star(4));
    await userEvent.click(send());
    await screen.findByRole('heading', { name: 'Thank you' });
    expect(hub.calls('POST /public/feedback')[0].body.table).toBe('T7');
  });
});
