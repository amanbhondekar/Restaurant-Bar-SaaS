import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OpenOrdersPanel } from '@/admin/OpenOrdersPanel';
import { SentOrders } from '@/waiter_mobile/SentOrders';
import { applyMessage } from '@/station/lib/board';
import { anyCooked, cancelConsequence, cancelledMessage, itemsLine, minutesSince, ageLabel, oldestFirst } from '@/admin/lib/openOrders';
import { deferred, fakeHub } from '../helpers/fakeHub';

// Cancelling an order, from reception and from a waiter's handset. What the screen promises about the
// ingredients must match what the hub does (the hub decides; the screen only has to not lie beforehand),
// and an order that is gone must leave every screen.

const T0 = new Date(Date.now() - 12 * 60000).toISOString();
const ticket = (over = {}) => ({
  id: 't1', ticket_number: 142, table_id: 1, table_name: 'T4', status: 'in_progress', created_at: T0, created_by_waiter: 'Asha',
  items: [{ name: 'Biryani', qty: 2 }, { name: 'Chai', qty: 1 }], course_log: { 1: { fired_at: T0, stations_ready: {} } }, ...over
});
const COOKED = ticket({ course_log: { 1: { fired_at: T0, stations_ready: { bar: T0 } } } });

describe('the words', () => {
  it('"cooked" is any station done, a ticket ready, or one recalled -- the same rule the hub uses', () => {
    expect(anyCooked(ticket())).toBe(false);
    expect(anyCooked(COOKED)).toBe(true);
    expect(anyCooked(ticket({ status: 'ready' }))).toBe(true);
    expect(anyCooked(ticket({ course_log: { 1: { recall_count: 1, stations_ready: {} } } }))).toBe(true);
    expect(anyCooked(ticket({ course_log: { 1: { ready_at: T0 } } }))).toBe(true);
    expect(anyCooked(null)).toBe(false);
    expect(anyCooked({})).toBe(false);
  });

  it('says before the tap what will happen to the ingredients', () => {
    expect(cancelConsequence(ticket())).toMatch(/Nothing has been cooked yet, so its ingredients go back into stock/);
    expect(cancelConsequence(COOKED)).toMatch(/already been made, so its ingredients stay counted as used/);
  });

  it('afterwards reports what the hub actually did, not what the screen expected', () => {
    expect(cancelledMessage(ticket(), { ticket: { ticket_number: 142 }, stock_returned: true })).toBe('Order #142 cancelled. Its ingredients are back in stock.');
    expect(cancelledMessage(ticket(), { ticket: { ticket_number: 142 }, cooked: true, stock_returned: false })).toBe('Order #142 cancelled. It had been cooked, so its ingredients stay used.');
    // Nothing to return (an order from before stock was recorded on tickets): said plainly, no false promise.
    expect(cancelledMessage(ticket(), { ticket: { ticket_number: 142 }, cooked: false, stock_returned: false })).toBe('Order #142 cancelled.');
  });

  it('an order is summarised in a line, cut with a count of what was hidden', () => {
    expect(itemsLine(ticket())).toBe('Biryani ×2, Chai');
    expect(itemsLine({ items: [] })).toBe('No items');
    expect(itemsLine({ items: [1, 2, 3, 4, 5].map(n => ({ name: `D${n}`, qty: 1 })) }, 3)).toBe('D1, D2, D3 and 2 more');
  });

  it('age is whole minutes, never negative, and blank when the time cannot be read', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(minutesSince('2026-10-22T11:48:00Z', now)).toBe(12);
    expect(minutesSince('2026-10-22T12:05:00Z', now)).toBe(0);
    expect(minutesSince('nonsense', now)).toBeNull();
    expect([ageLabel(0), ageLabel(12), ageLabel(75), ageLabel(null)]).toEqual(['just now', '12 min ago', '1 h 15 min ago', '']);
  });

  it('the oldest order is first, because that is the one most likely to be stuck', () => {
    const a = ticket({ id: 'a', created_at: '2026-10-22T10:00:00Z' });
    const b = ticket({ id: 'b', created_at: '2026-10-22T09:00:00Z' });
    expect(oldestFirst([a, b]).map(t => t.id)).toEqual(['b', 'a']);
    expect(oldestFirst(undefined)).toEqual([]);
  });
});

const setupPanel = (tickets, routes = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({ 'GET /orders/active': { body: { success: true, tickets } }, ...routes });
  render(<OpenOrdersPanel notify={notify} />);
  return { hub, notify };
};
const CANCELLED = { body: { success: true, cooked: false, stock_returned: true, ticket: { ticket_number: 142 } } };

describe('reception: open orders', () => {
  it('lists what is on the board, oldest first, with the table, items and who took it', async () => {
    setupPanel([ticket({ id: 'b', ticket_number: 143, table_name: 'T7', created_at: new Date().toISOString() }), ticket()]);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map(r => r.getAttribute('aria-label'))).toEqual(['Order 142, T4', 'Order 143, T7']);
    expect(within(rows[0]).getByText('Biryani ×2, Chai · Asha')).toBeInTheDocument();
    expect(within(rows[0]).getByText('12 min ago')).toBeInTheDocument();
  });

  it('says whether each is still in the kitchen or ready', async () => {
    setupPanel([ticket(), ticket({ id: 'r', ticket_number: 150, status: 'ready' })]);
    await screen.findAllByRole('listitem');
    expect(screen.getByText('In the kitchen')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('an empty board says so', async () => {
    setupPanel([]);
    expect(await screen.findByText('Nothing on the board')).toBeInTheDocument();
  });

  it('a hub that cannot be reached says so rather than looking empty', async () => {
    setupPanel(undefined, { 'GET /orders/active': new TypeError('Failed to fetch') });
    expect(await screen.findByText('Could not load the open orders')).toBeInTheDocument();
    expect(screen.queryByText('Nothing on the board')).not.toBeInTheDocument();
  });

  it('asks first, says what happens to the ingredients, and sends nothing until confirmed', async () => {
    const { hub } = setupPanel([ticket()], { 'POST /orders/t1/cancel': CANCELLED });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order 142' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel order #142?' });
    expect(within(dialog).getByText(/Nothing has been cooked yet, so its ingredients go back into stock/)).toBeInTheDocument();
    expect(hub.calls('POST /orders/t1/cancel')).toHaveLength(0);
  });

  it('for an order already made, the question says its ingredients stay used', async () => {
    setupPanel([COOKED]);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order 142' }));
    expect(await screen.findByText(/already been made, so its ingredients stay counted as used/)).toBeInTheDocument();
  });

  it('sends the reason and who, then says what the hub did and refreshes the board', async () => {
    const { hub, notify } = setupPanel([ticket()], { 'POST /orders/t1/cancel': CANCELLED });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order 142' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Why'), 'Wrong table');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    expect(hub.calls('POST /orders/t1/cancel')[0].body).toEqual({ reason: 'Wrong table', by: 'Reception' });
    expect(notify).toHaveBeenCalledWith('Order #142 cancelled. Its ingredients are back in stock.');
    await screen.findAllByRole('listitem');
    expect(hub.calls('GET /orders/active').length).toBeGreaterThan(1);
  });

  it('a reason of its own can be typed, and an empty one cannot be sent', async () => {
    const { hub } = setupPanel([ticket()], { 'POST /orders/t1/cancel': CANCELLED });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order 142' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Why'), 'Something else…');
    expect(within(dialog).getByRole('button', { name: 'Cancel order' })).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText('Say what happened'), '  Allergy  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(hub.calls('POST /orders/t1/cancel')[0].body.reason).toBe('Allergy');
  });

  it('"Keep the order" sends nothing', async () => {
    const { hub } = setupPanel([ticket()]);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order 142' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep the order' }));
    expect(hub.calls('POST /orders/t1/cancel')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a refusal (already billed) is shown in the hub\'s words and the dialog stays so it can be read', async () => {
    const { notify } = setupPanel([ticket()], { 'POST /orders/t1/cancel': { status: 409, body: { success: false, code: 'TICKET_CLOSED', error: 'This order has already been billed. Void the bill instead.' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order 142' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel order' }));

    expect(await screen.findByText('This order has already been billed. Void the bill instead.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
  });

  it('while it is being cancelled it cannot be sent twice or dismissed', async () => {
    const gate = deferred();
    const { hub } = setupPanel([ticket()], { 'POST /orders/t1/cancel': () => gate.promise.then(() => CANCELLED) });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order 142' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    expect(within(dialog).getByRole('button', { name: 'Cancel order' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Keep the order' })).toBeDisabled();
    expect(hub.calls('POST /orders/t1/cancel')).toHaveLength(1);
    gate.resolve();
  });
});

describe('a waiter\'s handset: sent orders', () => {
  const setupSent = (tickets, onCancel = vi.fn().mockResolvedValue({ ok: true, message: 'Order #142 cancelled.' })) => {
    render(<SentOrders tickets={tickets} onCancel={onCancel} />);
    return { onCancel };
  };

  it('shows nothing when the table has no orders on the board', () => {
    const { container } = render(<SentOrders tickets={[]} onCancel={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the table\'s orders and cancels nothing on the first tap -- it asks, and says what happens to the food', async () => {
    const { onCancel } = setupSent([ticket()]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order 142' }));
    expect(screen.getByText(/Nothing has been cooked yet/)).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('confirming sends the chosen reason for that order, and shows the result even after the order has left the list', async () => {
    const onCancel = vi.fn().mockResolvedValue({ ok: true, message: 'Order #142 cancelled. Its ingredients are back in stock.' });
    const { rerender } = render(<SentOrders tickets={[ticket()]} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order 142' }));
    await userEvent.selectOptions(screen.getByLabelText('Why'), 'Guest left');
    await userEvent.click(screen.getByRole('button', { name: /^Cancel order 142$/ }));

    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), 'Guest left');
    rerender(<SentOrders tickets={[]} onCancel={onCancel} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Order #142 cancelled. Its ingredients are back in stock.');
  });

  it('"Keep it" backs out without sending', async () => {
    const { onCancel } = setupSent([ticket()]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order 142' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel order 142' })).toBeInTheDocument();
  });

  it('a refusal is shown and the question stays open', async () => {
    const onCancel = vi.fn().mockResolvedValue({ ok: false, error: 'This order has already been billed. Void the bill instead.' });
    setupSent([ticket()], onCancel);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order 142' }));
    await userEvent.click(screen.getByRole('button', { name: /^Cancel order 142$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Void the bill instead');
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeEnabled();
  });

  it('only one order is being asked about at a time, and each is named by its number', async () => {
    setupSent([ticket(), ticket({ id: 't2', ticket_number: 143 })]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order 143' }));
    expect(screen.getByRole('button', { name: /^Cancel order 143$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel order 142' })).toBeInTheDocument();
  });
});

describe('every screen drops a cancelled order', () => {
  const board = [{ id: 'a', status: 'in_progress' }, { id: 'b', status: 'in_progress' }];

  it('the station board removes it at once and asks to read the list again', () => {
    const out = applyMessage(board, { type: 'TICKET_CANCELLED', payload: { ticket_id: 'a', ticket: { id: 'a', status: 'cancelled' } } });
    expect(out.tickets.map(t => t.id)).toEqual(['b']);
    expect(out.refetch).toBe(true);
  });

  it('a message that does not say which order still triggers a re-read, and removes nothing it cannot name', () => {
    const out = applyMessage(board, { type: 'TICKET_CANCELLED', payload: {} });
    expect(out.tickets).toEqual(board);
    expect(out.refetch).toBe(true);
  });
});
