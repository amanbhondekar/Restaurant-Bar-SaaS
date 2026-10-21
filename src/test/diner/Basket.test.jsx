import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DinerMenu } from '@/diner/DinerMenu';
import { addToBasket, removeFromBasket, basketCount, basketTotal, basketToOrder, lineKey, MAX_PER_LINE } from '@/diner/lib/basket';
import { publicMenu } from '../../../hub_server/lib/dinerMenu.js';
import { fakeHub } from '../helpers/fakeHub';

// Ordering from the code on the table (§4.5). The basket's rules first, then the guest's screen.

const CACHE = {
  categories: ['Mains'],
  items: [
    { id: 'dal', name: 'Dal Tadka', price: 220, category: 'Mains', isVeg: true, available: true },
    {
      id: 'bir', name: 'Biryani', category: 'Mains', isVeg: false, available: true,
      variants: [{ id: 'h', label: 'Half', price: 260 }, { id: 'f', label: 'Full', price: 480 }]
    }
  ]
};
const MENU = { restaurant: { name: 'Hotel Mejwani', currency: '₹' }, ...publicMenu(CACHE) };
const DAL = MENU.categories[0].items.find(i => i.id === 'dal');
const BIRYANI = MENU.categories[0].items.find(i => i.id === 'bir');

describe('the basket rules', () => {
  it('adding the same dish again is one more, not a second line', () => {
    let b = addToBasket({}, DAL);
    b = addToBasket(b, DAL);
    expect(Object.keys(b)).toHaveLength(1);
    expect(basketCount(b)).toBe(2);
  });

  it('two sizes of one dish are two lines, each at its own price', () => {
    let b = addToBasket({}, BIRYANI, BIRYANI.variants[0]);
    b = addToBasket(b, BIRYANI, BIRYANI.variants[1]);
    expect(Object.keys(b).sort()).toEqual([lineKey('bir', 'f'), lineKey('bir', 'h')].sort());
    expect(basketTotal(b)).toBe(740);
  });

  it('a line stops at a sane maximum rather than climbing for ever', () => {
    let b = {};
    for (let i = 0; i < MAX_PER_LINE + 5; i++) b = addToBasket(b, DAL);
    expect(basketCount(b)).toBe(MAX_PER_LINE);
  });

  it('taking the last one away removes the line rather than leaving a row saying zero', () => {
    let b = addToBasket({}, DAL);
    b = addToBasket(b, DAL);
    b = removeFromBasket(b, lineKey('dal', undefined));
    expect(basketCount(b)).toBe(1);
    b = removeFromBasket(b, lineKey('dal', undefined));
    expect(b).toEqual({});
    expect(removeFromBasket(b, 'nothing|')).toEqual({}, 'removing what is not there is harmless');
  });

  it('what is sent is ids and quantities, and nothing a guest could have edited', () => {
    let b = addToBasket({}, DAL);
    b = addToBasket(b, BIRYANI, BIRYANI.variants[1]);
    expect(basketToOrder(b)).toEqual([
      { id: 'dal', qty: 1 },
      { id: 'bir', qty: 1, variant_id: 'f' }
    ]);
    // No price and no name: the hub prices the order from its own menu anyway, and sending them
    // would only invite someone to change them.
  });
});

const setup = async (routes = {}, { table = 'T4' } = {}) => {
  if (table) window.history.replaceState(null, '', `/diner?t=${table}`);
  const hub = fakeHub({
    'GET /public/menu': { body: MENU },
    'GET /public/ordering': { body: { success: true, ordering: true, pay_online: false } },
    ...routes
  });
  render(<DinerMenu />);
  await screen.findByText('Dal Tadka');
  return hub;
};

describe('ordering from the table', () => {
  it('with ordering off, the menu is exactly what it was', async () => {
    await setup({ 'GET /public/ordering': { body: { success: true, ordering: false } } });
    expect(screen.queryByRole('button', { name: 'Add Dal Tadka' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Your order' })).not.toBeInTheDocument();
    expect(screen.getByText(/To order, please ask a member of staff/)).toBeInTheDocument();
  });

  it('a hub that cannot answer shows the menu rather than a basket that would fail', async () => {
    await setup({ 'GET /public/ordering': new TypeError('Failed to fetch') });
    expect(screen.queryByRole('button', { name: 'Add Dal Tadka' })).not.toBeInTheDocument();
  });

  it('a menu opened without scanning a table offers no basket -- an order has nowhere to go', async () => {
    await setup({}, { table: '' });
    expect(screen.queryByRole('button', { name: 'Add Dal Tadka' })).not.toBeInTheDocument();
  });

  it('with ordering on, dishes can be added and the basket adds them up', async () => {
    await setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add Dal Tadka' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Biryani, Full' }));

    const basket = screen.getByRole('region', { name: 'Your order' });
    expect(within(basket).getByText('₹700')).toBeInTheDocument();
    expect(within(basket).getByText(/Tax and any service charge are added/)).toBeInTheDocument();
  });

  it('the total is called "about", because tax and service are added to the bill', async () => {
    await setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add Dal Tadka' }));
    const basket = screen.getByRole('region', { name: 'Your order' });
    expect(within(basket).getByText('About')).toBeInTheDocument();
    // A total presented as final is one the guest would then be charged more than.
  });

  it('quantities can be changed from the basket, and the last one removes the line', async () => {
    await setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add Dal Tadka' }));
    const basket = screen.getByRole('region', { name: 'Your order' });

    await userEvent.click(within(basket).getByRole('button', { name: 'One more Dal Tadka' }));
    expect(within(basket).getByLabelText('2 Dal Tadka')).toBeInTheDocument();

    await userEvent.click(within(basket).getByRole('button', { name: 'One fewer Dal Tadka' }));
    await userEvent.click(within(basket).getByRole('button', { name: 'One fewer Dal Tadka' }));
    expect(screen.queryByRole('region', { name: 'Your order' })).not.toBeInTheDocument();
  });

  it('sending the order posts the table and the ids, then says it has gone', async () => {
    const hub = await setup({ 'POST /public/order': { status: 201, body: { success: true, ticket_number: 142, message: 'Sent to the kitchen.' } } });
    await userEvent.click(screen.getByRole('button', { name: 'Add Dal Tadka' }));
    await userEvent.click(screen.getByRole('button', { name: /Send 1 item to the kitchen/ }));

    expect(hub.calls('POST /public/order')[0].body).toEqual({ table: 'T4', items: [{ id: 'dal', qty: 1 }] });
    expect(await screen.findByRole('heading', { name: 'Sent to the kitchen' })).toBeInTheDocument();
    expect(screen.getByText(/Your order is number 142/)).toBeInTheDocument();
    expect(screen.getByText(/settle up with them/)).toBeInTheDocument();
  });

  it('the hub\'s reason is shown when it refuses, and what was chosen is kept', async () => {
    await setup({ 'POST /public/order': { status: 429, body: { success: false, code: 'TOO_SOON', error: 'That has just been sent to the kitchen. Give them a moment, or ask a member of staff.' } } });
    await userEvent.click(screen.getByRole('button', { name: 'Add Dal Tadka' }));
    await userEvent.click(screen.getByRole('button', { name: /Send 1 item/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Give them a moment');
    expect(screen.getByRole('region', { name: 'Your order' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send 1 item/ })).toBeEnabled();
  });

  it('off the wifi, it says that is the likely reason rather than failing silently', async () => {
    await setup({ 'POST /public/order': new TypeError('Failed to fetch') });
    await userEvent.click(screen.getByRole('button', { name: 'Add Dal Tadka' }));
    await userEvent.click(screen.getByRole('button', { name: /Send 1 item/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/off the restaurant's wifi/);
  });

  it('no payment is offered or implied: the bill is settled with staff', async () => {
    await setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add Dal Tadka' }));
    const basket = screen.getByRole('region', { name: 'Your order' });
    expect(within(basket).queryByText(/pay now/i)).not.toBeInTheDocument();
    expect(within(basket).getByText(/You pay a member of staff at the end/)).toBeInTheDocument();
  });
});
