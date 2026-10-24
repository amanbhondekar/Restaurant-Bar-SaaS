import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OpsApp } from '@/ops/OpsApp';
import { OpsError } from '@/ops/lib/api';

// The operator console as a person uses it (§4.9): signing in with the console's token, seeing every restaurant at once, finding the ones
// that need a call, and opening one. The service is a fake; the real routes are tested in hub_server/test/opsRoutes.test.mjs. What matters
// here: the token is held in memory and goes nowhere else, what is shown is what the service sent (and shown as text), what could not be
// read is shown as not read rather than as zero, and there is nothing on the screen that could change anything.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const iso = ms => new Date(NOW + ms).toISOString();
const TOKEN = 'a-long-secret-console-token';

const hub = (over = {}) => ({
  state: 'live', seen_at: iso(-2 * MIN), reported_at: iso(-2 * MIN), started_at: iso(-5 * HOUR), version: '1.0.0',
  queued: 0, quarantined: 0, last_synced_at: iso(-3 * MIN), devices: 3, waiters: 5, ...over
});
const tenant = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase().replace(/\W+/g, '-'), city: 'Nagpur', phone: '9822012345', plan: 'pro', plan_status: 'active',
  trial_ends_at: null, current_period_end: iso(20 * DAY), created_at: iso(-90 * DAY),
  subscription: { status: 'active', plan: 'pro', plan_change_to: null, cancel_requested_at: null, period_end: iso(20 * DAY), last_event_at: iso(-10 * DAY) },
  hub: hub(), activity: { last_invoice_at: iso(-20 * MIN), invoices_7d: 140 }, attention: [], severity: null, ...over
});

const BRAVO = tenant('b', 'Bravo', {
  plan: 'starter', plan_status: 'past_due', current_period_end: iso(-4 * DAY), severity: 'high',
  attention: [{ code: 'past_due', severity: 'high', message: 'Payment is overdue.' }],
  subscription: { status: 'halted', plan: 'starter', plan_change_to: null, cancel_requested_at: null, period_end: iso(-4 * DAY), last_event_at: iso(-4 * DAY) },
  activity: { last_invoice_at: iso(-3 * HOUR), invoices_7d: 31 }
});
const CHARLIE = tenant('c', 'Charlie', {
  city: 'Pune', phone: '+91 98765 43210', severity: 'medium', hub: hub({ state: 'silent', seen_at: iso(-2 * DAY), reported_at: iso(-2 * DAY), queued: 12, quarantined: 2 }),
  attention: [{ code: 'hub_silent', severity: 'medium', message: 'No word from the hub for 2 days.' }]
});
const ALPHA = tenant('a', 'Alpha');
const DELTA = tenant('d', 'Delta', {
  plan: 'starter', plan_status: 'trialing', trial_ends_at: iso(10 * DAY), current_period_end: null, subscription: null,
  hub: hub({ state: 'never', seen_at: null, reported_at: null, started_at: null, version: null, queued: null, quarantined: null, last_synced_at: null, devices: null, waiters: null }),
  activity: { last_invoice_at: null, invoices_7d: 0 }
});
const FLEET = {
  success: true, generated_at: iso(0), truncated: false,
  summary: {
    tenants: 4, by_status: { active: 2, trialing: 1, past_due: 1, suspended: 0, cancelled: 0, other: 0 }, by_plan: { starter: 2, pro: 2, enterprise: 0, other: 0 },
    hubs: { live: 2, quiet: 0, silent: 1, never: 1 }, attention: { high: 1, medium: 1 }
  },
  attention: [
    { restaurant_id: 'b', name: 'Bravo', code: 'past_due', severity: 'high', message: 'Payment is overdue.' },
    { restaurant_id: 'c', name: 'Charlie', code: 'hub_silent', severity: 'medium', message: 'No word from the hub for 2 days.' }
  ],
  tenants: [BRAVO, CHARLIE, ALPHA, DELTA],
  events: [
    { id: 'e1', restaurant_id: 'b', restaurant_name: 'Bravo', razorpay_subscription_id: 'sub_1', event: 'subscription.halted', applied_plan_status: 'past_due', received_at: iso(-2 * HOUR) },
    { id: 'e2', restaurant_id: null, restaurant_name: null, razorpay_subscription_id: 'sub_x', event: 'subscription.charged', applied_plan_status: null, received_at: iso(-DAY) }
  ]
};
const DETAIL = id => ({
  success: true, generated_at: iso(0), tenant: FLEET.tenants.find(t => t.id === id),
  subscriptions: [
    { razorpay_subscription_id: 'sub_9', status: 'halted', plan: 'starter', plan_change_to: 'pro', cancel_requested_at: iso(-DAY), current_start: iso(-34 * DAY), current_end: iso(-4 * DAY), last_event_at: iso(-4 * DAY), created_at: iso(-34 * DAY) },
    { razorpay_subscription_id: 'sub_2', status: 'cancelled', plan: 'starter', plan_change_to: null, cancel_requested_at: null, current_start: null, current_end: null, last_event_at: null, created_at: iso(-90 * DAY) }
  ],
  events: [{ id: 'e1', restaurant_id: id, restaurant_name: FLEET.tenants.find(t => t.id === id).name, razorpay_subscription_id: 'sub_9', event: 'subscription.halted', applied_plan_status: 'past_due', received_at: iso(-4 * DAY) }]
});

const fakeApi = (over = {}) => ({
  fleet: vi.fn(async () => FLEET),
  tenant: vi.fn(async (token, id) => DETAIL(id)),
  ...over
});

function open(api = fakeApi(), props = {}) {
  const user = userEvent.setup();
  const view = render(<OpsApp api={api} pollMs={60000} clock={() => NOW} {...props} />);
  return { api, user, ...view };
}
async function signIn(user, token = TOKEN) {
  await user.type(screen.getByLabelText('Console token'), token);
  await user.click(screen.getByRole('button', { name: 'Open console' }));
}
async function opened(props) {
  const ctx = open(undefined, props);
  await signIn(ctx.user);
  await screen.findByRole('heading', { name: 'Restaurants' });
  return ctx;
}
const tile = name => within(screen.getByRole('group', { name }));
const rowOf = name => within(screen.getByRole('table')).getByRole('button', { name }).closest('tr');
const openRow = async (user, name) => {
  const table = await screen.findByRole('table');
  await user.click(within(table).getByRole('button', { name }));
};

afterEach(() => { vi.useRealTimers(); });

// --- signing in ---------------------------------------------------------------------------------------------------------------

describe('signing in', () => {
  it('asks for nothing until a token is given, and takes it in a field the browser will not remember', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api } = open();
    expect(screen.getByRole('heading', { name: 'Operator console' })).toBeInTheDocument();
    const field = screen.getByLabelText('Console token');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByRole('button', { name: 'Open console' })).toBeDisabled();
    expect(api.fleet).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('sends the token to the service, and shows the fleet', async () => {
    const { api } = await opened();
    expect(api.fleet).toHaveBeenCalledTimes(1);
    expect(api.fleet).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByRole('heading', { name: 'Operator console' })).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByLabelText('Console token')).not.toBeInTheDocument();
  });

  it.each([
    ['denied', 'That token was not accepted.'],
    ['locked', 'Too many wrong tries from here. Wait a few minutes and try again.'],
    ['off', 'The operator console is not switched on at this service.'],
    ['offline', 'Could not reach the service. Check your connection and try again.'],
    ['down', 'The database did not answer. Try again in a moment.']
  ])('says so when the answer is "%s", and stays where it is, ready to try again', async (kind, message) => {
    const api = fakeApi({ fleet: vi.fn().mockRejectedValue(new OpsError(kind, message)) });
    const { user } = open(api);
    await signIn(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('Console token')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open console' })).toBeEnabled();
  });

  it('can be tried again after a wrong token, and the message goes', async () => {
    const api = fakeApi({ fleet: vi.fn().mockRejectedValueOnce(new OpsError('denied', 'That token was not accepted.')).mockResolvedValue(FLEET) });
    const { user } = open(api);
    await signIn(user, 'wrong');
    await screen.findByRole('alert');
    await user.clear(screen.getByLabelText('Console token'));
    await user.type(screen.getByLabelText('Console token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    await screen.findByRole('heading', { name: 'Restaurants' });
    expect(api.fleet).toHaveBeenLastCalledWith(TOKEN);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends the token without the spaces round it, and sends nothing at all for an empty one, however the form is sent', async () => {
    const api = fakeApi();
    const { user } = open(api);
    const form = screen.getByLabelText('Console token').closest('form');
    fireEvent.submit(form);
    await user.type(screen.getByLabelText('Console token'), '   ');
    fireEvent.submit(form);
    expect(api.fleet).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Console token'));
    await user.type(screen.getByLabelText('Console token'), `  ${TOKEN}  `);
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    expect(api.fleet).toHaveBeenCalledTimes(1);
    expect(api.fleet).toHaveBeenCalledWith(TOKEN);
  });

  it('drops the old message as soon as it tries again, and marks the field only while there is one', async () => {
    let answer;
    const api = fakeApi({ fleet: vi.fn().mockRejectedValueOnce(new OpsError('denied', 'That token was not accepted.')).mockImplementation(() => new Promise(resolve => { answer = resolve; })) });
    const { user } = open(api);
    const field = screen.getByLabelText('Console token');
    expect(field).not.toHaveAttribute('aria-invalid');
    await signIn(user, 'wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted.');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(field).not.toHaveAttribute('aria-invalid');
    await act(async () => { answer(FLEET); });
    await screen.findByRole('table');
  });

  it('shows what the try said, and not the reason for being signed out, when both are there', async () => {
    const api = fakeApi({ fleet: vi.fn().mockResolvedValueOnce(FLEET).mockRejectedValueOnce(new OpsError('denied', 'x')).mockRejectedValueOnce(new OpsError('locked', 'Too many wrong tries from here. Wait a few minutes and try again.')) });
    const { user } = open(api);
    await signIn(user);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByLabelText('Console token');
    await user.type(screen.getByLabelText('Console token'), 'y');
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many wrong tries from here.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('not accepted any more');
  });

  it('cannot be pressed twice while it waits for an answer', async () => {
    let answer;
    const api = fakeApi({ fleet: vi.fn(() => new Promise(resolve => { answer = resolve; })) });
    const { user } = open(api);
    await user.type(screen.getByLabelText('Console token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
    await user.keyboard('{Enter}');
    fireEvent.submit(screen.getByLabelText('Console token').closest('form'));
    expect(api.fleet).toHaveBeenCalledTimes(1);
    await act(async () => { answer(FLEET); });
    await screen.findByRole('heading', { name: 'Restaurants' });
  });

  it('keeps the token in memory only: not in storage, not in a cookie, not in the address, not on the page', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const before = window.location.href;
    await opened();
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
    expect(window.location.href).toBe(before);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('signs out: the data and the token go, and the sign-in comes back empty', async () => {
    const { user, api } = await opened();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByLabelText('Console token')).toHaveValue('');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Bravo');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.fleet).toHaveBeenCalledTimes(1);
  });
});

// --- the fleet ------------------------------------------------------------------------------------------------------------------

describe('the fleet', () => {
  it('counts the restaurants by what matters: how many, how many are paying, on trial or overdue, how many hubs are live, and how many need a call', async () => {
    await opened();
    expect(tile('Restaurants').getByText('4')).toBeInTheDocument();
    expect(tile('Active').getByText('2')).toBeInTheDocument();
    expect(tile('On trial').getByText('1')).toBeInTheDocument();
    expect(tile('Overdue or suspended').getByText('1')).toBeInTheDocument();
    expect(tile('Hubs live').getByText('2')).toBeInTheDocument();
    expect(tile('Hubs live').getByText('of 4')).toBeInTheDocument();
    expect(tile('Need attention').getByText('2')).toBeInTheDocument();
  });

  it('adds suspended to overdue, and shows the number of high-priority ones', async () => {
    const api = fakeApi({ fleet: vi.fn(async () => ({ ...FLEET, summary: { ...FLEET.summary, by_status: { ...FLEET.summary.by_status, past_due: 2, suspended: 3 } } })) });
    const { user } = open(api);
    await signIn(user);
    await screen.findByRole('heading', { name: 'Restaurants' });
    expect(tile('Overdue or suspended').getByText('5')).toBeInTheDocument();
    expect(tile('Need attention').getByText('1 high')).toBeInTheDocument();
  });

  it('says when it was read', async () => {
    await opened();
    expect(screen.getByText('Updated just now')).toBeInTheDocument();
  });

  it('lists what needs attention, worst first, in words, with how bad it is', async () => {
    await opened();
    const section = within(screen.getByRole('region', { name: 'Needs attention' }));
    const items = section.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByRole('button', { name: 'Bravo' })).toBeInTheDocument();
    expect(items[0]).toHaveTextContent('Payment is overdue.');
    expect(items[0]).toHaveTextContent('High');
    expect(within(items[1]).getByRole('button', { name: 'Charlie' })).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('No word from the hub for 2 days.');
    expect(items[1]).toHaveTextContent('Medium');
  });

  it('says so when nothing does', async () => {
    const api = fakeApi({ fleet: vi.fn(async () => ({ ...FLEET, attention: [], summary: { ...FLEET.summary, attention: { high: 0, medium: 0 } } })) });
    const { user } = open(api);
    await signIn(user);
    await screen.findByRole('heading', { name: 'Restaurants' });
    expect(within(screen.getByRole('region', { name: 'Needs attention' })).getByText('Nothing needs attention.')).toBeInTheDocument();
    expect(tile('Need attention').getByText('0')).toBeInTheDocument();
    expect(tile('Need attention').queryByText(/high/)).not.toBeInTheDocument();
  });

  it('lists every restaurant in the order it was sent, with its plan, its billing, its hub, its queue and its week\'s bills', async () => {
    await opened();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map(r => within(r).getAllByRole('button')[0].textContent)).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta']);
    expect(within(screen.getByRole('region', { name: 'Restaurants' })).getByText('4 of 4')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Recent events' })).getByText('Subscription changes across every restaurant')).toBeInTheDocument();

    const bravo = within(rowOf('Bravo'));
    expect(bravo.getByText('Starter')).toBeInTheDocument();
    expect(bravo.getByText('Overdue')).toBeInTheDocument();
    expect(bravo.getByText('Ended 4 days ago')).toBeInTheDocument();
    expect(bravo.getByText('Live')).toBeInTheDocument();
    expect(bravo.getByText('2 min ago')).toBeInTheDocument();
    expect(bravo.getByText('31')).toBeInTheDocument();
    expect(bravo.getByText('last 3 hours ago')).toBeInTheDocument();
    expect(bravo.getByText('v1.0.0')).toBeInTheDocument();
    expect(bravo.queryByText(/shelved/)).not.toBeInTheDocument();

    const charlie = within(rowOf('Charlie'));
    expect(charlie.getByText('Silent')).toBeInTheDocument();
    expect(charlie.getByText('2 days ago')).toBeInTheDocument();
    expect(charlie.getByText('12')).toBeInTheDocument();
    expect(charlie.getByText('2 shelved')).toBeInTheDocument();

    const alpha = within(rowOf('Alpha'));
    expect(alpha.getByText('Pro')).toBeInTheDocument();
    expect(alpha.getByText('Renews in 20 days')).toBeInTheDocument();
  });

  it('shows what is not known as not known: a hub that never reported has no queue, not an empty one, and a trial says when it ends', async () => {
    await opened();
    const delta = within(rowOf('Delta'));
    expect(delta.getByText('Never reported')).toBeInTheDocument();
    expect(delta.getByText('On trial')).toBeInTheDocument();
    expect(delta.getByText('Trial ends in 10 days')).toBeInTheDocument();
    const cells = rowOf('Delta').querySelectorAll('td');
    expect(cells[3]).toHaveTextContent(/^Never reported$/);
    expect(within(cells[4]).getByText('—')).toBeInTheDocument();
    expect(within(cells[5]).getByText('0')).toBeInTheDocument();
    expect(within(cells[5]).getByText('no bills yet')).toBeInTheDocument();
  });

  it('colours what matters: overdue and high priority in red, medium in amber, live in green, and nothing else', async () => {
    await opened();
    expect(screen.getByRole('group', { name: 'Overdue or suspended' })).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByRole('group', { name: 'Need attention' })).toHaveAttribute('data-tone', 'bad');
    for (const name of ['Restaurants', 'Active', 'On trial', 'Hubs live']) expect(screen.getByRole('group', { name })).toHaveAttribute('data-tone', 'none');
    const items = within(screen.getByRole('region', { name: 'Needs attention' })).getAllByRole('listitem');
    expect(within(items[0]).getByText('High')).toHaveAttribute('data-tone', 'bad');
    expect(within(items[1]).getByText('Medium')).toHaveAttribute('data-tone', 'warning');
    expect(within(rowOf('Bravo')).getByText('Overdue')).toHaveAttribute('data-tone', 'bad');
    expect(within(rowOf('Bravo')).getByText('Live')).toHaveAttribute('data-tone', 'good');
    expect(within(rowOf('Charlie')).getByText('Silent')).toHaveAttribute('data-tone', 'warning');
    expect(within(rowOf('Alpha')).getByText('Active')).toHaveAttribute('data-tone', 'good');
    expect(within(rowOf('Delta')).getByText('On trial')).toHaveAttribute('data-tone', 'info');
    expect(within(rowOf('Delta')).getByText('Never reported')).toHaveAttribute('data-tone', 'warning');
  });

  it('draws the tiles plainly when nothing is wrong, and amber when only medium things are', async () => {
    const calm = { ...FLEET, attention: [], summary: { ...FLEET.summary, by_status: { ...FLEET.summary.by_status, past_due: 0, suspended: 0 }, attention: { high: 0, medium: 0 } } };
    const first = open(fakeApi({ fleet: vi.fn(async () => calm) }));
    await signIn(first.user);
    await screen.findByRole('table');
    expect(screen.getByRole('group', { name: 'Overdue or suspended' })).toHaveAttribute('data-tone', 'none');
    expect(screen.getByRole('group', { name: 'Need attention' })).toHaveAttribute('data-tone', 'none');
    first.unmount();

    const amber = { ...calm, summary: { ...calm.summary, attention: { high: 0, medium: 3 } } };
    const second = open(fakeApi({ fleet: vi.fn(async () => amber) }));
    await signIn(second.user);
    await screen.findByRole('table');
    expect(screen.getByRole('group', { name: 'Need attention' })).toHaveAttribute('data-tone', 'warning');
    expect(tile('Need attention').getByText('3')).toBeInTheDocument();
    expect(tile('Need attention').queryByText(/high/)).not.toBeInTheDocument();
  });

  it('marks the restaurants that need attention in a way a screen reader hears', async () => {
    await opened();
    expect(within(rowOf('Bravo')).getByText('Needs attention (high)')).toBeInTheDocument();
    expect(within(rowOf('Charlie')).getByText('Needs attention (medium)')).toBeInTheDocument();
    expect(within(rowOf('Alpha')).queryByText(/Needs attention/)).not.toBeInTheDocument();
  });

  it('lists what has happened lately, in words, including what matched no restaurant', async () => {
    await opened();
    const section = within(screen.getByRole('region', { name: 'Recent events' }));
    const items = section.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Payment failed, subscription halted');
    expect(items[0]).toHaveTextContent('Bravo');
    expect(items[0]).toHaveTextContent('2 hours ago');
    expect(items[1]).toHaveTextContent('Payment taken');
    expect(items[1]).toHaveTextContent('Unknown restaurant');
    expect(items[0]).toHaveTextContent('Overdue');
    expect(within(items[1]).queryByText(/^(Active|Overdue|On trial|Suspended|Cancelled)$/)).not.toBeInTheDocument();
  });

  it('says so when nothing has happened', async () => {
    const api = fakeApi({ fleet: vi.fn(async () => ({ ...FLEET, events: [] })) });
    const { user } = open(api);
    await signIn(user);
    await screen.findByRole('heading', { name: 'Restaurants' });
    expect(within(screen.getByRole('region', { name: 'Recent events' })).getByText('Nothing has happened yet.')).toBeInTheDocument();
  });

  it('says so when there are no restaurants at all', async () => {
    const empty = { ...FLEET, tenants: [], attention: [], events: [], summary: { ...FLEET.summary, tenants: 0, hubs: { live: 0, quiet: 0, silent: 0, never: 0 }, by_status: { active: 0, trialing: 0, past_due: 0, suspended: 0, cancelled: 0, other: 0 }, attention: { high: 0, medium: 0 } } };
    const { user } = open(fakeApi({ fleet: vi.fn(async () => empty) }));
    await signIn(user);
    expect(await screen.findByText('No restaurants have signed up yet.')).toBeInTheDocument();
  });

  it('says when the list was cut at what one answer can hold', async () => {
    const { user } = open(fakeApi({ fleet: vi.fn(async () => ({ ...FLEET, truncated: true })) }));
    await signIn(user);
    expect(await screen.findByText(/showing the first 4 restaurants/i)).toBeInTheDocument();
  });

  it('shows what a restaurant is called as text, whatever it is called', async () => {
    const evil = tenant('x', '<img src=x onerror=alert(1)>', { city: '<b>Pune</b>' });
    const { user, container } = open(fakeApi({ fleet: vi.fn(async () => ({ ...FLEET, tenants: [evil], attention: [] })) }));
    await signIn(user);
    expect(await screen.findByRole('button', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument();
    expect(screen.getByText('<b>Pune</b>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });
});

// --- finding one -----------------------------------------------------------------------------------------------------------------

describe('finding a restaurant', () => {
  const shown = () => screen.getAllByRole('row').slice(1).map(r => within(r).getAllByRole('button')[0].textContent);

  it('keeps those whose name, city or phone has what is typed, ignoring capitals and spacing', async () => {
    const { user } = await opened();
    const box = screen.getByLabelText('Search restaurants');
    await user.type(box, 'ALPH');
    expect(shown()).toEqual(['Alpha']);
    await user.clear(box);
    await user.type(box, 'pune');
    expect(shown()).toEqual(['Charlie']);
    await user.clear(box);
    await user.type(box, '98765 4321');
    expect(shown()).toEqual(['Charlie']);
    await user.clear(box);
    expect(shown()).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta']);
  });

  it('says so when nothing matches, and offers to clear it', async () => {
    const { user } = await opened();
    await user.type(screen.getByLabelText('Search restaurants'), 'zzz');
    expect(screen.getByText('No restaurants match.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(shown()).toHaveLength(4);
  });

  it('keeps those in a view, with how many each would keep', async () => {
    const { user } = await opened();
    const chip = (label, n) => screen.getByRole('button', { name: new RegExp(`^${label}\\s*${n}$`) });
    expect(chip('All', 4)).toHaveAttribute('aria-pressed', 'true');
    await user.click(chip('Needs attention', 2));
    expect(shown()).toEqual(['Bravo', 'Charlie']);
    expect(chip('Needs attention', 2)).toHaveAttribute('aria-pressed', 'true');
    expect(chip('All', 4)).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip('On trial', 1));
    expect(shown()).toEqual(['Delta']);
    await user.click(chip('Overdue', 1));
    expect(shown()).toEqual(['Bravo']);
    await user.click(chip('Hub silent', 2));
    expect(shown()).toEqual(['Charlie', 'Delta']);
    await user.click(chip('All', 4));
    expect(shown()).toHaveLength(4);
  });

  it('keeps what was typed when a view is chosen, and the view when something is typed', async () => {
    const { user } = await opened();
    const box = screen.getByLabelText('Search restaurants');
    await user.type(box, 'del');
    await user.click(screen.getByRole('button', { name: /^Hub silent/ }));
    expect(shown()).toEqual(['Delta']);
    expect(box).toHaveValue('del');
    await user.clear(box);
    await user.type(box, 'a');
    expect(shown()).toEqual(['Charlie', 'Delta']);
    expect(screen.getByRole('button', { name: /^Hub silent/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('region', { name: 'Restaurants' })).getByText('2 of 4')).toBeInTheDocument();
  });

  it('puts a view and a search together', async () => {
    const { user } = await opened();
    await user.click(screen.getByRole('button', { name: /^Hub silent/ }));
    await user.type(screen.getByLabelText('Search restaurants'), 'del');
    expect(shown()).toEqual(['Delta']);
  });
});

// --- one restaurant ---------------------------------------------------------------------------------------------------------------

describe('one restaurant', () => {
  it('opens from the table or from the list of what needs attention, and asks the service for its history with the same token', async () => {
    const { user, api } = await opened();
    await user.click(within(screen.getByRole('region', { name: 'Needs attention' })).getByRole('button', { name: 'Bravo' }));
    expect(api.tenant).toHaveBeenCalledWith(TOKEN, 'b');
    expect(await screen.findByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All restaurants' }));
    await user.click(rowOf('Charlie').querySelector('button'));
    expect(api.tenant).toHaveBeenLastCalledWith(TOKEN, 'c');
    expect(await screen.findByRole('heading', { name: 'Charlie' })).toBeInTheDocument();
  });

  it('shows who it is, how to ring them, and why anyone should', async () => {
    const { user } = await opened();
    await user.click(rowOf('Bravo').querySelector('button'));
    await screen.findByRole('heading', { name: 'Subscriptions' });
    expect(screen.getByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
    expect(screen.getByText(/Nagpur/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '9822012345' })).toHaveAttribute('href', 'tel:9822012345');
    const why = within(screen.getByRole('region', { name: 'Why this needs attention' }));
    expect(why.getByText('Payment is overdue.')).toBeInTheDocument();
  });

  it('rings the number as dialled: spaces and brackets taken out, the plus kept', async () => {
    const { user } = await opened();
    await openRow(user, 'Charlie');
    expect(await screen.findByRole('link', { name: '+91 98765 43210' })).toHaveAttribute('href', 'tel:+919876543210');
  });

  it('shows a trial end only for a restaurant on trial that has one, and a period end only when there is one, ended or still to come', async () => {
    const onTrialNoEnd = tenant('t1', 'Trial No End', { plan_status: 'trialing', trial_ends_at: null, current_period_end: null });
    const wasTrial = tenant('t2', 'Was Trial', { trial_ends_at: iso(-30 * DAY) });
    const all = [BRAVO, ALPHA, DELTA, onTrialNoEnd, wasTrial];
    const api = fakeApi({
      fleet: vi.fn(async () => ({ ...FLEET, tenants: all, attention: [] })),
      tenant: vi.fn(async (token, id) => ({ ...DETAIL('b'), tenant: all.find(t => t.id === id) }))
    });
    const { user } = open(api);
    await signIn(user);
    const billingLabels = async name => {
      await openRow(user, name);
      await screen.findByRole('heading', { name: 'Subscriptions' });
      const labels = [...document.querySelectorAll('section[aria-labelledby="ops-billing"] dt')].map(dt => dt.textContent);
      await user.click(screen.getByRole('button', { name: 'All restaurants' }));
      return labels;
    };
    expect(await billingLabels('Trial No End')).toEqual(['Plan', 'State', 'Signed up']);
    expect(await billingLabels('Was Trial')).toEqual(['Plan', 'State', 'Period ends', 'Signed up']);
    expect(await billingLabels('Bravo')).toEqual(['Plan', 'State', 'Period ended', 'Signed up']);
    expect(await billingLabels('Delta')).toEqual(['Plan', 'State', 'Trial ends', 'Signed up']);
  });

  it('has no section about what is wrong for a restaurant with nothing wrong, and its names are plain buttons', async () => {
    const { user } = await opened();
    expect(rowOf('Alpha').querySelector('button')).toHaveAttribute('type', 'button');
    await user.click(rowOf('Alpha').querySelector('button'));
    await screen.findByRole('heading', { name: 'Subscriptions' });
    expect(screen.queryByRole('region', { name: 'Why this needs attention' })).not.toBeInTheDocument();
    expect(screen.queryByText('Why this needs attention')).not.toBeInTheDocument();
  });

  it('shows the billing: plan, state, and the dates that matter', async () => {
    const { user } = await opened();
    await user.click(rowOf('Delta').querySelector('button'));
    const billing = within(await screen.findByRole('region', { name: 'Billing' }));
    expect(billing.getByText('Plan').nextSibling).toHaveTextContent('Starter');
    expect(billing.getByText('State').nextSibling).toHaveTextContent('On trial');
    expect(billing.getByText('Trial ends').nextSibling).toHaveTextContent('in 10 days');
    expect(billing.getByText('Signed up').nextSibling).toHaveTextContent('12 weeks ago');
  });

  it('lists its subscriptions with their state and dates, newest first, and its own events', async () => {
    const { user } = await opened();
    await user.click(rowOf('Bravo').querySelector('button'));
    const subs = within(await screen.findByRole('region', { name: 'Subscriptions' }));
    const rows = subs.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('sub_9');
    expect(rows[0]).toHaveTextContent('halted');
    expect(rows[0]).toHaveTextContent('changing to Pro');
    expect(rows[0]).toHaveTextContent('asked to cancel 1 day ago');
    expect(rows[1]).toHaveTextContent('sub_2');
    expect(rows[1].querySelectorAll('td')[3]).toHaveTextContent(/^—$/);
    expect(rows[1].querySelectorAll('td')[4]).toHaveTextContent(/^—$/);
    const events = within(screen.getByRole('region', { name: 'Events for this restaurant' }));
    expect(events.getByText('Payment failed, subscription halted')).toBeInTheDocument();
    expect(events.getByText('4 days ago')).toBeInTheDocument();
  });

  it('says so when it has none', async () => {
    const api = fakeApi({ tenant: vi.fn(async (token, id) => ({ ...DETAIL(id), subscriptions: [], events: [] })) });
    const { user } = open(api);
    await signIn(user);
    await openRow(user, 'Delta');
    expect(await screen.findByText('No subscription has been started.')).toBeInTheDocument();
    expect(screen.getByText('Nothing has happened to this restaurant\'s subscription.')).toBeInTheDocument();
  });

  it('shows the hub: when it was heard, the clock, the version, the queue, the floor', async () => {
    const { user } = await opened();
    await user.click(rowOf('Charlie').querySelector('button'));
    const hubSection = within(await screen.findByRole('region', { name: 'Hub' }));
    expect(hubSection.getByText('Last heard').nextSibling).toHaveTextContent('Silent');
    expect(hubSection.getByText('Last heard').nextSibling).toHaveTextContent('2 days ago');
    expect(hubSection.getByText('Version').nextSibling).toHaveTextContent('1.0.0');
    expect(hubSection.getByText('Running since').nextSibling).toHaveTextContent('5 hours ago');
    expect(hubSection.getByText('Last synced').nextSibling).toHaveTextContent('3 min ago');
    expect(hubSection.getByText('Waiting to sync').nextSibling).toHaveTextContent(/^12$/);
    expect(hubSection.getByText('Shelved').nextSibling).toHaveTextContent(/^2$/);
    expect(hubSection.getByText('Handsets').nextSibling).toHaveTextContent(/^3$/);
    expect(hubSection.getByText('Waiters').nextSibling).toHaveTextContent(/^5$/);
    expect(hubSection.queryByText('Clock')).not.toBeInTheDocument();
  });

  it('says how far out a hub\'s clock is, when it is', async () => {
    const skewed = tenant('s', 'Skewed', { hub: hub({ reported_at: iso(-2 * MIN + 20 * MIN) }) });
    const api = fakeApi({ fleet: vi.fn(async () => ({ ...FLEET, tenants: [skewed], attention: [] })), tenant: vi.fn(async () => ({ ...DETAIL('b'), tenant: skewed })) });
    const { user } = open(api);
    await signIn(user);
    await openRow(user, 'Skewed');
    const hubSection = within(await screen.findByRole('region', { name: 'Hub' }));
    expect(hubSection.getByText('Clock').nextSibling).toHaveTextContent('20 minutes ahead');
  });

  it('shows a hub that has never reported as one that has not, with a dash for everything it would have said', async () => {
    const { user } = await opened();
    await user.click(rowOf('Delta').querySelector('button'));
    const hubSection = within(await screen.findByRole('region', { name: 'Hub' }));
    expect(hubSection.getByText('Last heard').nextSibling).toHaveTextContent(/^Never reported$/);
    for (const label of ['Version', 'Running since', 'Last synced', 'Waiting to sync', 'Shelved', 'Handsets', 'Waiters']) {
      expect(hubSection.getByText(label).nextSibling).toHaveTextContent('—');
    }
  });

  it('shows the week\'s bills', async () => {
    const { user } = await opened();
    await user.click(rowOf('Bravo').querySelector('button'));
    const activity = within(await screen.findByRole('region', { name: 'Activity' }));
    expect(activity.getByText('Bills in 7 days').nextSibling).toHaveTextContent('31');
    expect(activity.getByText('Last bill').nextSibling).toHaveTextContent('3 hours ago');
  });

  it('shows what it knows at once and says it is loading the rest, and goes back', async () => {
    let answer;
    const api = fakeApi({ tenant: vi.fn(() => new Promise(resolve => { answer = resolve; })) });
    const { user } = open(api);
    await signIn(user);
    await openRow(user, 'Bravo');
    expect(screen.getByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
    expect(screen.getByText('Loading the subscriptions and events…')).toBeInTheDocument();
    await act(async () => { answer(DETAIL('b')); });
    expect(await screen.findByRole('heading', { name: 'Subscriptions' })).toBeInTheDocument();
    expect(screen.queryByText('Loading the subscriptions and events…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All restaurants' }));
    expect(screen.getByRole('heading', { name: 'Restaurants' })).toBeInTheDocument();
  });

  it('measures what it already knows from when the fleet was read, not from now', async () => {
    let answer;
    const api = fakeApi({ tenant: vi.fn(() => new Promise(resolve => { answer = resolve; })) });
    const { user } = open(api, { clock: () => NOW + 7 * DAY });
    await signIn(user);
    await openRow(user, 'Bravo');
    const billing = within(screen.getByRole('region', { name: 'Billing' }));
    expect(billing.getByText('Signed up').nextSibling).toHaveTextContent('12 weeks ago');
    await act(async () => { answer(DETAIL('b')); });
    await screen.findByRole('heading', { name: 'Subscriptions' });
  });

  it('opens a restaurant the fleet did not list (one that came from the events) by the name the event gave, and shows the rest once it is read', async () => {
    let answer;
    const events = [{ id: 'e9', restaurant_id: 'z', restaurant_name: 'Zeta', razorpay_subscription_id: 'sub_z', event: 'subscription.charged', applied_plan_status: 'active', received_at: iso(-HOUR) }];
    const api = fakeApi({ fleet: vi.fn(async () => ({ ...FLEET, events })), tenant: vi.fn(() => new Promise(resolve => { answer = resolve; })) });
    const { user } = open(api);
    await signIn(user);
    const section = await screen.findByRole('region', { name: 'Recent events' });
    await user.click(within(section).getByRole('button', { name: 'Zeta' }));
    expect(api.tenant).toHaveBeenCalledWith(TOKEN, 'z');
    expect(screen.getByRole('heading', { name: 'Zeta' })).toBeInTheDocument();
    expect(screen.getByText('Loading the subscriptions and events…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Billing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Hub' })).not.toBeInTheDocument();
    await act(async () => { answer({ ...DETAIL('b'), tenant: tenant('z', 'Zeta Kitchen') }); });
    expect(await screen.findByRole('region', { name: 'Billing' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Zeta Kitchen' })).toBeInTheDocument();
  });

  it('has no phone link for a restaurant with no phone', async () => {
    const quiet = tenant('q', 'Quiet', { phone: null });
    const { user } = open(fakeApi({ fleet: vi.fn(async () => ({ ...FLEET, tenants: [quiet], attention: [] })) }));
    await signIn(user);
    await openRow(user, 'Quiet');
    await screen.findByRole('heading', { name: 'Quiet' });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('signs out, and says why, if the token stops being accepted while a restaurant is being read', async () => {
    const api = fakeApi({ tenant: vi.fn().mockRejectedValue(new OpsError('denied', 'That token was not accepted.')) });
    const { user } = open(api);
    await signIn(user);
    await openRow(user, 'Bravo');
    expect(await screen.findByLabelText('Console token')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('The console token was not accepted any more. Sign in again.');
    expect(screen.queryByRole('heading', { name: 'Bravo' })).not.toBeInTheDocument();
  });

  it('keeps what it had on screen while it is read again, and shows an answer that arrives late no more than the newest one', async () => {
    const waiting = [];
    const api = fakeApi({ tenant: vi.fn(() => new Promise(resolve => { waiting.push(resolve); })) });
    const { user } = open(api);
    await signIn(user);
    await openRow(user, 'Bravo');
    await act(async () => { waiting[0](DETAIL('b')); });
    await screen.findByRole('heading', { name: 'Subscriptions' });

    // Reload twice: the first reload's answer comes last, and is old.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(api.tenant).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { name: 'Subscriptions' })).toBeInTheDocument();
    const older = { ...DETAIL('b'), events: [{ ...DETAIL('b').events[0], id: 'old', event: 'subscription.cancelled' }] };
    const newer = { ...DETAIL('b'), events: [{ ...DETAIL('b').events[0], id: 'new', event: 'subscription.charged' }] };
    await act(async () => { waiting[2](newer); });
    expect(within(screen.getByRole('region', { name: 'Events for this restaurant' })).getByText('Payment taken')).toBeInTheDocument();
    await act(async () => { waiting[1](older); });
    const events = within(screen.getByRole('region', { name: 'Events for this restaurant' }));
    expect(events.getByText('Payment taken')).toBeInTheDocument();
    expect(events.queryByText('Subscription cancelled')).not.toBeInTheDocument();
  });

  it('measures a restaurant from when its own page was read, once it has been', async () => {
    const later = { ...DETAIL('b'), generated_at: iso(10 * MIN) };
    const { user } = open(fakeApi({ tenant: vi.fn(async () => later) }));
    await signIn(user);
    await openRow(user, 'Bravo');
    const hubSection = within(await screen.findByRole('region', { name: 'Hub' }));
    await screen.findByRole('heading', { name: 'Subscriptions' });
    expect(hubSection.getByText('Last heard').nextSibling).toHaveTextContent('12 min ago');
  });

  it('ignores a failure that arrives after a newer answer, and keeps what it had when a reload fails', async () => {
    const waiting = [];
    const api = fakeApi({ tenant: vi.fn(() => new Promise((resolve, reject) => { waiting.push({ resolve, reject }); })) });
    const { user } = open(api);
    await signIn(user);
    await openRow(user, 'Bravo');
    await act(async () => { waiting[0].resolve(DETAIL('b')); });
    await screen.findByRole('heading', { name: 'Subscriptions' });

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { waiting[2].resolve(DETAIL('b')); });
    await act(async () => { waiting[1].reject(new OpsError('down', 'The database did not answer. Try again in a moment.')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { waiting[3].reject(new OpsError('down', 'The database did not answer. Try again in a moment.')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('The database did not answer.');
    expect(screen.getByRole('heading', { name: 'Subscriptions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Events for this restaurant' })).toBeInTheDocument();
  });

  it('says when it could not be read, with a way to try again that works', async () => {
    const api = fakeApi({ tenant: vi.fn().mockRejectedValueOnce(new OpsError('down', 'The database did not answer. Try again in a moment.')).mockImplementation(async (t, id) => DETAIL(id)) });
    const { user } = open(api);
    await signIn(user);
    await openRow(user, 'Bravo');
    expect(await screen.findByRole('alert')).toHaveTextContent('The database did not answer.');
    expect(screen.getByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
    expect(screen.queryByText('Loading the subscriptions and events…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Subscriptions' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when the restaurant is gone', async () => {
    const api = fakeApi({ tenant: vi.fn().mockRejectedValue(new OpsError('missing', 'That restaurant is not there any more.')) });
    const { user } = open(api);
    await signIn(user);
    await openRow(user, 'Bravo');
    expect(await screen.findByRole('alert')).toHaveTextContent('That restaurant is not there any more.');
  });

  it('gives a way to reload what it shows', async () => {
    const { user, api } = await opened();
    await user.click(rowOf('Bravo').querySelector('button'));
    await screen.findByRole('heading', { name: 'Subscriptions' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.tenant).toHaveBeenCalledTimes(2));
    expect(api.fleet).toHaveBeenCalledTimes(1);
  });
});

// --- staying current --------------------------------------------------------------------------------------------------------------

describe('staying current', () => {
  it('reads again when asked, and shows the new figures', async () => {
    const second = { ...FLEET, tenants: [ALPHA], attention: [], events: [], summary: { ...FLEET.summary, tenants: 1, attention: { high: 0, medium: 0 } } };
    const api = fakeApi({ fleet: vi.fn().mockResolvedValueOnce(FLEET).mockResolvedValue(second) });
    const { user } = open(api);
    await signIn(user);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Bravo' })).toHaveLength(0));
    expect(tile('Restaurants').getByText('1')).toBeInTheDocument();
    expect(api.fleet).toHaveBeenLastCalledWith(TOKEN);
  });

  it('reads again by itself every minute, and stops when signed out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const api = fakeApi();
    const { user } = open(api, { pollMs: 60000 });
    await user.type(screen.getByLabelText('Console token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    await screen.findByRole('heading', { name: 'Restaurants' });
    expect(api.fleet).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(59999); });
    expect(api.fleet).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(api.fleet).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(api.fleet).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => { vi.advanceTimersByTime(5 * 60000); });
    expect(api.fleet).toHaveBeenCalledTimes(3);
  });

  it('keeps what it has and says so when a later read fails, and clears the warning when one works', async () => {
    const api = fakeApi({ fleet: vi.fn().mockResolvedValueOnce(FLEET).mockRejectedValueOnce(new OpsError('down', 'The database did not answer. Try again in a moment.')).mockResolvedValue(FLEET) });
    const { user } = open(api, { clock: () => NOW + 5 * MIN });
    await signIn(user);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not refresh');
    expect(screen.getByRole('status')).toHaveTextContent('The database did not answer.');
    expect(screen.getByRole('status')).toHaveTextContent('Showing what was read 5 min ago.');
    expect(rowOf('Bravo')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('signs out, and says why, if the token stops being accepted', async () => {
    const api = fakeApi({ fleet: vi.fn().mockResolvedValueOnce(FLEET).mockRejectedValue(new OpsError('denied', 'That token was not accepted.')) });
    const { user } = open(api);
    await signIn(user);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByLabelText('Console token')).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent('The console token was not accepted any more. Sign in again.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('turns Refresh off while a read is on its way, and on again once it has come back', async () => {
    const waiting = [];
    const api = fakeApi({ fleet: vi.fn().mockResolvedValueOnce(FLEET).mockImplementation(() => new Promise(resolve => { waiting.push(resolve); })) });
    const { user } = open(api);
    await signIn(user);
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    await act(async () => { waiting[0](FLEET); });
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('leaves nothing running once signed out: no timer to read again, and none to keep the clock', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const api = fakeApi();
    const { user } = open(api, { pollMs: 5000, tickMs: 1000 });
    await user.type(screen.getByLabelText('Console token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    await screen.findByRole('heading', { name: 'Restaurants' });
    expect(vi.getTimerCount()).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(vi.getTimerCount()).toBe(0);
    const read = api.fleet.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(api.fleet.mock.calls.length).toBe(read);
  });

  it('reads again after a minute when nothing else is said, and not a moment sooner', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const api = fakeApi();
    const { user } = open(api, { pollMs: undefined });
    await user.type(screen.getByLabelText('Console token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    await screen.findByRole('heading', { name: 'Restaurants' });
    await act(async () => { vi.advanceTimersByTime(59999); });
    expect(api.fleet).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(api.fleet).toHaveBeenCalledTimes(2);
  });

  it('does not start a second read while one is still on its way, and starts the next once it is over', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const waiting = [];
    const api = fakeApi({ fleet: vi.fn().mockResolvedValueOnce(FLEET).mockImplementation(() => new Promise(resolve => { waiting.push(resolve); })) });
    const { user } = open(api, { pollMs: 1000 });
    await user.type(screen.getByLabelText('Console token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    await screen.findByRole('heading', { name: 'Restaurants' });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(api.fleet).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(api.fleet).toHaveBeenCalledTimes(2);
    await act(async () => { waiting[0](FLEET); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(api.fleet).toHaveBeenCalledTimes(3);
  });

  it('ages what it shows as time passes: "updated just now" becomes minutes, without asking again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = NOW;
    const api = fakeApi();
    const { user } = open(api, { pollMs: 3600000, clock: () => now });
    await user.type(screen.getByLabelText('Console token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Open console' }));
    await screen.findByText('Updated just now');
    now = NOW + 5 * MIN;
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(screen.getByText('Updated 5 min ago')).toBeInTheDocument();
    expect(api.fleet).toHaveBeenCalledTimes(1);
  });
});

// --- it only reads ----------------------------------------------------------------------------------------------------------------

describe('it only reads', () => {
  it('offers nothing that changes anything: the only field is a search, the only buttons look, filter, reload or leave', async () => {
    const { user } = await opened();
    expect(screen.getAllByRole('textbox').map(e => e.getAttribute('aria-label') ?? e.id)).toHaveLength(1);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    const names = screen.getAllByRole('button').map(b => b.textContent.trim());
    expect(names.filter(n => /suspend|delete|remove|edit|save|change|cancel|provision|create|add|extend|reset|invite|send|charge|refund/i.test(n))).toEqual([]);
    await user.click(rowOf('Bravo').querySelector('button'));
    await screen.findByRole('heading', { name: 'Subscriptions' });
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getAllByRole('button').map(b => b.textContent.trim()).filter(n => /suspend|delete|remove|edit|save|change plan|provision|create|extend|reset|invite|send|charge|refund/i.test(n))).toEqual([]);
  });

  it('has no form in it once signed in', async () => {
    const { container } = await opened();
    expect(container.querySelector('form')).toBeNull();
  });
});
