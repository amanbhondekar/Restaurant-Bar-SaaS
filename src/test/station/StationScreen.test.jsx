import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/station/lib/chime', () => ({ playChime: vi.fn(), unlockAudio: vi.fn() }));

import { StationScreen } from '@/station/StationScreen';
import { playChime } from '@/station/lib/chime';
import { clearToken, getToken, setToken } from '@/services/hubAuth';
import { fakeHub } from '../helpers/fakeHub';
// Tickets come from the hub's own course functions, so a change there breaks these tests rather than
// leaving the screen quietly reading a shape the hub no longer sends.
import { initCourseState, markStationReady, fireCourse } from '../../../hub_server/lib/courses.js';

// The screen on a tablet at one station. A fake WebSocket stands in for the hub's live feed.

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
  }
  close() { this.readyState = 3; this.onclose?.(); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}
const live = () => FakeWebSocket.instances.at(-1);

const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const line = (name, station, course = 1, qty = 1, extra = {}) => ({ id: name.toLowerCase().replace(/\W+/g, '_'), name, qty, station, course, ...extra });
const make = (items, { id = 't1', n = 101, table = 'T4', staged = false, at = ago(2), note = '' } = {}) => ({
  id, ticket_number: n, table_name: table, status: 'in_progress', items, created_at: at, updated_at: at, note,
  ...initCourseState(items, { staged }, at)
});

const MIXED = make([line('Dal Tadka', 'hot', 1, 2), line('Masala Chaas', 'bar', 1, 3)], { id: 'a', n: 142 });
const FOOD = make([line('Naan', 'hot')], { id: 'b', n: 143, table: 'T7' });

const routes = (extra = {}) => ({
  'GET /orders/active': { body: { success: true, tickets: [MIXED, FOOD] } },
  ...extra
});

let hub;
const show = async (station = 'bar', over = {}) => {
  hub = fakeHub(routes(over));
  render(<StationScreen station={station} />);
  await screen.findByRole('heading', { level: 1, name: new RegExp(station === 'bar' ? 'Bar' : station === 'hot' ? 'Hot line' : 'Cold line') });
  return hub;
};
const connect = async () => {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  act(() => live().open());
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.mocked(playChime).mockClear();
  clearToken();
  try { window.localStorage.clear(); } catch { /* fine */ }
});
afterEach(() => { vi.useRealTimers(); });

describe('station screen — what it shows', () => {
  it('shows only this station\'s tickets, and on each only this station\'s lines', async () => {
    await show('bar');
    const card = await screen.findByRole('article', { name: /Ticket 142, T4/ });
    expect(within(card).getByText('Masala Chaas')).toBeInTheDocument();
    expect(within(card).getByText('3×')).toBeInTheDocument();
    expect(within(card).queryByText('Dal Tadka')).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /Ticket 143/ })).not.toBeInTheDocument();
    expect(screen.getByText('1 waiting')).toBeInTheDocument();
  });

  it('the hot line sees both, each with its own lines', async () => {
    await show('hot');
    expect(await screen.findAllByRole('article')).toHaveLength(2);
    expect(within(screen.getByRole('article', { name: /Ticket 142/ })).getByText('Dal Tadka')).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
  });

  it('says so plainly when there is nothing to cook', async () => {
    await show('cold');
    expect(await screen.findByText('Nothing waiting for the cold line.')).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('shows size, what was chosen, the ticket\'s note, and the course when served in courses', async () => {
    // "Served in courses" only means something when the order spans more than one, so there is a dessert too.
    const t = make(
      [line('Biryani', 'hot', 1, 1, { variant_label: 'Full', modifiers: [{ option_label: 'Extra spicy' }, { option_label: 'No onion' }] }), line('Kulfi', 'cold', 2)],
      { id: 'c', n: 150, staged: true, note: 'Allergy: nuts' }
    );
    await show('hot', { 'GET /orders/active': { body: { tickets: [t] } } });
    const card = await screen.findByRole('article', { name: /Ticket 150/ });
    expect(within(card).getByText(/Full/)).toBeInTheDocument();
    expect(within(card).getByText('Extra spicy, No onion')).toBeInTheDocument();
    expect(within(card).getByText('Allergy: nuts')).toBeInTheDocument();
    expect(within(card).getByText('Course 1')).toBeInTheDocument();
  });

  it('a course that has not been fired is not on the board yet', async () => {
    const staged = make([line('Starter', 'hot', 1), line('Main', 'hot', 2)], { id: 's', n: 160, staged: true });
    await show('hot', { 'GET /orders/active': { body: { tickets: [staged] } } });
    const card = await screen.findByRole('article', { name: /Ticket 160/ });
    expect(within(card).getByText('Starter')).toBeInTheDocument();
    expect(within(card).queryByText('Main')).not.toBeInTheDocument();
  });

  it('shows how long it has been waiting, and the longest wait first', async () => {
    const slow = make([line('Dal', 'hot')], { id: 'slow', n: 170, at: ago(12) });
    const quick = make([line('Naan', 'hot')], { id: 'quick', n: 171, at: ago(1) });
    await show('hot', { 'GET /orders/active': { body: { tickets: [quick, slow] } } });
    const cards = await screen.findAllByRole('article');
    expect(cards[0]).toHaveAccessibleName(/Ticket 170/);
    expect(within(cards[0]).getByLabelText('Waiting 12 min')).toBeInTheDocument();
    expect(within(cards[1]).getByLabelText('Waiting 1 min')).toBeInTheDocument();
  });
});

describe('station screen — the live feed', () => {
  it('declares which station it is, so the hub can tell reception when a station has no screen', async () => {
    await show('bar');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const url = new URL(live().url);
    expect(url.pathname).toBe('/live');
    expect(url.searchParams.get('station')).toBe('bar');
    expect(url.searchParams.get('label')).toBe('Bar screen');
    expect(url.protocol).toBe('ws:');
  });

  it('carries the device token, since the live feed is refused without one', async () => {
    setToken('a'.repeat(64));
    await show('bar');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(new URL(live().url).searchParams.get('token')).toBe('a'.repeat(64));
  });

  it('a new order for this station appears, and one for another station does not', async () => {
    await show('bar');
    await connect();
    act(() => live().receive({ type: 'NEW_ORDER', payload: make([line('Chai', 'bar')], { id: 'new1', n: 200 }) }));
    expect(await screen.findByRole('article', { name: /Ticket 200/ })).toBeInTheDocument();

    act(() => live().receive({ type: 'NEW_ORDER', payload: make([line('Dal', 'hot')], { id: 'new2', n: 201 }) }));
    expect(screen.queryByRole('article', { name: /Ticket 201/ })).not.toBeInTheDocument();
  });

  it('the same order announced twice appears once', async () => {
    await show('bar');
    await connect();
    const t = make([line('Chai', 'bar')], { id: 'dup', n: 210 });
    act(() => { live().receive({ type: 'NEW_ORDER', payload: t }); live().receive({ type: 'order_created', payload: { ticket: t } }); });
    expect(await screen.findAllByRole('article', { name: /Ticket 210/ })).toHaveLength(1);
  });

  it('a held course being fired puts it on the board', async () => {
    const staged = make([line('Starter', 'hot', 1), line('Main', 'hot', 2)], { id: 's', n: 220, staged: true });
    await show('hot', { 'GET /orders/active': { body: { tickets: [staged] } } });
    await connect();
    const done = markStationReady(staged, 'hot', ago(1)).ticket;
    act(() => live().receive({ type: 'TICKET_UPDATED', payload: { ticket: done } }));
    expect(await screen.findByText('Nothing waiting for the hot line.')).toBeInTheDocument();

    const fired = fireCourse(done, 2, new Date().toISOString()).ticket;
    act(() => live().receive({ type: 'COURSE_FIRED', payload: { ticket: fired } }));
    const card = await screen.findByRole('article', { name: /Ticket 220/ });
    expect(within(card).getByText('Main')).toBeInTheDocument();
    expect(within(card).queryByText('Starter')).not.toBeInTheDocument();
  });

  it('another screen marking this station\'s part ready takes it off this one too', async () => {
    await show('bar');
    await connect();
    act(() => live().receive({ type: 'STATION_READY', payload: { ticket: markStationReady(MIXED, 'bar', ago(0)).ticket } }));
    await waitFor(() => expect(screen.queryByRole('article', { name: /Ticket 142/ })).not.toBeInTheDocument());
  });

  it('a message that arrives while the tickets are being read again is not undone by the answer', async () => {
    // The hub answered the read, then took a new order; the message reached the tablet before the answer did.
    let reads = 0;
    let release;
    const gate = new Promise(r => { release = r; });
    hub = fakeHub(routes({
      'GET /orders/active': async () => {
        reads += 1;
        if (reads === 1) return { body: { tickets: [MIXED] } };
        await gate;                                                  // the second read, on connecting, is slow
        return { body: { tickets: [MIXED] } };                       // and its answer predates the new order
      }
    }));
    render(<StationScreen station="bar" />);
    await screen.findByRole('heading', { level: 1, name: 'Bar' });
    await connect();                                                 // starts the second read, which is held open

    act(() => live().receive({ type: 'NEW_ORDER', payload: make([line('Chai', 'bar')], { id: 'raced', n: 230 }) }));
    expect(await screen.findByRole('article', { name: /Ticket 230/ })).toBeInTheDocument();

    release();                                                       // the older answer lands now
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('article', { name: /Ticket 230/ })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Ticket 142/ })).toBeInTheDocument();
  });

  it('a table being cleared makes it read the tickets again', async () => {
    const h = await show('bar');
    await connect();
    const before = h.calls('GET /orders/active').length;
    act(() => live().receive({ type: 'CLEAR_TABLE', payload: {} }));
    await waitFor(() => expect(h.calls('GET /orders/active').length).toBeGreaterThan(before));
  });

  it('shows Live once connected, and says so when the connection drops, then reconnects and reads everything again', async () => {
    const h = await show('bar');
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…');
    await connect();
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    expect(screen.queryByText(/Not connected to the hub/)).not.toBeInTheDocument();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => live().drop());
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
    expect(screen.getByRole('alert')).toHaveTextContent(/Not connected to the hub.*may be out of date/);
    expect(screen.getByRole('article', { name: /Ticket 142/ })).toBeInTheDocument();      // the last board stays up

    const reads = h.calls('GET /orders/active').length;
    await act(async () => { vi.advanceTimersByTime(3100); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => live().open());
    expect(screen.getByRole('status')).toHaveTextContent('Live');
    await waitFor(() => expect(h.calls('GET /orders/active').length).toBeGreaterThan(reads));
  });
});

describe('station screen — marking a ticket ready', () => {
  it('sends this station\'s ready to the hub with the device token, and the ticket leaves the board', async () => {
    setToken('b'.repeat(64));
    const ready = markStationReady(MIXED, 'bar', new Date().toISOString());
    const h = await show('bar', { 'POST /orders/a/stations/bar/ready': { body: { success: true, ticket: ready.ticket, ticket_ready: false, station: 'bar' } } });
    await userEvent.click(await screen.findByRole('button', { name: /Mark ticket 142 ready at the Bar/ }));

    const calls = h.calls('POST /orders/a/stations/bar/ready');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${'b'.repeat(64)}`);
    await waitFor(() => expect(screen.queryByRole('article', { name: /Ticket 142/ })).not.toBeInTheDocument());
  });

  it('cannot be double-tapped: the button is disabled while the hub is answering', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const ready = markStationReady(MIXED, 'bar', new Date().toISOString());
    const h = await show('bar', { 'POST /orders/a/stations/bar/ready': async () => { await gate; return { body: { success: true, ticket: ready.ticket } }; } });
    const button = await screen.findByRole('button', { name: /Mark ticket 142 ready/ });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    release();
    await waitFor(() => expect(screen.queryByRole('article', { name: /Ticket 142/ })).not.toBeInTheDocument());
    expect(h.calls('POST /orders/a/stations/bar/ready')).toHaveLength(1);
  });

  it('when the hub refuses, says why and reads the tickets again, in case someone else just did it', async () => {
    const h = await show('bar', { 'POST /orders/a/stations/bar/ready': { status: 409, body: { success: false, code: 'NOTHING_TO_MARK', error: 'There is nothing for the bar station to mark ready on this ticket.' } } });
    const before = h.calls('GET /orders/active').length;
    await userEvent.click(await screen.findByRole('button', { name: /Mark ticket 142 ready/ }));
    expect(await screen.findByText('There is nothing for the bar station to mark ready on this ticket.')).toBeInTheDocument();
    await waitFor(() => expect(h.calls('GET /orders/active').length).toBeGreaterThan(before));
  });

  it('when the hub cannot be reached, the ticket stays and says it was not marked', async () => {
    await show('bar', { 'POST /orders/a/stations/bar/ready': new TypeError('Failed to fetch') });
    await userEvent.click(await screen.findByRole('button', { name: /Mark ticket 142 ready/ }));
    expect(await screen.findByText(/That was not marked ready/)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Ticket 142/ })).toBeInTheDocument();
  });

  it('a revoked device is sent back to enrol, rather than failing silently on every tap', async () => {
    setToken('c'.repeat(64));
    await show('bar', { 'POST /orders/a/stations/bar/ready': { status: 401, body: { error: 'Unauthorised' } } });
    await userEvent.click(await screen.findByRole('button', { name: /Mark ticket 142 ready/ }));
    expect(await screen.findByLabelText('Enrollment code')).toBeInTheDocument();
    expect(getToken()).toBeFalsy();
  });
});

describe('station screen — sound', () => {
  it('stays quiet for the tickets already there when it opens', async () => {
    await show('bar');
    await connect();
    act(() => live().receive({ type: 'TICKET_UPDATED', payload: { ticket: MIXED } }));
    expect(playChime).not.toHaveBeenCalled();
  });

  it('plays when new work arrives for this station, if sound is on', async () => {
    await show('bar');
    await connect();
    await userEvent.click(screen.getByRole('button', { name: 'Turn the new-ticket sound on' }));
    vi.mocked(playChime).mockClear();                     // turning it on plays a sample, which is not what is under test

    act(() => live().receive({ type: 'NEW_ORDER', payload: make([line('Chai', 'bar')], { id: 'n1', n: 300 }) }));
    await screen.findByRole('article', { name: /Ticket 300/ });
    expect(playChime).toHaveBeenCalledTimes(1);
  });

  it('does not play for work that belongs to another station', async () => {
    await show('bar');
    await connect();
    await userEvent.click(screen.getByRole('button', { name: 'Turn the new-ticket sound on' }));
    vi.mocked(playChime).mockClear();
    act(() => live().receive({ type: 'NEW_ORDER', payload: make([line('Dal', 'hot')], { id: 'n2', n: 301 }) }));
    expect(playChime).not.toHaveBeenCalled();
  });

  it('does not play when sound is off, but still shows the ticket', async () => {
    await show('bar');
    await connect();
    act(() => live().receive({ type: 'NEW_ORDER', payload: make([line('Chai', 'bar')], { id: 'n3', n: 302 }) }));
    expect(await screen.findByRole('article', { name: /Ticket 302/ })).toBeInTheDocument();
    expect(playChime).not.toHaveBeenCalled();
  });

  it('remembers the choice for next time', async () => {
    await show('bar');
    await userEvent.click(screen.getByRole('button', { name: 'Turn the new-ticket sound on' }));
    expect(screen.getByRole('button', { name: 'Turn the new-ticket sound off' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('kullina_station_sound')).toBe('on');
  });
});

describe('station screen — connecting a tablet', () => {
  it('a tablet the hub does not know is asked for the code once, and nothing else is shown', async () => {
    hub = fakeHub({ 'GET /orders/active': { status: 401, body: { error: 'Unauthorised' } } });
    render(<StationScreen station="bar" />);
    expect(await screen.findByLabelText('Enrollment code')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bar screen' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('typing the code enrols the tablet under its station\'s name, then shows the board', async () => {
    let reads = 0;
    hub = fakeHub({
      'GET /orders/active': () => (++reads === 1 ? { status: 401, body: {} } : { body: { tickets: [MIXED] } }),
      'POST /auth/device': { body: { success: true, device_token: 'd'.repeat(64) } }
    });
    render(<StationScreen station="bar" />);
    await userEvent.type(await screen.findByLabelText('Enrollment code'), 'kit123');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(hub.calls('POST /auth/device')[0].body).toEqual({ enrollment_code: 'KIT123', device_label: 'Bar screen', scope: 'kitchen' });
    expect(await screen.findByRole('article', { name: /Ticket 142/ })).toBeInTheDocument();
    expect(getToken()).toBe('d'.repeat(64));
  });

  it('a wrong code says so and stays on the form', async () => {
    hub = fakeHub({
      'GET /orders/active': { status: 401, body: {} },
      'POST /auth/device': { status: 401, body: { error: 'That enrollment code is not right.' } }
    });
    render(<StationScreen station="hot" />);
    await userEvent.type(await screen.findByLabelText('Enrollment code'), 'WRONG1');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That enrollment code is not right.');
    expect(screen.getByLabelText('Enrollment code')).toBeInTheDocument();
  });

  it('scanning the station\'s QR enrols without typing anything: the code is in the address', async () => {
    window.history.replaceState(null, '', '/station/bar#e=SCAN1234');
    let reads = 0;
    hub = fakeHub({
      'GET /orders/active': () => (++reads === 1 ? { body: { tickets: [] } } : { body: { tickets: [MIXED] } }),
      'POST /auth/device': { body: { success: true, device_token: 'e'.repeat(64) } }
    });
    render(<StationScreen station="bar" />);
    await screen.findByRole('heading', { level: 1, name: 'Bar' });
    expect(hub.calls('POST /auth/device')[0].body).toMatchObject({ enrollment_code: 'SCAN1234', scope: 'kitchen' });
    expect(window.location.hash).toBe('', 'the code is taken out of the address bar so it is not left in history');
  });

  it('the reception laptop itself needs no code: it is simply let in', async () => {
    await show('bar');
    expect(screen.queryByLabelText('Enrollment code')).not.toBeInTheDocument();
    expect(show).toBeDefined();
  });

  it('an unreachable hub says so and does not pretend the board is empty', async () => {
    hub = fakeHub({ 'GET /orders/active': new TypeError('Failed to fetch') });
    render(<StationScreen station="bar" />);
    // Nothing has ever loaded, so it keeps trying rather than showing "Nothing waiting".
    await waitFor(() => expect(hub.calls('GET /orders/active').length).toBeGreaterThan(0));
    expect(screen.queryByText(/Nothing waiting/)).not.toBeInTheDocument();
  });
});
