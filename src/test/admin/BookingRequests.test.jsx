import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BookingRequests } from '@/admin/BookingRequests';
import { fakeHub, deferred } from '../helpers/fakeHub';

// What reception sees of guests' requests for a table (§4.6), and what it can do with them. The list is read from the hub, which holds what it
// has collected; accepting is a booking through the hub's own check (and says when there is no table, asking whether to book anyway);
// declining asks first. After either, the guest has to be told, from the host's own phone, so the WhatsApp words are kept in front of them
// until they say they are done.

const LIST = 'GET /admin/booking-requests';
const when = hours => new Date(Date.now() + hours * 3600000).toISOString();
const free = { ok: true, free: 2, fitting: 2, taken: 0, code: null };
const request = (n, name, over = {}) => ({
  id: `rq_${n}`, guest_name: name, party_size: 2, at: when(3), created_at: when(-1), status: 'pending', past: false, availability: free,
  phone: '919876543210', phone_display: '+91 98765 43210', whatsapp: `https://wa.me/919876543210?text=Hello%20${name}`, tel: 'tel:+919876543210', ...over
});
const list = (requests, over = {}) => ({ body: { success: true, requests, checked_at: new Date(2026, 9, 23, 12, 3).toISOString(), inbox_ok: true, ...over } });

afterEach(() => { vi.useRealTimers(); });

function setup(routes = {}, props = {}) {
  const notify = vi.fn();
  const onBooked = vi.fn();
  const hub = fakeHub({ [LIST]: list([request(1, 'Asha')]), ...routes });
  const view = render(<BookingRequests notify={notify} onBooked={onBooked} {...props} />);
  return { hub, notify, onBooked, ...view };
}
const row = name => screen.findByRole('listitem', { name: new RegExp(`Request from ${name}`) });

describe('the list', () => {
  it('is not there at all when nobody has asked, and says nothing if the hub cannot be read', async () => {
    const { container, hub: quiet } = setup({ [LIST]: list([]) });
    await waitFor(() => expect(quiet.calls(LIST)).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    cleanup();

    const broken = setup({ [LIST]: new TypeError('fetch failed') });
    await waitFor(() => expect(broken.hub.calls(LIST).length).toBeGreaterThan(0));
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows who is asking, for how many, when, what they said, and whether there is a table', async () => {
    setup({ [LIST]: list([
      request(1, 'Asha', { party_size: 4, note: 'Window, if possible' }),
      request(2, 'Bina', { availability: { ok: false, code: 'FULLY_BOOKED', free: 0, fitting: 2, taken: 2 } }),
      request(3, 'Chitra', { party_size: 12, availability: { ok: false, code: 'NO_TABLE_THAT_SIZE', free: 0, fitting: 0, taken: 0 } }),
      request(4, 'Dev', { past: true, at: when(-1), availability: free })
    ]) });
    expect(await screen.findByRole('heading', { name: 'Requests from the booking page (4)' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is booked until you accept/)).toBeInTheDocument();

    const asha = await row('Asha');
    expect(within(asha).getByText('Asha')).toBeInTheDocument();
    expect(within(asha).getByText('4')).toBeInTheDocument();
    expect(within(asha).getByText('Window, if possible')).toBeInTheDocument();
    expect(within(asha).getByText('A table is free')).toBeInTheDocument();
    expect(within(await row('Bina')).getByText('Fully booked then')).toBeInTheDocument();
    expect(within(await row('Chitra')).getByText('No table that size')).toBeInTheDocument();
    const dev = await row('Dev');
    expect(within(dev).getByText('That time has passed')).toBeInTheDocument();
    expect(within(dev).getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(within(dev).getByRole('button', { name: 'Decline' })).toBeEnabled();
    expect(within(asha).getByRole('button', { name: 'Accept' })).toBeEnabled();
  });

  it('keeps the order the hub gave, which is soonest first', async () => {
    setup({ [LIST]: list([request(1, 'First'), request(2, 'Second'), request(3, 'Third')]) });
    await screen.findByRole('listitem', { name: /First/ });
    expect(screen.getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Request from First', 'Request from Second', 'Request from Third']);
  });

  it('gives a way to reach the guest first, by WhatsApp with the opening words already written, or by phone', async () => {
    setup();
    const asha = await row('Asha');
    const wa = within(asha).getByRole('link', { name: 'Message Asha on WhatsApp' });
    expect(wa).toHaveAttribute('href', 'https://wa.me/919876543210?text=Hello%20Asha');
    expect(wa).toHaveAttribute('target', '_blank');
    expect(wa.getAttribute('rel')).toMatch(/noreferrer/);
    expect(within(asha).getByRole('link', { name: 'Call Asha' })).toHaveAttribute('href', 'tel:+919876543210');
  });

  it('says when it last checked the cloud, and when the last check did not work', async () => {
    setup({ [LIST]: list([request(1, 'Asha')]) });
    expect(await screen.findByText(/Checked with the cloud at 12:03/)).toBeInTheDocument();
    cleanup();
    setup({ [LIST]: list([request(1, 'Asha')], { checked_at: null, inbox_ok: null }) });
    expect(await screen.findByText('Not checked with the cloud yet.')).toBeInTheDocument();
    cleanup();
    setup({ [LIST]: list([request(1, 'Asha')], { inbox_ok: false }) });
    expect(await screen.findByText(/The last check with the cloud did not work/)).toBeInTheDocument();
  });

  it('reads the list again every minute, so a request that arrives while the tab is open appears', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let answers = [list([]), list([request(1, 'Late Arrival')])];
    let n = 0;
    const { hub } = setup({ [LIST]: () => answers[Math.min(n++, 1)] });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Late Arrival')).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(59000); });
    expect(hub.calls(LIST)).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(await screen.findByText('Late Arrival')).toBeInTheDocument();
  });

  it('stops reading when it is taken off the screen', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { hub, unmount } = setup();
    await act(async () => { await Promise.resolve(); });
    unmount();
    const before = hub.calls(LIST).length;
    await act(async () => { vi.advanceTimersByTime(300000); });
    expect(hub.calls(LIST)).toHaveLength(before);
  });
});

describe('checking for new requests', () => {
  it('asks the hub to look in the cloud now, and says how many are new', async () => {
    const answers = [list([request(1, 'Asha')]), list([request(1, 'Asha'), request(2, 'Bina'), request(3, 'Chitra')])];
    let n = 0;
    const { hub, notify, rerender } = setup({ [LIST]: () => answers[Math.min(n++, 1)] });
    await row('Asha');
    rerender(<BookingRequests notify={notify} onBooked={vi.fn()} refreshKey={1} />);
    await waitFor(() => expect(notify).toHaveBeenCalledWith('2 new requests.'));
    expect(hub.calls(LIST)[1].url.searchParams.get('refresh')).toBe('1');
    expect(hub.calls(LIST)[0].url.searchParams.get('refresh')).toBeNull();
  });

  it('says so when there is nothing new, in the singular for one, and when the cloud could not be reached', async () => {
    const answers = [list([request(1, 'Asha')]), list([request(1, 'Asha')]), list([request(1, 'Asha'), request(2, 'Bina')]), list([request(1, 'Asha'), request(2, 'Bina')], { inbox_ok: false })];
    let n = 0;
    const { notify, rerender } = setup({ [LIST]: () => answers[Math.min(n++, 3)] });
    await row('Asha');
    rerender(<BookingRequests notify={notify} onBooked={vi.fn()} refreshKey={1} />);
    await waitFor(() => expect(notify).toHaveBeenLastCalledWith('No new requests.'));
    rerender(<BookingRequests notify={notify} onBooked={vi.fn()} refreshKey={2} />);
    await waitFor(() => expect(notify).toHaveBeenLastCalledWith('1 new request.'));
    rerender(<BookingRequests notify={notify} onBooked={vi.fn()} refreshKey={3} />);
    await waitFor(() => expect(notify).toHaveBeenLastCalledWith('Could not reach the cloud. New requests will show when the internet is back.'));
  });

  it('does not check on the first showing, only when asked', async () => {
    const { hub } = setup();
    await row('Asha');
    expect(hub.calls(LIST)).toHaveLength(1);
    expect(hub.calls(LIST)[0].url.searchParams.get('refresh')).toBeNull();
  });
});

describe('accepting', () => {
  const ACCEPT = 'POST /admin/booking-requests/rq_1/accept';
  const booked = { status: 201, body: { success: true, reservation: { id: 'res_1', guest_name: 'Asha', at: when(3) }, request: { id: 'rq_1', status: 'accepted' }, reply_whatsapp: 'https://wa.me/919876543210?text=confirmed' } };

  it('books it, says so, reads the diary again, and keeps the words to tell the guest in front of the host until they are done', async () => {
    const { hub, notify, onBooked } = setup({ [LIST]: ({ call }) => list(call === 1 ? [request(1, 'Asha')] : []), [ACCEPT]: booked });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(hub.calls(ACCEPT)).toHaveLength(1));
    expect(hub.calls(ACCEPT)[0].body).toEqual({});
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Asha booked for /));
    await waitFor(() => expect(onBooked).toHaveBeenCalled());
    expect(screen.queryByRole('listitem', { name: /Request from Asha/ })).not.toBeInTheDocument();

    const told = await screen.findByRole('listitem', { name: 'Tell Asha' });
    expect(within(told).getByText(/Asha.s table is booked/)).toBeInTheDocument();
    const link = within(told).getByRole('link', { name: 'Tell Asha on WhatsApp' });
    expect(link).toHaveAttribute('href', 'https://wa.me/919876543210?text=confirmed');
    expect(link).toHaveAttribute('target', '_blank');
    await userEvent.click(within(told).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('listitem', { name: 'Tell Asha' })).not.toBeInTheDocument();
  });

  it('when there is no table free it says so and asks whether to book anyway; no sends nothing more, yes sends it as overbooking', async () => {
    const full = { status: 409, body: { success: false, code: 'FULLY_BOOKED', error: 'Every table that size is already booked then.', availability: { ok: false, fitting: 2, taken: 2, free: 0 } } };
    let n = 0;
    const { hub } = setup({ [ACCEPT]: () => (n++ < 2 ? full : booked) });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('No table free then')).toBeInTheDocument();
    expect(within(dialog).getByText(/All 2 table\(s\) that size are taken at that time\. Booking anyway is recorded as an overbooking/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(hub.calls(ACCEPT)).toHaveLength(1);

    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Accept' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Book it anyway' }));
    await waitFor(() => expect(hub.calls(ACCEPT)).toHaveLength(3));
    expect(hub.calls(ACCEPT)[2].body).toEqual({ force: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('listitem', { name: 'Tell Asha' })).toBeInTheDocument();
  });

  it('a party no table seats is said as that, not as a full house', async () => {
    setup({ [ACCEPT]: { status: 409, body: { success: false, code: 'NO_TABLE_THAT_SIZE', error: 'No table here seats 12.', availability: { ok: false, fitting: 0, taken: 0, free: 0 } } } });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Accept' }));
    expect(within(await screen.findByRole('dialog')).getByText('No table here seats 2.')).toBeInTheDocument();
  });

  it('any other refusal is said in the hub\'s words, with no dialog, and the list is read again', async () => {
    const { hub, notify } = setup({ [ACCEPT]: { status: 409, body: { success: false, code: 'NOT_PENDING', error: 'Asha\'s request has already been declined.' } } });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Asha\'s request has already been declined.'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(hub.calls(LIST).length).toBeGreaterThan(1));
  });

  it('the buttons are off while the hub is being asked, so a double press cannot book twice', async () => {
    const slow = deferred();
    const { hub } = setup({ [ACCEPT]: () => slow.promise });
    const asha = await row('Asha');
    await userEvent.click(within(asha).getByRole('button', { name: 'Accept' }));
    expect(within(asha).getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(within(asha).getByRole('button', { name: 'Decline' })).toBeDisabled();
    await userEvent.click(within(asha).getByRole('button', { name: 'Accept' }));
    expect(hub.calls(ACCEPT)).toHaveLength(1);
    slow.resolve(booked);
    await screen.findByRole('listitem', { name: 'Tell Asha' });
  });
});

describe('declining', () => {
  const DECLINE = 'POST /admin/booking-requests/rq_1/decline';
  const declined = { body: { success: true, request: { id: 'rq_1', status: 'declined' }, reply_whatsapp: 'https://wa.me/919876543210?text=sorry' } };

  it('asks first, and does nothing if the answer is no', async () => {
    const { hub } = setup({ [DECLINE]: declined });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Decline Asha\'s request?')).toBeInTheDocument();
    expect(within(dialog).getByText(/Nothing is booked/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(hub.calls(DECLINE)).toHaveLength(0);
    expect(screen.getByRole('listitem', { name: /Request from Asha/ })).toBeInTheDocument();
  });

  it('when confirmed it declines, says so, and gives the words to tell the guest kindly', async () => {
    const { hub, notify } = setup({ [LIST]: ({ call }) => list(call === 1 ? [request(1, 'Asha')] : []), [DECLINE]: declined });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Decline' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(hub.calls(DECLINE)).toHaveLength(1));
    expect(hub.calls(DECLINE)[0].body).toEqual({});
    expect(notify).toHaveBeenCalledWith('Asha\'s request declined.');
    const told = await screen.findByRole('listitem', { name: 'Tell Asha' });
    expect(within(told).getByText(/Tell Asha that you cannot take it/)).toBeInTheDocument();
    expect(within(told).getByRole('link', { name: 'Tell Asha on WhatsApp' })).toHaveAttribute('href', 'https://wa.me/919876543210?text=sorry');
    await waitFor(() => expect(screen.queryByRole('listitem', { name: /Request from Asha/ })).not.toBeInTheDocument());
  });

  it('a refusal is said in the hub\'s words, the dialog closes, and the list is read again', async () => {
    const { hub, notify } = setup({ [DECLINE]: { status: 409, body: { success: false, code: 'NOT_PENDING', error: 'Asha\'s request has already been accepted.' } } });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Decline' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Asha\'s request has already been accepted.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(hub.calls(LIST).length).toBeGreaterThan(1);
  });

  it('the dialog cannot be confirmed twice', async () => {
    const slow = deferred();
    const { hub } = setup({ [DECLINE]: () => slow.promise });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(within(dialog).getByRole('button', { name: 'Decline' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(hub.calls(DECLINE)).toHaveLength(1);
    slow.resolve(declined);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('the words to tell guests', () => {
  const booked = id => ({ status: 201, body: { success: true, reservation: { id: `res_${id}`, at: when(3) }, request: { id: `rq_${id}`, status: 'accepted' }, reply_whatsapp: `https://wa.me/9190000000${id}?text=confirmed` } });

  it('stay in front of the host, one for each guest, until that guest\'s own Done is pressed; and open in their own tab', async () => {
    setup({
      [LIST]: ({ call }) => list(call === 1 ? [request(1, 'Asha'), request(2, 'Bina')] : call === 2 ? [request(2, 'Bina')] : []),
      'POST /admin/booking-requests/rq_1/accept': booked(1),
      'POST /admin/booking-requests/rq_2/accept': booked(2)
    });
    await userEvent.click(within(await row('Asha')).getByRole('button', { name: 'Accept' }));
    await screen.findByRole('listitem', { name: 'Tell Asha' });
    await userEvent.click(within(await row('Bina')).getByRole('button', { name: 'Accept' }));
    await screen.findByRole('listitem', { name: 'Tell Bina' });
    expect(screen.getAllByRole('listitem', { name: /^Tell / })).toHaveLength(2);

    const link = within(screen.getByRole('listitem', { name: 'Tell Asha' })).getByRole('link', { name: 'Tell Asha on WhatsApp' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noreferrer/);

    await userEvent.click(within(screen.getByRole('listitem', { name: 'Tell Asha' })).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('listitem', { name: 'Tell Asha' })).not.toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Tell Bina' })).toBeInTheDocument();
  });
});
