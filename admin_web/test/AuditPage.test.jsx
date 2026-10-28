import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AuditPage } from '../src/screens/AuditPage.jsx';
import { A_ID, B_ID, apiError, auditEvent, auditPayload, fakeApi, fleetPayload, iso } from './helpers.jsx';

// The audit log: every event the console has recorded, filtered and paged, with the people and restaurants named, exportable, and with its own
// integrity checkable. What is shown is text from the API, shown as text; what could not be read is said; a result that no longer matches the
// question being asked is not left on the screen.

const tenants = fleetPayload().tenants;
const NOW = Date.parse('2026-10-26T10:00:30.000Z');

function setup(apiOver = {}, props = {}) {
  const api = fakeApi(apiOver);
  const download = vi.fn();
  const onLeave = vi.fn();
  const user = userEvent.setup();
  render(<AuditPage api={api} tenants={tenants} clock={() => NOW} timeZone="UTC" download={download} onLeave={onLeave} {...props} />);
  return { api, user, download, onLeave };
}
const table = () => screen.getByRole('table', { name: /audit events/i });
const rowsOf = () => within(table()).getAllByRole('row').slice(1);

describe('reading the log', () => {
  it('reads the newest events when it opens and shows each with when, where, what and who', async () => {
    const api = {
      audit: vi.fn(async () => auditPayload([
        auditEvent(3, { type: 'admin.signin', source: 'admin', actor_type: 'admin', actor_email: 'aman@example.test', restaurant_id: null, restaurant_name: null, request_id: '3f2b8c1e-aaaa-bbbb-cccc-1234567890ab' }),
        auditEvent(2, { type: 'subscription.halted' }),
        auditEvent(1, { type: 'hub.first_report', source: 'hub', actor_type: 'hub' })
      ]))
    };
    setup(api);
    await screen.findByRole('table', { name: /audit events/i });
    const [first, second, third] = rowsOf();
    expect(within(first).getByText('admin.signin')).toBeInTheDocument();
    expect(within(first).getByText('aman@example.test')).toBeInTheDocument();
    expect(within(first).getByText('3f2b8c1e')).toBeInTheDocument();
    expect(within(first).getByText(/26 Oct 2026, 09:57/)).toBeInTheDocument();
    expect(within(second).getByText('Spice Route')).toBeInTheDocument();
    expect(within(second).getByText('subscription.halted')).toBeInTheDocument();
    expect(within(third).getByText('hub.first_report')).toBeInTheDocument();
  });

  it('asks for the default page with no filters, and says when it was read', async () => {
    const { api } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    expect(api.audit).toHaveBeenCalledTimes(1);
    expect(api.audit.mock.calls[0][0]).toEqual({});
    expect(screen.getByText(/as of 10:00/i)).toBeInTheDocument();
    expect(screen.getByText(/3 events/i)).toBeInTheDocument();
  });

  it('shows an event with no restaurant as the console\'s own, and one with no person by what did it', async () => {
    setup({ audit: vi.fn(async () => auditPayload([auditEvent(5, { restaurant_id: null, restaurant_name: null, actor_email: null, actor_type: 'system', type: 'admin.user_added', source: 'system' })])) });
    await screen.findByRole('table', { name: /audit events/i });
    const [row] = rowsOf();
    expect(within(row).getByText(/the console/i)).toBeInTheDocument();
    expect(within(row).getByText('System')).toBeInTheDocument();
  });

  it('shows what an event carries on request, as plain text', async () => {
    const { user } = setup({ audit: vi.fn(async () => auditPayload([auditEvent(4, { payload: { note: '<img src=x onerror="window.__pwned=1">', n: 2 } })])) });
    await screen.findByRole('table', { name: /audit events/i });
    await user.click(screen.getByText(/details/i));
    expect(screen.getByText(/onerror/)).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  it('shows names and types as text whatever they contain', async () => {
    setup({ audit: vi.fn(async () => auditPayload([auditEvent(4, { restaurant_name: '<b>Bold</b> Bistro', type: 'x.<script>y' })])) });
    await screen.findByRole('table', { name: /audit events/i });
    expect(screen.getByText('<b>Bold</b> Bistro')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('says when there is nothing, and does not show an empty table', async () => {
    setup({ audit: vi.fn(async () => auditPayload([])) });
    expect(await screen.findByText(/no events match/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says what could not be read, shows no events, and can try again', async () => {
    const audit = vi.fn().mockRejectedValueOnce(apiError('down', 'The database did not answer. Try again in a moment.')).mockResolvedValue(auditPayload([auditEvent(1)]));
    const { user } = setup({ audit });
    expect(await screen.findByRole('alert')).toHaveTextContent(/database did not answer/i);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/as of/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('table', { name: /audit events/i })).toBeInTheDocument();
  });

  it('shows no events at all when a later search fails, not the ones from the search before', async () => {
    const audit = vi.fn().mockResolvedValueOnce(auditPayload([auditEvent(1, { type: 'earlier.result' })])).mockRejectedValueOnce(apiError('down', 'The database did not answer. Try again in a moment.'));
    const { user } = setup({ audit });
    await screen.findByText('earlier.result');
    await user.type(screen.getByLabelText(/event type/i), 'something');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/database did not answer/i);
    expect(screen.queryByText('earlier.result')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('leaves for sign-in when the API stops accepting the session', async () => {
    const { onLeave } = setup({ audit: vi.fn(async () => { throw apiError('denied', 'Sign in again.'); }) });
    await waitFor(() => expect(onLeave).toHaveBeenCalled());
  });
});

describe('filtering', () => {
  it('lists the restaurants it was given, and the sources an event can come from', async () => {
    setup();
    await screen.findByRole('table', { name: /audit events/i });
    const restaurants = within(screen.getByLabelText(/^restaurant$/i)).getAllByRole('option').map(o => o.textContent);
    expect(restaurants).toEqual(['All restaurants', 'Chai Corner', 'Spice Route']);
    const sources = within(screen.getByLabelText(/^source$/i)).getAllByRole('option').map(o => o.value);
    expect(sources).toEqual(['', 'hub', 'razorpay', 'admin', 'system', 'support']);
  });

  it('searches with what was chosen and typed, and nothing else', async () => {
    const { api, user } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    await user.selectOptions(screen.getByLabelText(/^restaurant$/i), A_ID);
    await user.type(screen.getByLabelText(/event type/i), 'subscription.halted');
    await user.selectOptions(screen.getByLabelText(/^source$/i), 'razorpay');
    await user.type(screen.getByLabelText(/^from$/i), '2026-10-01');
    await user.type(screen.getByLabelText(/^to$/i), '2026-10-26');
    api.audit.mockClear();
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(1));
    expect(api.audit.mock.calls[0][0]).toEqual({ restaurant: A_ID, type: 'subscription.halted', source: 'razorpay', from: '2026-10-01', to: '2026-10-27' });
  });

  it('makes the "to" date include the whole of that day', async () => {
    const { api, user } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    await user.type(screen.getByLabelText(/^to$/i), '2026-12-31');
    api.audit.mockClear();
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() => expect(api.audit).toHaveBeenCalled());
    expect(api.audit.mock.calls[0][0].to).toBe('2027-01-01');
  });

  it('trims what was typed, and leaves out what is empty', async () => {
    const { api, user } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    await user.type(screen.getByLabelText(/event type/i), '  admin.signin  ');
    api.audit.mockClear();
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() => expect(api.audit).toHaveBeenCalled());
    expect(api.audit.mock.calls[0][0]).toEqual({ type: 'admin.signin' });
  });

  it('searches on Enter in a field', async () => {
    const { api, user } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    api.audit.mockClear();
    await user.type(screen.getByLabelText(/event type/i), 'admin.signin{Enter}');
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(1));
  });

  it('clears the filters and reads the newest again', async () => {
    const { api, user } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    await user.type(screen.getByLabelText(/event type/i), 'x');
    await user.selectOptions(screen.getByLabelText(/^source$/i), 'hub');
    api.audit.mockClear();
    await user.click(screen.getByRole('button', { name: /clear/i }));
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(1));
    expect(api.audit.mock.calls[0][0]).toEqual({});
    expect(screen.getByLabelText(/event type/i)).toHaveValue('');
    expect(screen.getByLabelText(/^source$/i)).toHaveValue('');
  });

  it('shows what the API said when it does not understand a filter', async () => {
    const audit = vi.fn().mockResolvedValueOnce(auditPayload([auditEvent(1)])).mockRejectedValueOnce(apiError('bad', 'type is not an event type.'));
    const { user } = setup({ audit });
    await screen.findByRole('table', { name: /audit events/i });
    await user.type(screen.getByLabelText(/event type/i), 'a b');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('type is not an event type.');
  });

  it('shows the results of the latest search only, even if an earlier one comes back after it', async () => {
    let first;
    const audit = vi.fn()
      .mockImplementationOnce(() => new Promise(r => { first = r; }))
      .mockResolvedValueOnce(auditPayload([auditEvent(9, { type: 'newer.search' })]));
    const { user } = setup({ audit });
    await user.type(screen.getByLabelText(/event type/i), 'newer');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await screen.findByText('newer.search');
    first(auditPayload([auditEvent(1, { type: 'older.search' })]));
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText('older.search')).toBeNull();
    expect(screen.getByText('newer.search')).toBeInTheDocument();
  });
});

describe('older events', () => {
  const page = (from, n, next) => auditPayload(Array.from({ length: n }, (_, i) => auditEvent(from - i)), { next_before: next });

  it('offers more only when the API says there is more', async () => {
    setup({ audit: vi.fn(async () => page(100, 3, null)) });
    await screen.findByRole('table', { name: /audit events/i });
    expect(screen.queryByRole('button', { name: /load older/i })).toBeNull();
  });

  it('reads the next page from where the last one ended and adds it, keeping the filters', async () => {
    const audit = vi.fn(async filters => (filters.before ? page(97, 2, null) : page(100, 3, 98)));
    const { user } = setup({ audit });
    await screen.findByRole('table', { name: /audit events/i });
    await user.type(screen.getByLabelText(/event type/i), 'subscription.halted');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await screen.findByRole('button', { name: /load older/i });
    await user.click(screen.getByRole('button', { name: /load older/i }));
    await waitFor(() => expect(rowsOf()).toHaveLength(5));
    const last = audit.mock.calls.at(-1)[0];
    expect(last).toEqual({ type: 'subscription.halted', before: 98 });
    expect(screen.queryByRole('button', { name: /load older/i })).toBeNull();
    expect(screen.getByText(/5 events/i)).toBeInTheDocument();
  });

  it('never shows an event twice', async () => {
    const audit = vi.fn().mockResolvedValueOnce(page(100, 3, 98)).mockResolvedValueOnce(page(99, 3, null));
    const { user } = setup({ audit });
    await user.click(await screen.findByRole('button', { name: /load older/i }));
    await waitFor(() => expect(audit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowsOf()).toHaveLength(4));
  });

  it('asks once even if the button is pressed twice before the page has caught up', async () => {
    let finish;
    const audit = vi.fn().mockResolvedValueOnce(page(100, 3, 98)).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    setup({ audit });
    const button = await screen.findByRole('button', { name: /load older/i });
    act(() => { button.click(); button.click(); });
    expect(audit).toHaveBeenCalledTimes(2);
    await act(async () => { finish(page(97, 1, null)); });
  });

  it('keeps what is shown and says so when the next page cannot be read', async () => {
    const audit = vi.fn().mockResolvedValueOnce(page(100, 3, 98)).mockRejectedValueOnce(apiError('down', 'The database did not answer. Try again in a moment.'));
    const { user } = setup({ audit });
    await user.click(await screen.findByRole('button', { name: /load older/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/database did not answer/i);
    expect(rowsOf()).toHaveLength(3);
    expect(screen.getByRole('button', { name: /load older/i })).toBeEnabled();
  });

  it('does not ask twice while one request is out', async () => {
    let finish;
    const audit = vi.fn().mockResolvedValueOnce(page(100, 3, 98)).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const { user } = setup({ audit });
    const button = await screen.findByRole('button', { name: /load older/i });
    await user.dblClick(button);
    expect(audit).toHaveBeenCalledTimes(2);
    finish(page(97, 1, null));
    await waitFor(() => expect(rowsOf()).toHaveLength(4));
  });
});

describe('exporting', () => {
  it('asks for the file with the filters in force, and hands it to the browser to save', async () => {
    const { api, user, download } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    await user.selectOptions(screen.getByLabelText(/^source$/i), 'hub');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() => expect(api.audit).toHaveBeenCalledTimes(2));
    await screen.findByRole('table', { name: /audit events/i });
    await user.click(screen.getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(api.auditCsv).toHaveBeenCalledWith({ source: 'hub' });
    expect(download.mock.calls[0][1]).toBe('kullina-audit-2026-10-26.csv');
    expect(download.mock.calls[0][0]).toBeInstanceOf(Blob);
  });

  it('makes one file even if the button is pressed twice before the page has caught up', async () => {
    let finish;
    const { api, download } = setup({ auditCsv: vi.fn(() => new Promise(r => { finish = r; })) });
    const button = await screen.findByRole('button', { name: /export csv/i });
    await screen.findByRole('table', { name: /audit events/i });
    act(() => { button.click(); button.click(); });
    expect(api.auditCsv).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ blob: new Blob(['x']), filename: 'f.csv' }); });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('says so, and downloads nothing, when the file cannot be made', async () => {
    const { user, download } = setup({ auditCsv: vi.fn(async () => { throw apiError('down', 'The database did not answer. Try again in a moment.'); }) });
    await screen.findByRole('table', { name: /audit events/i });
    await user.click(screen.getByRole('button', { name: /export csv/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/database did not answer/i);
    expect(download).not.toHaveBeenCalled();
  });

  it('only exports once at a time', async () => {
    let finish;
    const { api, user, download } = setup({ auditCsv: vi.fn(() => new Promise(r => { finish = r; })) });
    await screen.findByRole('table', { name: /audit events/i });
    await user.dblClick(screen.getByRole('button', { name: /export csv/i }));
    expect(api.auditCsv).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /exporting/i })).toBeDisabled();
    finish({ blob: new Blob(['x']), filename: 'f.csv' });
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  });
});

describe('checking the history', () => {
  it('checks the console\'s own history when no restaurant is chosen, and says it is intact, with how many events and when', async () => {
    const { api, user } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    await user.click(screen.getByRole('button', { name: /check history integrity/i }));
    await waitFor(() => expect(api.verify).toHaveBeenCalledWith(null));
    expect(await screen.findByText(/history is intact/i)).toBeInTheDocument();
    expect(screen.getByText(/12 events checked/i)).toBeInTheDocument();
    expect(screen.getByText(/the console's own/i)).toBeInTheDocument();
  });

  it('checks the restaurant that is chosen', async () => {
    const { api, user } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    await user.selectOptions(screen.getByLabelText(/^restaurant$/i), B_ID);
    await user.click(screen.getByRole('button', { name: /check history integrity/i }));
    await waitFor(() => expect(api.verify).toHaveBeenCalledWith(B_ID));
    expect(await screen.findByText(/chai corner/i, { selector: '[data-verify] *' })).toBeInTheDocument();
  });

  it('says where a broken history breaks and why, and does not call it intact', async () => {
    const { user } = setup({ verify: vi.fn(async () => ({ success: true, generated_at: iso(0), restaurant_id: null, ok: false, checked: 16, broken_at: 17, reason: 'the hash of event 17 does not match its contents (it was edited)' })) });
    await screen.findByRole('table', { name: /audit events/i });
    await user.click(screen.getByRole('button', { name: /check history integrity/i }));
    const result = await screen.findByText(/history is broken/i);
    expect(result.closest('[data-verify]')).toHaveTextContent(/event 17/);
    expect(result.closest('[data-verify]')).toHaveTextContent(/it was edited/);
    expect(screen.queryByText(/history is intact/i)).toBeNull();
  });

  it('shows no verdict when the check itself fails: not "intact", not "broken"', async () => {
    const { user } = setup({ verify: vi.fn(async () => { throw apiError('down', 'The database did not answer. Try again in a moment.'); }) });
    await screen.findByRole('table', { name: /audit events/i });
    await user.click(screen.getByRole('button', { name: /check history integrity/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/database did not answer/i);
    expect(screen.queryByText(/history is (intact|broken)/i)).toBeNull();
  });

  it('forgets a verdict as soon as the question changes, so it is never read as the answer to another', async () => {
    const { user } = setup();
    await screen.findByRole('table', { name: /audit events/i });
    await user.click(screen.getByRole('button', { name: /check history integrity/i }));
    await screen.findByText(/history is intact/i);
    await user.selectOptions(screen.getByLabelText(/^restaurant$/i), A_ID);
    expect(screen.queryByText(/history is intact/i)).toBeNull();
  });

  it('does not show a verdict that arrives after the question has changed', async () => {
    let finish;
    const { user } = setup({ verify: vi.fn(() => new Promise(r => { finish = r; })) });
    await screen.findByRole('table', { name: /audit events/i });
    await user.click(screen.getByRole('button', { name: /check history integrity/i }));
    await user.selectOptions(screen.getByLabelText(/^restaurant$/i), A_ID);
    finish({ success: true, generated_at: iso(0), restaurant_id: null, ok: true, checked: 3, broken_at: null, reason: null });
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText(/history is intact/i)).toBeNull();
  });
});
