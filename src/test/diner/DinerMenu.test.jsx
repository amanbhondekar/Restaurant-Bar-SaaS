import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DinerMenu } from '@/diner/DinerMenu';
import { publicMenu } from '../../../hub_server/lib/dinerMenu.js';
import { fakeHub } from '../helpers/fakeHub';

// The menu a guest opens by scanning the code on their table -- the first thing a stranger sees of
// the product, on their own phone.
//
// The fixture is built with the hub's own publicMenu() from a menu cache in the hub's own shape,
// not hand-written, so these tests break if the hub and this page ever disagree about a field name.

const CACHE = {
  categories: ['Starters', 'Mains'],
  items: [
    { id: 's1', name: 'Paneer Tikka', price: 280, category: 'Starters', isVeg: true, available: true },
    { id: 's2', name: 'Chicken 65', price: 320, category: 'Starters', isVeg: false, available: true },
    // 86'd: the hub hides it, so the guest must never see it.
    { id: 's3', name: 'Fish Fry', price: 400, category: 'Starters', isVeg: false, available: false },
    {
      id: 'm1', name: 'Biryani', category: 'Mains', isVeg: false, available: true,
      variants: [{ id: 'h', label: 'Half', price: 260 }, { id: 'f', label: 'Full', price: 1200 }]
    },
    {
      id: 'm2', name: 'Dal Tadka', price: 220, category: 'Mains', isVeg: true, available: true,
      modifier_groups: [{
        id: 'g1', label: 'Spice', options: [
          { id: 'o1', label: 'Mild', price_delta: 0 },
          { id: 'o2', label: 'Extra ghee', price_delta: 30 }
        ]
      }]
    }
  ]
};

const menuFrom = (cache, restaurant = { name: 'Hotel Mejwani', currency: '₹' }) => ({ restaurant, ...publicMenu(cache) });

const openAt = search => window.history.replaceState(null, '', `/diner${search}`);

describe('diner menu', () => {
  it('shows the restaurant, each category in the restaurant\'s order, and the dishes in it', async () => {
    fakeHub({ 'GET /public/menu': { body: menuFrom(CACHE) } });
    render(<DinerMenu />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Hotel Mejwani' })).toBeInTheDocument();
    const sections = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
    // The feedback heading comes after the menu, not before it.
    expect(sections).toEqual(['Starters', 'Mains', 'How was your meal?']);

    expect(screen.getByText('Paneer Tikka')).toBeInTheDocument();
    expect(screen.getByText('Chicken 65')).toBeInTheDocument();
  });

  it('never shows an 86\'d dish', async () => {
    fakeHub({ 'GET /public/menu': { body: menuFrom(CACHE) } });
    render(<DinerMenu />);
    await screen.findByText('Paneer Tikka');
    expect(screen.queryByText('Fish Fry')).not.toBeInTheDocument();
  });

  it('prices in Indian grouping, and a dish sold by size as a range with each size listed', async () => {
    fakeHub({ 'GET /public/menu': { body: menuFrom(CACHE) } });
    render(<DinerMenu />);

    const biryani = (await screen.findByText('Biryani')).closest('li');
    expect(within(biryani).getByText('₹260 – ₹1,200')).toBeInTheDocument();
    expect(within(biryani).getByText('Half')).toBeInTheDocument();
    expect(within(biryani).getByText('₹1,200', { selector: '.variant-price' })).toBeInTheDocument();
  });

  it('a dish whose sizes all cost the same shows one price, not "₹200 – ₹200"', async () => {
    const cache = {
      categories: ['Mains'],
      items: [{
        id: 'x', name: 'Thali', category: 'Mains', isVeg: true, available: true,
        variants: [{ id: 'a', label: 'Lunch', price: 200 }, { id: 'b', label: 'Dinner', price: 200 }]
      }]
    };
    fakeHub({ 'GET /public/menu': { body: menuFrom(cache) } });
    render(<DinerMenu />);
    const thali = (await screen.findByText('Thali')).closest('li');
    expect(within(thali).getByText('₹200', { selector: '.price' })).toBeInTheDocument();
    expect(thali.textContent).not.toMatch(/₹200 – ₹200/);
  });

  it('lists the choices on a dish, with what a paid one adds and nothing for a free one', async () => {
    fakeHub({ 'GET /public/menu': { body: menuFrom(CACHE) } });
    render(<DinerMenu />);
    const dal = (await screen.findByText('Dal Tadka')).closest('li');
    const options = dal.querySelector('.options').textContent;
    expect(options).toBe('Spice: Mild, Extra ghee +₹30');
  });

  it('marks veg and non-veg so a guest can tell at a glance', async () => {
    fakeHub({ 'GET /public/menu': { body: menuFrom(CACHE) } });
    render(<DinerMenu />);
    const paneer = (await screen.findByText('Paneer Tikka')).closest('li');
    const chicken = screen.getByText('Chicken 65').closest('li');
    expect(paneer.querySelector('.dot')).toHaveClass('veg');
    expect(chicken.querySelector('.dot')).toHaveClass('nonveg');
  });

  it('shows the table from the code that was scanned, so a guest can tell it is theirs', async () => {
    openAt('?t=T4');
    fakeHub({ 'GET /public/menu': { body: menuFrom(CACHE) } });
    render(<DinerMenu />);
    expect(await screen.findByText('Table T4')).toBeInTheDocument();
  });

  it('opened without a table code, it shows no table line rather than "Table null"', async () => {
    fakeHub({ 'GET /public/menu': { body: menuFrom(CACHE) } });
    render(<DinerMenu />);
    await screen.findByText('Paneer Tikka');
    expect(screen.queryByText(/^Table /)).not.toBeInTheDocument();
  });

  it('says so plainly when nothing is being served', async () => {
    fakeHub({ 'GET /public/menu': { body: menuFrom({ categories: ['Mains'], items: [] }) } });
    render(<DinerMenu />);
    expect(await screen.findByText('Nothing is being served right now.')).toBeInTheDocument();
  });

  it('when the menu cannot be loaded, says so and recovers on "Try again"', async () => {
    const hub = fakeHub({
      'GET /public/menu': ({ call }) => (call === 1 ? new TypeError('Failed to fetch') : { body: menuFrom(CACHE) })
    });
    render(<DinerMenu />);

    expect(await screen.findByText(/The menu could not be loaded/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Paneer Tikka')).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(hub.calls('GET /public/menu')).toHaveLength(2);
  });

  it('treats a hub error status as a failure, not as an empty menu', async () => {
    fakeHub({ 'GET /public/menu': { status: 503, body: { error: 'HUB_UNINITIALIZED' } } });
    render(<DinerMenu />);
    expect(await screen.findByText(/The menu could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing is being served right now.')).not.toBeInTheDocument();
  });

  it('asks the hub for a fresh menu every time, so an 86 reaches a guest who reloads', async () => {
    const hub = fakeHub({ 'GET /public/menu': { body: menuFrom(CACHE) } });
    render(<DinerMenu />);
    await screen.findByText('Paneer Tikka');
    expect(hub.calls('GET /public/menu')[0].init.cache).toBe('no-store');
  });

  it('renders names typed into the menu editor as text, never as markup', async () => {
    const cache = {
      categories: ['<i>Mains</i>'],
      items: [{ id: 'x', name: '<img src=x onerror="window.__pwn=1">Dal', price: 100, category: '<i>Mains</i>', isVeg: true, available: true }]
    };
    fakeHub({ 'GET /public/menu': { body: menuFrom(cache, { name: '<b>Mejwani</b>', currency: '₹' }) } });
    const { container } = render(<DinerMenu />);

    expect(await screen.findByText('<b>Mejwani</b>')).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror="window.__pwn=1">Dal')).toBeInTheDocument();
    expect(container.querySelector('img, b, i')).toBeNull();
    expect(window.__pwn).toBeUndefined();
  });
});
