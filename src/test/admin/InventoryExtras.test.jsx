import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InventoryTab } from '@/admin/InventoryTab';
import {
  dishExtras, extraKey, recipeSubjects, recipeSummary, recipeToExtras, recipeToLines, validateRecipe
} from '@/admin/lib/inventory';
import { fakeHub } from '../helpers/fakeHub';

// Modifier choices that use stock (§4.2) on reception's Stock screen: "extra cheese uses 20 g of
// cheese", set on the dish's own recipe. The helpers first, then the dialog.

const PANEER = { id: 'ing_p', name: 'Paneer', unit: 'g', on_hand: 800, low_at: 200, level: 'ok' };
const CHEESE = { id: 'ing_c', name: 'Cheese', unit: 'g', on_hand: 300, low_at: 0, level: 'ok' };
const ONION = { id: 'ing_o', name: 'Onion', unit: 'kg', on_hand: 2, low_at: 0, level: 'ok' };
const INGREDIENTS = [PANEER, CHEESE, ONION];

const EXTRAS = {
  id: 'g_extras', label: 'Extras', min: 0, max: 2,
  options: [{ id: 'o_cheese', label: 'Extra cheese', price_delta: 30 }, { id: 'o_egg', label: 'Egg', price_delta: 20 }]
};
const MENU = {
  revision: 4,
  items: [
    { id: 'paneer', name: 'Paneer Tikka', price: 280, modifier_groups: [EXTRAS] },
    // Offers the very same group and options as the paneer: menus reuse extras across dishes.
    { id: 'tikki', name: 'Aloo Tikki', price: 120, modifier_groups: [EXTRAS] },
    { id: 'dal', name: 'Dal Tadka', price: 220 }
  ]
};

const CHEESE_KEY = extraKey('g_extras', 'o_cheese');
const line = (id, qty, option) => ({ inventory_item_id: id, qty, ...(option ? { group_id: option[0], option_id: option[1] } : {}) });

// --- the helpers ---------------------------------------------------------------------------------

describe('the extras a dish offers', () => {
  it('lists each choice with its name, its group and a key made of both ids', () => {
    expect(dishExtras(MENU.items[0])).toEqual([
      { key: CHEESE_KEY, group_id: 'g_extras', option_id: 'o_cheese', label: 'Extra cheese', group_label: 'Extras' },
      { key: extraKey('g_extras', 'o_egg'), group_id: 'g_extras', option_id: 'o_egg', label: 'Egg', group_label: 'Extras' }
    ]);
  });

  it('a dish with no choices, or nothing at all, offers none', () => {
    expect(dishExtras(MENU.items.find(i => i.id === 'dal'))).toEqual([]);
    expect(dishExtras(null)).toEqual([]);
    expect(dishExtras({ modifier_groups: 'x' })).toEqual([]);
    expect(dishExtras({ modifier_groups: [{ id: 'g', options: null }] })).toEqual([]);
  });

  it('the same option id in two groups is two different extras', () => {
    const item = { modifier_groups: [{ id: 'g1', label: 'A', options: [{ id: 'o', label: 'One' }] }, { id: 'g2', label: 'B', options: [{ id: 'o', label: 'Two' }] }] };
    expect(dishExtras(item).map(x => x.key)).toEqual(['g1|o', 'g2|o']);
  });

  it('every subject carries the extras of its dish, so a size can have its own', () => {
    const subjects = recipeSubjects([{ ...MENU.items[0], variants: [{ id: 'h', label: 'Half' }, { id: 'f', label: 'Full' }] }]);
    expect(subjects.map(s => s.extras.length)).toEqual([2, 2, 2]);
  });
});

describe('reading a recipe into the editor', () => {
  const recipe = { lines: [line('ing_p', 150), line('ing_c', 20, ['g_extras', 'o_cheese']), line('ing_o', 0.1, ['g_extras', 'o_cheese'])] };

  it('the dish\'s own ingredients and each extra\'s are separated', () => {
    expect(recipeToLines(recipe)).toEqual([{ inventory_item_id: 'ing_p', qty: '150' }]);
    expect(recipeToExtras(recipe)).toEqual({ [CHEESE_KEY]: [{ inventory_item_id: 'ing_c', qty: '20' }, { inventory_item_id: 'ing_o', qty: '0.1' }] });
  });

  it('a recipe with no extras has none', () => {
    expect(recipeToExtras({ lines: [line('ing_p', 150)] })).toEqual({});
  });
});

describe('the one-line summary', () => {
  const recipe = { lines: [line('ing_p', 150), line('ing_c', 20, ['g_extras', 'o_cheese'])] };

  it('says what the dish uses, then what each extra adds', () => {
    expect(recipeSummary(recipe, INGREDIENTS, dishExtras(MENU.items[0]))).toBe('Paneer 150 g · With Extra cheese: Cheese 20 g');
  });

  it('is the same line it always was for a recipe with no extras', () => {
    expect(recipeSummary({ lines: [line('ing_p', 150), line('ing_o', 0.1)] }, INGREDIENTS)).toBe('Paneer 150 g · Onion 0.1 kg');
  });

  it('falls back to the option id rather than hiding an extra whose name it cannot find', () => {
    expect(recipeSummary(recipe, INGREDIENTS)).toBe('Paneer 150 g · With o_cheese: Cheese 20 g');
  });

  it('says so when an extra\'s ingredient has since been removed', () => {
    expect(recipeSummary({ lines: [line('ing_gone', 5, ['g_extras', 'o_cheese'])] }, INGREDIENTS, dishExtras(MENU.items[0]))).toBe('With Extra cheese: (removed ingredient)');
  });
});

describe('checking the whole editor', () => {
  const offered = dishExtras(MENU.items[0]);
  const row = (id, qty) => ({ inventory_item_id: id, qty });

  it('sends the dish\'s lines, then each extra\'s with its group and its choice', () => {
    const { errors, extraErrors, payload } = validateRecipe([row('ing_p', '150')], { [CHEESE_KEY]: [row('ing_c', '20')] }, offered, INGREDIENTS);
    expect(errors).toEqual({});
    expect(extraErrors).toEqual({});
    expect(payload).toEqual([line('ing_p', 150), line('ing_c', 20, ['g_extras', 'o_cheese'])]);
  });

  it('the same ingredient may be in the dish and in an extra -- that is how "extra" cheese works', () => {
    const { errors, extraErrors } = validateRecipe([row('ing_c', '30')], { [CHEESE_KEY]: [row('ing_c', '20')] }, offered, INGREDIENTS);
    expect([errors, extraErrors]).toEqual([{}, {}]);
  });

  it('but not twice in the same extra', () => {
    const { extraErrors } = validateRecipe([], { [CHEESE_KEY]: [row('ing_c', '20'), row('ing_c', '10')] }, offered, INGREDIENTS);
    expect(extraErrors[CHEESE_KEY][1].ingredient).toMatch(/once/);
  });

  it('a mistake in an extra is reported against that extra and not the dish', () => {
    const { errors, extraErrors } = validateRecipe([row('ing_p', '150')], { [CHEESE_KEY]: [row('', '20'), row('ing_c', 'lots')] }, offered, INGREDIENTS);
    expect(errors).toEqual({});
    expect(Object.keys(extraErrors[CHEESE_KEY]).sort()).toEqual(['0', '1']);
  });

  it('rows for an extra the dish no longer offers are left out, not sent to be refused', () => {
    const { payload } = validateRecipe([row('ing_p', '150')], { 'g_extras|o_gone': [row('ing_c', '20')] }, offered, INGREDIENTS);
    expect(payload).toEqual([line('ing_p', 150)]);
  });

  it('an extra with no rows adds nothing, and an editor with nothing at all sends nothing (which removes the recipe)', () => {
    expect(validateRecipe([], { [CHEESE_KEY]: [] }, offered, INGREDIENTS).payload).toEqual([]);
  });

  it('counts the extras toward the 30-line limit the hub enforces', () => {
    const many = Array.from({ length: 16 }, () => row('ing_p', '1'));
    const { errors } = validateRecipe(many.map((r, i) => ({ ...r, inventory_item_id: `ing_${i}` })), {}, offered, Array.from({ length: 16 }, (_, i) => ({ id: `ing_${i}`, name: String(i), unit: 'g' })));
    expect(errors.form).toBeUndefined();
    const ings = Array.from({ length: 32 }, (_, i) => ({ id: `i${i}`, name: String(i), unit: 'g' }));
    const base = ings.slice(0, 16).map(i => row(i.id, '1'));
    const extra = ings.slice(16, 32).map(i => row(i.id, '1'));
    expect(validateRecipe(base, { [CHEESE_KEY]: extra }, offered, ings).errors.form).toMatch(/30/);
  });
});

// --- the dialog ------------------------------------------------------------------------------------------

const snapshot = (over = {}) => ({
  success: true, restaurant_id: 'r', revision: 5, units: ['g', 'kg', 'ml', 'l', 'pcs'],
  items: INGREDIENTS, recipes: [],
  summary: { ingredients: 3, out: 0, low: 0, recipes: 0 },
  ...over
});
const setup = (routes = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({ 'GET /admin/inventory': { body: snapshot() }, 'GET /menu': { body: MENU }, ...routes });
  render(<InventoryTab menu={MENU} notify={notify} />);
  return { hub, notify };
};
const openRecipes = async () => {
  await screen.findByText('Paneer');
  await userEvent.click(screen.getByRole('button', { name: 'Recipes' }));
};
const newRecipeFor = async key => {
  await openRecipes();
  await userEvent.click(screen.getByRole('button', { name: /Set up a recipe/ }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.selectOptions(within(dialog).getByLabelText('Dish'), key);
  return dialog;
};
const SAVED = { 'PUT /admin/inventory/recipes': { body: { success: true, revision: 6, recipe: {} } } };

describe('the recipe dialog — extras', () => {
  it('a dish with choices offers them, each closed until it has something in it', async () => {
    setup();
    const dialog = await newRecipeFor('paneer|');
    expect(within(dialog).getByText('Extras', { selector: 'legend' })).toBeInTheDocument();
    for (const name of ['Extra cheese', 'Egg']) {
      const summary = within(dialog).getByText(name, { selector: 'summary' });
      expect(summary.closest('details')).not.toHaveAttribute('open');
    }
    expect(within(dialog).getByText(/Leave it empty and the choice uses no stock/)).toBeInTheDocument();
  });

  it('a dish with no choices has no Extras section at all', async () => {
    setup();
    const dialog = await newRecipeFor('dal|');
    expect(within(dialog).queryByText('Extras', { selector: 'legend' })).not.toBeInTheDocument();
  });

  it('saving sends the dish\'s lines, then the extra\'s with its group and choice', async () => {
    const { hub, notify } = setup(SAVED);
    const dialog = await newRecipeFor('paneer|');
    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 1'), 'ing_p');
    await userEvent.type(within(dialog).getByLabelText('Quantity 1'), '150');

    await userEvent.click(within(dialog).getByText('Extra cheese', { selector: 'summary' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient for Extra cheese' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 1 for Extra cheese'), 'ing_c');
    await userEvent.type(within(dialog).getByLabelText('Quantity 1 for Extra cheese'), '20');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));

    expect(hub.calls('PUT /admin/inventory/recipes')[0].body).toEqual({
      item_id: 'paneer',
      lines: [
        { inventory_item_id: 'ing_p', qty: 150 },
        { inventory_item_id: 'ing_c', qty: 20, group_id: 'g_extras', option_id: 'o_cheese' }
      ]
    });
    expect(notify).toHaveBeenCalledWith('Recipe saved.');
  });

  it('a dish that uses nothing of its own can still have an extra that does', async () => {
    const { hub } = setup(SAVED);
    const dialog = await newRecipeFor('paneer|');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove ingredient 1' }));
    await userEvent.click(within(dialog).getByText('Egg', { selector: 'summary' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient for Egg' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 1 for Egg'), 'ing_o');
    await userEvent.type(within(dialog).getByLabelText('Quantity 1 for Egg'), '0.05');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));

    expect(hub.calls('PUT /admin/inventory/recipes')[0].body.lines).toEqual([
      { inventory_item_id: 'ing_o', qty: 0.05, group_id: 'g_extras', option_id: 'o_egg' }
    ]);
  });

  it('switching to another dish does not carry the first dish\'s extras over, even when both offer the same choice', async () => {
    const { hub } = setup(SAVED);
    const dialog = await newRecipeFor('paneer|');
    await userEvent.click(within(dialog).getByText('Extra cheese', { selector: 'summary' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient for Extra cheese' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 1 for Extra cheese'), 'ing_c');
    await userEvent.type(within(dialog).getByLabelText('Quantity 1 for Extra cheese'), '20');

    await userEvent.selectOptions(within(dialog).getByLabelText('Dish'), 'tikki|');
    expect(within(dialog).getByText('Extra cheese', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');

    await userEvent.selectOptions(within(dialog).getByLabelText('Ingredient 1'), 'ing_p');
    await userEvent.type(within(dialog).getByLabelText('Quantity 1'), '100');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));
    expect(hub.calls('PUT /admin/inventory/recipes')[0].body).toEqual({ item_id: 'tikki', lines: [{ inventory_item_id: 'ing_p', qty: 100 }] });
  });

  it('a mistake in an extra is shown on that row, and nothing is sent', async () => {
    const { hub } = setup(SAVED);
    const dialog = await newRecipeFor('paneer|');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove ingredient 1' }));
    await userEvent.click(within(dialog).getByText('Extra cheese', { selector: 'summary' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient for Extra cheese' }));
    await userEvent.type(within(dialog).getByLabelText('Quantity 1 for Extra cheese'), '20');   // no ingredient chosen
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save recipe' }));

    expect(await within(dialog).findByText('Choose an ingredient.')).toBeInTheDocument();
    expect(hub.calls('PUT /admin/inventory/recipes')).toHaveLength(0);
  });

  it('editing a recipe opens the extras that already use stock, filled in', async () => {
    const recipes = [{
      id: 'rec_1', item_id: 'paneer', variant_id: null, item_name: 'Paneer Tikka', on_menu: true,
      lines: [line('ing_p', 150), line('ing_c', 20, ['g_extras', 'o_cheese'])]
    }];
    setup({ 'GET /admin/inventory': { body: snapshot({ recipes, summary: { ingredients: 3, out: 0, low: 0, recipes: 1 } }) } });
    await openRecipes();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit the recipe for Paneer Tikka' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByLabelText('Quantity 1')).toHaveValue('150');
    expect(within(dialog).getByText('Extra cheese', { selector: 'summary' }).closest('details')).toHaveAttribute('open');
    expect(within(dialog).getByLabelText('Ingredient 1 for Extra cheese')).toHaveValue('ing_c');
    expect(within(dialog).getByLabelText('Quantity 1 for Extra cheese')).toHaveValue('20');
    expect(within(dialog).getByText('Egg', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
  });

  it('clearing the dish\'s lines but leaving an extra does not warn that the recipe will be removed', async () => {
    const recipes = [{
      id: 'rec_1', item_id: 'paneer', variant_id: null, item_name: 'Paneer Tikka', on_menu: true,
      lines: [line('ing_p', 150), line('ing_c', 20, ['g_extras', 'o_cheese'])]
    }];
    setup({ 'GET /admin/inventory': { body: snapshot({ recipes, summary: { ingredients: 3, out: 0, low: 0, recipes: 1 } }) } });
    await openRecipes();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit the recipe for Paneer Tikka' }));
    const dialog = await screen.findByRole('dialog');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove ingredient 1' }));
    expect(within(dialog).queryByText(/removes this recipe/)).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove ingredient 1 for Extra cheese' }));
    expect(within(dialog).getByText(/removes this recipe, and the dish stops being tracked/)).toBeInTheDocument();
  });

  it('the recipes list says what each extra adds, by the name reception gave it', async () => {
    const recipes = [{
      id: 'rec_1', item_id: 'paneer', variant_id: null, item_name: 'Paneer Tikka', on_menu: true,
      lines: [line('ing_p', 150), line('ing_c', 20, ['g_extras', 'o_cheese'])]
    }];
    setup({ 'GET /admin/inventory': { body: snapshot({ recipes, summary: { ingredients: 3, out: 0, low: 0, recipes: 1 } }) } });
    await openRecipes();
    expect(await screen.findByText('Paneer 150 g · With Extra cheese: Cheese 20 g')).toBeInTheDocument();
  });
});
