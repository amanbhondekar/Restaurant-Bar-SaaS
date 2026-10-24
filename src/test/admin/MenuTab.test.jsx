import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MenuTab } from '@/admin/MenuTab';
import { deferred, fakeHub } from '../helpers/fakeHub';

// Reception's Menu tab: the category rail, the item table and the 86 switch. Every action is one write to
// the hub followed by a re-read, and the page must never let two writes race (each carries the revision
// the previous one produced). What matters here is what each action asks the hub to do, and that a refusal
// is shown rather than swallowed.

const MENU = {
  revision: 7,
  categories: ['Starters', 'Mains', 'Desserts'],
  items: [
    { id: 'm1', name: 'Paneer Tikka', price: 280, category: 'Starters', isVeg: true, available: true, station: 'bar' },
    { id: 'm2', name: 'Dal Tadka', price: 220, category: 'Mains', isVeg: true, available: true },
    {
      id: 'm3', name: 'Biryani', price: 260, category: 'Mains', isVeg: false, available: false,
      variants: [{ id: 'h', label: 'Half', price: 260 }, { id: 'f', label: 'Full', price: 480 }],
      modifier_groups: [{ id: 'g', label: 'Extras', options: [{ id: 'o', label: 'Raita', price_delta: 20 }] }],
      day_parts: [{ id: 'dp', label: 'Lunch', starts_at: '12:00', ends_at: '15:00', price: 240 }]
    },
    { id: 'm4', name: 'Fish Fry', price: 340.5, category: 'Starters', isVeg: false, available: true, stock_out: true }
  ]
};

const setup = (routes = {}, props = {}) => {
  const handlers = { onRetry: vi.fn(), onReload: vi.fn().mockResolvedValue(undefined), onStale: vi.fn(), notify: vi.fn() };
  const hub = fakeHub(routes);
  render(<MenuTab menu={MENU} error={null} {...handlers} {...props} />);
  return { hub, ...handlers };
};
const OK = { body: { success: true, revision: 8 } };
const rail = () => screen.getByRole('navigation', { name: 'Menu categories' });
const rowOf = name => screen.getByRole('button', { name }).closest('tr');

describe('menu tab — states', () => {
  it('shows placeholders while the menu is on its way, and no controls that would act on nothing', () => {
    setup({}, { menu: null });
    expect(screen.queryByRole('button', { name: /Add item/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('a menu that could not be loaded says why and offers to try again', async () => {
    const { onRetry } = setup({}, { menu: null, error: { code: 'NETWORK' } });
    expect(screen.getByText('The menu could not be loaded')).toBeInTheDocument();
    expect(screen.getByText(/The hub could not be reached/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a hub that has not downloaded a menu yet switches editing off rather than offering an empty form', () => {
    setup({}, { menu: { uninitialized: true } });
    expect(screen.getByText('This hub has no menu yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add item/ })).not.toBeInTheDocument();
  });

  it('a refresh that failed after a good load keeps the menu on screen and shows the error above it', () => {
    setup({}, { error: { code: 'TIMEOUT' } });
    expect(screen.getByText(/took too long/)).toBeInTheDocument();
    expect(screen.getByText('Paneer Tikka')).toBeInTheDocument();
  });
});

describe('menu tab — the item table', () => {
  it('lists everything under "All items" with its category, and counts each category in the rail', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'All items' })).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: /All items\s*4/ })).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: /Starters\s*2/ })).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: /Mains\s*2/ })).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: /Desserts\s*0/ })).toBeInTheDocument();
    expect(within(rowOf('Dal Tadka')).getByText('Mains')).toBeInTheDocument();
  });

  it('prices a dish with sizes as a range, and a whole or fractional price as written', () => {
    setup();
    expect(within(rowOf('Biryani')).getByText('₹260–₹480')).toBeInTheDocument();
    expect(within(rowOf('Paneer Tikka')).getByText('₹280')).toBeInTheDocument();
    expect(within(rowOf('Fish Fry')).getByText('₹340.50')).toBeInTheDocument();
  });

  it('says what is configured on a dish, so reception can see it without opening it', () => {
    setup();
    const biryani = within(rowOf('Biryani'));
    expect(biryani.getByText('2 variants')).toBeInTheDocument();
    expect(biryani.getByText('1 modifier group')).toBeInTheDocument();
    expect(biryani.getByText('1 day-part price')).toBeInTheDocument();
    expect(within(rowOf('Dal Tadka')).queryByText(/variant|modifier|day-part/)).not.toBeInTheDocument();
  });

  it('shows the station, defaulting to hot', () => {
    setup();
    expect(within(rowOf('Paneer Tikka')).getByText('bar')).toBeInTheDocument();
    expect(within(rowOf('Dal Tadka')).getByText('hot')).toBeInTheDocument();
  });

  it('marks a dish the hub has run out of stock on, and says it is not a switch reception sets here', () => {
    setup();
    const badge = within(rowOf('Fish Fry')).getByText('Out of stock');
    expect(badge).toHaveAttribute('title', expect.stringMatching(/comes back by itself when stock is recorded/));
    expect(within(rowOf('Dal Tadka')).queryByText('Out of stock')).not.toBeInTheDocument();
  });

  it('an 86’d dish reads as 86’d, struck through, with its switch off', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Biryani' })).toHaveClass('line-through');
    expect(screen.getByRole('switch', { name: 'Biryani: 86’d' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Dal Tadka: Available' })).toBeChecked();
  });
});

describe('menu tab — categories and search', () => {
  it('choosing a category shows only its items, and the heading says which', async () => {
    setup();
    await userEvent.click(within(rail()).getByRole('button', { name: /Mains/ }));
    expect(screen.getByRole('heading', { name: 'Mains' })).toBeInTheDocument();
    expect(screen.getByText('Dal Tadka')).toBeInTheDocument();
    expect(screen.queryByText('Paneer Tikka')).not.toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
  });

  it('search looks across every category by name or category, and says it did', async () => {
    setup();
    await userEvent.click(within(rail()).getByRole('button', { name: /Mains/ }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search items' }), 'tikka');
    expect(screen.getByRole('heading', { name: /Results for/ })).toHaveTextContent('Results for “tikka”');
    expect(screen.getByText('Paneer Tikka')).toBeInTheDocument();
    expect(screen.getByText('1 item, all categories')).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search items' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search items' }), 'startERS');
    expect(screen.getByText('Fish Fry')).toBeInTheDocument();
    expect(screen.getByText('2 items, all categories')).toBeInTheDocument();
  });

  it('a search that matches nothing says so, and offers no "add item" that would be about the search', async () => {
    setup();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search items' }), 'zzz');
    expect(screen.getByText('No items match your search')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Items' })).getAllByRole('button', { name: /Add item/ })).toHaveLength(1);
  });

  it('an empty category says so and points at what to do about it', async () => {
    setup();
    await userEvent.click(within(rail()).getByRole('button', { name: /Desserts/ }));
    expect(screen.getByText('No items in this category')).toBeInTheDocument();
    expect(screen.getByText(/delete the category if you do not need it/)).toBeInTheDocument();
  });

  it('an empty menu says to add a dish or import a spreadsheet', () => {
    setup({}, { menu: { revision: 1, categories: [], items: [] } });
    expect(screen.getByText('The menu is empty')).toBeInTheDocument();
    expect(screen.getByText(/import a spreadsheet/)).toBeInTheDocument();
  });
});

describe('menu tab — the 86 switch', () => {
  it('86ing a dish sends only the availability, against the revision on screen, then re-reads and says so', async () => {
    const { hub, onReload, notify } = setup({ 'PUT /admin/menu/items/m2': OK });
    await userEvent.click(screen.getByRole('switch', { name: 'Dal Tadka: Available' }));

    expect(hub.calls('PUT /admin/menu/items/m2')[0].body).toEqual({ base_revision: 7, item: { available: false } });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Dal Tadka is 86’d.');
  });

  it('bringing it back sends available: true', async () => {
    const { hub, notify } = setup({ 'PUT /admin/menu/items/m3': OK });
    await userEvent.click(screen.getByRole('switch', { name: 'Biryani: 86’d' }));
    expect(hub.calls('PUT /admin/menu/items/m3')[0].body.item).toEqual({ available: true });
    expect(notify).toHaveBeenCalledWith('Biryani is available again.');
  });

  it('flipping the switch does not also open the dish for editing', async () => {
    setup({ 'PUT /admin/menu/items/m2': OK });
    await userEvent.click(screen.getByRole('switch', { name: 'Dal Tadka: Available' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('an id with awkward characters is encoded into the address, not trusted into it', async () => {
    const menu = { ...MENU, items: [{ ...MENU.items[0], id: 'a/b?c' }] };
    const { hub } = setup({ 'PUT /admin/menu/items/a%2Fb%3Fc': OK }, { menu });
    await userEvent.click(screen.getByRole('switch', { name: 'Paneer Tikka: Available' }));
    expect(hub.calls('PUT /admin/menu/items/a%2Fb%3Fc')).toHaveLength(1);
  });

  it('while one write is in flight every switch is off, so two writes cannot race on one revision', async () => {
    const gate = deferred();
    const { hub } = setup({ 'PUT /admin/menu/items/m2': () => gate.promise.then(() => OK) });
    await userEvent.click(screen.getByRole('switch', { name: 'Dal Tadka: Available' }));

    expect(screen.getByRole('switch', { name: 'Paneer Tikka: Available' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /Add item/ })).toBeDisabled();
    expect(hub.calls('PUT /admin/menu/items/m2')).toHaveLength(1);

    gate.resolve();
    await screen.findByText('Paneer Tikka');
    expect(await screen.findByRole('switch', { name: 'Paneer Tikka: Available' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('a hub that has moved on (stale revision) hands over to the page\'s reload banner, with no error of its own', async () => {
    const { onStale, notify } = setup({ 'PUT /admin/menu/items/m2': { status: 409, body: { success: false, code: 'STALE_REVISION', error: 'old' } } });
    await userEvent.click(screen.getByRole('switch', { name: 'Dal Tadka: Available' }));
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('any other refusal is shown in the hub\'s own words, can be dismissed, and says nothing was done', async () => {
    const { notify, onReload } = setup({ 'PUT /admin/menu/items/m2': { status: 400, body: { success: false, code: 'INVALID_ITEM', error: 'That price is not valid.' } } });
    await userEvent.click(screen.getByRole('switch', { name: 'Dal Tadka: Available' }));

    expect(await screen.findByText('That price is not valid.')).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('That price is not valid.')).not.toBeInTheDocument();
  });

  it('a hub that cannot be reached says so', async () => {
    setup({ 'PUT /admin/menu/items/m2': new TypeError('Failed to fetch') });
    await userEvent.click(screen.getByRole('switch', { name: 'Dal Tadka: Available' }));
    expect(await screen.findByText(/The hub could not be reached/)).toBeInTheDocument();
  });
});

describe('menu tab — adding a category', () => {
  const type = async text => userEvent.type(screen.getByRole('textbox', { name: 'New category name' }), text);
  const add = () => userEvent.click(screen.getByRole('button', { name: /^Add$/ }));

  it('refuses an empty name, a name already there in any case, and one that is too long -- before asking the hub', async () => {
    const { hub } = setup();
    await add();
    expect(screen.getByText('Type a category name.')).toBeInTheDocument();

    await type('  mAiNs ');
    await add();
    expect(screen.getByText('That category already exists.')).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('textbox', { name: 'New category name' }));
    await type('x'.repeat(61));
    await add();
    expect(screen.getByText('Use at most 60 characters.')).toBeInTheDocument();
    expect(hub.all()).toHaveLength(0);
  });

  it('sends the trimmed name with the revision, says so, and clears the box', async () => {
    const { hub, notify } = setup({ 'POST /admin/menu/categories': OK });
    await type('  Drinks ');
    await add();

    expect(hub.calls('POST /admin/menu/categories')[0].body).toEqual({ base_revision: 7, name: 'Drinks' });
    expect(notify).toHaveBeenCalledWith('Added category “Drinks”.');
    expect(screen.getByRole('textbox', { name: 'New category name' })).toHaveValue('');
  });

  it('a refusal leaves what was typed so it can be corrected', async () => {
    setup({ 'POST /admin/menu/categories': { status: 400, body: { success: false, code: 'INVALID_CATEGORY', error: 'That name is not allowed.' } } });
    await type('Drinks');
    await add();
    expect(await screen.findByText('That name is not allowed.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New category name' })).toHaveValue('Drinks');
  });
});

describe('menu tab — renaming, ordering and deleting a category', () => {
  const pickCategory = name => userEvent.click(within(rail()).getByRole('button', { name: new RegExp(name) }));

  it('offers category actions only once a category is chosen', async () => {
    setup();
    expect(screen.queryByRole('group', { name: /Actions for/ })).not.toBeInTheDocument();
    await pickCategory('Mains');
    expect(screen.getByRole('group', { name: 'Actions for Mains' })).toBeInTheDocument();
  });

  it('renaming sends from and to, and says every item moves with it', async () => {
    const { hub, notify } = setup({ 'PUT /admin/menu/categories': OK });
    await pickCategory('Mains');
    await userEvent.click(screen.getByRole('button', { name: /Rename/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Every item in .Mains. moves to the new name/)).toBeInTheDocument();

    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Main course');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

    expect(hub.calls('PUT /admin/menu/categories')[0].body).toEqual({ base_revision: 7, from: 'Mains', to: 'Main course' });
    expect(notify).toHaveBeenCalledWith('Renamed to “Main course”.');
  });

  it('refuses an empty name or another category\'s name, and an unchanged name just closes', async () => {
    const { hub } = setup();
    await pickCategory('Mains');
    await userEvent.click(screen.getByRole('button', { name: /Rename/ }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');

    await userEvent.clear(name);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(within(dialog).getByText('Type a name.')).toBeInTheDocument();

    await userEvent.type(name, 'starters');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(within(dialog).getByText('Another category already has that name.')).toBeInTheDocument();

    await userEvent.clear(name);
    await userEvent.type(name, 'Mains');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(hub.all()).toHaveLength(0);
  });

  it('moving a category sends the whole new order, and the first and last cannot move off the ends', async () => {
    const { hub } = setup({ 'PUT /admin/menu/categories/order': OK });
    await pickCategory('Starters');
    expect(screen.getByRole('button', { name: 'Move category up' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Move category down' }));
    expect(hub.calls('PUT /admin/menu/categories/order')[0].body).toEqual({ base_revision: 7, names: ['Mains', 'Starters', 'Desserts'] });

    await pickCategory('Desserts');
    expect(screen.getByRole('button', { name: 'Move category down' })).toBeDisabled();
  });

  it('a category with dishes cannot be deleted, and says to move them first', async () => {
    setup();
    await pickCategory('Mains');
    const del = screen.getByRole('button', { name: /Delete/ });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', 'Move or delete its items first');
  });

  it('an empty one can: it asks first, then deletes by name against the revision', async () => {
    const { hub, notify } = setup({ 'DELETE /admin/menu/categories': OK });
    await pickCategory('Desserts');
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Delete .Desserts.\?/)).toBeInTheDocument();
    expect(hub.calls('DELETE /admin/menu/categories')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const url = hub.calls('DELETE /admin/menu/categories')[0].url;
    expect(url.searchParams.get('name')).toBe('Desserts');
    expect(url.searchParams.get('base_revision')).toBe('7');
    expect(notify).toHaveBeenCalledWith('Deleted category “Desserts”.');
  });

  it('backing out of the delete asks the hub for nothing', async () => {
    const { hub } = setup();
    await pickCategory('Desserts');
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(hub.all()).toHaveLength(0);
  });
});

describe('menu tab — opening the editors', () => {
  it('"Add item" opens an empty editor', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: /Add item/ }));
    expect(await screen.findByText('New item')).toBeInTheDocument();
  });

  it('clicking a dish opens it for editing, by its name or anywhere on its row', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Dal Tadka' }));
    expect(await screen.findByText('Edit item')).toBeInTheDocument();
  });

  it('"Import menu" opens the importer', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: /Import menu/ }));
    expect(await screen.findByRole('dialog', { name: 'Import menu' })).toBeInTheDocument();
  });
});
