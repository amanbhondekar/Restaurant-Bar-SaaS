import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AlertsPage } from '../src/screens/AlertsPage.jsx';
import { A_ID, MIN, alertRow, alertsPayload, apiError, defaultAlerts, fakeApi, iso } from './helpers.jsx';

// The alerts inbox: what is waiting, what somebody has taken on, and what is closed; each with the restaurant named and the problem said in words; and
// the two things a person can do about one, acknowledge ("I know") and resolve ("it is dealt with"), each with a reason in their own words.
//
// What matters: nothing is recorded without a reason of at least ten characters; a double tap sends one request; a refusal is said and the words the
// person typed are kept; a read that fails never leaves the old list looking current; and nothing the API sends is ever treated as anything but text.

const NOW = Date.parse('2026-10-26T10:00:30.000Z');
const clock = () => NOW;
const GOOD = 'the owner is ringing them back';

async function show(api = fakeApi(), props = {}) {
  const onLeave = vi.fn();
  // `settle: false` is for a test whose first read is meant to stay pending.
  const { advance, settle = true, ...rest } = props;
  const user = userEvent.setup(advance ? { advanceTimers: advance } : {});
  const view = render(<AlertsPage api={api} clock={clock} timeZone="UTC" pollMs={60000} nonce={0} onLeave={onLeave} {...rest} />);
  await screen.findByRole('heading', { name: /^alerts$/i });
  // The heading is there before the list is: wait for the first read to finish (a list, or a reason why not), so a test never races it on a slow machine.
  if (settle) await waitFor(() => expect(screen.queryByText(/reading the alerts/i)).toBeNull());
  return { user, api, onLeave, view };
}
const rows = () => screen.getAllByRole('article');
const rowOf = name => rows().find(r => within(r).queryByText(name));
const type = async (user, text) => user.type(screen.getByRole('textbox'), text);

afterEach(() => { vi.useRealTimers(); });

describe('the list', () => {
  it('asks for what is waiting and taken on, says when it was read, and counts', async () => {
    const { api } = await show();
    await screen.findAllByRole('article');
    expect(api.alerts).toHaveBeenCalledWith({ state: 'active' });
    expect(screen.getByText(/as of 10:00/i)).toBeInTheDocument();
    expect(screen.getByText(/2 waiting/)).toBeInTheDocument();
    expect(screen.getByText(/1 taken on/)).toBeInTheDocument();
  });

  it('shows each alert with how bad it is, which restaurant, and what is wrong, in words', async () => {
    await show();
    const [first, second] = await screen.findAllByRole('article');
    expect(within(first).getByText('P1')).toBeInTheDocument();
    expect(within(first).getByText('Spice Route')).toBeInTheDocument();
    expect(within(first).getByText(/2 orders were shelved and have not reached the cloud/)).toBeInTheDocument();
    expect(within(second).getByText('P2')).toBeInTheDocument();
    expect(within(second).getByText('Chai Corner')).toBeInTheDocument();
    expect(within(second).getByText(/60 bills are waiting to reach the cloud/)).toBeInTheDocument();
  });

  it('keeps the order the API gave: it is the API that ranks them', async () => {
    const api = fakeApi({ alerts: vi.fn(async () => alertsPayload([alertRow(9, { restaurant_name: 'Zed' }), alertRow(1, { restaurant_name: 'Alpha' })])) });
    await show(api);
    const names = (await screen.findAllByRole('article')).map(a => within(a).getByText(/^(Zed|Alpha)$/).textContent);
    expect(names).toEqual(['Zed', 'Alpha']);
  });

  it('says when each was opened, to the minute, and how long ago', async () => {
    await show();
    const [first] = await screen.findAllByRole('article');
    expect(within(first).getByText(/opened 26 Oct 2026, 09:30/i)).toBeInTheDocument();
    expect(within(first).getByText(/30 min ago/)).toBeInTheDocument();
  });

  it('says who has taken one on and what they said', async () => {
    await show();
    const taken = rowOf('Payment is overdue.');
    expect(within(taken).getByText(/taken on/i)).toBeInTheDocument();
    expect(within(taken).getByText(/darshil@example.test/)).toBeInTheDocument();
    expect(within(taken).getByText(/ringing the owner now/)).toBeInTheDocument();
  });

  it('says how far the paging has got: not yet, paged, or on which reminder; and that a P3 is never sent', async () => {
    const api = fakeApi({ alerts: vi.fn(async () => alertsPayload([
      alertRow(1, { last_notified_at: null, text: 'unpaged' }),
      alertRow(2, { last_notified_at: iso(-12 * MIN), escalation_level: 0, text: 'paged once' }),
      alertRow(3, { last_notified_at: iso(-2 * MIN), escalation_level: 2, text: 'second reminder' }),
      alertRow(4, { rule_key: 'service_hours_missing', severity: 'P3', last_notified_at: null, text: 'hours' })
    ])) });
    await show(api);
    expect(within(rowOf('unpaged')).getByText(/not paged yet/i)).toBeInTheDocument();
    expect(within(rowOf('paged once')).getByText(/paged 12 min ago/i)).toBeInTheDocument();
    expect(within(rowOf('second reminder')).getByText(/reminder 2 of 3/i)).toBeInTheDocument();
    expect(within(rowOf('hours')).getByText(/never sent/i)).toBeInTheDocument();
    expect(within(rowOf('hours')).queryByText(/not paged yet/i)).toBeNull();
  });

  it('flags the ones nobody answered after every reminder, and counts them', async () => {
    const api = fakeApi({ alerts: vi.fn(async () => alertsPayload([alertRow(1, { unattended_at: iso(-3 * MIN), escalation_level: 3 }), alertRow(2)])) });
    await show(api);
    expect(within(rowOf(/2 orders were shelved/)).queryAllByText(/nobody has answered/i).length).toBe(1);
    expect(screen.getAllByText(/nobody has answered/i).length).toBe(2);
    expect(screen.getByText(/1 nobody has answered/i)).toBeInTheDocument();
  });

  it('with nothing open says so, in a sentence that is not the same as a failed read', async () => {
    await show(fakeApi({ alerts: vi.fn(async () => alertsPayload([])) }));
    expect(await screen.findByText(/nothing needs a look/i)).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('says when the list was cut, rather than passing it off as everything', async () => {
    await show(fakeApi({ alerts: vi.fn(async () => alertsPayload(defaultAlerts(), { truncated: true })) }));
    expect(await screen.findByText(/more alerts than this page shows/i)).toBeInTheDocument();
  });

  it('draws what the API sends as text, never as markup', async () => {
    const api = fakeApi({ alerts: vi.fn(async () => alertsPayload([alertRow(1, { restaurant_name: '<img src=x onerror=alert(1)>', text: '<b>bold</b> shelved', ack_reason: '<script>x</script>', state: 'acked', acked_by_email: 'a@b.c', acked_at: iso(-MIN) })])) });
    const { view } = await show(api);
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(screen.getByText(/<b>bold<\/b> shelved/)).toBeInTheDocument();
    expect(screen.getByText(/<script>x<\/script>/)).toBeInTheDocument();
    expect(view.container.querySelector('img, b, script')).toBeNull();
  });
});

describe('the filter', () => {
  it('offers waiting and taken on together, waiting, taken on, and closed', async () => {
    await show();
    const select = screen.getByRole('combobox', { name: /show/i });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Waiting and taken on', 'Waiting', 'Taken on', 'Closed']);
    expect(select).toHaveValue('active');
  });

  it('asks for the one chosen, and shows how the closed ones were closed', async () => {
    const closed = [
      alertRow(5, { state: 'resolved', resolved_at: iso(-5 * MIN), resolved_by: 'system', resolve_reason: 'condition_cleared', text: 'cleared alone' }),
      alertRow(6, { state: 'resolved', resolved_at: iso(-2 * 60 * MIN), resolved_by: 'person', resolve_reason: 'owner restarted the hub', text: 'closed by hand' })
    ];
    const api = fakeApi({ alerts: vi.fn(async f => alertsPayload(f.state === 'resolved' ? closed : defaultAlerts())) });
    const { user } = await show(api);
    await screen.findAllByRole('article');
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'resolved');
    expect(api.alerts).toHaveBeenLastCalledWith({ state: 'resolved' });
    await screen.findByText('cleared alone');
    expect(within(rowOf('cleared alone')).getByText(/closed by the system/i)).toBeInTheDocument();
    expect(within(rowOf('cleared alone')).getByText(/the problem cleared on its own/i)).toBeInTheDocument();
    expect(within(rowOf('closed by hand')).getByText(/closed by a person/i)).toBeInTheDocument();
    expect(within(rowOf('closed by hand')).getByText(/owner restarted the hub/)).toBeInTheDocument();
    for (const r of rows()) expect(within(r).queryByRole('button')).toBeNull();
  });

  it('a search that was superseded by a newer one is dropped when it arrives', async () => {
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    const api = fakeApi({ alerts: vi.fn(async f => (f.state === 'open' ? slow : alertsPayload(f.state === 'acked' ? [alertRow(3, { state: 'acked', text: 'the taken-on one', acked_by_email: 'a@b.c', acked_at: iso(-MIN) })] : defaultAlerts()))) });
    const { user } = await show(api);
    await screen.findAllByRole('article');
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'open');
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'acked');
    await screen.findByText('the taken-on one');
    await act(async () => { release(alertsPayload([alertRow(8, { text: 'late answer to the old question' })])); });
    expect(screen.queryByText('late answer to the old question')).toBeNull();
    expect(screen.getByText('the taken-on one')).toBeInTheDocument();
  });
});

describe('reading and failing to read', () => {
  it('a first read that fails shows nothing and says why, with a way to try again', async () => {
    const alerts = vi.fn().mockRejectedValueOnce(apiError('down', 'The admin service could not read that. Try again in a moment.')).mockResolvedValue(alertsPayload(defaultAlerts()));
    const { user } = await show(fakeApi({ alerts }));
    expect(await screen.findByText(/could not read that/i)).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect((await screen.findAllByRole('article')).length).toBe(3);
  });

  it('a read that fails after a good one keeps the list but marks it as older, with the time it was read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const alerts = vi.fn().mockResolvedValueOnce(alertsPayload(defaultAlerts())).mockRejectedValue(apiError('offline', 'Could not reach the admin service. Check your connection and try again.'));
    await show(fakeApi({ alerts }), { pollMs: 1000, advance: vi.advanceTimersByTime });
    await screen.findAllByRole('article');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(screen.getByText(/could not reach the admin service/i)).toBeInTheDocument();
    expect(screen.getAllByText(/as of 10:00/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('article').length).toBe(3);
  });

  it('reads again on its own, one read at a time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release;
    const alerts = vi.fn().mockResolvedValueOnce(alertsPayload(defaultAlerts())).mockImplementationOnce(() => new Promise(r => { release = r; })).mockResolvedValue(alertsPayload(defaultAlerts()));
    await show(fakeApi({ alerts }), { pollMs: 1000, advance: vi.advanceTimersByTime });
    await screen.findAllByRole('article');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(alerts).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(alerts).toHaveBeenCalledTimes(2);
    await act(async () => { release(alertsPayload(defaultAlerts())); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(alerts).toHaveBeenCalledTimes(3);
  });

  it('reads again when it is told to (the console\'s Refresh)', async () => {
    const api = fakeApi();
    const { view, onLeave } = await show(api);
    await screen.findAllByRole('article');
    const before = api.alerts.mock.calls.length;
    view.rerender(<AlertsPage api={api} clock={clock} timeZone="UTC" pollMs={60000} nonce={1} onLeave={onLeave} />);
    await waitFor(() => expect(api.alerts.mock.calls.length).toBe(before + 1));
    await act(async () => { await Promise.resolve(); });
    expect(api.alerts.mock.calls.length).toBe(before + 1);
  });

  it('a session that ended is the console\'s to handle, and nothing is shown', async () => {
    const { onLeave } = await show(fakeApi({ alerts: vi.fn(async () => { throw apiError('denied', 'Your session is not accepted any more. Sign in again.'); }) }), { settle: false });
    await waitFor(() => expect(onLeave).toHaveBeenCalledWith('Your session ended. Sign in again.'));
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('stops reading when it is closed: a late answer changes nothing and stops no timer twice', async () => {
    let release;
    const alerts = vi.fn(() => new Promise(r => { release = r; }));
    const api = fakeApi({ alerts });
    const { view } = await show(api, { settle: false });
    view.unmount();
    await act(async () => { release(alertsPayload(defaultAlerts())); });
    expect(screen.queryByRole('article')).toBeNull();
  });
});

describe('what can be done', () => {
  it('offers Acknowledge and Resolve on what is waiting, and only Resolve on what somebody has taken on', async () => {
    await show();
    const waiting = rowOf(/2 orders were shelved/);
    expect(within(waiting).getByRole('button', { name: /^acknowledge/i })).toBeInTheDocument();
    expect(within(waiting).getByRole('button', { name: /^resolve/i })).toBeInTheDocument();
    const taken = rowOf('Payment is overdue.');
    expect(within(taken).queryByRole('button', { name: /^acknowledge/i })).toBeNull();
    expect(within(taken).getByRole('button', { name: /^resolve/i })).toBeInTheDocument();
  });

  it('says in the form what acknowledging does and does not do', async () => {
    const { user } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    const form = screen.getByRole('form', { name: /acknowledge/i });
    expect(within(form).getByText(/stops the paging/i)).toBeInTheDocument();
    expect(within(form).getByText(/does not fix anything/i)).toBeInTheDocument();
    expect(within(form).getByText(/closes by itself when the problem clears/i)).toBeInTheDocument();
    expect(within(form).getByText(/at least 10 characters/i)).toBeInTheDocument();
  });

  it('says in the form what resolving does: it closes now, and a new one opens if the problem is still there', async () => {
    const { user } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^resolve/i }));
    const form = screen.getByRole('form', { name: /resolve/i });
    expect(within(form).getByText(/closes this alert now/i)).toBeInTheDocument();
    expect(within(form).getByText(/new alert opens/i)).toBeInTheDocument();
    expect(within(form).getByText(/acknowledge to say you know/i)).toBeInTheDocument();
  });

  it('is one form at a time, on one alert, and the row\'s own buttons give way to it', async () => {
    const { user } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    expect(screen.getAllByRole('form').length).toBe(1);
    expect(within(rowOf(/2 orders were shelved/)).queryByRole('button', { name: /^acknowledge/i })).toBe(null);
    await user.click(within(rowOf(/60 bills/)).getByRole('button', { name: /^resolve/i }));
    expect(screen.getAllByRole('form').length).toBe(1);
    expect(screen.getByRole('form', { name: /resolve/i })).toBeInTheDocument();
    expect(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i })).toBeInTheDocument();
  });

  it('Cancel closes it and sends nothing, and what was typed is gone', async () => {
    const { user, api } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('form')).toBeNull();
    expect(api.acknowledgeAlert).not.toHaveBeenCalled();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  describe('the reason', () => {
    it('nothing is sent until it is ten characters of a person\'s words, after trimming', async () => {
      const { user } = await show();
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      const send = within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i });
      expect(send).toBeDisabled();
      await type(user, '123456789');
      expect(send).toBeDisabled();
      expect(screen.getByText(/9 of at least 10/)).toBeInTheDocument();
      await user.clear(screen.getByRole('textbox'));
      await type(user, '   123456789   ');
      expect(send).toBeDisabled();
      await user.clear(screen.getByRole('textbox'));
      await type(user, '1234567890');
      expect(send).toBeEnabled();
    });

    it('is at most five hundred: past that it says so and will not send', async () => {
      const { user } = await show();
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      const box = screen.getByRole('textbox');
      await user.click(box);
      await user.paste('a'.repeat(500));
      expect(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i })).toBeEnabled();
      await user.paste('a');
      expect(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i })).toBeDisabled();
      expect(screen.getByText(/501\/500/)).toBeInTheDocument();
    });

    it('counts characters, not bytes or code units: ten letters of any script are ten', async () => {
      const { user } = await show();
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await user.click(screen.getByRole('textbox'));
      await user.paste('अआइईउऊऋएऐओ');
      expect(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i })).toBeEnabled();
    });

    it('the box takes the focus when the form opens, so the words can be typed straight away', async () => {
      const { user } = await show();
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      expect(screen.getByRole('textbox')).toHaveFocus();
      await user.keyboard(GOOD);
      expect(screen.getByRole('textbox')).toHaveValue(GOOD);
    });

    it('the box is labelled, so it can be found and read aloud', async () => {
      const { user } = await show();
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      expect(screen.getByRole('textbox', { name: /why are you acknowledging/i })).toBeInTheDocument();
    });
  });

  describe('acknowledging', () => {
    it('sends the reason, trimmed, for that alert, says what was recorded, and reads the list again', async () => {
      const { user, api } = await show();
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await type(user, `  ${GOOD}  `);
      const reads = api.alerts.mock.calls.length;
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
      await waitFor(() => expect(api.acknowledgeAlert).toHaveBeenCalledWith(1, GOOD));
      expect(api.acknowledgeAlert).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/acknowledged\. recorded as event 41/i)).toBeInTheDocument();
      expect(screen.queryByRole('form')).toBeNull();
      await waitFor(() => expect(api.alerts.mock.calls.length).toBe(reads + 1));
    });

    it('a double tap is one request, and nothing can be sent while one is on its way', async () => {
      let release;
      const api = fakeApi({ acknowledgeAlert: vi.fn(() => new Promise(r => { release = r; })) });
      const { user } = await show(api);
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await type(user, GOOD);
      const send = within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i });
      await user.dblClick(send);
      await user.click(send);
      expect(api.acknowledgeAlert).toHaveBeenCalledTimes(1);
      expect(send).toBeDisabled();
      expect(screen.getByRole('textbox')).toBeDisabled();
      await act(async () => { release({ success: true, generated_at: iso(0), alert: { id: 1, state: 'acked' }, event_id: 41 }); });
      expect(await screen.findByText(/recorded as event 41/i)).toBeInTheDocument();
    });

    it('a refusal for the reason is said in the API\'s own words, and what was typed is kept', async () => {
      const api = fakeApi({ acknowledgeAlert: vi.fn(async () => { throw apiError('bad', 'Give a reason of at least 10 characters, in your own words.'); }) });
      const { user } = await show(api);
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await type(user, GOOD);
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
      expect(await screen.findByText(/give a reason of at least 10 characters, in your own words/i)).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveValue(GOOD);
      expect(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i })).toBeEnabled();
    });

    it('a connection that fails is said, the words are kept, and it can be sent again', async () => {
      const send = vi.fn().mockRejectedValueOnce(apiError('offline', 'Could not reach the admin service. Check your connection and try again.')).mockResolvedValue({ success: true, generated_at: iso(0), alert: { id: 1, state: 'acked' }, event_id: 43 });
      const { user } = await show(fakeApi({ acknowledgeAlert: send }));
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await type(user, GOOD);
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
      expect(await screen.findByText(/could not reach the admin service/i)).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveValue(GOOD);
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
      expect(await screen.findByText(/recorded as event 43/i)).toBeInTheDocument();
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('an alert that was resolved meanwhile is said so, in the page\'s own words, and the list is read again', async () => {
      const api = fakeApi({ acknowledgeAlert: vi.fn(async () => { throw apiError('conflict', 'That alert is already resolved.'); }) });
      const { user } = await show(api);
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await type(user, GOOD);
      const reads = api.alerts.mock.calls.length;
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
      expect(await screen.findByText(/that alert is already resolved/i)).toBeInTheDocument();
      expect(screen.queryByRole('form')).toBeNull();
      await waitFor(() => expect(api.alerts.mock.calls.length).toBe(reads + 1));
    });

    it('an alert that is not there any more is said so too', async () => {
      const api = fakeApi({ acknowledgeAlert: vi.fn(async () => { throw apiError('missing', 'That is not there any more.'); }) });
      const { user } = await show(api);
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await type(user, GOOD);
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
      expect(await screen.findByText(/not there any more/i)).toBeInTheDocument();
    });

    it('a session that ended while writing is the console\'s to handle', async () => {
      const api = fakeApi({ acknowledgeAlert: vi.fn(async () => { throw apiError('denied', 'Your session is not accepted any more. Sign in again.'); }) });
      const { user, onLeave } = await show(api);
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await type(user, GOOD);
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
      await waitFor(() => expect(onLeave).toHaveBeenCalledWith('Your session ended. Sign in again.'));
    });

    it('a second factor that is needed again is said, not hidden behind a generic failure', async () => {
      const api = fakeApi({ acknowledgeAlert: vi.fn(async () => { throw apiError('mfa', 'Sign in with your second factor to continue.'); }) });
      const { user } = await show(api);
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
      await type(user, GOOD);
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
      expect(await screen.findByText(/second factor/i)).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveValue(GOOD);
    });
  });

  describe('resolving', () => {
    it('sends the reason for that alert, from open or from taken on, and says what was recorded', async () => {
      const { user, api } = await show();
      await user.click(within(rowOf('Payment is overdue.')).getByRole('button', { name: /^resolve/i }));
      await type(user, 'the owner paid by hand today');
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^resolve$/i }));
      await waitFor(() => expect(api.resolveAlert).toHaveBeenCalledWith(3, 'the owner paid by hand today'));
      expect(await screen.findByText(/resolved\. recorded as event 42/i)).toBeInTheDocument();
      expect(api.acknowledgeAlert).not.toHaveBeenCalled();
    });

    it('needs the same ten characters, and sends one request for a double tap', async () => {
      let release;
      const api = fakeApi({ resolveAlert: vi.fn(() => new Promise(r => { release = r; })) });
      const { user } = await show(api);
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^resolve/i }));
      const send = within(screen.getByRole('form')).getByRole('button', { name: /^resolve$/i });
      expect(send).toBeDisabled();
      await type(user, 'too short');
      expect(send).toBeDisabled();
      await type(user, '!!');
      await user.dblClick(send);
      expect(api.resolveAlert).toHaveBeenCalledTimes(1);
      await act(async () => { release({ success: true, generated_at: iso(0), alert: { id: 1, state: 'resolved' }, event_id: 42 }); });
    });

    it('an alert already resolved is said, and the list is read again', async () => {
      const api = fakeApi({ resolveAlert: vi.fn(async () => { throw apiError('conflict', 'That alert is already resolved.'); }) });
      const { user } = await show(api);
      await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^resolve/i }));
      await type(user, GOOD);
      const reads = api.alerts.mock.calls.length;
      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^resolve$/i }));
      expect(await screen.findByText(/already resolved/i)).toBeInTheDocument();
      await waitFor(() => expect(api.alerts.mock.calls.length).toBe(reads + 1));
    });
  });

  it('a result that arrives after the page was closed changes nothing', async () => {
    let release;
    const api = fakeApi({ acknowledgeAlert: vi.fn(() => new Promise(r => { release = r; })) });
    const { user, view } = await show(api);
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
    view.unmount();
    await act(async () => { release({ success: true, generated_at: iso(0), alert: { id: 1, state: 'acked' }, event_id: 41 }); });
    expect(screen.queryByText(/recorded as event/i)).toBeNull();
  });

  it('the page offers no way to change a restaurant, a plan or a person: only these two actions on an alert', async () => {
    await show();
    await screen.findAllByRole('article');
    const labels = screen.getAllByRole('button').map(b => b.textContent.trim().toLowerCase());
    for (const label of labels) expect(label).not.toMatch(/delete|remove|suspend|extend|save|edit|void|refund|impersonate|log in as|snooze|mute|silence/);
  });

  it('a note about a past action goes away when something else is chosen', async () => {
    const { user } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
    await screen.findByText(/recorded as event 41/i);
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'resolved');
    expect(screen.queryByText(/recorded as event 41/i)).toBeNull();
  });
});

describe('the restaurant is a link in words only', () => {
  it('names the restaurant and nothing else about it: no phone, no id on the screen', async () => {
    const api = fakeApi({ alerts: vi.fn(async () => alertsPayload([alertRow(1, { restaurant_id: A_ID })])) });
    const { view } = await show(api);
    await screen.findByRole('article');
    expect(view.container.textContent).not.toContain(A_ID);
  });
});

// --- details the mutation check pointed at ------------------------------------------------------------------------------------------------

describe('what the page must not do when things around it change', () => {
  it('a parent that hands it a new function each time it draws does not make it read again, empty its list or close a form being written', async () => {
    const { user, api, view } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    const reads = api.alerts.mock.calls.length;
    for (let i = 0; i < 3; i++) view.rerender(<AlertsPage api={api} clock={clock} timeZone="UTC" pollMs={60000} nonce={0} onLeave={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(api.alerts.mock.calls.length).toBe(reads);
    expect(screen.getByRole('textbox')).toHaveValue(GOOD);
    expect(screen.getAllByRole('article').length).toBe(3);
  });

  it('a read after the filter was changed asks for the filter that is chosen now, not the one it began with', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user, api } = await show(fakeApi(), { pollMs: 1000, advance: vi.advanceTimersByTime });
    await screen.findAllByRole('article');
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'resolved');
    await waitFor(() => expect(api.alerts).toHaveBeenLastCalledWith({ state: 'resolved' }));
    const calls = api.alerts.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.alerts.mock.calls.length).toBeGreaterThan(calls);
    expect(api.alerts).toHaveBeenLastCalledWith({ state: 'resolved' });
  });

  it('once closed it reads no more: the timer is stopped with it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, view } = await show(fakeApi(), { pollMs: 1000, advance: vi.advanceTimersByTime });
    await screen.findAllByRole('article');
    view.unmount();
    const calls = api.alerts.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.alerts.mock.calls.length).toBe(calls);
  });

  it('an answer that arrives after it was closed does nothing: it does not read again and does not tell the console the session ended', async () => {
    let release;
    const api = fakeApi({ acknowledgeAlert: vi.fn(() => new Promise(r => { release = r; })) });
    const { user, view, onLeave } = await show(api);
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
    view.unmount();
    const reads = api.alerts.mock.calls.length;
    await act(async () => { release({ success: true, generated_at: iso(0), alert: { id: 1, state: 'acked' }, event_id: 41 }); });
    expect(api.alerts.mock.calls.length).toBe(reads);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('a refusal that arrives after it was closed is not passed to the console either', async () => {
    let fail;
    const api = fakeApi({ acknowledgeAlert: vi.fn(() => new Promise((_, reject) => { fail = reject; })) });
    const { user, view, onLeave } = await show(api);
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
    view.unmount();
    await act(async () => { fail(apiError('denied', 'Your session is not accepted any more. Sign in again.')); });
    expect(onLeave).not.toHaveBeenCalled();
  });
});

describe('what the form must not let through', () => {
  it('two submissions in the same instant send one request', async () => {
    let release;
    const api = fakeApi({ acknowledgeAlert: vi.fn(() => new Promise(r => { release = r; })) });
    const { user } = await show(api);
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    const form = screen.getByRole('form');
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(api.acknowledgeAlert).toHaveBeenCalledTimes(1);
    await act(async () => { release({ success: true, generated_at: iso(0), alert: { id: 1, state: 'acked' }, event_id: 41 }); });
  });

  it('a form submitted with too short a reason (not by the button) sends nothing', async () => {
    const { user, api } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, 'too short');
    act(() => { fireEvent.submit(screen.getByRole('form')); });
    expect(api.acknowledgeAlert).not.toHaveBeenCalled();
    expect(screen.getByRole('form')).toBeInTheDocument();
  });

  it('counts characters as a person sees them: five emoji are five, ten are ten', async () => {
    const { user } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await user.paste('😀😀😀😀😀');
    const send = within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i });
    expect(send).toBeDisabled();
    expect(screen.getByText(/5 of at least 10/)).toBeInTheDocument();
    await user.paste('😀😀😀😀😀');
    expect(send).toBeEnabled();
  });

  it('an alert that is not there any more closes the form, says so, and reads the list again', async () => {
    const api = fakeApi({ acknowledgeAlert: vi.fn(async () => { throw apiError('missing', 'That is not there any more.'); }) });
    const { user } = await show(api);
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    const reads = api.alerts.mock.calls.length;
    await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
    expect(await screen.findByText(/not there any more/i)).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    await waitFor(() => expect(api.alerts.mock.calls.length).toBe(reads + 1));
  });

  it('choosing another list closes a form that was open', async () => {
    const { user } = await show();
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    expect(screen.getByRole('form')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'open');
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('a repeat that recorded nothing says so, rather than claiming an event', async () => {
    const api = fakeApi({ acknowledgeAlert: vi.fn(async id => ({ success: true, generated_at: iso(0), alert: { id, state: 'acked' }, event_id: null })) });
    const { user } = await show(api);
    await user.click(within(rowOf(/2 orders were shelved/)).getByRole('button', { name: /^acknowledge/i }));
    await type(user, GOOD);
    await user.click(within(screen.getByRole('form')).getByRole('button', { name: /^acknowledge$/i }));
    expect(await screen.findByText(/nothing new was recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/recorded as event/i)).toBeNull();
  });
});

describe('what the list must not claim', () => {
  it('the closed list has no "waiting" and "taken on" counts: they would be of nothing', async () => {
    const closed = [alertRow(5, { state: 'resolved', resolved_at: iso(-5 * MIN), resolved_by: 'system', resolve_reason: 'condition_cleared', text: 'cleared alone' })];
    const api = fakeApi({ alerts: vi.fn(async f => alertsPayload(f.state === 'resolved' ? closed : defaultAlerts())) });
    const { user } = await show(api);
    await screen.findAllByRole('article');
    expect(screen.getByText(/\d+ waiting/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'resolved');
    await screen.findByText('cleared alone');
    expect(screen.queryByText(/\d+ waiting/)).toBeNull();
    expect(screen.queryByText(/nobody has answered/i)).toBeNull();
  });

  it('an alert somebody has taken on is not shown as one nobody answered, even if it was once flagged', async () => {
    const api = fakeApi({ alerts: vi.fn(async () => alertsPayload([alertRow(1, { state: 'acked', acked_at: iso(-MIN), acked_by_email: 'a@b.c', ack_reason: 'looking at it now', unattended_at: iso(-5 * MIN) })])) });
    await show(api);
    await screen.findByRole('article');
    expect(within(screen.getByRole('article')).queryByText(/nobody has answered/i)).toBeNull();
  });
});

describe('the way out the console gave most recently', () => {
  it('is the one used when the session ends, not the one it was first given', async () => {
    const alerts = vi.fn().mockResolvedValueOnce(alertsPayload(defaultAlerts())).mockRejectedValue(apiError('denied', 'Your session is not accepted any more. Sign in again.'));
    const api = fakeApi({ alerts });
    const first = vi.fn();
    const second = vi.fn();
    const { view } = await show(api, { onLeave: first });
    await screen.findAllByRole('article');
    view.rerender(<AlertsPage api={api} clock={clock} timeZone="UTC" pollMs={60000} nonce={1} onLeave={second} />);
    await waitFor(() => expect(second).toHaveBeenCalledWith('Your session ended. Sign in again.'));
    expect(first).not.toHaveBeenCalled();
  });
});
