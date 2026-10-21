import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GuestOrderingSwitch } from '@/admin/GuestOrderingSwitch';
import { fakeHub } from '../helpers/fakeHub';

// Reception's switch for ordering from the table code (§4.5). The thing it must never do is turn
// itself on, so that is what most of this checks.

const setup = async (routes = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({
    'GET /public/ordering': { body: { success: true, ordering: false } },
    'PUT /admin/guest-ordering': { body: { success: true } },
    ...routes
  });
  render(<GuestOrderingSwitch notify={notify} />);
  return { hub, notify };
};

const theSwitch = () => screen.findByRole('switch', { name: /Let guests order/ });

describe('the guest ordering switch', () => {
  it('reads as off until the hub says otherwise', async () => {
    await setup();
    expect(await theSwitch()).not.toBeChecked();
    expect(screen.getByText(/The code shows the menu only/)).toBeInTheDocument();
  });

  it('reads as on when the restaurant has already turned it on', async () => {
    await setup({ 'GET /public/ordering': { body: { success: true, ordering: true } } });
    expect(await theSwitch()).toBeChecked();
    expect(screen.getByText(/straight to the kitchen/)).toBeInTheDocument();
  });

  it('a hub that cannot answer shows no switch rather than a wrong one', async () => {
    await setup({ 'GET /public/ordering': new TypeError('Failed to fetch') });
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    // Showing it as off would invite reception to "turn it on" against a hub that never heard.
  });

  it('turning it on sends the switch, not the whole settings file', async () => {
    const { hub, notify } = await setup();
    await userEvent.click(await theSwitch());

    const calls = hub.calls('PUT /admin/guest-ordering');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ ordering: true });
    expect(await theSwitch()).toBeChecked();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/can now order/));
  });

  it('turning it off sends false, and says orders come from staff again', async () => {
    const { hub, notify } = await setup({ 'GET /public/ordering': { body: { success: true, ordering: true } } });
    await userEvent.click(await theSwitch());

    expect(hub.calls('PUT /admin/guest-ordering')[0].body).toEqual({ ordering: false });
    expect(await theSwitch()).not.toBeChecked();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/off/i));
  });

  it('a refused change leaves the switch where it was, and says why', async () => {
    const { notify } = await setup({
      'PUT /admin/guest-ordering': { status: 403, body: { success: false, error: 'Only reception may change this.' } }
    });
    await userEvent.click(await theSwitch());

    expect(await screen.findByText('Only reception may change this.')).toBeInTheDocument();
    expect(await theSwitch()).not.toBeChecked();
    expect(notify).not.toHaveBeenCalled();
  });
});
