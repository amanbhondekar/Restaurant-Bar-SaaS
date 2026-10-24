import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InventoryTab } from '@/admin/InventoryTab';
import { fakeHub } from '../helpers/fakeHub';

// Reception's stock and recipes screen. The hub owns the figures; what matters here is what the
// screen asks the hub to do, what it says when the hub refuses, and that it never invites a mistake.

const PANEER = { id: 'ing_p', name: 'Paneer', unit: 'g', on_hand: 800, low_at: 200, level: 'ok' };
const ONION = { id: 'ing_o', name: 'Onion', unit: 'kg', on_hand: 0.4, low_at: 0.5, level: 'low' };
const RICE = { id: 'ing_r', name: 'Rice', unit: 'kg', on_hand: 0, low_at: 1, level: 'out' };

const snapshot = (over = {}) => ({
  success: true, restaurant_id: 'r', revision: 5, units: ['g', 'kg', 'ml', 'l', 'pcs'],
  items: [PANEER, ONION, RICE],
  recipes: [{ id: 'rec_1', item_id: 'paneer', variant_id: null, item_name: 'Paneer Tikka', on_menu: true, lines: [{ inventory_item_id: 'ing_p', qty: 150 }, { inventory_item_id: 'ing_o', qty: 0.1 }] }],
  summary: { ingredients: 3, out: 1, low: 1, recipes: 1 },
  ...over
});
const MENU = {
  revision: 4,
  items: [
    { id: 'paneer', name: 'Paneer Tikka', price: 280 },
    { id: 'dal', name: 'Dal Tadka', price: 220 },
    { id: 'bir', name: 'Biryani', price: 260, variants: [{ id: 'h', label: 'Half', price: 260 }, { id: 'f', label: 'Full', price: 480 }] }
  ]
};

const setup = (routes = {}, props = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({
    'GET /admin/inventory': { body: snapshot() },
    'GET /menu': { body: MENU },
    ...routes
  });
  render(<InventoryTab menu={MENU} notify={notify} {...props} />);
  return { hub, notify };
};
const ingredientRow = name => screen.getByText(name, { selector: 'span.font-semibold' }).closest('li');

describe('inventory tab — stock', () => {
  it('lists each ingredient with how much is on hand and its level', async () => {
    setup();
    expect(await screen.findByText('Paneer')).toBeInTheDocument();
    const paneer = ingredientRow('Paneer');
    expect(within(paneer).getByText('In stock')).toBeInTheDocument();
    expect(within(paneer).getByText(/800 g on hand · warns at 200 g/)).toBeInTheDocument();
    expect(within(ingredientRow('Onion')).getByText('Low')).toBeInTheDocument();
    expect(within(ingredientRow('Rice')).getByText('Out')).toBeInTheDocument();
    expect(within(ingredientRow('Rice')).getByText(/0 kg on hand/)).toBeInTheDocument();
  });

  it('summarises the lot in the header', async () => {
    setup();
    expect(await screen.findByText('3 ingredients · 1 low · 1 out of stock · 1 recipe')).toBeInTheDocument();
  });

  it('names the dishes that cannot be ordered right now, and says they return by themselves', async () => {
    setup({ 'GET /menu': { body: { ...MENU, items: [{ ...MENU.items[0], stock_out: true }, MENU.items[1], { ...MENU.items[2], variants: [MENU.items[2].variants[0], { ...MENU.items[2].variants[1], stock_out: true }] }] } } });
    const banner = await screen.findByText('Out of stock right now');
    expect(banner.parentElement).toHaveTextContent('Paneer Tikka and Biryani · Full cannot be ordered until restocked.');
    expect(banner.parentElement).toHaveTextContent('They come back on their own');
  });

  it('shows no banner when everything can be made', async () => {
    setup();
    await screen.findByText('Paneer');
    expect(screen.queryByText('Out of stock right now')).not.toBeInTheDocument();
  });

  it('with nothing set up, explains what to do and that untracked dishes are never held up', async () => {
    setup({ 'GET /admin/inventory': { body: snapshot({ items: [], recipes: [], summary: { ingredients: 0, out: 0, low: 0, recipes: 0 } }) } });
    expect(await screen.findByText('No ingredients yet')).toBeInTheDocument();
    expect(screen.getByText(/never held up by stock/)).toBeInTheDocument();
  });

  it('when the hub cannot be reached, says so and offers to try again', async () => {
    const { hub } = setup({ 'GET /admin/inventory': ({ call }) => (call === 1 ? new TypeError('Failed to fetch') : { body: snapshot() }) });
    expect(await screen.findByText('Could not load stock')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Paneer')).toBeInTheDocument();
    expect(hub.calls('GET /admin/inventory')).toHaveLength(2);
  });
});

describe('inventory tab — adding and editing', () => {
  it('adds an ingredient with exactly what was typed, then reloads and says so', async () => {
    const { hub, notify } = setup({ 'POST /admin/inventory/items': { status: 201, body: { success: true, revision: 6, item: {} } } });
    await screen.findByText('Paneer');
    await userEvent.click(screen.getByRole('button', { name: /Add ingredient/ }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), '  Cashew  ');
    await userEvent.selectOptions(within(dialog).getByLabelText('Counted in'), 'kg');
    await userEvent.type(within(dialog).getByLabelText('On hand now'), '2.5');
    await userEvent.type(within(dialog).getByLabelText('Warn me when it gets low'), '0.5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient' }));

    expect(hub.calls('POST /admin/inventory/items')[0].body).toEqual({ item: { name: 'Cashew', unit: 'kg', on_hand: 2.5, low_at: 0.5, par: 0, unit_cost: null } });
    expect(notify).toHaveBeenCalledWith('Cashew added.');
    expect(hub.calls('GET /admin/inventory').length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not send a form with a mistake in it, and shows the mistake beside the field', async () => {
    const { hub } = setup();
    await screen.findByText('Paneer');
    await userEvent.click(screen.getByRole('button', { name: /Add ingredient/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('On hand now'), '-3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient' }));

    expect(within(dialog).getByText('Give it a name.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Use digits only/)).toBeInTheDocument();
    expect(hub.calls('POST /admin/inventory/items')).toHaveLength(0);
  });

  it('refuses a name already on the list before asking the hub', async () => {
    const { hub } = setup();
    await screen.findByText('Paneer');
    await userEvent.click(screen.getByRole('button', { name: /Add ingredient/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'paneer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient' }));
    expect(within(dialog).getByText('"paneer" is already on the list.')).toBeInTheDocument();
    expect(hub.calls('POST /admin/inventory/items')).toHaveLength(0);
  });

  it('when the hub refuses, its own words appear in the dialog and the dialog stays open', async () => {
    setup({ 'POST /admin/inventory/items': { status: 409, body: { success: false, code: 'DUPLICATE_INGREDIENT', error: '"Cashew" already exists.' } } });
    await screen.findByText('Paneer');
    await userEvent.click(screen.getByRole('button', { name: /Add ingredient/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cashew');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient' }));
    expect(await within(dialog).findByText('"Cashew" already exists.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('editing offers no way to change how much is on hand, and explains why', async () => {
    const { hub } = setup({ 'PUT /admin/inventory/items/ing_p': { body: { success: true, revision: 6, item: {} } } });
    await screen.findByText('Paneer');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Paneer' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('On hand now')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/record a delivery, waste or a count instead/)).toBeInTheDocument();

    const low = within(dialog).getByLabelText('Warn me when it gets low');
    await userEvent.clear(low);
    await userEvent.type(low, '300');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(hub.calls('PUT /admin/inventory/items/ing_p')[0].body).toEqual({ item: { name: 'Paneer', unit: 'g', low_at: 300, par: 0, unit_cost: null } });
  });
});

describe('inventory tab — deliveries, waste and counts', () => {
  const open = async name => {
    await screen.findByText('Paneer');
    return within(ingredientRow('Paneer')).getByRole('button', { name });
  };

  it('a delivery previews what will be on hand, then sends the kind, quantity and note', async () => {
    const { hub, notify } = setup({ 'POST /admin/inventory/items/ing_p/adjust': { body: { success: true, revision: 6, item: {}, delta: 1500 } } });
    await userEvent.click(await open('Delivery'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/On hand now: 800 g/)).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText(/Quantity received/), '1500');
    expect(within(dialog).getByText('2,300 g')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'Tuesday delivery');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    expect(hub.calls('POST /admin/inventory/items/ing_p/adjust')[0].body).toEqual({ kind: 'receive', qty: 1500, note: 'Tuesday delivery' });
    expect(notify).toHaveBeenCalledWith('Paneer updated.');
  });

  it('waste cannot be more than is on hand: the button is disabled and the reason is given', async () => {
    const { hub } = setup();
    await userEvent.click(await open('Waste'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Quantity wasted/), '900');

    expect(within(dialog).getByText(/Only 800 g is on hand/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(hub.calls('POST /admin/inventory/items/ing_p/adjust')).toHaveLength(0);
  });

  it('a count may be zero, and replaces the figure', async () => {
    const { hub } = setup({ 'POST /admin/inventory/items/ing_p/adjust': { body: { success: true, revision: 6, item: {}, delta: -800 } } });
    await userEvent.click(await open('Count'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Quantity counted/), '0');
    expect(within(dialog).getByText('0 g')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set' }));
    expect(hub.calls('POST /admin/inventory/items/ing_p/adjust')[0].body).toEqual({ kind: 'count', qty: 0 });
  });

  it('nothing is sent until a valid quantity has been typed', async () => {
    const { hub } = setup();
    await userEvent.click(await open('Delivery'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Quantity received/), 'ten');
    expect(within(dialog).getByText(/Use digits only/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(hub.calls('POST /admin/inventory/items/ing_p/adjust')).toHaveLength(0);
  });

  it('history lists the latest changes in words, newest first', async () => {
    setup({
      'GET /admin/inventory/movements': {
        body: {
          success: true,
          movements: [
            { id: 'm2', at: '2026-10-19T12:00:00Z', inventory_item_id: 'ing_p', reason: 'sale', delta: -300, on_hand_after: 800, ref: '#142' },
            { id: 'm1', at: '2026-10-19T09:00:00Z', inventory_item_id: 'ing_p', reason: 'receive', delta: 1100, on_hand_after: 1100, note: 'Delivery', by: 'Reception' }
          ]
        }
      }
    });
    await userEvent.click(await open('History of Paneer'));
    const dialog = await screen.findByRole('dialog');
    const items = await within(dialog).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Used in orders');
    expect(items[0]).toHaveTextContent('−300 g');
    expect(items[0]).toHaveTextContent('Ticket #142');
    expect(items[1]).toHaveTextContent('+1,100 g');
  });
});

describe('inventory tab — deleting', () => {
  it('asks first, then deletes', async () => {
    const { hub, notify } = setup({ 'DELETE /admin/inventory/items/ing_r': { body: { success: true, revision: 6 } } });
    await screen.findByText('Rice');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Rice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Rice?')).toBeInTheDocument();
    expect(hub.calls('DELETE /admin/inventory/items/ing_r')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(hub.calls('DELETE /admin/inventory/items/ing_r')).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith('Rice deleted.');
  });

  it('an ingredient a recipe uses is refused, with the hub\'s reason shown where the question was asked', async () => {
    setup({ 'DELETE /admin/inventory/items/ing_p': { status: 409, body: { success: false, code: 'INGREDIENT_IN_USE', error: '"Paneer" is used in 1 recipe(s). Remove it from them first.' } } });
    await screen.findByText('Paneer');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Paneer' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByText(/is used in 1 recipe/)).toBeInTheDocument();
  });
});

describe('inventory tab — recipes', () => {
  const toRecipes = async () => {
    await screen.findByText('Paneer');
    await userEvent.click(screen.getByRole('button', { name: 'Recipes' }));
  };

  it('lists each recipe with what it uses', async () => {
    setup();
    await toRecipes();
    expect(await screen.findByText('Paneer Tikka')).toBeInTheDocument();
    expect(screen.getByText('Paneer 150 g · Onion 0.1 kg')).toBeInTheDocument();
  });

  it('flags a recipe for a dish that has left the menu, and offers no edit for it', async () => {
    setup({ 'GET /admin/inventory': { body: snapshot({ recipes: [{ id: 'rec_9', item_id: 'gone', variant_id: null, item_name: null, on_menu: false, lines: [{ inventory_item_id: 'ing_p', qty: 5 }] }] }) } });
    await toRecipes();
    expect(await screen.findByText('Not on the menu')).toBeInTheDocument();
    expect(screen.getByText('A dish that is no longer on the menu')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit the recipe for/ })).not.toBeInTheDocument();
  });

  it('sets up a recipe for a dish: choose the dish, list what one portion uses, save', async () => {
    const { hub, notify } = setup({ 'PUT /admin/inventory/recipes': { body: { success: true, revision: 6, recipe: {} } } });
    await toRecipes();
    await userEvent.click(screen.getByRole('button', { name: /Set up a recipe/ }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.selectOptions(within(dialog).getByLabelText('Dish'), 'dal|');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 1'), 'ing_o');
    await userEvent.type(within(dialog).getByLabelText('Quantity 1'), '0.2');
    await userEvent.click(within(dialog).getByRole('button', { name: /Add ingredient/ }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 2'), 'ing_p');
    await userEvent.type(within(dialog).getByLabelText('Quantity 2'), '50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));

    expect(hub.calls('PUT /admin/inventory/recipes')[0].body).toEqual({
      item_id: 'dal',
      lines: [{ inventory_item_id: 'ing_o', qty: 0.2 }, { inventory_item_id: 'ing_p', qty: 50 }]
    });
    expect(notify).toHaveBeenCalledWith('Recipe saved.');
  });

  it('a recipe for one size sends that size\'s id', async () => {
    const { hub } = setup({ 'PUT /admin/inventory/recipes': { body: { success: true, revision: 6, recipe: {} } } });
    await toRecipes();
    await userEvent.click(screen.getByRole('button', { name: /Set up a recipe/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Dish'), 'bir|f');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 1'), 'ing_r');
    await userEvent.type(within(dialog).getByLabelText('Quantity 1'), '0.4');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));
    expect(hub.calls('PUT /admin/inventory/recipes')[0].body).toEqual({ item_id: 'bir', variant_id: 'f', lines: [{ inventory_item_id: 'ing_r', qty: 0.4 }] });
  });

  it('mistakes in the lines are shown on the line and nothing is sent', async () => {
    const { hub } = setup();
    await toRecipes();
    await userEvent.click(screen.getByRole('button', { name: /Set up a recipe/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Dish'), 'dal|');
    await userEvent.type(within(dialog).getByLabelText('Quantity 1'), '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));
    expect(within(dialog).getByText('Choose an ingredient.')).toBeInTheDocument();
    expect(hub.calls('PUT /admin/inventory/recipes')).toHaveLength(0);
  });

  it('editing an existing recipe starts from what it already says, and removing every line removes it', async () => {
    const { hub, notify } = setup({ 'PUT /admin/inventory/recipes': { body: { success: true, revision: 6, removed: true } } });
    await toRecipes();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit the recipe for Paneer Tikka' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Ingredient 1')).toHaveValue('ing_p');
    expect(within(dialog).getByLabelText('Quantity 1')).toHaveValue('150');
    expect(within(dialog).getByLabelText('Quantity 2')).toHaveValue('0.1');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove ingredient 2' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove ingredient 1' }));
    expect(within(dialog).getByText(/removes this recipe, and the dish stops being tracked/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));
    expect(hub.calls('PUT /admin/inventory/recipes')[0].body).toEqual({ item_id: 'paneer', lines: [] });
    expect(notify).toHaveBeenCalledWith('Recipe removed.');
  });

  it('with no ingredients yet, says to add some first instead of offering an empty recipe form', async () => {
    setup({ 'GET /admin/inventory': { body: snapshot({ items: [], recipes: [], summary: { ingredients: 0, out: 0, low: 0, recipes: 0 } }) } });
    await screen.findByText('No ingredients yet');
    await userEvent.click(screen.getByRole('button', { name: 'Recipes' }));
    expect(screen.getByText(/Add some ingredients first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set up a recipe/ })).toBeDisabled();
  });
});
