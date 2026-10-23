import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RewardsPanel } from '@/admin/RewardsPanel';
import { fakeHub } from '../helpers/fakeHub';

// The restaurant's own rule for rewarding a guest who comes back. The product chooses nothing: it is off until the owner sets a
// number of visits and the words, and the panel says plainly that applying the reward to the bill is still a person's job.

const OFF = { body: { success: true, enabled: false, limits: { max_visits: 50, max_text: 80 } } };
const ON = { body: { success: true, enabled: true, every_n_visits: 5, text: 'a free dessert', limits: { max_visits: 50, max_text: 80 } } };

const setup = (routes = {}) => {
  const notify = vi.fn();
  const onChange = vi.fn();
  const hub = fakeHub({ 'GET /admin/rewards': OFF, ...routes });
  render(<RewardsPanel notify={notify} onChange={onChange} />);
  return { hub, notify, onChange };
};

describe('rewards panel', () => {
  it('while no rule is set it says so, and what the product does and does not do', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Rewards' })).toBeInTheDocument();
    expect(screen.getByText(/No reward is set up/)).toBeInTheDocument();
    expect(screen.getByText(/You apply it on the bill/)).toBeInTheDocument();
    expect(screen.getByLabelText('Every … visits')).toBeInTheDocument();
    expect(screen.getByLabelText('The guest gets')).toBeInTheDocument();
  });

  it('nothing can be saved until the number and the words are right, and each is said', async () => {
    const { hub } = setup();
    const save = await screen.findByRole('button', { name: 'Turn on' });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Every … visits'), '1');
    expect(await screen.findByText('From 2 to 50 visits.')).toBeInTheDocument();
    expect(save).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Every … visits'));
    await userEvent.type(screen.getByLabelText('Every … visits'), '5');
    expect(save).toBeDisabled();   // still no words
    await userEvent.type(screen.getByLabelText('The guest gets'), 'a free dessert');
    expect(save).toBeEnabled();
    expect(hub.calls('PUT /admin/rewards')).toHaveLength(0);
  });

  it('turning it on sends the number as a number and the words as typed, says so, and shows the rule', async () => {
    const { hub, notify, onChange } = setup({
      'PUT /admin/rewards': { body: { success: true, enabled: true, every_n_visits: 5, text: 'a free dessert' } },
      'GET /admin/rewards': ({ call }) => (call === 1 ? OFF : ON)
    });
    await userEvent.type(await screen.findByLabelText('Every … visits'), '5');
    await userEvent.type(screen.getByLabelText('The guest gets'), '  a free dessert ');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));

    expect(hub.calls('PUT /admin/rewards')[0].body).toEqual({ every_n_visits: 5, text: 'a free dessert' });
    expect(notify).toHaveBeenCalledWith('Reward turned on: every 5th visit, a free dessert.');
    expect(onChange).toHaveBeenCalled();
    expect(await screen.findByText('Every 5th visit: a free dessert')).toBeInTheDocument();
  });

  it('a rule that is on is shown, and can be turned off or changed', async () => {
    const { hub, notify, onChange } = setup({
      'GET /admin/rewards': ({ call }) => (call === 1 ? ON : OFF),
      'PUT /admin/rewards': { body: { success: true, enabled: false } }
    });
    expect(await screen.findByText('Every 5th visit: a free dessert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(hub.calls('PUT /admin/rewards')[0].body).toEqual({ enabled: false });
    expect(notify).toHaveBeenCalledWith('Rewards turned off.');
    expect(onChange).toHaveBeenCalled();
    expect(await screen.findByText(/No reward is set up/)).toBeInTheDocument();
    expect(screen.getByLabelText('Every … visits')).toHaveValue('');   // not the rule that was just switched off
    expect(screen.getByLabelText('The guest gets')).toHaveValue('');
  });

  it('changing a rule starts from what it is now', async () => {
    const { hub } = setup({
      'GET /admin/rewards': ON,
      'PUT /admin/rewards': { body: { success: true, enabled: true, every_n_visits: 10, text: 'a free dessert' } }
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Every … visits')).toHaveValue('5');
    expect(screen.getByLabelText('The guest gets')).toHaveValue('a free dessert');
    await userEvent.clear(screen.getByLabelText('Every … visits'));
    await userEvent.type(screen.getByLabelText('Every … visits'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(hub.calls('PUT /admin/rewards')[0].body).toEqual({ every_n_visits: 10, text: 'a free dessert' });
  });

  it('pressing Enter in a form that is not right sends nothing', async () => {
    const { hub } = setup();
    await userEvent.type(await screen.findByLabelText('Every … visits'), '5{Enter}');
    await userEvent.type(screen.getByLabelText('The guest gets'), '{Enter}');
    expect(hub.calls('PUT /admin/rewards')).toHaveLength(0);
  });

  it('changing can be given up: Cancel puts the rule back as it was, and sends nothing', async () => {
    const { hub } = setup({ 'GET /admin/rewards': ON });
    await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
    await userEvent.clear(screen.getByLabelText('Every … visits'));
    await userEvent.type(screen.getByLabelText('Every … visits'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Every 5th visit: a free dessert')).toBeInTheDocument();
    expect(screen.queryByLabelText('Every … visits')).not.toBeInTheDocument();
    expect(hub.calls('PUT /admin/rewards')).toHaveLength(0);
  });

  it('a rule the hub refuses is said in the hub\'s words, and the form stays', async () => {
    setup({ 'PUT /admin/rewards': { status: 400, body: { success: false, code: 'INVALID_REWARD', error: 'Choose a number of visits from 2 to 50, and say what the guest gets (up to 80 characters).' } } });
    await userEvent.type(await screen.findByLabelText('Every … visits'), '5');
    await userEvent.type(screen.getByLabelText('The guest gets'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText(/Choose a number of visits from 2 to 50/)).toBeInTheDocument();
    expect(screen.getByLabelText('Every … visits')).toHaveValue('5');
  });

  it('a hub that cannot be reached says so rather than showing a form for a rule it cannot save', async () => {
    setup({ 'GET /admin/rewards': new TypeError('Failed to fetch') });
    expect(await screen.findByText('Could not load the rewards')).toBeInTheDocument();
    expect(screen.queryByLabelText('Every … visits')).not.toBeInTheDocument();
  });
});
