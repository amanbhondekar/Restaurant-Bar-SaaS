import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { deferred, fakeHub } from '../helpers/fakeHub';

// The waiter's order drawer: the draft, and the one button that sends it to the kitchen. Only the context it
// reads is faked. What matters: what is SENT (the hub re-prices from its own menu, so only ids travel for
// modifiers), that a failed send keeps the draft, that a double tap or a retry cannot make two tickets, and
// that the drawer is honest when the hub is not there.

const pos = {
  menu: [
    { id: 'starter', name: 'Soup', course: 1 },
    { id: 'main', name: 'Dal', course: 2 },
    { id: 'dessert', name: 'Kulfi', course: 3 },
    { id: 'plain', name: 'Chai' }
  ],
  tables: [{ id: 1, name: 'T1' }, { id: 2, name: 'Terrace' }],
  currentRestaurant: { name: 'Mejwani', currency: '₹' }
};
vi.mock('@/context/PosContext', () => ({ usePos: () => pos }));
vi.mock('@/services/hubAuth', () => ({ authFetch: (url, options) => fetch(url, options) }));

const { OrderDraftDrawer } = await import('@/waiter_mobile/OrderDraftDrawer');

const line = (over = {}) => ({ item_id: 'plain', name: 'Chai', price: 40, isVeg: true, qty: 1, ...over });
const draft = (...lines) => Object.fromEntries(lines.map((l, i) => [`k${i}`, l]));

const TICKET = { ticket: { id: 't_1', ticket_number: 142 } };
const setup = (props = {}, routes = {}) => {
  const onClearDraft = vi.fn();
  const onRemoveItem = vi.fn();
  const hub = fakeHub({ 'POST /orders': { status: 201, body: TICKET }, ...routes });
  const utils = render(
    <OrderDraftDrawer
      selectedTableId={1}
      draftItems={draft(line())}
      onRemoveItem={onRemoveItem}
      onClearDraft={onClearDraft}
      hubUrl="http://hub.local:4000"
      hubConnected
      {...props}
    />
  );
  return { hub, onClearDraft, onRemoveItem, ...utils };
};
const send = () => userEvent.click(screen.getByRole('button', { name: /Send to Kitchen KDS|Sending to Kitchen|Not Connected/ }));
const sentBody = (hub, n = 0) => hub.calls('POST /orders')[n].body;

beforeEach(() => { vi.stubGlobal('navigator', { ...navigator, vibrate: undefined }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('order drawer — before there is an order', () => {
  it('asks for a table first, and offers nothing to send', () => {
    setup({ selectedTableId: null });
    expect(screen.getByText('No table selected')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says to go to the Menu tab when the draft is empty, with nothing to send', () => {
    setup({ draftItems: {} });
    expect(screen.getByText(/add items/)).toBeInTheDocument();
    expect(screen.getByText('T1 Draft Order')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send to Kitchen/ })).toBeNull();
  });
});

describe('order drawer — the draft', () => {
  it('shows each line with its quantity, its price for that quantity, the pieces, and the total', () => {
    setup({ draftItems: draft(line({ name: 'Dal', price: 200, qty: 2 }), line({ name: 'Chai', price: 40, qty: 1 })) });
    expect(screen.getByText('2×')).toBeInTheDocument();
    expect(screen.getByText('₹400')).toBeInTheDocument();   // 2 x 200
    expect(screen.getByText('₹40')).toBeInTheDocument();
    expect(screen.getByText('3 pcs')).toBeInTheDocument();
    expect(screen.getByText('Order Total').nextSibling).toHaveTextContent('₹440');
  });

  it('shows a size beside the dish and the part of the day that priced it', () => {
    setup({ draftItems: draft(line({ name: 'Biryani', price: 300, variant_id: 'full', variant_label: 'Full', active_day_part: { label: 'Lunch' } })) });
    expect(screen.getByText('· Full')).toBeInTheDocument();
    expect(screen.getByText('LUNCH')).toBeInTheDocument();
  });

  it('shows modifiers: a choice with no price by its group, an extra with its price for the quantity', () => {
    const mods = [
      { group_id: 'g1', option_id: 'o1', group_label: 'Spice', option_label: 'Medium', price_delta: 0 },
      { group_id: 'g2', option_id: 'o2', group_label: 'Extras', option_label: 'Cheese', price_delta: 30 },
      { group_id: 'g3', option_id: 'o3', group_label: 'Swap', option_label: 'Less rice', price_delta: -10 }
    ];
    setup({ draftItems: draft(line({ name: 'Pizza', price: 360, qty: 2, modifiers: mods })) });
    expect(screen.getByText('· Spice: Medium')).toBeInTheDocument();
    expect(screen.getByText('+ Cheese')).toBeInTheDocument();
    expect(screen.getByText('+₹60')).toBeInTheDocument();     // 30 x 2
    expect(screen.getByText('−₹20')).toBeInTheDocument();     // a discount is shown as one
  });

  it('offers "remove one" on a line with modifiers, and it removes that line', async () => {
    const mods = [{ group_id: 'g1', option_id: 'o1', option_label: 'Egg', price_delta: 20 }];
    const { onRemoveItem } = setup({ draftItems: { 'plain|g1:o1': line({ modifiers: mods }) } });
    await userEvent.click(screen.getByTitle('Remove one'));
    expect(onRemoveItem).toHaveBeenCalledWith('plain|g1:o1');
  });

  it('clears the draft only after asking', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { onClearDraft } = setup();
    const trash = screen.getAllByRole('button').find(b => b.querySelector('svg.lucide-trash2, svg.lucide-trash-2'));
    confirm.mockReturnValueOnce(false);
    await userEvent.click(trash);
    expect(onClearDraft).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    await userEvent.click(trash);
    expect(onClearDraft).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
});

describe('order drawer — what is sent', () => {
  it('sends the table, the lines and the kitchen note, trimmed', async () => {
    const { hub } = setup({ selectedTableId: 2, draftItems: draft(line({ item_id: 'main', name: 'Dal', price: 200, qty: 2 })) });
    await userEvent.type(screen.getByPlaceholderText(/Extra spicy/), '  Jain prep  ');
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(1));
    const body = sentBody(hub);
    expect(body).toMatchObject({ table_id: 2, table_name: 'Terrace', note: 'Jain prep', items: [{ id: 'main', name: 'Dal', qty: 2, price: 200 }] });
    expect(body.order_request_id).toMatch(/^req_/);
    expect('course_service' in body).toBe(false);
    expect(hub.calls('POST /orders')[0].url.origin).toBe('http://hub.local:4000');
  });

  it('sends a size by its id, and a modifier by its two ids only: the hub prices from its own menu', async () => {
    const mods = [{ group_id: 'g2', option_id: 'o2', group_label: 'Extras', option_label: 'Cheese', price_delta: 30 }];
    const { hub } = setup({ draftItems: draft(line({ item_id: 'main', name: 'Pizza', price: 360, variant_id: 'large', variant_label: 'Large', modifiers: mods })) });
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(1));
    const item = sentBody(hub).items[0];
    expect(item.variant_id).toBe('large');
    expect(item.modifiers).toEqual([{ group_id: 'g2', option_id: 'o2' }]);   // no label, no price_delta
    expect(JSON.stringify(item)).not.toMatch(/Cheese|price_delta|variant_label/);
  });

  it('sends no variant or modifier keys for a plain dish', async () => {
    const { hub } = setup();
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(1));
    const item = sentBody(hub).items[0];
    expect('variant_id' in item).toBe(false);
    expect('modifiers' in item).toBe(false);
  });

  it('names who took the order, with a plain fallback', async () => {
    const { hub, unmount } = setup({ waiter: { id: 'w_1', name: 'Asha' } });
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(1));
    expect(sentBody(hub)).toMatchObject({ created_by_waiter: 'Asha (PWA)', waiter_id: 'w_1' });
    unmount();

    const second = setup();
    await send();
    await waitFor(() => expect(second.hub.calls('POST /orders')).toHaveLength(1));
    expect(sentBody(second.hub)).toMatchObject({ created_by_waiter: 'Waiter Handset (PWA)' });
    expect(sentBody(second.hub).waiter_id).toBeUndefined();
  });

  it('finds the hub without a trailing slash, and falls back to this machine when none is given', async () => {
    const { hub, unmount } = setup({ hubUrl: 'http://hub.local:4000///' });
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(1));
    expect(hub.calls('POST /orders')[0].url.href).toBe('http://hub.local:4000/orders');
    unmount();

    const fallback = setup({ hubUrl: '' });
    await send();
    await waitFor(() => expect(fallback.hub.calls('POST /orders')).toHaveLength(1));
    expect(fallback.hub.calls('POST /orders')[0].url.origin).toBe('http://localhost:4000');
  });
});

describe('order drawer — courses', () => {
  const COURSES = draft(line({ item_id: 'starter', name: 'Soup' }), line({ item_id: 'main', name: 'Dal' }));

  it('offers to serve in courses only when the order spans more than one', () => {
    setup({ draftItems: draft(line({ item_id: 'main', name: 'Dal' }), line({ item_id: 'main', name: 'Dal 2' })) });
    expect(screen.queryByText('Serve in courses')).toBeNull();
  });

  it('a dish with no course counts as course 1', () => {
    setup({ draftItems: draft(line({ item_id: 'plain' }), line({ item_id: 'main', name: 'Dal' })) });
    expect(screen.getByText('Serve in courses')).toBeInTheDocument();
    expect(screen.getByText(/Course 1 goes to the kitchen now\. Course 2 waits until you fire it\./)).toBeInTheDocument();
  });

  it('says "the rest wait" when there are more than two courses', () => {
    setup({ draftItems: draft(line({ item_id: 'starter' }), line({ item_id: 'main', name: 'Dal' }), line({ item_id: 'dessert', name: 'Kulfi' })) });
    expect(screen.getByText(/Course 1 goes to the kitchen now\. The rest wait until you fire them\./)).toBeInTheDocument();
  });

  it('sends course_service only when it is ticked, and unticks again after the order is sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { hub } = setup({ draftItems: COURSES });
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(screen.getByRole('checkbox')).toBeChecked();
    await send();
    await screen.findByText(/Pushed to Kitchen/);
    expect(sentBody(hub).course_service).toBe(true);
    act(() => { vi.advanceTimersByTime(3100); });
    expect(await screen.findByRole('checkbox')).not.toBeChecked();   // the next order starts as one course
  });

  it('a ticked box that no longer applies, because the order has shrunk to one course, is not sent', async () => {
    const { hub, rerender } = setup({ draftItems: COURSES });
    await userEvent.click(screen.getByRole('checkbox'));
    rerender(
      <OrderDraftDrawer selectedTableId={1} draftItems={draft(line({ item_id: 'main', name: 'Dal' }))} onRemoveItem={() => {}} onClearDraft={() => {}} hubUrl="http://hub.local:4000" hubConnected />
    );
    expect(screen.queryByText('Serve in courses')).toBeNull();
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(1));
    expect('course_service' in sentBody(hub)).toBe(false);   // nothing would be held back for the kitchen to wait on
  });

  it('an untouched checkbox sends nothing about courses', async () => {
    const { hub } = setup({ draftItems: COURSES });
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(1));
    expect('course_service' in sentBody(hub)).toBe(false);
  });
});

describe('order drawer — after the hub answers', () => {
  it('on success clears the draft and the note, and says which ticket went to the kitchen', async () => {
    const { onClearDraft } = setup();
    await userEvent.type(screen.getByPlaceholderText(/Extra spicy/), 'less oil');
    await send();
    expect(await screen.findByText(/Ticket #142 Pushed to Kitchen!/)).toBeInTheDocument();
    expect(onClearDraft).toHaveBeenCalledTimes(1);
  });

  it('puts the drawer back after a moment, with the note gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await userEvent.type(screen.getByPlaceholderText(/Extra spicy/), 'less oil', { advanceTimers: vi.advanceTimersByTime });
    await send();
    expect(await screen.findByText(/Pushed to Kitchen/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3100); });
    expect(await screen.findByText('T1 Draft Order')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Extra spicy/)).toHaveValue('');
  });

  it('when the hub refuses, shows its reason and keeps the draft and the note to try again', async () => {
    const { onClearDraft } = setup({}, { 'POST /orders': { status: 409, body: { success: false, error: 'Paneer Tikka is out of stock.' } } });
    await userEvent.type(screen.getByPlaceholderText(/Extra spicy/), 'less oil');
    await send();
    expect(await screen.findByText('Paneer Tikka is out of stock.')).toBeInTheDocument();
    expect(onClearDraft).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/Extra spicy/)).toHaveValue('less oil');
    expect(screen.getByRole('button', { name: 'Send to Kitchen KDS (LAN)' })).toBeEnabled();
  });

  it('a refusal that says nothing is still reported', async () => {
    setup({}, { 'POST /orders': { status: 500, body: undefined } });
    await send();
    expect(await screen.findByText('Failed to post order to hub.')).toBeInTheDocument();
  });

  it('when the hub cannot be reached, says so with the address and keeps the draft', async () => {
    const { onClearDraft } = setup({}, { 'POST /orders': new TypeError('fetch failed') });
    await send();
    expect(await screen.findByText('Hub unreachable at http://hub.local:4000. Check WiFi network.')).toBeInTheDocument();
    expect(onClearDraft).not.toHaveBeenCalled();
  });

  it('clears the old error the moment the next attempt begins, not when it ends', async () => {
    const gate = deferred();
    let calls = 0;
    setup({}, { 'POST /orders': async () => { if (++calls === 1) return { status: 409, body: { success: false, error: 'Busy.' } }; await gate.promise; return { status: 201, body: TICKET }; } });
    await send();
    expect(await screen.findByText('Busy.')).toBeInTheDocument();
    await send();
    await screen.findByRole('button', { name: 'Sending to Kitchen...' });
    expect(screen.queryByText('Busy.')).toBeNull();   // a waiter watching it send is not told it failed
    gate.resolve();
    await screen.findByText(/Pushed to Kitchen/);
  });
});

describe('order drawer — when it must not send', () => {
  it('with no hub connection, says so on a button that cannot be pressed, and sends nothing', async () => {
    const { hub } = setup({ hubConnected: false });
    const button = screen.getByRole('button', { name: 'Not Connected to Hub' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(hub.calls('POST /orders')).toHaveLength(0);
  });

  it('a second tap while the first is on its way does not send a second order', async () => {
    const gate = deferred();
    const { hub } = setup({}, { 'POST /orders': async () => { await gate.promise; return { status: 201, body: TICKET }; } });
    await send();
    const busy = await screen.findByRole('button', { name: 'Sending to Kitchen...' });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    await userEvent.click(busy);
    expect(hub.calls('POST /orders')).toHaveLength(1);
    gate.resolve();
    await screen.findByText(/Pushed to Kitchen/);
    expect(hub.calls('POST /orders')).toHaveLength(1);
  });
});

describe('order drawer — a retry is the same order, not a second one', () => {
  // The hub remembers an order_request_id for a minute and answers a repeat with the ticket it already made. That
  // protects a waiter on flaky WiFi whose first reply was lost -- the order may well have been made -- but only if
  // the retry carries the SAME id.
  it('after a failure the retry carries the same request id', async () => {
    let calls = 0;
    const { hub } = setup({}, { 'POST /orders': () => (++calls === 1 ? new TypeError('fetch failed') : { status: 201, body: TICKET }) });
    await send();
    await screen.findByText(/Hub unreachable/);
    await send();
    await screen.findByText(/Pushed to Kitchen/);
    const ids = hub.calls('POST /orders').map(c => c.body.order_request_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it('an order that was sent is finished: the next one gets a new id', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { hub } = setup();
    await send();
    await screen.findByText(/Pushed to Kitchen/);
    act(() => { vi.advanceTimersByTime(3100); });
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(2));
    const [a, b] = hub.calls('POST /orders').map(c => c.body.order_request_id);
    expect(b).not.toBe(a);
  });

  it('a draft that has been changed since the failed attempt is a different order and gets a new id', async () => {
    let calls = 0;
    const { hub, rerender } = setup({}, { 'POST /orders': () => (++calls === 1 ? new TypeError('fetch failed') : { status: 201, body: TICKET }) });
    await send();
    await screen.findByText(/Hub unreachable/);
    rerender(
      <OrderDraftDrawer selectedTableId={1} draftItems={draft(line({ qty: 2 }))} onRemoveItem={() => {}} onClearDraft={() => {}} hubUrl="http://hub.local:4000" hubConnected />
    );
    await send();
    await screen.findByText(/Pushed to Kitchen/);
    const ids = hub.calls('POST /orders').map(c => c.body.order_request_id);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('so does a changed note, or a changed table', async () => {
    let calls = 0;
    const { hub, rerender } = setup({}, { 'POST /orders': () => (++calls < 3 ? new TypeError('fetch failed') : { status: 201, body: TICKET }) });
    await send();
    await screen.findByText(/Hub unreachable/);
    await userEvent.type(screen.getByPlaceholderText(/Extra spicy/), 'x');
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(2));
    rerender(
      <OrderDraftDrawer selectedTableId={2} draftItems={draft(line())} onRemoveItem={() => {}} onClearDraft={() => {}} hubUrl="http://hub.local:4000" hubConnected />
    );
    await send();
    await waitFor(() => expect(hub.calls('POST /orders')).toHaveLength(3));
    const ids = hub.calls('POST /orders').map(c => c.body.order_request_id);
    expect(new Set(ids).size).toBe(3);
  });
});
