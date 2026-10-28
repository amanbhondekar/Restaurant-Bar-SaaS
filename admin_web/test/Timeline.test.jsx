import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Timeline } from '../src/screens/Timeline.jsx';
import { A_ID, HOUR, MIN, apiError, defaultTimeline, fakeApi, iso, timelineEvent, timelinePayload } from './helpers.jsx';

// One restaurant's timeline: what happened to it, in words, newest first, grouped by day, with the kind of thing each was, filtered by kind, paged back
// in time, and read again as it changes.
//
// What matters: a person reads sentences and not type names; the filter is the database's, so a filtered page is a page of that kind and paging stays in
// it; paging back never shows an event twice or loses the ones above; a read that fails never leaves an old list looking current; and nothing the API sends
// is ever treated as anything but text.

const NOW = Date.parse('2026-10-26T10:00:30.000Z');
const clock = () => NOW;

async function show(api = fakeApi(), props = {}) {
  const onLeave = vi.fn();
  const { advance, settle = true, ...rest } = props;
  const user = userEvent.setup(advance ? { advanceTimers: advance } : {});
  const view = render(<Timeline api={api} restaurantId={A_ID} clock={clock} timeZone="UTC" pollMs={60000} nonce={0} onLeave={onLeave} {...rest} />);
  await screen.findByRole('heading', { name: /^timeline$/i });
  if (settle) await waitFor(() => expect(screen.queryByText(/reading the timeline/i)).toBeNull());
  return { user, api, onLeave, view };
}
const items = () => screen.getAllByRole('listitem').filter(li => li.hasAttribute('data-event'));
const itemOf = text => items().find(li => within(li).queryByText(text));

afterEach(() => { vi.useRealTimers(); });

describe('what it shows', () => {
  it('asks for this restaurant\'s timeline, and says when it was read', async () => {
    const { api } = await show();
    await screen.findAllByRole('listitem');
    expect(api.timeline).toHaveBeenCalledWith(A_ID, {});
    expect(screen.getByText(/as of 10:00/i)).toBeInTheDocument();
  });

  it('says each event in a sentence, with the time, and which kind of thing it was', async () => {
    await show();
    const acked = itemOf('Alert acknowledged by aman@example.test (orders shelved)');
    expect(within(acked).getByText('“ringing the owner now”')).toBeInTheDocument();
    expect(within(acked).getByText('09:55')).toBeInTheDocument();
    expect(within(acked).getByText('Alerts')).toBeInTheDocument();
    const shelved = itemOf('Orders were shelved');
    expect(within(shelved).getByText('Now 2 (was 0).')).toBeInTheDocument();
    expect(within(shelved).getByText('Hub')).toBeInTheDocument();
    const halted = itemOf('Subscription halted: the payment could not be collected');
    expect(within(halted).getByText('The plan status is now past due.')).toBeInTheDocument();
    expect(within(halted).getByText('Billing')).toBeInTheDocument();
  });

  it('keeps the order the API gave, newest first', async () => {
    await show();
    const titles = items().map(li => li.querySelector('[data-title]').textContent);
    expect(titles).toEqual([
      'Alert acknowledged by aman@example.test (orders shelved)', 'Orders were shelved', 'Subscription halted: the payment could not be collected', 'Subscription activated'
    ]);
  });

  it('groups by day, and says Today, Yesterday, and the date for older ones, one heading per day', async () => {
    await show();
    const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(headings).toEqual(['Today', 'Yesterday', '23 Oct 2026']);
  });

  it('puts each event under the day it happened on in the time zone it was given, not the server\'s', async () => {
    const api = fakeApi({ timeline: vi.fn(async () => timelinePayload([timelineEvent(1, 'hub.restarted', { source: 'hub', occurred_at: '2026-10-25T23:30:00.000Z' })])) });
    await show(api, { timeZone: 'Asia/Kolkata' });
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Today');
    expect(screen.getByText('05:00')).toBeInTheDocument();
  });

  it('puts the details of an event in a place that opens, as text', async () => {
    const { user } = await show();
    const halted = itemOf('Subscription halted: the payment could not be collected');
    const details = within(halted).getByText(/details/i);
    await user.click(details);
    expect(within(halted).getByText(/"applied_plan_status": "past_due"/)).toBeInTheDocument();
  });

  it('draws everything the API sends as text, never as markup', async () => {
    const api = fakeApi({ timeline: vi.fn(async () => timelinePayload([timelineEvent(1, 'alert.acked', { source: 'admin', actor_email: '<img src=x onerror=alert(1)>', payload: { rule_key: 'orders_shelved', reason: '<script>x</script>' } })])) });
    const { view } = await show(api);
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(screen.getAllByText(/<script>x<\/script>/).length).toBeGreaterThan(0);   // in the sentence, and again in the details
    expect(view.container.querySelector('img, script')).toBeNull();
  });

  it('says what it does not know as what it is: an event of a type it has no words for shows its type, quoted', async () => {
    const api = fakeApi({ timeline: vi.fn(async () => timelinePayload([timelineEvent(1, 'support.note_added', { source: 'support' })])) });
    await show(api);
    expect(screen.getByText('Event “support.note_added”')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('with no history says so, and says which kind when one is chosen', async () => {
    const api = fakeApi({ timeline: vi.fn(async () => timelinePayload([])) });
    const { user } = await show(api);
    expect(screen.getByText(/nothing has happened to this restaurant yet/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'alerts');
    expect(await screen.findByText(/no alert events/i)).toBeInTheDocument();
  });
});

describe('the filter', () => {
  it('offers every kind, and asks for the one chosen', async () => {
    const api = fakeApi({ timeline: vi.fn(async (id, f) => timelinePayload(f.kind === 'alerts' ? [defaultTimeline()[0]] : defaultTimeline(), { kind: f.kind ?? null })) });
    const { user } = await show(api);
    const select = screen.getByRole('combobox', { name: /show/i });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Everything', 'Billing', 'Hub', 'Alerts', 'Admin actions']);
    await user.selectOptions(select, 'alerts');
    expect(api.timeline).toHaveBeenLastCalledWith(A_ID, { kind: 'alerts' });
    await waitFor(() => expect(items().length).toBe(1));
    await user.selectOptions(select, '');
    expect(api.timeline).toHaveBeenLastCalledWith(A_ID, {});
    await waitFor(() => expect(items().length).toBe(4));
  });

  it('an answer to an older question is dropped when it arrives', async () => {
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    const api = fakeApi({ timeline: vi.fn(async (id, f) => (f.kind === 'billing' ? slow : timelinePayload(f.kind === 'hub' ? [defaultTimeline()[1]] : defaultTimeline()))) });
    const { user } = await show(api);
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'billing');
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'hub');
    await waitFor(() => expect(items().length).toBe(1));
    await act(async () => { release(timelinePayload([timelineEvent(99, 'subscription.charged', { source: 'razorpay' })])); });
    expect(screen.queryByText('Payment received')).toBeNull();
    expect(items().length).toBe(1);
  });

  it('is reset when another restaurant is shown', async () => {
    const api = fakeApi({ timeline: vi.fn(async id => timelinePayload([timelineEvent(1, 'hub.restarted', { source: 'hub', restaurant_id: id })])) });
    const { user, view, onLeave } = await show(api);
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'hub');
    view.rerender(<Timeline api={api} restaurantId="b0b0b0b0-0000-4000-8000-000000000002" clock={clock} timeZone="UTC" pollMs={60000} nonce={0} onLeave={onLeave} />);
    await waitFor(() => expect(api.timeline).toHaveBeenLastCalledWith('b0b0b0b0-0000-4000-8000-000000000002', {}));
    expect(screen.getByRole('combobox', { name: /show/i })).toHaveValue('');
  });
});

describe('going back in time', () => {
  const page = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => timelineEvent(from - i, 'hub.restarted', { source: 'hub', occurred_at: iso(-(from - i) * MIN) }));

  it('offers older events only when the API says there are some, and fetches them before the oldest shown', async () => {
    const timeline = vi.fn(async (id, f) => (f.before ? timelinePayload(page(2, 1)) : timelinePayload(page(5, 3), { next_before: 3 })));
    const { user } = await show(fakeApi({ timeline }));
    expect(items().length).toBe(3);
    await user.click(screen.getByRole('button', { name: /show older/i }));
    expect(timeline).toHaveBeenLastCalledWith(A_ID, { before: 3 });
    await waitFor(() => expect(items().length).toBe(5));
    expect(screen.queryByRole('button', { name: /show older/i })).toBeNull();
  });

  it('keeps the kind while going back, and the ones already shown above', async () => {
    const timeline = vi.fn(async (id, f) => (f.before ? timelinePayload(page(2, 1)) : timelinePayload(page(5, 3), { next_before: 3 })));
    const { user } = await show(fakeApi({ timeline }));
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'hub');
    await waitFor(() => expect(timeline).toHaveBeenLastCalledWith(A_ID, { kind: 'hub' }));
    await user.click(await screen.findByRole('button', { name: /show older/i }));
    expect(timeline).toHaveBeenLastCalledWith(A_ID, { kind: 'hub', before: 3 });
    await waitFor(() => expect(items().map(li => li.getAttribute('data-event'))).toEqual(['5', '4', '3', '2', '1']));
  });

  it('shows no event twice even if the API repeats one', async () => {
    const timeline = vi.fn(async (id, f) => (f.before ? timelinePayload(page(3, 1)) : timelinePayload(page(5, 3), { next_before: 3 })));
    const { user } = await show(fakeApi({ timeline }));
    await user.click(screen.getByRole('button', { name: /show older/i }));
    await waitFor(() => expect(items().length).toBe(5));
    expect(items().map(li => li.getAttribute('data-event'))).toEqual(['5', '4', '3', '2', '1']);
  });

  it('a double tap asks once, and the button waits while it is asking', async () => {
    let release;
    const timeline = vi.fn(async (id, f) => (f.before ? new Promise(r => { release = r; }) : timelinePayload(page(5, 3), { next_before: 3 })));
    const { user } = await show(fakeApi({ timeline }));
    const more = screen.getByRole('button', { name: /show older/i });
    await user.dblClick(more);
    expect(timeline.mock.calls.filter(c => c[1].before).length).toBe(1);
    expect(more).toBeDisabled();
    await act(async () => { release(timelinePayload(page(2, 1))); });
    await waitFor(() => expect(items().length).toBe(5));
  });

  it('a failure going back is said, keeps what is shown, and can be tried again', async () => {
    const timeline = vi.fn()
      .mockResolvedValueOnce(timelinePayload(page(5, 3), { next_before: 3 }))
      .mockRejectedValueOnce(apiError('offline', 'Could not reach the admin service. Check your connection and try again.'))
      .mockResolvedValue(timelinePayload(page(2, 1)));
    const { user } = await show(fakeApi({ timeline }));
    await user.click(screen.getByRole('button', { name: /show older/i }));
    expect(await screen.findByText(/could not reach the admin service/i)).toBeInTheDocument();
    expect(items().length).toBe(3);
    await user.click(screen.getByRole('button', { name: /show older/i }));
    await waitFor(() => expect(items().length).toBe(5));
  });
});

describe('reading and failing to read', () => {
  it('a first read that fails shows nothing and says why, with a way to try again', async () => {
    const timeline = vi.fn().mockRejectedValueOnce(apiError('down', 'The admin service could not read that. Try again in a moment.')).mockResolvedValue(timelinePayload(defaultTimeline()));
    const { user } = await show(fakeApi({ timeline }));
    expect(await screen.findByText(/could not read that/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem').length).toBe(0);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(items().length).toBe(4));
  });

  it('a restaurant that is not there says so', async () => {
    await show(fakeApi({ timeline: vi.fn(async () => { throw apiError('missing', 'That is not there any more.'); }) }));
    expect(await screen.findByText(/not there any more/i)).toBeInTheDocument();
  });

  it('a read that fails after a good one keeps the list but marks it as older', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const timeline = vi.fn().mockResolvedValueOnce(timelinePayload(defaultTimeline())).mockRejectedValue(apiError('offline', 'Could not reach the admin service. Check your connection and try again.'));
    await show(fakeApi({ timeline }), { pollMs: 1000, advance: vi.advanceTimersByTime });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(items().length).toBe(4);
    expect(screen.getAllByText(/as of 10:00/i).length).toBeGreaterThan(0);
  });

  it('a session that ended is the console\'s to handle', async () => {
    const { onLeave } = await show(fakeApi({ timeline: vi.fn(async () => { throw apiError('denied', 'Your session is not accepted any more. Sign in again.'); }) }), { settle: false });
    await waitFor(() => expect(onLeave).toHaveBeenCalledWith('Your session ended. Sign in again.'));
  });

  it('reads again when told, and puts what is new above what is shown, losing nothing below', async () => {
    const timeline = vi.fn()
      .mockResolvedValueOnce(timelinePayload([timelineEvent(5, 'hub.restarted', { source: 'hub' }), timelineEvent(4, 'hub.restarted', { source: 'hub' })], { next_before: 4 }))
      .mockResolvedValueOnce(timelinePayload([timelineEvent(3, 'hub.restarted', { source: 'hub' }), timelineEvent(2, 'hub.restarted', { source: 'hub' })], { next_before: 2 }))
      .mockResolvedValue(timelinePayload([timelineEvent(7, 'hub.restarted', { source: 'hub' }), timelineEvent(6, 'hub.restarted', { source: 'hub' }), timelineEvent(5, 'hub.restarted', { source: 'hub' })], { next_before: 5 }));
    const api = fakeApi({ timeline });
    const { user, view, onLeave } = await show(api);
    await user.click(screen.getByRole('button', { name: /show older/i }));
    await waitFor(() => expect(items().length).toBe(4));
    view.rerender(<Timeline api={api} restaurantId={A_ID} clock={clock} timeZone="UTC" pollMs={60000} nonce={1} onLeave={onLeave} />);
    await waitFor(() => expect(items().map(li => li.getAttribute('data-event'))).toEqual(['7', '6', '5', '4', '3', '2']));
  });

  it('reads again on its own, one read at a time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release;
    const timeline = vi.fn().mockResolvedValueOnce(timelinePayload(defaultTimeline())).mockImplementationOnce(() => new Promise(r => { release = r; })).mockResolvedValue(timelinePayload(defaultTimeline()));
    await show(fakeApi({ timeline }), { pollMs: 1000, advance: vi.advanceTimersByTime });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(timeline).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(timeline).toHaveBeenCalledTimes(2);
    await act(async () => { release(timelinePayload(defaultTimeline())); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(timeline).toHaveBeenCalledTimes(3);
  });

  it('once closed it reads no more, and a late answer does nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, view } = await show(fakeApi(), { pollMs: 1000, advance: vi.advanceTimersByTime });
    view.unmount();
    const calls = api.timeline.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.timeline.mock.calls.length).toBe(calls);
  });

  it('a parent that hands it a new function each time it draws does not make it read again or reset its list', async () => {
    const { user, api, view } = await show();
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'alerts');
    await waitFor(() => expect(api.timeline).toHaveBeenLastCalledWith(A_ID, { kind: 'alerts' }));
    const reads = api.timeline.mock.calls.length;
    for (let i = 0; i < 3; i++) view.rerender(<Timeline api={api} restaurantId={A_ID} clock={clock} timeZone="UTC" pollMs={60000} nonce={0} onLeave={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(api.timeline.mock.calls.length).toBe(reads);
    expect(screen.getByRole('combobox', { name: /show/i })).toHaveValue('alerts');
  });
});

// --- details the mutation check pointed at ------------------------------------------------------------------------------------------------

const rerender = (view, api, props = {}) => view.rerender(<Timeline api={api} restaurantId={A_ID} clock={clock} timeZone="UTC" pollMs={60000} nonce={0} onLeave={() => {}} {...props} />);
const hubEvents = (...ids) => ids.map(id => timelineEvent(id, 'hub.restarted', { source: 'hub', occurred_at: iso(-id * MIN) }));

describe('days are the viewer\'s, not the server\'s', () => {
  it('a day is the day in the time zone given: late on the 23rd in Los Angeles is the 23rd, even though it is the 24th in UTC', async () => {
    const api = fakeApi({ timeline: vi.fn(async () => timelinePayload([timelineEvent(1, 'hub.restarted', { source: 'hub', occurred_at: '2026-10-24T05:00:00.000Z' })])) });
    await show(api, { timeZone: 'America/Los_Angeles' });
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('23 Oct 2026');
    expect(screen.getByText('22:00')).toBeInTheDocument();
  });
});

describe('what a read that comes by itself does to a list that has been paged', () => {
  const firstPage = () => timelinePayload(hubEvents(5, 4), { next_before: 4 });

  it('when more than a page happened meanwhile, the list starts again from the new page: what lies between is not known', async () => {
    const timeline = vi.fn().mockResolvedValueOnce(firstPage()).mockResolvedValue(timelinePayload(hubEvents(20, 19), { next_before: 19 }));
    const api = fakeApi({ timeline });
    const { view } = await show(api);
    rerender(view, api, { nonce: 1 });
    await waitFor(() => expect(items().map(li => li.getAttribute('data-event'))).toEqual(['20', '19']));
  });

  it('when what is new joins up with what is shown, the way further back is still where it was', async () => {
    const timeline = vi.fn()
      .mockResolvedValueOnce(firstPage())
      .mockResolvedValueOnce(timelinePayload(hubEvents(3, 2), { next_before: 2 }))
      .mockResolvedValueOnce(timelinePayload(hubEvents(7, 6, 5), { next_before: 5 }))
      .mockResolvedValue(timelinePayload(hubEvents(1)));
    const api = fakeApi({ timeline });
    const { user, view } = await show(api);
    await user.click(screen.getByRole('button', { name: /show older/i }));
    await waitFor(() => expect(items().length).toBe(4));
    rerender(view, api, { nonce: 1 });
    await waitFor(() => expect(items().length).toBe(6));
    await user.click(screen.getByRole('button', { name: /show older/i }));
    expect(timeline).toHaveBeenLastCalledWith(A_ID, { before: 2 });
  });

  it('does not read while an older page is on its way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release;
    const timeline = vi.fn(async (id, f) => (f.before ? new Promise(r => { release = r; }) : firstPage()));
    const { user } = await show(fakeApi({ timeline }), { pollMs: 1000, advance: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: /show older/i }));
    const calls = timeline.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(timeline.mock.calls.length).toBe(calls);
    await act(async () => { release(timelinePayload(hubEvents(3, 2))); });
  });
});

describe('what the older button must not do', () => {
  it('two taps in the same instant ask once', async () => {
    let release;
    const timeline = vi.fn(async (id, f) => (f.before ? new Promise(r => { release = r; }) : timelinePayload(hubEvents(5, 4), { next_before: 4 })));
    await show(fakeApi({ timeline }));
    const more = screen.getByRole('button', { name: /show older/i });
    act(() => { more.click(); more.click(); });
    expect(timeline.mock.calls.filter(c => c[1].before).length).toBe(1);
    await act(async () => { release(timelinePayload(hubEvents(3, 2))); });
  });

  it('an answer that arrives after it was closed is not passed to the console', async () => {
    let fail;
    const timeline = vi.fn(async (id, f) => (f.before ? new Promise((_, reject) => { fail = reject; }) : timelinePayload(hubEvents(5, 4), { next_before: 4 })));
    const { user, view, onLeave } = await show(fakeApi({ timeline }));
    await user.click(screen.getByRole('button', { name: /show older/i }));
    view.unmount();
    await act(async () => { fail(apiError('denied', 'Your session is not accepted any more. Sign in again.')); });
    expect(onLeave).not.toHaveBeenCalled();
  });
});

describe('what it must remember and what it must forget', () => {
  it('the way out the console gave most recently is the one used when the session ends', async () => {
    const timeline = vi.fn().mockResolvedValueOnce(timelinePayload(defaultTimeline())).mockRejectedValue(apiError('denied', 'Your session is not accepted any more. Sign in again.'));
    const api = fakeApi({ timeline });
    const first = vi.fn();
    const second = vi.fn();
    const { view } = await show(api, { onLeave: first });
    rerender(view, api, { nonce: 1, onLeave: second });
    await waitFor(() => expect(second).toHaveBeenCalledWith('Your session ended. Sign in again.'));
    expect(first).not.toHaveBeenCalled();
  });

  it('another restaurant is read as soon as it is shown, even when no kind was chosen', async () => {
    const api = fakeApi();
    const { view } = await show(api);
    rerender(view, api, { restaurantId: 'b0b0b0b0-0000-4000-8000-000000000002' });
    await waitFor(() => expect(api.timeline).toHaveBeenLastCalledWith('b0b0b0b0-0000-4000-8000-000000000002', {}));
  });

  it('a kind chosen for the second restaurant is that restaurant\'s, and is asked for', async () => {
    const api = fakeApi();
    const { user, view } = await show(api);
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'hub');
    rerender(view, api, { restaurantId: 'b0b0b0b0-0000-4000-8000-000000000002' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: /show/i })).toHaveValue(''));
    await user.selectOptions(screen.getByRole('combobox', { name: /show/i }), 'alerts');
    expect(screen.getByRole('combobox', { name: /show/i })).toHaveValue('alerts');
    await waitFor(() => expect(api.timeline).toHaveBeenLastCalledWith('b0b0b0b0-0000-4000-8000-000000000002', { kind: 'alerts' }));
  });

  it('the restaurant read is always the one shown now', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi();
    const { view } = await show(api, { pollMs: 1000, advance: vi.advanceTimersByTime });
    rerender(view, api, { restaurantId: 'b0b0b0b0-0000-4000-8000-000000000002', pollMs: 1000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.timeline).toHaveBeenLastCalledWith('b0b0b0b0-0000-4000-8000-000000000002', {});
  });
});
