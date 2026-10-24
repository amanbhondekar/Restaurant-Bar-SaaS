import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WaiterLogin } from '@/waiter_mobile/WaiterLogin';
import { fakeHub } from '../helpers/fakeHub';

// Signing in on a handset, and the new way someone sets themselves up: reception reads them an
// invite code and they choose their own PIN, so nobody else ever knows it.

const WAITERS = { body: { success: true, waiters: [{ id: 'w_1', name: 'Asha', role: 'waiter' }, { id: 'w_2', name: 'Bhavna', role: 'manager' }] } };

const setup = (routes = {}) => {
  const onLogin = vi.fn();
  const hub = fakeHub({ 'GET /waiters': WAITERS, ...routes });
  render(<WaiterLogin hubUrl="" onLogin={onLogin} currentRestaurant={{ name: 'Hotel Mejwani' }} />);
  return { hub, onLogin };
};

describe('waiter sign-in', () => {
  it('offers the people who can sign in, and signs one in on the fourth digit', async () => {
    const { hub, onLogin } = setup({ 'POST /waiters/login': { body: { success: true, waiter: { id: 'w_1', name: 'Asha' } } } });
    await userEvent.click(await screen.findByRole('button', { name: /Asha/ }));
    await userEvent.type(screen.getByPlaceholderText('••••'), '7391');

    expect(hub.calls('POST /waiters/login')[0].body).toEqual({ waiter_id: 'w_1', pin: '7391' });
    expect(onLogin).toHaveBeenCalledWith({ id: 'w_1', name: 'Asha' });
  });

  it('a wrong PIN clears the box and says so, without signing anyone in', async () => {
    const { onLogin } = setup({ 'POST /waiters/login': { status: 401, body: { error: 'Wrong name or PIN.', code: 'INVALID_CREDENTIALS' } } });
    await userEvent.click(await screen.findByRole('button', { name: /Asha/ }));
    await userEvent.type(screen.getByPlaceholderText('••••'), '0000');

    expect(await screen.findByText('Wrong name or PIN.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••')).toHaveValue('');
    expect(onLogin).not.toHaveBeenCalled();
  });
});

describe('setting up from an invite', () => {
  const start = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'I have an invite code' }));
  };

  it('takes the code, then a PIN of their choosing, and signs them straight in', async () => {
    const { hub, onLogin } = setup({ 'POST /waiters/redeem-invite': { body: { success: true, waiter: { id: 'w_9', name: 'Divya', role: 'waiter' } } } });
    await start();

    await userEvent.type(screen.getByLabelText('Invite code'), 'k7m2pq');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Choose a PIN'), '7391');
    await userEvent.click(screen.getByRole('button', { name: 'Set my PIN' }));

    expect(hub.calls('POST /waiters/redeem-invite')[0].body).toEqual({ code: 'K7M2PQ', pin: '7391' });
    expect(onLogin).toHaveBeenCalledWith({ id: 'w_9', name: 'Divya', role: 'waiter' });
  });

  it('nothing is sent until there is a whole code and a whole PIN', async () => {
    const { hub } = setup();
    await start();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Invite code'), 'K7M2');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Invite code'), 'PQ');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    await userEvent.type(screen.getByLabelText('Choose a PIN'), '73');
    expect(screen.getByRole('button', { name: 'Set my PIN' })).toBeDisabled();
    expect(hub.calls('POST /waiters/redeem-invite')).toHaveLength(0);
  });

  it('a bad code sends them back to the code, not to guessing which half was wrong', async () => {
    setup({ 'POST /waiters/redeem-invite': { status: 401, body: { error: 'That invite code is not valid, or it has expired.', code: 'INVALID_INVITE' } } });
    await start();
    await userEvent.type(screen.getByLabelText('Invite code'), 'WRONG1');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Choose a PIN'), '7391');
    await userEvent.click(screen.getByRole('button', { name: 'Set my PIN' }));

    expect(await screen.findByText(/not valid, or it has expired/)).toBeInTheDocument();
    expect(screen.getByLabelText('Invite code')).toBeInTheDocument();
  });

  it('a PIN the hub refuses keeps them on the PIN step, with the reason', async () => {
    setup({ 'POST /waiters/redeem-invite': { status: 400, body: { error: 'That PIN is too easy to guess. Choose another.', code: 'WEAK_PIN' } } });
    await start();
    await userEvent.type(screen.getByLabelText('Invite code'), 'K7M2PQ');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.type(screen.getByLabelText('Choose a PIN'), '1111');
    await userEvent.click(screen.getByRole('button', { name: 'Set my PIN' }));

    expect(await screen.findByText(/too easy to guess/)).toBeInTheDocument();
    expect(screen.getByLabelText('Choose a PIN')).toHaveValue('');
    expect(screen.queryByLabelText('Invite code')).not.toBeInTheDocument();
  });

  it('they can go back to the name list without setting anything up', async () => {
    setup();
    await start();
    await userEvent.click(screen.getByRole('button', { name: /back to the name list/ }));
    expect(await screen.findByRole('button', { name: /Asha/ })).toBeInTheDocument();
  });
});
