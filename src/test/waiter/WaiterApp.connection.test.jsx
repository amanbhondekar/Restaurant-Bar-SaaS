import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { deferred, fakeHub } from '../helpers/fakeHub';
import { clearToken, setToken } from '@/services/hubAuth';

// How the waiter's handset keeps hold of the hub: the first look, the grace period before it says "Off", the
// recovery, being turned away, and the live socket. Everything else the app draws is real; the hub, the clock and
// the socket are faked, and a waiter is already signed in so the floor is what is on screen.

vi.mock('@/context/PosContext', () => ({ usePos: () => ({ currentRestaurant: { name: 'Mejwani', currency: '₹' }, menu: [], tables: [], isMenuUninitialized: false }) }));
vi.mock('../../context/PosContext', () => ({ usePos: () => ({ currentRestaurant: { name: 'Mejwani', currency: '₹' }, menu: [], tables: [], isMenuUninitialized: false }) }));
vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('../../components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/waiter_mobile/QrScannerModal', () => ({ QrScannerModal: () => null }));
vi.mock('../../waiter_mobile/QrScannerModal', () => ({ QrScannerModal: () => null }));

const { WaiterApp } = await import('@/waiter_mobile/WaiterApp');

const T = (id, over = {}) => ({ id, name: `T${id}`, capacity: 4, section: 'Main', status: 'available', ...over });
const PAIRING = { name: 'Test Kitchen', authorised: true };

/** A socket that records itself and lets a test open, message and close it. */
class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.closed = false; FakeSocket.all.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  say(type, payload) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }); }
  drop() { this.onclose?.(); }
}
const live = () => FakeSocket.all.filter(s => !s.closed);

let tables;
let hold = null;   // while set, reads of the floor wait for it: what the screen shows then is only what the socket said
let activeTickets = [];   // what the hub says is on the board
let pairing;
const routes = (over = {}) => ({
  'GET /pairing-info': () => (pairing instanceof Error ? pairing : { body: pairing }),
  'GET /tables': async () => { if (hold) await hold.promise; return tables instanceof Error ? tables : { body: { tables, sections: ['Main'] } }; },
  'GET /orders/active': () => ({ body: { tickets: activeTickets } }),
  'GET /menu': { body: { items: [], categories: [] } },
  ...over
});
const setup = (over = {}) => {
  const hub = fakeHub(routes(over));
  const view = render(<WaiterApp />);
  return { hub, ...view };
};
const badge = () => screen.getByText(/^(LAN|Off|Code|…)$/);
const card = name => screen.getByText(name, { selector: '.typography-title-md' }).closest('.table-card');
const tick = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  // jsdom has no matchMedia, which the reduced-motion check asks for.
  window.matchMedia ??= query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeSocket.all = [];
  hold = null;
  activeTickets = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  localStorage.clear();
  setToken('test-device-token');   // an enrolled handset
  localStorage.setItem('kullina_waiter_session', JSON.stringify({ id: 'w_1', name: 'Asha' }));
  localStorage.setItem('mejwani_hub_url', 'http://hub.local:4000');
  tables = [T(1), T(2, { status: 'occupied' })];
  pairing = PAIRING;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearToken(); localStorage.clear(); });

describe('waiter app — reaching the hub', () => {
  it('looks at the hub straight away, says LAN, and fills the floor from it', async () => {
    const { hub } = setup();
    expect(await screen.findByText('LAN')).toBeInTheDocument();
    expect(await screen.findByText('T1', { selector: '.typography-title-md' })).toBeInTheDocument();
    expect(card('T2')).toHaveTextContent('Dining');
    for (const key of ['GET /pairing-info', 'GET /tables', 'GET /orders/active', 'GET /menu']) expect(hub.calls(key).length).toBeGreaterThan(0);
    expect(hub.calls('GET /tables')[0].url.origin).toBe('http://hub.local:4000');
  });

  it('keeps asking every five seconds without re-reading the whole floor each time', async () => {
    const { hub } = setup();
    await screen.findByText('LAN');
    const floorReads = hub.calls('GET /tables').length;
    const pings = hub.calls('GET /pairing-info').length;
    await tick(10500);
    expect(hub.calls('GET /pairing-info').length).toBeGreaterThanOrEqual(pings + 2);
    expect(hub.calls('GET /tables').length).toBe(floorReads);   // the socket and reconnects carry changes; the ping only checks
  });

  it('shows a dot while it first looks, not Off', () => {
    pairing = new Error('slow');
    setup();
    expect(badge()).toHaveTextContent('…');
  });
});

describe('waiter app — when the hub goes quiet', () => {
  it('waits out a grace period and two failures before saying Off, so one dropped packet is not an outage', async () => {
    pairing = new TypeError('fetch failed');
    tables = new TypeError('fetch failed');
    setup();
    await tick(100);
    expect(badge()).toHaveTextContent('…');          // one failure, still in the grace period
    await tick(5200);                                 // the grace period is over and it has failed again
    await waitFor(() => expect(badge()).toHaveTextContent('Off'));
    expect(screen.getByText('No tables loaded')).toBeInTheDocument();
  });

  it('after the first moments, one missed check is enough to say Off: the grace period is for start-up only', async () => {
    setup();
    await screen.findByText('LAN');
    await tick(3500);
    pairing = new TypeError('fetch failed');
    await tick(5100);
    await waitFor(() => expect(badge()).toHaveTextContent('Off'));
  });

  it('comes back by itself, and reads the floor again because it may have changed while it was away', async () => {
    const { hub } = setup();
    await screen.findByText('LAN');
    await tick(3500);
    pairing = new TypeError('down');
    await tick(10300);
    await waitFor(() => expect(badge()).toHaveTextContent('Off'));
    const before = hub.calls('GET /tables').length;

    tables = [T(1, { status: 'ready' })];
    pairing = PAIRING;
    await tick(5200);
    await waitFor(() => expect(badge()).toHaveTextContent('LAN'));
    await waitFor(() => expect(card('T1')).toHaveTextContent('Bill Ready'));
    expect(hub.calls('GET /tables').length).toBeGreaterThan(before);
  });

  it('a miss is forgiven the moment the hub answers again', async () => {
    setup();
    await screen.findByText('LAN');
    await tick(3500);
    pairing = new TypeError('blip');
    await tick(5100);
    await waitFor(() => expect(badge()).toHaveTextContent('Off'));
    pairing = PAIRING;
    await tick(5100);
    await waitFor(() => expect(badge()).toHaveTextContent('LAN'));
  });
});

describe('waiter app — being turned away', () => {
  it('says Code, and why, when the hub will not trust this handset yet', async () => {
    clearToken();   // a handset that has never enrolled
    pairing = { name: 'Test Kitchen', authorised: false };
    setup();
    await waitFor(() => expect(badge()).toHaveTextContent('Code'));
    expect(screen.getByText(/Handset not enrolled/)).toBeInTheDocument();
  });

  it('a tablet that was set up as a kitchen screen is not an enrolled handset, whatever the hub says about the token', async () => {
    pairing = { name: 'Test Kitchen', authorised: true, device_scope: 'kitchen' };
    setup();
    await waitFor(() => expect(badge()).toHaveTextContent('Code'));
    expect(screen.getByText(/Handset not enrolled/)).toBeInTheDocument();
  });

  it('a hub that answers 403 for the floor turns the handset away too: the cure is to enrol as a handset', async () => {
    tables = new Error('placeholder');
    setup({ 'GET /tables': { status: 403, body: { success: false, code: 'DEVICE_SCOPE' } } });
    await waitFor(() => expect(badge()).toHaveTextContent('Code'));
  });

  it('a 401 for the floor does the same', async () => {
    setup({ 'GET /tables': { status: 401, body: { success: false } } });
    await waitFor(() => expect(badge()).toHaveTextContent('Code'));
  });

  it('a 401 for the open orders does the same, even when the floor and the menu are answered', async () => {
    setup({ 'GET /orders/active': { status: 401, body: { success: false } } });
    await waitFor(() => expect(badge()).toHaveTextContent('Code'));
  });

  it('a handset that holds a token is not turned away on the hub\'s pairing answer alone: the routes that carry data decide', async () => {
    pairing = { name: 'Test Kitchen', authorised: false };   // the token is stale for this check, but the floor still answers
    setup();
    await waitFor(() => expect(badge()).toHaveTextContent('LAN'));
    expect(card('T1')).toBeInTheDocument();
  });
});

describe('waiter app — the live socket', () => {
  // Opens the app and waits until the reads the hub coming up started have finished, so nothing in flight can
  // correct (or overwrite) what a test sends down the socket.
  // Opens the app and waits until the reads the hub coming up started have finished. Every socket event starts a
  // read of the floor and the hub's answer then wins, so to see what the event ITSELF did, hold those reads open.
  const open = async ({ holdReads = false } = {}) => {
    const ctx = setup();
    await screen.findByText('LAN');
    await waitFor(() => expect(live()).toHaveLength(1));
    let last = -1;
    for (let i = 0; i < 40 && ctx.hub.calls('GET /tables').length !== last; i++) {
      last = ctx.hub.calls('GET /tables').length;
      await tick(150);
    }
    await tick(300);
    if (holdReads) hold = deferred();
    return { ...ctx, ws: live()[0] };
  };
  const release = async () => { const h = hold; hold = null; await act(async () => { h.resolve(); }); await tick(100); };

  it('listens on /live at the hub it is talking to, and reads the floor when it opens', async () => {
    const { hub, ws } = await open();
    expect(ws.url).toMatch(/^ws:\/\/hub\.local:4000\/live/);
    const before = hub.calls('GET /tables').length;
    await act(async () => ws.open());
    expect(hub.calls('GET /tables').length).toBeGreaterThan(before);
  });

  it('a ticket that is ready turns that table to Bill Ready at once, and the hub then has the last word', async () => {
    const { ws } = await open({ holdReads: true });
    await screen.findByText('T2', { selector: '.typography-title-md' });
    await act(async () => ws.say('TICKET_READY', { table_id: 2, ticket_id: 't_9' }));
    expect(card('T2')).toHaveTextContent('Bill Ready');          // before any answer from the hub

    tables = [T(1), T(2, { status: 'ready' }), T(3)];            // and the hub's own view arrives with a table the event knew nothing of
    await release();
    expect(card('T2')).toHaveTextContent('Bill Ready');
    expect(card('T3')).toBeInTheDocument();
  });

  it('an order announced twice is listed once for its table, where the waiter can cancel it', async () => {
    const { ws } = await open({ holdReads: true });
    await screen.findByText('T1', { selector: '.typography-title-md' });
    const ticket = { id: 't_1', ticket_number: 101, table_id: 1, table_name: 'T1', total_amount: 240, status: 'in_progress', items: [{ name: 'Dal', qty: 1 }] };
    await act(async () => ws.say('NEW_ORDER', { ticket }));
    await act(async () => ws.say('order_created', { ticket }));
    await userEvent.click(card('T1'));
    const sent = screen.getByLabelText('Orders sent to the kitchen');
    expect(within(sent).getAllByText(/#101/)).toHaveLength(1);
    await release();
  });

  it('an order the floor read already includes is not added to its table again when its event arrives', async () => {
    const ticket = { id: 't_1', ticket_number: 101, table_id: 1, total_amount: 240, status: 'in_progress' };
    tables = [T(1, { status: 'kot', activeOrderTotal: 240 })];
    activeTickets = [ticket];                         // the hub's own read already has it in the table's 240
    const { ws } = await open({ holdReads: true });
    await screen.findByText('T1', { selector: '.typography-title-md' });
    expect(card('T1')).toHaveTextContent('₹240');
    await act(async () => ws.say('NEW_ORDER', { ticket }));
    expect(card('T1')).toHaveTextContent('₹240');     // not 480
    await release();
  });

  it('each event starts a fresh read of the floor', async () => {
    const { hub, ws } = await open();
    const before = hub.calls('GET /tables').length;
    await act(async () => ws.say('NEW_ORDER', { ticket: { id: 't_1', ticket_number: 101, table_id: 1, total_amount: 240 } }));
    await act(async () => ws.say('TICKET_READY', { table_id: 2, ticket_id: 't_9' }));
    expect(hub.calls('GET /tables').length).toBe(before + 2);
  });

  it('an older read of the floor that lands after a newer one is ignored', async () => {
    // Every event starts a read, so two can be in flight, and nothing says they land in order. The newer read has
    // the "bill ready" in it; the older one, landing last, must not put the table back to Dining.
    let held = null;   // { promise, body }: reads made while this is set are answered, late, with the answer as of then
    const { ws } = await (async () => {
      const ctx = setup({
        'GET /tables': async () => {
          const mine = held;
          if (mine) { await mine.promise; return { body: mine.body }; }
          return { body: { tables: JSON.parse(JSON.stringify(tables)), sections: ['Main'] } };
        }
      });
      await screen.findByText('LAN');
      await waitFor(() => expect(live()).toHaveLength(1));
      await tick(300);
      return { ...ctx, ws: live()[0] };
    })();
    await screen.findByText('T2', { selector: '.typography-title-md' });

    const stale = deferred();
    held = { promise: stale.promise, body: { tables: JSON.parse(JSON.stringify(tables)), sections: ['Main'] } };   // T2 still Dining
    await act(async () => ws.open());                                              // a read begins, and is held
    tables = [T(1), T(2, { status: 'ready' })];                                    // meanwhile the kitchen finishes
    held = null;
    await act(async () => ws.say('TICKET_READY', { table_id: 2, ticket_id: 't_9' }));
    expect(card('T2')).toHaveTextContent('Bill Ready');

    await act(async () => { stale.resolve(); });                                   // the old answer lands
    await tick(300);
    expect(card('T2')).toHaveTextContent('Bill Ready');
  });

  it('a new order puts the table in the kitchen and adds its total to the bill', async () => {
    const { ws } = await open({ holdReads: true });
    await screen.findByText('T1', { selector: '.typography-title-md' });
    await act(async () => ws.say('NEW_ORDER', { ticket: { id: 't_1', ticket_number: 101, table_id: 1, total_amount: 240 } }));
    expect(card('T1')).toHaveTextContent('In Kitchen');
    expect(card('T1')).toHaveTextContent('₹240');
    await act(async () => ws.say('order_created', { ticket: { id: 't_2', ticket_number: 102, table_id: 1, total_amount: 60 } }));
    expect(card('T1')).toHaveTextContent('₹300');
    await release();
  });

  it('the same new order told twice is not added twice', async () => {
    const { ws } = await open({ holdReads: true });
    await screen.findByText('T1', { selector: '.typography-title-md' });
    const ticket = { id: 't_1', ticket_number: 101, table_id: 1, total_amount: 240 };
    await act(async () => ws.say('NEW_ORDER', { ticket }));
    await act(async () => ws.say('order_created', { ticket }));
    expect(card('T1')).toHaveTextContent('₹240');
    expect(card('T1')).not.toHaveTextContent('₹480');
    await release();
  });

  it('a table whose bill is ready stays ready when another order arrives for it', async () => {
    tables = [T(1, { status: 'ready', activeOrderTotal: 100 })];
    const { ws } = await open({ holdReads: true });
    await screen.findByText('T1', { selector: '.typography-title-md' });
    await act(async () => ws.say('NEW_ORDER', { ticket: { id: 't_3', ticket_number: 103, table_id: 1, total_amount: 50 } }));
    expect(card('T1')).toHaveTextContent('Bill Ready');
    expect(card('T1')).toHaveTextContent('₹150');
    await release();
  });

  it('clearing a table opens it again and resets its total and its time', async () => {
    tables = [T(1, { status: 'ready', activeOrderTotal: 100, occupiedSince: '2026-10-22T10:00:00.000Z' })];
    const { ws } = await open({ holdReads: true });
    await screen.findByText('T1', { selector: '.typography-title-md' });
    expect(card('T1')).toHaveTextContent('₹100');
    await act(async () => ws.say('CLEAR_TABLE', { table_id: 1 }));
    expect(card('T1')).toHaveTextContent('Open');
    expect(card('T1')).not.toHaveTextContent('₹100');
    expect(card('T1')).not.toHaveTextContent(/\dm$|Just in/);
    await release();
  });

  it('takes no notice of a message it cannot read, or one it does not know', async () => {
    const { ws } = await open();
    await screen.findByText('T1', { selector: '.typography-title-md' });
    await act(async () => { ws.onmessage({ data: 'not json' }); ws.say('SOMETHING_NEW', { table_id: 1 }); ws.onmessage({ data: JSON.stringify({ payload: {} }) }); });
    expect(card('T1')).toHaveTextContent('Open');
  });

  it('opens a fresh socket four seconds after one drops', async () => {
    const { ws } = await open();
    await act(async () => ws.drop());
    expect(FakeSocket.all).toHaveLength(1);
    await tick(3900);
    expect(FakeSocket.all).toHaveLength(1);
    await tick(200);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('closes its socket when the app goes away, and a reconnect timer already waiting does not open a new one', async () => {
    // The socket drops, a reconnect is scheduled, and then the app unmounts (or the hub's address changes) before
    // the timer fires. The timer must not open a socket that nothing will ever close.
    const { ws, unmount } = await open();
    await act(async () => ws.drop());
    unmount();
    await tick(4500);
    expect(FakeSocket.all).toHaveLength(1);
    expect(live()).toHaveLength(0);
  });
});
