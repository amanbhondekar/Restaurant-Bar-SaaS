import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AdminApp } from '../src/AdminApp.jsx';
import { A_ID, B_ID, READY, apiError, auditEvent, auditPayload, fakeApi, fakeAuth, fleetPayload, iso, tenantPayload } from './helpers.jsx';

// The console once someone is in: the fleet, one restaurant, the way between them and the audit log, and what it does when a read fails. Every
// figure says when it was read; a failed read is said, and what is still on the screen is marked as older rather than passed off as current.

const asOf = text => new RegExp(`as of ${text}`, 'i');

async function open(api = fakeApi(), props = {}) {
  const auth = fakeAuth(READY);
  const user = userEvent.setup(props.advance ? { advanceTimers: props.advance } : {});
  const { advance: _advance, ...rest } = props;
  render(<AdminApp auth={auth} api={api} pollMs={60000} tickMs={15000} timeZone="UTC" clock={() => Date.parse('2026-10-26T10:00:30.000Z')} {...rest} />);
  await screen.findByRole('navigation');
  return { user, auth, api };
}

afterEach(() => { vi.useRealTimers(); });

describe('the shell', () => {
  it('names the console and the person in it, and offers the two places to go', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: /kullina admin/i })).toBeInTheDocument();
    expect(screen.getByText('aman@example.test')).toBeInTheDocument();
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByRole('button', { name: /fleet/i })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: /audit log/i })).not.toHaveAttribute('aria-current');
  });

  it('moves between the places and says which one it is on', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: /audit log/i }));
    expect(await screen.findByRole('heading', { name: /^audit log$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /audit log/i })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: /^fleet$/i }));
    expect((await screen.findAllByText('Spice Route')).length).toBeGreaterThan(0);
  });

  it('leaves a restaurant behind when the person goes elsewhere, so coming back shows the fleet', async () => {
    const { user } = await open();
    const [name] = await screen.findAllByRole('button', { name: 'Spice Route' });
    await user.click(name);
    await screen.findByRole('heading', { name: 'Spice Route' });
    await user.click(screen.getByRole('button', { name: /audit log/i }));
    await user.click(screen.getByRole('button', { name: /^fleet$/i }));
    expect(await screen.findByLabelText(/search restaurants/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Spice Route' })).toBeNull();
  });

  it('gives the audit log the restaurants the fleet found', async () => {
    const { user } = await open();
    await screen.findAllByText('Spice Route');
    await user.click(screen.getByRole('button', { name: /audit log/i }));
    expect(await screen.findByRole('option', { name: 'Chai Corner' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Spice Route' })).toBeInTheDocument();
  });

  it('can change nothing: there is no control on the page that writes', async () => {
    await open();
    const labels = screen.getAllByRole('button').map(b => b.textContent.trim().toLowerCase());
    for (const label of labels) expect(label).not.toMatch(/delete|remove|suspend|extend|cancel|save|edit|void|refund|impersonate|log in as/);
  });
});

describe('the fleet', () => {
  it('shows every restaurant, the ones that need a look, and when it was read', async () => {
    await open();
    expect(await screen.findAllByText('Spice Route')).not.toHaveLength(0);
    expect(screen.getByText('Chai Corner')).toBeInTheDocument();
    expect(screen.getByText(/payment is overdue/i)).toBeInTheDocument();
    expect(screen.getByText(asOf('10:00'))).toBeInTheDocument();
  });

  it('shows the restaurants\' names as text, whatever they contain', async () => {
    const api = fakeApi({
      fleet: vi.fn(async () => {
        const f = fleetPayload();
        f.tenants[1].name = '<img src=x onerror="window.__pwned=1">Chai';
        return f;
      })
    });
    await open(api);
    await screen.findByText(/Chai/);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  it('reads again when asked, and says it is doing so', async () => {
    const { user, api } = await open();
    await screen.findAllByText('Spice Route');
    api.fleet.mockClear();
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(api.fleet).toHaveBeenCalledTimes(1));
  });

  it('reads again every minute on its own, and one read at a time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release;
    const api = fakeApi();
    await open(api, { advance: vi.advanceTimersByTime });
    await screen.findAllByText('Spice Route');
    api.fleet.mockClear();
    api.fleet.mockImplementation(() => new Promise(r => { release = () => r(fleetPayload()); }));
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(api.fleet).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(api.fleet).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
  });

  it('keeps ageing the reading between reads, so "as of" is never mistaken for "now"', async () => {
    let now = Date.parse('2026-10-26T10:00:30.000Z');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open(fakeApi(), { clock: () => now, advance: vi.advanceTimersByTime, pollMs: 10 * 60000 });
    await screen.findAllByText('Spice Route');
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
    now = Date.parse('2026-10-26T10:07:00.000Z');
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(screen.getByText(/7 min ago/i)).toBeInTheDocument();
  });

  it('when a read fails it says so and marks what is still shown as older, with the time it was read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    await open(api, { advance: vi.advanceTimersByTime });
    await screen.findAllByText('Spice Route');
    api.fleet.mockRejectedValue(apiError('down', 'The database did not answer. Try again in a moment.'));
    await act(async () => { vi.advanceTimersByTime(60000); });
    const notice = await screen.findByText(/could not refresh/i);
    expect(notice.closest('[role]')).toHaveTextContent(/database did not answer/i);
    expect(notice.closest('[role]')).toHaveTextContent(asOf('10:00'));
    expect(screen.getAllByText('Spice Route').length).toBeGreaterThan(0);
    api.fleet.mockResolvedValue(fleetPayload({ generated_at: iso(5 * 60000) }));
    await act(async () => { vi.advanceTimersByTime(60000); });
    await waitFor(() => expect(screen.queryByText(/could not refresh/i)).toBeNull());
    expect(screen.getByText(asOf('10:05'))).toBeInTheDocument();
  });

  it('says what could not be read when the very first read fails, and shows no restaurants at all', async () => {
    const api = fakeApi({ fleet: vi.fn(async () => { throw apiError('down', 'The database did not answer. Try again in a moment.'); }) });
    const { user } = await open(api);
    expect(await screen.findByRole('alert')).toHaveTextContent(/database did not answer/i);
    expect(screen.queryByText('Spice Route')).toBeNull();
    expect(screen.queryByText(/as of/i)).toBeNull();
    api.fleet.mockResolvedValue(fleetPayload());
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findAllByText('Spice Route')).not.toHaveLength(0);
  });

  it('says when the list is cut short, so a partial list is not taken for the whole', async () => {
    const api = fakeApi({ fleet: vi.fn(async () => fleetPayload({ truncated: true })) });
    await open(api);
    expect(await screen.findByText(/only the first/i)).toBeInTheDocument();
  });

  it('goes back to sign-in if the API stops accepting the session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    const { auth } = await open(api, { advance: vi.advanceTimersByTime });
    await screen.findAllByText('Spice Route');
    api.fleet.mockRejectedValue(apiError('denied', 'Sign in again.'));
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/your session ended/i);
    expect(screen.queryByText('Spice Route')).toBeNull();
  });

  it('is turned away politely when the API says there have been too many wrong tries', async () => {
    const api = fakeApi({ fleet: vi.fn(async () => { throw apiError('locked', 'Too many wrong tries from here. Wait a few minutes.'); }) });
    await open(api);
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many/i);
  });
});

describe('one restaurant', () => {
  it('opens from the fleet, reads it, and goes back', async () => {
    const { user, api } = await open();
    const [name] = await screen.findAllByRole('button', { name: 'Spice Route' });
    await user.click(name);
    await waitFor(() => expect(api.tenant).toHaveBeenCalledWith(A_ID));
    expect(await screen.findByRole('heading', { name: 'Spice Route' })).toBeInTheDocument();
    expect(await screen.findByText(/subscriptions/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /all restaurants/i }));
    expect(await screen.findByText('Chai Corner')).toBeInTheDocument();
  });

  it('says it could not read one and lets them try again, without losing the fleet', async () => {
    const api = fakeApi();
    api.tenant.mockRejectedValueOnce(apiError('down', 'The database did not answer. Try again in a moment.'));
    const { user } = await open(api);
    const [name] = await screen.findAllByRole('button', { name: 'Spice Route' });
    await user.click(name);
    expect(await screen.findByRole('alert')).toHaveTextContent(/database did not answer/i);
    api.tenant.mockResolvedValue(tenantPayload());
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/subscriptions/i)).toBeInTheDocument();
  });

  it('tells them a restaurant that is not there any more is not there, rather than showing an empty page', async () => {
    const api = fakeApi();
    api.tenant.mockRejectedValue(apiError('missing', 'That restaurant is not there any more.'));
    const { user } = await open(api);
    const [name] = await screen.findAllByRole('button', { name: 'Spice Route' });
    await user.click(name);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not there any more/i);
  });

  it('goes back to sign-in if the session is no longer accepted while reading one', async () => {
    const api = fakeApi();
    api.tenant.mockRejectedValue(apiError('denied', 'Sign in again.'));
    const { user } = await open(api);
    const [name] = await screen.findAllByRole('button', { name: 'Spice Route' });
    await user.click(name);
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
  });
});
