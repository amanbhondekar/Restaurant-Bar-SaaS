import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ItemEditor } from '@/admin/ItemEditor';
import { deferred, fakeHub } from '../helpers/fakeHub';

// The item editor: what it sends when an item is added, changed or deleted, what it refuses before asking
// the hub, and how it reports the hub's refusals. The rule that matters most is in its header comment: a save
// sends only the keys that changed, so editing a price can never drop the variants, modifiers or day-parts.

const MENU = { revision: 7, categories: ['Starters', 'Mains'], items: [] };
const DISH = {
  id: 'm1', name: 'Biryani', price: 260, category: 'Mains', isVeg: false, available: true, station: 'hot',
  variants: [{ id: 'v1', label: 'Half', price: 260, available: true }, { id: 'v2', label: 'Full', price: 480, available: false }],
  modifier_groups: [{
    id: 'g1', label: 'Extras', min: 0, max: 2,
    options: [{ id: 'o1', label: 'Raita', price_delta: 20, available: true }, { id: 'o2', label: 'Egg', price_delta: 30, available: false }]
  }],
  day_parts: [{ id: 'd1', label: 'Lunch', starts_at: '12:00', ends_at: '15:00', days: [], price: 240 }]
};

const setup = (routes = {}, props = {}) => {
  const handlers = { onClose: vi.fn(), onSaved: vi.fn().mockResolvedValue(undefined), onStale: vi.fn() };
  const hub = fakeHub(routes);
  render(<ItemEditor item={DISH} menu={MENU} defaultCategory="Mains" {...handlers} {...props} />);
  return { hub, ...handlers };
};
const SAVED = { body: { success: true, revision: 8 } };
const save = () => userEvent.click(screen.getByRole('button', { name: /Save changes|Add item/ }));

describe('item editor — what each switch is called', () => {
  it('every availability switch says which dish, size or option it is, rather than all reading "Available"', () => {
    setup();
    // By the real accessible-name computation: each of the five has its own name, and no two share one.
    expect(screen.getAllByRole('switch')).toHaveLength(5);
    for (const name of ['Available', 'Variant 1 available', 'Variant 2 available', 'Group 1 option 1 available', 'Group 1 option 2 available']) {
      expect(screen.getAllByRole('switch', { name }), name).toHaveLength(1);
    }
  });

  it('and each one is reachable by that name, with its own state', () => {
    setup();
    expect(screen.getByRole('switch', { name: 'Variant 1 available' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Variant 2 available' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Group 1 option 2 available' })).not.toBeChecked();
  });
});

describe('item editor — changing an item', () => {
  it('opens on what the item already is, and offers nothing to save until something changes', () => {
    setup();
    expect(screen.getByText('Edit item')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Biryani');
    expect(screen.getByLabelText('Price (₹)')).toHaveValue('260');
    const button = screen.getByRole('button', { name: 'Save changes' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No changes to save');
  });

  it('changing the price sends the price and NOTHING else -- the variants, modifiers and day-parts are left to the hub', async () => {
    const { hub, onSaved } = setup({ 'PUT /admin/menu/items/m1': SAVED });
    const price = screen.getByLabelText('Price (₹)');
    await userEvent.clear(price);
    await userEvent.type(price, '275');
    await save();

    expect(hub.calls('PUT /admin/menu/items/m1')[0].body).toEqual({ base_revision: 7, item: { price: 275 } });
    expect(onSaved).toHaveBeenCalledWith('Saved “Biryani”.');
  });

  it('86ing it sends only the availability', async () => {
    const { hub } = setup({ 'PUT /admin/menu/items/m1': SAVED });
    await userEvent.click(screen.getByRole('switch', { name: 'Available' }));
    await save();
    expect(hub.calls('PUT /admin/menu/items/m1')[0].body.item).toEqual({ available: false });
  });

  it('changing one size sends the whole list of sizes, so the hub is never left to guess which one', async () => {
    const { hub } = setup({ 'PUT /admin/menu/items/m1': SAVED });
    await userEvent.click(screen.getByRole('switch', { name: 'Variant 2 available' }));
    await save();

    const sent = hub.calls('PUT /admin/menu/items/m1')[0].body.item;
    expect(Object.keys(sent)).toEqual(['variants']);
    expect(sent.variants).toEqual([
      expect.objectContaining({ id: 'v1', available: true }),
      expect.objectContaining({ id: 'v2', available: true })
    ]);
  });

  it('an unrelated edit is not blocked by old data the hub would no longer accept', async () => {
    // A row from before a rule tightened: a variant with no price. Only what was touched is checked.
    const legacy = { ...DISH, variants: [{ id: 'v1', label: 'Half', price: '', available: true }] };
    const { hub } = setup({ 'PUT /admin/menu/items/m1': SAVED }, { item: legacy });
    await userEvent.click(screen.getByRole('switch', { name: 'Available' }));
    await save();
    expect(hub.calls('PUT /admin/menu/items/m1')).toHaveLength(1);
  });

  it('an id with awkward characters is encoded into the address', async () => {
    const { hub } = setup({ 'PUT /admin/menu/items/a%2Fb': SAVED }, { item: { ...DISH, id: 'a/b' } });
    await userEvent.click(screen.getByRole('switch', { name: 'Available' }));
    await save();
    expect(hub.calls('PUT /admin/menu/items/a%2Fb')).toHaveLength(1);
  });
});

describe('item editor — refusing before asking, and reporting a refusal', () => {
  it('a blank name or a price that is not a price is flagged on the field and nothing is sent', async () => {
    const { hub } = setup();
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.clear(screen.getByLabelText('Price (₹)'));
    await userEvent.type(screen.getByLabelText('Price (₹)'), '0');
    await save();

    expect(await screen.findByText(/Name is required/)).toBeInTheDocument();
    expect(screen.getByText(/Price must be above 0/)).toBeInTheDocument();
    expect(screen.getByText('Fix the highlighted fields.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(hub.all()).toHaveLength(0);
  });

  it('errors are not shown until the first attempt to save, so a form is not red before it is touched', async () => {
    setup();
    await userEvent.clear(screen.getByLabelText('Name'));
    expect(screen.queryByText(/Name is required/)).not.toBeInTheDocument();
  });

  it('a menu that moved on under the editor is reported, and the page is told to show its reload banner', async () => {
    const { onStale, onSaved } = setup({ 'PUT /admin/menu/items/m1': { status: 409, body: { success: false, code: 'STALE_REVISION', error: 'old' } } });
    await userEvent.click(screen.getByRole('switch', { name: 'Available' }));
    await save();

    expect(await screen.findByText(/The menu changed on the hub after you opened this item/)).toBeInTheDocument();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a duplicate name is put on the name field, in the hub\'s words', async () => {
    setup({ 'PUT /admin/menu/items/m1': { status: 409, body: { success: false, code: 'DUPLICATE_ITEM', error: 'There is already a dish called Dal Tadka.' } } });
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Dal Tadka');
    await save();
    expect(await screen.findByText('There is already a dish called Dal Tadka.')).toBeInTheDocument();
    // On the field itself, not only somewhere on the sheet: that is what tells reception which input to change.
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(/The messages are next to the fields/)).not.toBeInTheDocument();
  });

  it('field-by-field refusals land beside their fields, with a pointer from the top', async () => {
    setup({ 'PUT /admin/menu/items/m1': { status: 400, body: { success: false, code: 'INVALID_ITEM', errors: [{ field: 'price', message: 'The hub says that price is too high.' }] } } });
    const price = screen.getByLabelText('Price (₹)');
    await userEvent.clear(price);
    await userEvent.type(price, '999');
    await save();

    expect(await screen.findByText('The hub says that price is too high.')).toBeInTheDocument();
    expect(screen.getByText(/The messages are next to the fields/)).toBeInTheDocument();
  });

  it('while a save is in flight it cannot be sent twice or cancelled', async () => {
    const gate = deferred();
    const { hub } = setup({ 'PUT /admin/menu/items/m1': () => gate.promise.then(() => SAVED) });
    await userEvent.click(screen.getByRole('switch', { name: 'Available' }));
    await save();

    expect(screen.getByRole('button', { name: /Save changes/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(hub.calls('PUT /admin/menu/items/m1')).toHaveLength(1);
    gate.resolve();
  });
});

describe('item editor — adding an item', () => {
  it('starts empty in the category being looked at, and says it is a new dish', () => {
    setup({}, { item: null });
    expect(screen.getByText('New item')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Category')).toHaveValue('Mains');
    expect(screen.getByRole('button', { name: 'Add item' })).toBeEnabled();
  });

  it('refuses to add one with no name, no price or no veg choice', async () => {
    const { hub } = setup({}, { item: null });
    await save();
    expect(await screen.findByText(/Name is required/)).toBeInTheDocument();
    expect(screen.getByText(/Price must be above 0/)).toBeInTheDocument();
    expect(screen.getByText('Choose Veg or Non-veg.')).toBeInTheDocument();
    expect(hub.all()).toHaveLength(0);
  });

  it('sends what was typed, without empty lists the hub would only have to throw away', async () => {
    const { hub, onSaved } = setup({ 'POST /admin/menu/items': { status: 201, body: { success: true, revision: 8 } } }, { item: null });
    await userEvent.type(screen.getByLabelText('Name'), '  Masala Chai ');
    await userEvent.type(screen.getByLabelText('Price (₹)'), '40');
    await userEvent.click(screen.getByRole('radio', { name: 'Veg' }));
    await save();

    const body = hub.calls('POST /admin/menu/items')[0].body;
    expect(body.base_revision).toBe(7);
    expect(body.item).toMatchObject({ name: 'Masala Chai', price: 40, category: 'Mains', isVeg: true });
    expect(body.item).not.toHaveProperty('variants');
    expect(body.item).not.toHaveProperty('modifier_groups');
    expect(body.item).not.toHaveProperty('day_parts');
    expect(onSaved).toHaveBeenCalledWith('Added “Masala Chai”.');
  });

  it('a menu with no categories yet asks for a new one rather than offering an empty list', () => {
    setup({}, { item: null, menu: { revision: 1, categories: [], items: [] }, defaultCategory: '' });
    expect(screen.getByPlaceholderText('New category name')).toBeInTheDocument();
  });
});

describe('item editor — leaving, and deleting', () => {
  it('closing an untouched editor just closes it', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closing with changes asks first, and keeping the editor keeps what was typed', async () => {
    const { onClose } = setup();
    await userEvent.type(screen.getByLabelText('Name'), ' Special');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    const dialog = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Biryani Special');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' })).getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deleting asks first, then deletes against the revision, and says so', async () => {
    const { hub, onSaved } = setup({ 'DELETE /admin/menu/items/m1': SAVED });
    await userEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    const dialog = await screen.findByRole('dialog', { name: /Delete .Biryani.\?/ });
    expect(within(dialog).getByText(/Bills that are already open keep their lines/)).toBeInTheDocument();
    expect(hub.calls('DELETE /admin/menu/items/m1')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(hub.calls('DELETE /admin/menu/items/m1')[0].url.searchParams.get('base_revision')).toBe('7');
    expect(onSaved).toHaveBeenCalledWith('Deleted “Biryani”.');
  });

  it('a delete the hub refuses closes the question and says why', async () => {
    setup({ 'DELETE /admin/menu/items/m1': { status: 400, body: { success: false, code: 'ERROR', error: 'That dish is on an open bill.' } } });
    await userEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: /Delete/ })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('That dish is on an open bill.')).toBeInTheDocument();
  });

  it('a new item has nothing to delete', () => {
    setup({}, { item: null });
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
  });
});
