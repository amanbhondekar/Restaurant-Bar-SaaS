import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { deferred, fakeHub } from '../helpers/fakeHub';
import { initCourseState, markStationReady } from '../../../hub_server/lib/courses.js';

// The reception Kitchen Display, the real component against a fake hub and a fake socket: the board, the station
// tabs, held courses, how it says the hub is gone, and the bill from preview to paid, split, voided and refunded.
// What it sends the hub is asserted exactly, since that is where a wrong bill would come from; the arithmetic
// itself is the hub's, and has its own tests.

// The whole page renders in every test, and the first bill modal is the slowest thing in it. A machine busy with
// something else should not turn a slow render into a failure, so waits get four seconds instead of one.
configure({ asyncUtilTimeout: 4000 });

vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('../../components/ThemeToggle', () => ({ ThemeToggle: () => null }));

const { KitchenHubApp } = await import('../../kitchen_main.jsx');

const NOW = '2026-10-23T09:00:00.000Z';
const DAL = { id: 'dal', name: 'Dal', qty: 2, station: 'hot', course: 1 };
const CHAI = { id: 'tea', name: 'Chai', qty: 1, station: 'bar', course: 1 };
const KHEER = { id: 'kheer', name: 'Kheer', qty: 1, station: 'cold', course: 2 };

const ticket = (id, number, items, over = {}) => ({
  id, ticket_number: number, table_id: number - 100, table_name: `T${number - 100}`, status: 'in_progress',
  created_by_waiter: 'Asha', note: '', synced_to_cloud: false, items, created_at: NOW, updated_at: NOW,
  ...initCourseState(items, { staged: over.staged === true }, NOW), ...over
});
const T1 = () => ticket('t1', 101, [DAL, CHAI], { note: 'No onion' });

const LINES = [{ ticket_number: 101, name: 'Dal', qty: 2, price: 100, line_total: 200 }];
const TAX = [{ label: 'CGST', rate_percent: 2.5, amount: 5 }, { label: 'SGST', rate_percent: 2.5, amount: 5 }];
const preview = over => ({
  table_name: 'T1', currency: '₹', items: LINES, subtotal: 200, discount_rows: [], discount_total: 0,
  service_charge_percent: 0, service_charge_amount: 0, tax_rows: TAX, grand_total: 210, ...over
});
const issued = over => preview({ id: 'inv_1', invoice_number: 'INV-000001', payment_status: 'pending', ...over });

/** A socket that records itself and lets a test open, message and close it. */
class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.closed = false; FakeSocket.all.push(this); }
  close() { this.closed = true; this.onclose?.(); }
  open() { act(() => this.onopen?.()); }
  say(type, payload) { act(() => this.onmessage?.({ data: JSON.stringify({ type, payload }) })); }
  drop() { act(() => this.onclose?.()); }
}
const socket = () => FakeSocket.all.at(-1);

let board = [];
let sync = { queued: 0, online: true, isSyncing: false };
const routes = (over = {}) => ({
  'GET /pairing-info': { body: { name: 'Mejwani', pairing_code: 'MEJ-0001', server_url: 'http://192.168.1.5:4000' } },
  'GET /qr': { body: { qr_code: 'data:image/png;base64,AAAA', enrollment_code: 'ENR12345' } },
  'GET /orders/active': () => ({ body: { tickets: board } }),
  'GET /sync-status': () => ({ body: sync }),
  ...over
});
const setup = (over = {}) => {
  const hub = fakeHub(routes(over));
  render(<KitchenHubApp />);
  return hub;
};
const user = () => userEvent.setup();
const tab = name => screen.getByRole('tab', { name: new RegExp(name) });

beforeEach(() => {
  // jsdom has no matchMedia. Reduced motion is on so nothing waits for an animation to finish.
  window.matchMedia = query => ({ matches: /reduce/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  localStorage.clear();
  board = [T1()];
  sync = { queued: 0, online: true, isSyncing: false };
});
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe('the page itself', () => {
  // The suite runs with CSS switched off, so a page that stopped loading its stylesheet would still pass every other test
  // here and come up as unstyled text on the reception laptop. This was found by looking at it in a browser, after the
  // component was split into files and the import went with the code that had surrounded it.
  it('still loads its stylesheet, and the kitchen\'s own components are the files it says they are', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(__dirname, '../../kitchen_main.jsx'), 'utf8');
    expect(source).toMatch(/^import '\.\/index\.css';$/m);
    for (const [, file] of source.matchAll(/from '\.\/kitchen\/([A-Za-z]+)'/g)) {
      expect(existsSync(resolve(__dirname, `../../kitchen/${file}.jsx`)) || existsSync(resolve(__dirname, `../../kitchen/${file}.js`)), file).toBe(true);
    }
  });
});

describe('the board', () => {
  it('shows who it is connected to, the pairing details and what is on the board', async () => {
    const hub = setup();
    expect(await screen.findByText('Mejwani (MEJ-0001)')).toBeInTheDocument();
    expect(await screen.findByText('ENR12345')).toBeInTheDocument();
    expect(screen.getByAltText('Waiter App Pairing QR')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(screen.getByText(/192\.168\.1\.5:4000\/waiter/)).toBeInTheDocument();

    expect(await screen.findByText('TICKET #101')).toBeInTheDocument();
    expect(screen.getByText('T1')).toBeInTheDocument();
    expect(screen.getByText('Dal')).toBeInTheDocument();
    expect(screen.getByText('Chai')).toBeInTheDocument();
    expect(screen.getByText('No onion')).toBeInTheDocument();
    expect(screen.getByText('By Asha')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE KOTS').previousSibling).toHaveTextContent('1');
    expect(screen.getByText('READY TO SERVE').previousSibling).toHaveTextContent('0');
    // The page is served from the hub's own port, or is told it.
    expect(hub.calls('GET /orders/active')[0].url.origin).toBe('http://localhost:4000');
  });

  it('says so when nothing is on the board', async () => {
    board = [];
    setup();
    expect(await screen.findByText('Kitchen Rail Clear')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Live Order Tickets (0)' })).toBeInTheDocument();
  });

  it('keeps a line\'s station and a ticket\'s other stations visible, and an extra only when the dish was routed off the hot line', async () => {
    setup();
    await screen.findByText('TICKET #101');
    expect(screen.getByText('BAR')).toBeInTheDocument();          // Chai is routed to the bar
    expect(screen.queryByText('HOT')).not.toBeInTheDocument();    // curries do not get a tag on every ticket
    expect(screen.getAllByText(/^Hot line$|^Bar$/).length).toBeGreaterThan(0);   // where each station stands
  });

  it('will not mark a ticket ready until every line is ticked, then marks it and moves it to Ready to Serve', async () => {
    const hub = setup({ 'POST /orders/t1/ready': { body: { success: true, ticket: { ...T1(), status: 'ready' } } } });
    const u = user();
    await screen.findByText('TICKET #101');

    expect(screen.getByRole('button', { name: 'Tick All' })).toBeDisabled();
    await u.click(screen.getByText('Dal'));
    expect(screen.getByRole('button', { name: 'Tick All' })).toBeDisabled();   // one of two
    await u.click(screen.getByText('Chai'));
    const mark = screen.getByRole('button', { name: /Mark Ready/ });
    expect(mark).toBeEnabled();
    await u.click(mark);

    expect(await screen.findByText('Ready to Serve (1)')).toBeInTheDocument();
    expect(screen.getByText('Ticket #101 · Ready')).toBeInTheDocument();
    expect(hub.calls('POST /orders/t1/ready')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Live Order Tickets (0)' })).toBeInTheDocument();
    expect(screen.getByText('READY TO SERVE').previousSibling).toHaveTextContent('1');
  });

  it('ticking a line twice un-ticks it', async () => {
    setup();
    const u = user();
    await screen.findByText('TICKET #101');
    await u.click(screen.getByText('Dal'));
    await u.click(screen.getByText('Chai'));
    expect(screen.getByRole('button', { name: /Mark Ready/ })).toBeEnabled();
    await u.click(screen.getByText('Chai'));
    expect(screen.getByRole('button', { name: 'Tick All' })).toBeDisabled();
  });

  it('a ticked line is struck through and an unticked one is not', async () => {
    setup();
    const u = user();
    await screen.findByText('TICKET #101');
    const row = name => screen.getByText(name).closest('div[style*="cursor"]');
    expect(row('Dal').style.textDecoration).toBe('none');
    await u.click(screen.getByText('Dal'));
    expect(row('Dal').style.textDecoration).toBe('line-through');
    expect(row('Chai').style.textDecoration).toBe('none');
    await u.click(screen.getByText('Dal'));
    expect(row('Dal').style.textDecoration).toBe('none');
  });

  it('shows no Ready to Serve section while nothing is ready', async () => {
    setup();
    await screen.findByText('TICKET #101');
    expect(screen.queryByText(/Ready to Serve/)).not.toBeInTheDocument();
  });

  it('Refresh reads the board and the sync status again', async () => {
    const hub = setup();
    await screen.findByText('TICKET #101');
    const tickets = hub.calls('GET /orders/active').length;
    const syncs = hub.calls('GET /sync-status').length;
    board = [T1(), ticket('t2', 102, [KHEER])];
    sync = { queued: 4, online: true, isSyncing: false };
    await user().click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('TICKET #102')).toBeInTheDocument();
    expect(await screen.findByText('Cloud Queue (4)')).toBeInTheDocument();
    expect(hub.calls('GET /orders/active').length).toBe(tickets + 1);
    expect(hub.calls('GET /sync-status').length).toBe(syncs + 1);
  });

  it('puts a ticket marked ready back on the board with Recall', async () => {
    board = [{ ...T1(), status: 'ready' }];
    const hub = setup({ 'POST /orders/t1/recall': { body: { success: true, ticket: T1() } } });
    const u = user();
    await screen.findByText('Ready to Serve (1)');
    await u.click(screen.getByRole('button', { name: /Recall/ }));
    expect(await screen.findByText('TICKET #101')).toBeInTheDocument();
    expect(screen.queryByText('Ready to Serve (1)')).not.toBeInTheDocument();
    expect(hub.calls('POST /orders/t1/recall')).toHaveLength(1);
  });

  it('lists a ticket that is on the board but whose table is unknown without a bill button that does anything', async () => {
    board = [ticket('t9', 109, [DAL], { table_id: null, table_name: undefined })];
    setup();
    await screen.findByText('TICKET #109');
    expect(screen.getByRole('button', { name: /Bill/ })).toBeDisabled();
    expect(screen.getByText('Table')).toBeInTheDocument();
  });
});

describe('station screens', () => {
  it('a station tab shows only that station\'s lines, counts and a ready button of its own', async () => {
    const reply = markStationReady(T1(), 'bar', NOW).ticket;
    const hub = setup({ 'POST /orders/t1/stations/bar/ready': { body: { success: true, ticket: reply } } });
    const u = user();
    await screen.findByText('TICKET #101');
    expect(tab('All stations')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Bar')).toHaveTextContent('1');

    await u.click(tab('Bar'));
    expect(screen.getByRole('heading', { name: 'Bar (1)' })).toBeInTheDocument();
    expect(screen.getByText('Chai')).toBeInTheDocument();
    expect(screen.queryByText('Dal')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tick All' })).toBeDisabled();

    await u.click(screen.getByText('Chai'));
    await u.click(screen.getByRole('button', { name: 'Bar ready' }));
    expect(hub.calls('POST /orders/t1/stations/bar/ready')).toHaveLength(1);
    expect(await screen.findByText('Bar is clear')).toBeInTheDocument();   // the bar has nothing left to cook on it

    await u.click(tab('Hot line'));
    expect(screen.getByText('Dal')).toBeInTheDocument();   // the hot line still has its part
  });

  it('remembers the station on the device, and in the address', async () => {
    setup();
    const u = user();
    await screen.findByText('TICKET #101');
    await u.click(tab('Cold line'));
    expect(localStorage.getItem('kullina_kds_station')).toBe('cold');
    expect(window.location.search).toContain('station=cold');
    await u.click(tab('All stations'));
    expect(window.location.search).not.toContain('station=');
  });

  it('a station screen opened as ?station=bar starts on the bar', async () => {
    window.history.replaceState(null, '', '/?station=bar');
    setup();
    expect(await screen.findByRole('heading', { name: 'Bar (1)' })).toBeInTheDocument();
    expect(tab('Bar')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('courses', () => {
  const STAGED = () => ticket('t1', 101, [DAL, KHEER], { staged: true });

  it('shows what is held back and lets reception fire it, but not on a station screen', async () => {
    board = [STAGED()];
    const hub = setup({ 'POST /orders/t1/fire': { body: { success: true, ticket: { ...STAGED(), ...initCourseState([DAL, KHEER], { staged: false }, NOW) } } } });
    const u = user();
    await screen.findByText('TICKET #101');
    expect(screen.getByText('On hold: course 2 (1)')).toBeInTheDocument();
    expect(screen.getByText('Course 1')).toBeInTheDocument();

    await u.click(tab('Hot line'));
    expect(screen.getByText('On hold: course 2 (1)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fire course/ })).not.toBeInTheDocument();

    await u.click(tab('All stations'));
    await u.click(screen.getByRole('button', { name: /Fire course 2/ }));
    expect(hub.calls('POST /orders/t1/fire')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText(/On hold/)).not.toBeInTheDocument());
  });

  it('the next course can be fired from the Ready to Serve list too, and it is Fire and not Recall that is sent', async () => {
    board = [{ ...STAGED(), status: 'ready' }];
    const hub = setup({
      'POST /orders/t1/fire': { body: { success: true, ticket: { ...STAGED(), status: 'in_progress', ...initCourseState([DAL, KHEER], { staged: false }, NOW) } } },
      'POST /orders/t1/recall': { body: { success: true, ticket: STAGED() } }
    });
    await screen.findByText('Ready to Serve (1)');
    await user().click(screen.getByRole('button', { name: /Fire course 2/ }));
    await waitFor(() => expect(hub.calls('POST /orders/t1/fire')).toHaveLength(1));
    expect(hub.calls('POST /orders/t1/recall')).toHaveLength(0);
  });

  it('when the hub refuses, says why and reads the board again so the screen is true', async () => {
    board = [STAGED()];
    const hub = setup({ 'POST /orders/t1/fire': { status: 409, body: { error: 'Course 2 has already been fired.' } } });
    const u = user();
    await screen.findByText('TICKET #101');
    const reads = hub.calls('GET /orders/active').length;
    await u.click(screen.getByRole('button', { name: /Fire course 2/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Course 2 has already been fired.');
    expect(hub.calls('GET /orders/active').length).toBeGreaterThan(reads);
    await u.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the hub is unreachable when the request itself fails', async () => {
    board = [STAGED()];
    setup({ 'POST /orders/t1/fire': new Error('network down') });
    await screen.findByText('TICKET #101');
    await user().click(screen.getByRole('button', { name: /Fire course 2/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Hub unreachable: network down');
  });
});

describe('the live feed', () => {
  it('a new order appears at once, a cancelled one goes, and a cleared table asks the hub what is left', async () => {
    const hub = setup();
    await screen.findByText('TICKET #101');
    socket().open();

    socket().say('NEW_ORDER', ticket('t2', 102, [KHEER]));
    expect(await screen.findByText('TICKET #102')).toBeInTheDocument();
    expect(screen.getByText('ACTIVE KOTS').previousSibling).toHaveTextContent('2');

    const reads = hub.calls('GET /orders/active').length;
    board = [];
    socket().say('TICKET_CANCELLED', { ticket_id: 't2' });
    await waitFor(() => expect(screen.queryByText('TICKET #102')).not.toBeInTheDocument());
    await waitFor(() => expect(hub.calls('GET /orders/active').length).toBeGreaterThan(reads));

    // The hub says the board is empty after a table is cleared.
    socket().say('CLEAR_TABLE', { table_id: 1 });
    expect(await screen.findByText('Kitchen Rail Clear')).toBeInTheDocument();
  });

  it('an order the screen already has is not shown twice', async () => {
    setup();
    await screen.findByText('TICKET #101');
    socket().open();
    socket().say('NEW_ORDER', T1());
    socket().say('order_created', { ticket: T1() });
    expect(screen.getAllByText('TICKET #101')).toHaveLength(1);
  });

  it('a station finishing its part updates the card without a re-read', async () => {
    const hub = setup();
    await screen.findByText('TICKET #101');
    socket().open();
    const reads = hub.calls('GET /orders/active').length;
    socket().say('TICKET_UPDATED', { ticket: markStationReady(T1(), 'bar', NOW).ticket });
    await waitFor(() => expect(screen.getAllByText(/^Bar$/).length).toBeGreaterThan(0));
    expect(hub.calls('GET /orders/active').length).toBe(reads);
  });

  it('shows the sync status the hub reports: queued, synced and local only', async () => {
    setup();
    await screen.findByText('Cloud Synced');
    socket().open();
    socket().say('SYNC_STATUS_CHANGE', { queued: 3, online: true, isSyncing: true });
    expect(await screen.findByText('Cloud Queue (3)')).toBeInTheDocument();
    socket().say('SYNC_STATUS_CHANGE', { queued: 72, online: false, isSyncing: false });
    expect(await screen.findByText('Local Only (72 queued)')).toBeInTheDocument();
  });
});

describe('the connection light', () => {
  const tick = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('connecting at first, active once the socket opens, and red only after it has really failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    expect(await screen.findByText('Connecting…')).toBeInTheDocument();
    socket().open();
    expect(screen.getByText('LAN WiFi Active')).toBeInTheDocument();

    socket().drop();                                  // the first seconds: a hub a moment slow is not an outage
    expect(screen.getByText('Connecting…')).toBeInTheDocument();

    await tick(3100);                                 // it tried again, and the grace period is over
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    socket().drop();                                  // a second failure
    expect(screen.getByText('LAN Disconnected')).toBeInTheDocument();

    await tick(3100);                                 // and it keeps trying
    socket().open();
    expect(screen.getByText('LAN WiFi Active')).toBeInTheDocument();
  });

  it('after the grace period a dropped socket is red at once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await screen.findByText('Connecting…');
    socket().open();
    await tick(3500);
    socket().drop();
    expect(screen.getByText('LAN Disconnected')).toBeInTheDocument();
  });

  it('asks the hub again every ten seconds as a fallback to the socket', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = setup();
    await screen.findByText('TICKET #101');
    const reads = hub.calls('GET /orders/active').length;
    await tick(10500);
    expect(hub.calls('GET /orders/active').length).toBeGreaterThan(reads);
    expect(hub.calls('GET /sync-status').length).toBeGreaterThan(1);
  });
});

describe('the bill', () => {
  const openBill = async (over = {}) => {
    const hub = setup({ 'GET /tables/1/invoice': { body: { invoice: preview() } }, ...over });
    const u = user();
    await screen.findByText('TICKET #101');
    await u.click(screen.getByRole('button', { name: /Bill/ }));
    await screen.findByText('Bill Preview');
    return { hub, u };
  };
  const modal = () => screen.getByText('Bill Preview').closest('div[style*="overflow"]')?.parentElement ?? document.body;

  it('opens a preview of the table\'s bill: the lines, the tax, the grand total, and nothing issued yet', async () => {
    const { hub } = await openBill();
    expect(await screen.findByText('T1 · not yet issued')).toBeInTheDocument();
    expect(await screen.findByText('Grand Total')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Bill · ₹210' })).toBeEnabled();
    expect(screen.getByText('Subtotal').nextSibling).toHaveTextContent('₹200');
    expect(screen.getByText('CGST (2.5%)')).toBeInTheDocument();
    expect(screen.getByText(/₹100 each/)).toBeInTheDocument();
    expect(hub.calls('GET /tables/1/invoice')).toHaveLength(1);
  });

  it('shows the hub\'s own words when there is no bill to show', async () => {
    setup({ 'GET /tables/1/invoice': { status: 404, body: { error: 'No open tickets for this table.' } } });
    await screen.findByText('TICKET #101');
    await user().click(screen.getByRole('button', { name: /Bill/ }));
    expect(await screen.findByText('No open tickets for this table.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close Bill/ })).not.toBeInTheDocument();
  });

  it('says the hub is unreachable when it cannot be asked', async () => {
    setup({ 'GET /tables/1/invoice': new Error('network down') });
    await screen.findByText('TICKET #101');
    await user().click(screen.getByRole('button', { name: /Bill/ }));
    expect(await screen.findByText('Hub unreachable: network down')).toBeInTheDocument();
  });

  it('a discount is sent to the hub to be priced, and the bill shows what the hub answers', async () => {
    const withDiscount = preview({
      discount_rows: [{ type: 'percent', value: 10, reason: 'regular', amount: 20 }], discount_total: 20, grand_total: 189,
      tax_rows: [{ label: 'CGST', rate_percent: 2.5, amount: 4.5 }, { label: 'SGST', rate_percent: 2.5, amount: 4.5 }]
    });
    const { hub, u } = await openBill({ 'POST /tables/1/invoice/preview': { body: { invoice: withDiscount } } });
    const [discount] = screen.getAllByRole('spinbutton');
    await u.type(discount, '10');
    await u.type(screen.getByPlaceholderText('Reason (optional)'), 'regular');

    expect(await screen.findByRole('button', { name: 'Close Bill · ₹189' })).toBeInTheDocument();
    expect(screen.getByText('Discount (10%) · regular')).toBeInTheDocument();
    const last = hub.calls('POST /tables/1/invoice/preview').at(-1);
    expect(last.body).toEqual({ discounts: [{ type: 'percent', value: 10, reason: 'regular' }] });
  });

  it('a flat discount and a service charge are sent as such, and a service charge of 0 is an instruction to waive it', async () => {
    const { hub, u } = await openBill({ 'POST /tables/1/invoice/preview': { body: { invoice: preview() } } });
    await u.selectOptions(screen.getByRole('combobox'), 'flat');
    const [discount, service] = screen.getAllByRole('spinbutton');
    await u.type(discount, '50');
    await u.type(service, '0');
    await waitFor(() => {
      expect(hub.calls('POST /tables/1/invoice/preview').at(-1)?.body).toEqual({ discounts: [{ type: 'flat', value: 50 }], service_charge_percent: 0 });
    });
  });

  it('closing the bill sends the same adjustments and then shows the invoice number awaiting payment', async () => {
    const closed = issued({ discount_rows: [{ type: 'percent', value: 10, amount: 20 }], discount_total: 20, grand_total: 189 });
    const { hub, u } = await openBill({
      'POST /tables/1/invoice/preview': { body: { invoice: preview({ grand_total: 189 }) } },
      'POST /tables/1/clear': { body: { success: true, invoice: closed } }
    });
    await u.type(screen.getAllByRole('spinbutton')[0], '10');
    await screen.findByRole('button', { name: 'Close Bill · ₹189' });
    await u.click(screen.getByRole('button', { name: 'Close Bill · ₹189' }));

    expect(await screen.findByText(/INV-000001 · Awaiting payment/)).toBeInTheDocument();
    expect(hub.calls('POST /tables/1/clear')[0].body).toEqual({ discounts: [{ type: 'percent', value: 10 }] });
    expect(screen.queryByText('Bill adjustments')).not.toBeInTheDocument();   // issued: no longer adjustable
    expect(screen.getByRole('button', { name: 'upi' })).toBeEnabled();
  });

  it('a late preview never replaces a bill that has been issued: close right after typing a discount and the invoice stays on screen', async () => {
    // The preview is recalculated a moment after the last keystroke. If the bill is closed first, that recalculation
    // lands on a table with no open tickets, and the hub (rightly) says there is nothing to preview.
    let closed = false;
    const { hub, u } = await openBill({
      'POST /tables/1/invoice/preview': () => (closed ? { status: 404, body: { error: 'No open tickets for this table.' } } : { body: { invoice: preview() } }),
      'POST /tables/1/clear': () => { closed = true; return { body: { success: true, invoice: issued({ grand_total: 189 }) } }; }
    });
    await u.type(screen.getAllByRole('spinbutton')[0], '10');
    await u.click(screen.getByRole('button', { name: /Close Bill/ }));
    expect(await screen.findByText(/INV-000001 · Awaiting payment/)).toBeInTheDocument();

    await new Promise(r => setTimeout(r, 700));   // longer than the recalculation's delay and a request
    expect(screen.getByText(/INV-000001 · Awaiting payment/)).toBeInTheDocument();
    expect(screen.queryByText('No open tickets for this table.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'upi' })).toBeEnabled();
    expect(hub.calls('POST /tables/1/clear')).toHaveLength(1);
  });

  it('opening a bill asks the hub for its preview once, not once on the click and again from the delayed recalculation', async () => {
    const { hub } = await openBill();
    await new Promise(r => setTimeout(r, 500));   // longer than the recalculation's delay
    expect(hub.calls('GET /tables/1/invoice')).toHaveLength(1);
    expect(hub.calls('POST /tables/1/invoice/preview')).toHaveLength(0);
  });

  it('changing an adjustment still asks again, once the typing has paused, and typing back to nothing asks for the plain bill', async () => {
    const { hub, u } = await openBill({ 'POST /tables/1/invoice/preview': { body: { invoice: preview() } } });
    const [discount] = screen.getAllByRole('spinbutton');
    await u.type(discount, '7');
    await waitFor(() => expect(hub.calls('POST /tables/1/invoice/preview')).toHaveLength(1));
    await u.clear(discount);
    await waitFor(() => expect(hub.calls('GET /tables/1/invoice')).toHaveLength(2));   // nothing adjusted: the plain bill
    await new Promise(r => setTimeout(r, 400));
    expect(hub.calls('POST /tables/1/invoice/preview')).toHaveLength(1);
  });

  it('does not even ask for a preview once the bill is closed: nothing is recalculated after the close', async () => {
    let previews = 0;
    let atClose = -1;
    await openBill({
      'POST /tables/1/invoice/preview': () => { previews += 1; return { body: { invoice: preview() } }; },
      'POST /tables/1/clear': () => { atClose = previews; return { body: { success: true, invoice: issued() } }; }
    });
    await user().type(screen.getAllByRole('spinbutton')[0], '5');
    await user().click(screen.getByRole('button', { name: /Close Bill/ }));
    await screen.findByText(/Awaiting payment/);
    await new Promise(r => setTimeout(r, 600));
    expect(atClose).toBeGreaterThanOrEqual(0);
    expect(previews).toBe(atClose);
  });

  it('while a preview is on its way the Close button is disabled, so a close cannot overtake it', async () => {
    const held = deferred();
    const { hub, u } = await openBill({
      'POST /tables/1/invoice/preview': async () => { await held.promise; return { body: { invoice: preview({ grand_total: 199 }) } }; }
    });
    await u.type(screen.getAllByRole('spinbutton')[0], '10');
    await waitFor(() => expect(hub.calls('POST /tables/1/invoice/preview')).toHaveLength(1));   // asked, not answered
    expect(await screen.findByText('Fetching latest bill from hub…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close Bill/ })).toBeDisabled();
    held.resolve();
    expect(await screen.findByRole('button', { name: 'Close Bill · ₹199' })).toBeEnabled();
  });

  it('opening a bill after another was issued asks for its preview straight away, not after the delay', async () => {
    const { hub, u } = await openBill({ 'POST /tables/1/clear': { body: { success: true, invoice: issued() } } });
    await u.click(screen.getByRole('button', { name: /Close Bill/ }));
    await screen.findByText(/Awaiting payment/);
    await u.click(screen.getByRole('button', { name: 'Close bill preview' }));
    await waitFor(() => expect(screen.queryByText('Bill Preview')).not.toBeInTheDocument());

    const before = hub.calls('GET /tables/1/invoice').length;
    await u.click(screen.getByRole('button', { name: /Bill/ }));
    expect(hub.calls('GET /tables/1/invoice').length).toBe(before + 1);   // synchronously, on the click
    expect(await screen.findByRole('button', { name: /Close Bill/ })).toBeInTheDocument();
  });

  it('a close with nothing adjusted sends an empty body', async () => {
    const { hub, u } = await openBill({ 'POST /tables/1/clear': { body: { success: true, invoice: issued() } } });
    await u.click(screen.getByRole('button', { name: 'Close Bill · ₹210' }));
    await screen.findByText(/Awaiting payment/);
    expect(hub.calls('POST /tables/1/clear')[0].body).toEqual({});
  });

  it('a close the hub refuses keeps the bill open and says why', async () => {
    const { u } = await openBill({ 'POST /tables/1/clear': { status: 400, body: { error: 'Discount is larger than the subtotal.' } } });
    await u.click(screen.getByRole('button', { name: 'Close Bill · ₹210' }));
    expect(await screen.findByText('Discount is larger than the subtotal.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Bill · ₹210' })).toBeInTheDocument();
  });

  it('Cancel and the close button dismiss the preview', async () => {
    const { u } = await openBill();
    await u.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Bill Preview')).not.toBeInTheDocument());
    await u.click(screen.getByRole('button', { name: /Bill/ }));
    await screen.findByText('Bill Preview');
    await u.click(screen.getByRole('button', { name: 'Close bill preview' }));
    await waitFor(() => expect(screen.queryByText('Bill Preview')).not.toBeInTheDocument());
  });

  describe('once issued', () => {
    const openIssued = async (over = {}, invoice = issued()) => {
      const hub = setup({ 'GET /tables/1/invoice': { body: { invoice } }, ...over });
      const u = user();
      await screen.findByText('TICKET #101');
      await u.click(screen.getByRole('button', { name: /Bill/ }));
      await screen.findByText(/INV-000001/);
      return { hub, u };
    };

    it('marks it paid with the method, and the reference if one was typed', async () => {
      const paid = issued({ payment_status: 'paid', payment_method: 'upi', payment_ref: 'TXN42' });
      const { hub, u } = await openIssued({ 'POST /invoices/inv_1/mark-paid': { body: { invoice: paid } } });
      await u.type(screen.getByPlaceholderText(/Payment reference \(optional/), '  TXN42 ');
      await u.click(screen.getByRole('button', { name: 'upi' }));

      expect(await screen.findByText('✓ INV-000001 · Paid · UPI')).toBeInTheDocument();
      expect(screen.getByText('Ref: TXN42')).toBeInTheDocument();
      expect(hub.calls('POST /invoices/inv_1/mark-paid')[0].body).toEqual({ payment_method: 'upi', payment_ref: 'TXN42' });
    });

    it('sends no reference when none was typed, and offers all four methods', async () => {
      const { hub, u } = await openIssued({ 'POST /invoices/inv_1/mark-paid': { body: { invoice: issued({ payment_status: 'paid', payment_method: 'cash' }) } } });
      for (const m of ['cash', 'upi', 'card', 'other']) expect(screen.getByRole('button', { name: m })).toBeInTheDocument();
      await u.click(screen.getByRole('button', { name: 'cash' }));
      await screen.findByText(/Paid · CASH/);
      expect(hub.calls('POST /invoices/inv_1/mark-paid')[0].body).toEqual({ payment_method: 'cash' });
    });

    it('a payment the hub refuses is said, and the bill stays awaiting payment', async () => {
      const { u } = await openIssued({ 'POST /invoices/inv_1/mark-paid': { status: 400, body: { error: 'Invoice already voided.' } } });
      await u.click(screen.getByRole('button', { name: 'card' }));
      expect(await screen.findByText('Invoice already voided.')).toBeInTheDocument();
      expect(screen.getByText(/Awaiting payment/)).toBeInTheDocument();
    });

    it('splits by seats, settles one share at a time with its method, and the bill is paid when the hub says so', async () => {
      const shares = (paid = []) => [0, 1, 2].map(i => ({ label: `Seat ${i + 1}`, share_amount: 70, payment_status: paid.includes(i) ? 'paid' : 'pending', payment_method: paid.includes(i) ? 'cash' : undefined }));
      const split = issued({ splits: shares(), split_mode: 'seats' });
      const { hub, u } = await openIssued({
        'POST /invoices/inv_1/split-by-seats': { body: { invoice: split } },
        'POST /invoices/inv_1/splits/0/mark-paid': { body: { invoice: { ...split, splits: shares([0]) }, parent_settled: false } }
      });
      await u.click(screen.getByRole('button', { name: '3' }));
      expect(await screen.findByText('Split into 3 seats')).toBeInTheDocument();
      expect(hub.calls('POST /invoices/inv_1/split-by-seats')[0].body).toEqual({ count: 3 });
      expect(screen.getByRole('button', { name: 'Undo split' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Void bill (reopens tickets)' })).not.toBeInTheDocument();

      await u.click(screen.getAllByRole('button', { name: 'cash' })[0]);
      expect(await screen.findByText('✓ cash')).toBeInTheDocument();
      expect(hub.calls('POST /invoices/inv_1/splits/0/mark-paid')[0].body).toEqual({ payment_method: 'cash' });
      expect(screen.queryByRole('button', { name: 'Undo split' })).not.toBeInTheDocument();   // a share is paid: no going back
    });

    it('a reference typed for a share goes with that share\'s payment, trimmed, and not with a payment made without one', async () => {
      const shares = [{ label: 'Seat 1', share_amount: 105, payment_status: 'pending' }, { label: 'Seat 2', share_amount: 105, payment_status: 'pending' }];
      const split = issued({ splits: shares, split_mode: 'seats' });
      const { hub, u } = await openIssued({
        'POST /invoices/inv_1/splits/0/mark-paid': { body: { invoice: split } },
        'POST /invoices/inv_1/splits/1/mark-paid': { body: { invoice: split } }
      }, split);
      await u.type(screen.getByPlaceholderText(/Payment reference for next split/), ' UPI-77 ');
      await u.click(screen.getAllByRole('button', { name: 'upi' })[0]);
      await waitFor(() => expect(hub.calls('POST /invoices/inv_1/splits/0/mark-paid')).toHaveLength(1));
      expect(hub.calls('POST /invoices/inv_1/splits/0/mark-paid')[0].body).toEqual({ payment_method: 'upi', payment_ref: 'UPI-77' });

      // The box was cleared by the payment it was for.
      await waitFor(() => expect(screen.getByPlaceholderText(/Payment reference for next split/)).toHaveValue(''));
      await u.click(screen.getAllByRole('button', { name: 'cash' })[1]);
      await waitFor(() => expect(hub.calls('POST /invoices/inv_1/splits/1/mark-paid')).toHaveLength(1));
      expect(hub.calls('POST /invoices/inv_1/splits/1/mark-paid')[0].body).toEqual({ payment_method: 'cash' });
    });

    it('undoes a split while nothing is paid, and the whole-bill payment buttons come back', async () => {
      const split = issued({ splits: [{ label: 'Seat 1', share_amount: 105, payment_status: 'pending' }, { label: 'Seat 2', share_amount: 105, payment_status: 'pending' }], split_mode: 'seats' });
      const { hub, u } = await openIssued({ 'DELETE /invoices/inv_1/splits': { body: { invoice: issued() } } }, split);
      await u.click(screen.getByRole('button', { name: 'Undo split' }));
      expect(await screen.findByRole('button', { name: 'upi' })).toBeInTheDocument();
      expect(hub.calls('DELETE /invoices/inv_1/splits')).toHaveLength(1);
    });

    it('splits by custom amounts: seeded with an equal share, sent as typed, and Apply waits for a total that adds up', async () => {
      const split = issued({ splits: [{ label: 'Asha', share_amount: 100, payment_status: 'pending' }, { label: 'Ravi', share_amount: 110, payment_status: 'pending' }], split_mode: 'amounts' });
      const { hub, u } = await openIssued({ 'POST /invoices/inv_1/split-by-amounts': { body: { invoice: split } } });
      await u.click(screen.getByRole('button', { name: 'Custom amounts…' }));

      const amounts = screen.getAllByPlaceholderText('0');
      expect(amounts.map(a => a.value)).toEqual(['105', '105']);
      expect(screen.getByRole('button', { name: 'Apply split' })).toBeEnabled();

      await u.clear(amounts[0]);
      await u.type(amounts[0], '100');
      expect(screen.getByRole('button', { name: 'Apply split' })).toBeDisabled();   // 100 + 105 is not 210
      await u.clear(amounts[1]);
      await u.type(amounts[1], '110');
      await u.type(screen.getByPlaceholderText('Split 1'), 'Asha');
      await u.type(screen.getByPlaceholderText('Split 2'), 'Ravi');
      await u.click(screen.getByRole('button', { name: 'Apply split' }));

      expect(await screen.findByText('Split into 2 shares')).toBeInTheDocument();
      expect(hub.calls('POST /invoices/inv_1/split-by-amounts')[0].body).toEqual({ splits: [{ label: 'Asha', share_amount: 100 }, { label: 'Ravi', share_amount: 110 }] });
    });

    it('splits by items: every line starts on split 1, an empty split is refused, and the assignment is what is sent', async () => {
      const two = issued({
        items: [{ ticket_number: 101, name: 'Dal', qty: 2, price: 100, line_total: 200 }, { ticket_number: 101, name: 'Chai', qty: 1, price: 40, line_total: 40 }],
        subtotal: 240, grand_total: 252
      });
      const split = { ...two, splits: [{ label: 'Split 1', share_amount: 210, payment_status: 'pending' }, { label: 'Split 2', share_amount: 42, payment_status: 'pending' }], split_mode: 'items' };
      const { hub, u } = await openIssued({ 'POST /invoices/inv_1/split-by-items': { body: { invoice: split } } }, two);
      await u.click(screen.getByRole('button', { name: 'By items…' }));

      expect(screen.getByText('By items · 2 splits')).toBeInTheDocument();
      expect(screen.getByText('Every split needs at least one item (1 empty).')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Apply split' })).toBeDisabled();

      const panel = screen.getByText('By items · 2 splits').parentElement.parentElement;
      const chaiRow = within(panel).getByText('Chai').parentElement;
      await u.click(within(chaiRow).getByRole('button', { name: '2' }));
      expect(screen.queryByText(/Every split needs at least one item/)).not.toBeInTheDocument();
      await u.click(screen.getByRole('button', { name: 'Apply split' }));

      await screen.findByText('Split into 2 shares');
      expect(hub.calls('POST /invoices/inv_1/split-by-items')[0].body).toEqual({ splits: [{ label: 'Split 1', item_indices: [0] }, { label: 'Split 2', item_indices: [1] }] });
    });

    it('voids a bill with a reason, closes, and re-reads the board so the reopened tickets appear', async () => {
      const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  wrong table ');
      const { hub, u } = await openIssued({ 'POST /invoices/inv_1/void': { body: { invoice: issued({ payment_status: 'voided' }) } } });
      const reads = hub.calls('GET /orders/active').length;
      await u.click(screen.getByRole('button', { name: 'Void bill (reopens tickets)' }));

      await waitFor(() => expect(screen.queryByText('Bill Preview')).not.toBeInTheDocument());
      expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Void INV-000001?'));
      expect(hub.calls('POST /invoices/inv_1/void')[0].body).toEqual({ reason: 'wrong table' });
      await waitFor(() => expect(hub.calls('GET /orders/active').length).toBeGreaterThan(reads));
    });

    it('a void with no reason, or a cancelled prompt, sends nothing', async () => {
      const prompt = vi.spyOn(window, 'prompt').mockReturnValue('   ');
      const { hub, u } = await openIssued();
      await u.click(screen.getByRole('button', { name: 'Void bill (reopens tickets)' }));
      prompt.mockReturnValue(null);
      await u.click(screen.getByRole('button', { name: 'Void bill (reopens tickets)' }));
      expect(hub.all().filter(c => c.key.endsWith('/void'))).toHaveLength(0);
      expect(screen.getByText('Bill Preview')).toBeInTheDocument();
    });

    it('a void the hub refuses leaves the bill open with the hub\'s reason', async () => {
      vi.spyOn(window, 'prompt').mockReturnValue('oops');
      const { u } = await openIssued({ 'POST /invoices/inv_1/void': { status: 400, body: { error: 'A paid invoice cannot be voided; refund it instead.' } } });
      await u.click(screen.getByRole('button', { name: 'Void bill (reopens tickets)' }));
      expect(await screen.findByText('A paid invoice cannot be voided; refund it instead.')).toBeInTheDocument();
      expect(screen.getByText('Bill Preview')).toBeInTheDocument();
    });

    const paidInvoice = () => issued({ payment_status: 'paid', payment_method: 'cash' });

    it('refunds a paid bill with a reason, and shows it refunded with the reason', async () => {
      const prompt = vi.spyOn(window, 'prompt').mockReturnValue('cold food');
      const refunded = issued({ payment_status: 'refunded', refund_reason: 'cold food' });
      const { hub, u } = await openIssued({ 'POST /invoices/inv_1/refund': { body: { invoice: refunded } } }, paidInvoice());
      await u.click(screen.getByRole('button', { name: 'Refund invoice' }));

      expect(await screen.findByText(/INV-000001 · Refunded/)).toBeInTheDocument();
      expect(screen.getByText('Reason: cold food')).toBeInTheDocument();
      expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Refund INV-000001 (₹210)?'));
      expect(hub.calls('POST /invoices/inv_1/refund')[0].body).toEqual({ reason: 'cold food' });
    });

    it('a refund with no reason sends nothing', async () => {
      vi.spyOn(window, 'prompt').mockReturnValue('');
      const { hub, u } = await openIssued({}, paidInvoice());
      await u.click(screen.getByRole('button', { name: 'Refund invoice' }));
      expect(hub.all().filter(c => c.key.endsWith('/refund'))).toHaveLength(0);
    });

    it('prints the receipt and shows what was sent, or that there is no printer', async () => {
      const { hub, u } = await openIssued({
        'POST /invoices/inv_1/print-receipt': { body: { success: true, results: [{ printer_id: 'preview', ok: true, preview: true }], preview_text: 'MEJWANI\nTotal 210' } }
      }, paidInvoice());
      await u.click(screen.getByRole('button', { name: 'Print receipt' }));

      expect(await screen.findByText('Receipt · INV-000001')).toBeInTheDocument();
      expect(screen.getByText('👁 Preview only · no printer configured')).toBeInTheDocument();
      expect(screen.getByText(/Total 210/)).toBeInTheDocument();
      expect(hub.calls('POST /invoices/inv_1/print-receipt')).toHaveLength(1);
    });

    it('says when the printer failed', async () => {
      const { u } = await openIssued({
        'POST /invoices/inv_1/print-receipt': { body: { success: true, results: [{ printer_id: 'p1', ok: false, error: 'Paper out' }], preview_text: 'X' } }
      }, paidInvoice());
      await u.click(screen.getByRole('button', { name: 'Print receipt' }));
      expect(await screen.findByText('✕ Printer error: Paper out')).toBeInTheDocument();
    });
  });
});
