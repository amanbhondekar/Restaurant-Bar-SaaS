import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StaffTab } from '@/admin/StaffTab';
import { checkName, checkPin, staffStatus, deviceStatus, deviceKind, staffSummary } from '@/admin/lib/staff';
import { fakeHub } from '../helpers/fakeHub';

// Who may take money in this restaurant, and which devices may reach the hub. The wording rules
// first, then the screen.

describe('staff wording and checks', () => {
  it('a PIN is four digits, and not one anybody would try first', () => {
    expect(checkPin('7391')).toEqual({ ok: true, value: '7391' });
    expect(checkPin('').error).toMatch(/Enter a 4-digit PIN/);
    for (const bad of ['123', '12345', 'abcd', '12 4']) expect(checkPin(bad).error, bad).toMatch(/exactly 4 digits/);
    for (const weak of ['0000', '1234', '1111', '4321', '2580']) expect(checkPin(weak).error, weak).toMatch(/too easy to guess/);
  });

  it('a name is required, bounded, and not already on the list', () => {
    expect(checkName('  Asha ')).toEqual({ ok: true, value: 'Asha' });
    expect(checkName('   ').error).toMatch(/Give them a name/);
    expect(checkName('x'.repeat(61)).error).toMatch(/60/);
    expect(checkName('asha', ['Asha', 'Bhavna']).error).toMatch(/already on the staff list/);
    expect(checkName('Chetan', ['Asha']).ok).toBe(true);
  });

  it('a staff member reads as one of the states reception can act on', () => {
    expect(staffStatus({ pin_set: true, pin_set_at: '2026-10-19T10:00:00Z' })).toMatchObject({ tone: 'green', label: 'Can sign in' });
    expect(staffStatus({ pin_set: false, invite_expires_at: '2026-10-28T10:00:00Z', invite_expired: false })).toMatchObject({ tone: 'amber', label: 'Invited' });
    expect(staffStatus({ pin_set: false, invite_expired: true })).toMatchObject({ tone: 'rust', label: 'Invite expired' });
    expect(staffStatus({ active: false, pin_set: true })).toMatchObject({ tone: 'muted', label: 'Removed' });
    expect(staffStatus({ active: false }).detail).toMatch(/past bills name them/);
  });

  it('a device says whether it still counts', () => {
    expect(deviceStatus({ expired: false, expires_at: '2026-11-19T10:00:00Z' })).toMatchObject({ tone: 'green', label: 'Enrolled' });
    expect(deviceStatus({ expired: true })).toMatchObject({ tone: 'muted', label: 'Expired' });
  });

  it('a kitchen screen is named as one, and says what it cannot do; an ordinary handset is left unlabelled', () => {
    expect(deviceKind({ scope: 'kitchen' })).toEqual({ label: 'Kitchen screen', note: expect.stringMatching(/Cannot take orders or touch bills/) });
    expect(deviceKind({ scope: 'full' })).toEqual({ label: null, note: '' });
    // Grants from before scopes existed carry none, and were handsets.
    expect(deviceKind({})).toEqual({ label: null, note: '' });
  });

  it('the header counts people and devices, and names what still needs doing', () => {
    expect(staffSummary([], [])).toBe('0 people · 0 devices');
    expect(staffSummary([{ pin_set: true }], [{ expired: false }])).toBe('1 person · 1 device');
    expect(staffSummary(
      [{ pin_set: true }, { pin_set: false }, { active: false, pin_set: true }],
      [{ expired: false }, { expired: true }]
    )).toBe('2 people · 1 yet to set a PIN · 1 device');
  });
});

const ASHA = { id: 'w_1', name: 'Asha', role: 'manager', active: true, pin_set: true, pin_set_at: '2026-10-19T10:00:00Z' };
const BHAVNA = { id: 'w_2', name: 'Bhavna', role: 'waiter', active: true, pin_set: false, invite_expires_at: '2026-10-28T10:00:00Z', invite_expired: false };
const CHETAN = { id: 'w_3', name: 'Chetan', role: 'kitchen', active: true, pin_set: false, invite_expired: true };
const DEVICE = { id: 'dev_1', label: 'Asha handset', issued_at: '2026-10-01T10:00:00Z', expires_at: '2026-10-31T10:00:00Z', expired: false };

const answer = (over = {}) => ({
  body: {
    success: true,
    staff: [ASHA, BHAVNA, CHETAN],
    devices: [DEVICE],
    roles: [{ id: 'waiter', label: 'Waiter' }, { id: 'manager', label: 'Manager' }, { id: 'kitchen', label: 'Kitchen' }],
    ...over
  }
});
const setup = (routes = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({ 'GET /admin/staff': answer(), ...routes });
  render(<StaffTab notify={notify} />);
  return { hub, notify };
};
const row = name => screen.getByRole('listitem', { name });
/** The list only exists after the first read of the hub, so every row lookup waits for it. */
const rowWhenLoaded = name => screen.findByRole('listitem', { name });

describe('staff tab', () => {
  it('lists everyone with their role and where they stand', async () => {
    setup();
    expect(await screen.findByText('3 people · 2 yet to set a PIN · 1 device')).toBeInTheDocument();
    // The role also appears as an <option> in the select, so match the badge specifically.
    expect(within(row('Asha')).getByText('Manager', { selector: 'span' })).toBeInTheDocument();
    expect(within(row('Asha')).getByText('Can sign in')).toBeInTheDocument();
    expect(within(row('Bhavna')).getByText('Invited')).toBeInTheDocument();
    expect(within(row('Chetan')).getByText('Invite expired')).toBeInTheDocument();
  });

  it('adding someone sends a name and a role, and shows the code exactly once', async () => {
    const { hub } = setup({
      'POST /admin/staff': { status: 201, body: { success: true, waiter: { id: 'w_9', name: 'Divya', role: 'waiter' }, invite_code: 'K7M2PQ', expires_at: '2026-10-28T10:00:00Z' } }
    });
    await userEvent.click(await screen.findByRole('button', { name: /Add someone/ }));

    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Name'), 'Divya');
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'waiter');
    await userEvent.click(within(form).getByRole('button', { name: 'Create invite' }));

    expect(hub.calls('POST /admin/staff')[0].body).toEqual({ name: 'Divya', role: 'waiter' });
    const shown = await screen.findByRole('dialog');
    expect(within(shown).getByText('K7M2PQ')).toBeInTheDocument();
    expect(within(shown).getByText(/only time it is shown/)).toBeInTheDocument();
  });

  it('reception never types the PIN when adding someone -- there is no PIN field at all', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /Add someone/ }));
    const form = await screen.findByRole('dialog');
    expect(within(form).queryByLabelText(/PIN/i)).not.toBeInTheDocument();
    expect(within(form).getByText(/set their own PIN/)).toBeInTheDocument();
  });

  it('a duplicate name is caught before the hub is asked', async () => {
    const { hub } = setup();
    await userEvent.click(await screen.findByRole('button', { name: /Add someone/ }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText('Name'), 'asha');
    expect(within(form).getByText('asha is already on the staff list.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Create invite' })).toBeDisabled();
    expect(hub.calls('POST /admin/staff')).toHaveLength(0);
  });

  it('resetting a PIN sends it, and refuses an easy one before asking', async () => {
    const { hub, notify } = setup({ 'POST /admin/staff/w_1/pin': { body: { success: true, waiter: ASHA } } });
    await userEvent.click(within(await rowWhenLoaded('Asha')).getByRole('button', { name: /Reset PIN/ }));

    const form = await screen.findByRole('dialog');
    const field = within(form).getByLabelText('New PIN');
    await userEvent.type(field, '1111');
    expect(within(form).getByText(/too easy to guess/)).toBeInTheDocument();
    expect(hub.calls('POST /admin/staff/w_1/pin')).toHaveLength(0);

    await userEvent.clear(field);
    await userEvent.type(field, '8502');
    await userEvent.click(within(form).getByRole('button', { name: 'Set PIN' }));
    expect(hub.calls('POST /admin/staff/w_1/pin')[0].body).toEqual({ pin: '8502' });
    expect(notify).toHaveBeenCalledWith('Asha has a new PIN.');
  });

  it('someone still invited is offered a new invite rather than a PIN reset', async () => {
    const { hub } = setup({ 'POST /admin/staff/w_3/reinvite': { body: { success: true, waiter: CHETAN, invite_code: 'NEW999', expires_at: '2026-10-29T10:00:00Z' } } });
    expect(within(await rowWhenLoaded('Chetan')).queryByRole('button', { name: /Reset PIN/ })).not.toBeInTheDocument();
    await userEvent.click(within(row('Chetan')).getByRole('button', { name: 'New invite' }));
    expect(hub.calls('POST /admin/staff/w_3/reinvite')).toHaveLength(1);
    expect(await screen.findByText('NEW999')).toBeInTheDocument();
  });

  it('changing a role saves it straight away', async () => {
    const { hub, notify } = setup({ 'PUT /admin/staff/w_2/role': { body: { success: true, waiter: { ...BHAVNA, role: 'manager' } } } });
    await userEvent.selectOptions(within(await rowWhenLoaded('Bhavna')).getByLabelText('Role for Bhavna'), 'manager');
    expect(hub.calls('PUT /admin/staff/w_2/role')[0].body).toEqual({ role: 'manager' });
    expect(notify).toHaveBeenCalledWith('Bhavna is now a manager.');
  });

  it('removing someone is confirmed, and says they stay on the record', async () => {
    const { hub } = setup({ 'DELETE /admin/staff/w_1': { body: { success: true } } });
    await userEvent.click(within(await rowWhenLoaded('Asha')).getByRole('button', { name: 'Remove Asha' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/bills they took still name them/)).toBeInTheDocument();
    expect(hub.calls('DELETE /admin/staff/w_1')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(hub.calls('DELETE /admin/staff/w_1')).toHaveLength(1);
  });
});

describe('staff tab — devices', () => {
  it('lists enrolled devices and revokes one without touching the others', async () => {
    const { hub, notify } = setup({ 'DELETE /admin/devices/dev_1': { body: { success: true, device: { id: 'dev_1', label: 'Asha handset' } } } });
    expect(within(await screen.findByRole('listitem', { name: 'Asha handset' })).getByText('Enrolled')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Asha handset' }));
    expect(hub.calls('DELETE /admin/devices/dev_1')).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith('Asha handset can no longer reach the hub.');
  });

  it('tells a kitchen screen apart from a handset, so a tablet at the pass is not mistaken for a phone', async () => {
    const barScreen = { ...DEVICE, id: 'dev_2', label: 'Bar screen', scope: 'kitchen' };
    setup({ 'GET /admin/staff': answer({ devices: [DEVICE, barScreen] }) });

    const bar = within(await screen.findByRole('listitem', { name: 'Bar screen' }));
    expect(bar.getByText('Kitchen screen')).toBeInTheDocument();
    expect(bar.getByText(/Cannot take orders or touch bills/)).toBeInTheDocument();

    const handset = within(screen.getByRole('listitem', { name: 'Asha handset' }));
    expect(handset.queryByText('Kitchen screen')).not.toBeInTheDocument();
  });

  it('rotating the code is confirmed, and warns that every device has to join again', async () => {
    const { hub, notify } = setup({ 'POST /admin/devices/rotate-code': { body: { success: true, revoked: 3 } } });
    await userEvent.click(await screen.findByRole('button', { name: /Rotate the enrollment code/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/has to join again with the new code/)).toBeInTheDocument();
    expect(within(dialog).getByText(/To lock out a single device, remove just that one/)).toBeInTheDocument();
    expect(hub.calls('POST /admin/devices/rotate-code')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Rotate it' }));
    expect(notify).toHaveBeenCalledWith('Code rotated. 3 device(s) must join again.');
  });

  it('with nothing enrolled, says how a device joins', async () => {
    setup({ 'GET /admin/staff': answer({ devices: [] }) });
    expect(await screen.findByText('No devices enrolled')).toBeInTheDocument();
    expect(screen.getByText(/scanning the code on the Kitchen Display/)).toBeInTheDocument();
  });

  it('a hub that cannot be reached says so rather than showing an empty staff list', async () => {
    const { hub } = setup({ 'GET /admin/staff': ({ call }) => (call === 1 ? new TypeError('Failed to fetch') : answer()) });
    expect(await screen.findByText('Could not load the staff list')).toBeInTheDocument();
    expect(screen.queryByText('Nobody on the list yet')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listitem', { name: 'Asha' })).toBeInTheDocument();
    expect(hub.calls('GET /admin/staff')).toHaveLength(2);
  });
});
