import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InventoryTab } from '@/admin/InventoryTab';
import {
  parseCost, rupees, validateIngredientForm, ingredientToForm, blankIngredient, pricingNote, costLine, reorderText, reorderTotalLine, recipeSubjects
} from '@/admin/lib/inventory';
import { fakeHub } from '../helpers/fakeHub';

// Cost, "stock up to" and the shopping list on reception's Stock screen. The rule the wording keeps: a
// figure that is only part of the truth says so, and never produces a percentage that flatters the dish.

describe('money and costs, typed', () => {
  it('rupees use Indian grouping, show paise only when there are some, and are blank for nonsense', () => {
    expect([rupees(1080), rupees(49.5), rupees(0), rupees(1234567.8)]).toEqual(['₹1,080', '₹49.5', '₹0', '₹12,34,567.8']);
    expect(rupees('x')).toBe('');
  });

  it('a cost may be empty -- which means "not costed", not free -- or digits with up to four decimals', () => {
    expect(parseCost('')).toEqual({ ok: true, value: null });
    expect(parseCost('   ')).toEqual({ ok: true, value: null });
    expect(parseCost('0')).toEqual({ ok: true, value: 0 });
    expect(parseCost('0.4567')).toEqual({ ok: true, value: 0.4567 });
    expect(parseCost('₹ 90')).toEqual({ ok: true, value: 90 });
  });

  it('a cost that is not a cost says what is wrong', () => {
    expect(parseCost('cheap').ok).toBe(false);
    expect(parseCost('-5').ok).toBe(false);
    expect(parseCost('1,5').ok).toBe(false);
    expect(parseCost('0.00001').error).toMatch(/At most 4 decimal places/);
    expect(parseCost('2000000').error).toMatch(/more than the hub accepts/);
  });
});

describe('the ingredient form, with cost and stock-up-to', () => {
  const form = over => ({ ...blankIngredient(), name: 'Paneer', ...over });

  it('both are optional, and an empty form sends "none set" for each', () => {
    const { errors, payload } = validateIngredientForm(form());
    expect(errors).toEqual({});
    expect([payload.par, payload.unit_cost]).toEqual([0, null]);
  });

  it('what is typed is sent as numbers', () => {
    const { payload } = validateIngredientForm(form({ low_at: '2', par: '10', unit_cost: '300' }));
    expect([payload.low_at, payload.par, payload.unit_cost]).toEqual([2, 10, 300]);
  });

  it('a stock-up-to level at or below the warning level is refused beside the field', () => {
    expect(validateIngredientForm(form({ low_at: '5', par: '5' })).errors.par).toMatch(/Must be more than the warning level/);
    expect(validateIngredientForm(form({ low_at: '5', par: '3' })).errors.par).toMatch(/Must be more than the warning level/);
    expect(validateIngredientForm(form({ low_at: '5', par: '6' })).errors).toEqual({});
    expect(validateIngredientForm(form({ par: '6' })).errors).toEqual({});
  });

  it('a bad warning level is reported once, not twice via the stock-up-to level', () => {
    const { errors } = validateIngredientForm(form({ low_at: 'x', par: '3' }));
    expect(Object.keys(errors)).toEqual(['low_at']);
  });

  it('opening one for editing shows what is set, and empty where nothing is', () => {
    expect(ingredientToForm({ name: 'A', unit: 'kg', low_at: 2, par: 10, unit_cost: 90 })).toMatchObject({ par: '10', unit_cost: '90' });
    expect(ingredientToForm({ name: 'A', unit: 'kg', low_at: 0, par: 0, unit_cost: null })).toMatchObject({ par: '', unit_cost: '' });
    expect(ingredientToForm({ name: 'A', unit: 'kg', low_at: 0, unit_cost: 0 }).unit_cost).toBe('0');
  });

  it('emptying the cost sends null on an edit, which is how a cost is taken away', () => {
    const { payload } = validateIngredientForm({ ...ingredientToForm({ name: 'A', unit: 'kg', low_at: 0, unit_cost: 90 }), unit_cost: '' }, { editing: true });
    expect(payload.unit_cost).toBeNull();
  });

  it('the figures under an ingredient: cost per unit, and where it stocks up to', () => {
    expect(pricingNote({ unit: 'kg', unit_cost: 90, par: 10 })).toBe('₹90 per kg · stocks up to 10 kg');
    expect(pricingNote({ unit: 'kg', unit_cost: 0, par: 0 })).toBe('₹0 per kg');
    expect(pricingNote({ unit: 'kg', unit_cost: null, par: 0 })).toBe('');
  });
});

describe('what a portion costs, in words', () => {
  const subject = { price: 260, extras: [{ key: 'g|cheese', label: 'Extra cheese' }] };

  it('a complete cost gives the cost and its share of the price', () => {
    expect(costLine({ cost: { cost: 65, complete: true, extras: {} } }, subject)).toBe('Costs ₹65 a portion · 25% of the ₹260 price');
  });

  it('a cost with a missing ingredient says "at least" and gives NO percentage', () => {
    const line = costLine({ cost: { cost: 27, complete: false, extras: {} } }, subject);
    expect(line).toBe('At least ₹27 a portion (some ingredients have no cost)');
    expect(line).not.toMatch(/%/);
  });

  it('when nothing is costed at all it says so rather than showing ₹0', () => {
    expect(costLine({ cost: { cost: 0, complete: false, extras: {} } }, subject)).toBe('No costs entered for these ingredients yet.');
  });

  it('a genuinely free dish is "₹0", because free is known', () => {
    expect(costLine({ cost: { cost: 0, complete: true, extras: {} } }, subject)).toMatch(/^Costs ₹0 a portion/);
  });

  it('with no price to compare, the cost is given without a share (a recipe for every size)', () => {
    expect(costLine({ cost: { cost: 65, complete: true, extras: {} } }, { price: null, extras: [] })).toBe('Costs ₹65 a portion');
  });

  it('an extra says what it adds, by its name, and whether that too is only a floor', () => {
    const line = costLine({ cost: { cost: 65, complete: true, extras: { 'g|cheese': { cost: 10, complete: true } } } }, subject);
    expect(line).toBe('Costs ₹65 a portion · 25% of the ₹260 price · Extra cheese adds ₹10');
    expect(costLine({ cost: { cost: 65, complete: true, extras: { 'g|cheese': { cost: 4, complete: false } } } }, subject)).toMatch(/Extra cheese adds at least ₹4/);
  });

  it('a recipe the hub did not cost shows nothing', () => {
    expect(costLine({}, subject)).toBe('');
    expect(costLine(undefined, subject)).toBe('');
  });

  it('subjects carry the price of the dish or the size, and none for "every size"', () => {
    const subjects = recipeSubjects([{ id: 'dal', name: 'Dal', price: 220 }, { id: 'bir', name: 'Biryani', variants: [{ id: 'h', label: 'Half', price: 260 }, { id: 'f', label: 'Full', price: 480 }] }]);
    expect(subjects.map(s => [s.label, s.price])).toEqual([['Dal', 220], ['Biryani · every size', null], ['Biryani · Half', 260], ['Biryani · Full', 480]]);
  });
});

describe('the shopping list, in words', () => {
  const reorder = {
    items: [
      { id: 'a', name: 'Onion', unit: 'kg', on_hand: 0, low_at: 3, suggested: 12, estimated_cost: 480, level: 'out' },
      { id: 'b', name: 'Oil', unit: 'l', on_hand: 1, low_at: 2, suggested: null, estimated_cost: null, level: 'low' }
    ],
    estimated_total: 480, unpriced: 1
  };

  it('as text a supplier can read: what, and how much, and "how much?" where reception has not said', () => {
    expect(reorderText(reorder, '22/10/2026')).toBe('Shopping list — 22/10/2026\n- Onion: 12 kg\n- Oil: (how much?)');
  });

  it('an empty list is empty text, so nothing is offered to send', () => {
    expect(reorderText({ items: [] })).toBe('');
    expect(reorderText(undefined)).toBe('');
  });

  it('the total says what it leaves out, so it is never mistaken for the whole bill', () => {
    expect(reorderTotalLine(reorder)).toBe('About ₹480 for 1 of 2 items, not counting the 1 without a cost or a quantity.');
  });

  it('when everything is priced it just says what it comes to', () => {
    expect(reorderTotalLine({ items: [reorder.items[0]], estimated_total: 480, unpriced: 0 })).toBe('About ₹480 for 1 of 1 item.');
  });

  it('when nothing can be priced it says what to fill in, not "about ₹0"', () => {
    expect(reorderTotalLine({ items: [reorder.items[1]], estimated_total: 0, unpriced: 1 })).toMatch(/Add a cost and a stock-up-to level/);
  });
});

// --- the screen -----------------------------------------------------------------------------------------

const ONION = { id: 'ing_o', name: 'Onion', unit: 'kg', on_hand: 0, low_at: 3, par: 12, unit_cost: 40, level: 'out' };
const OIL = { id: 'ing_l', name: 'Oil', unit: 'l', on_hand: 1, low_at: 2, par: 0, unit_cost: null, level: 'low' };
const RICE = { id: 'ing_r', name: 'Rice', unit: 'kg', on_hand: 8, low_at: 1, par: 20, unit_cost: 90, level: 'ok' };
const REORDER = {
  items: [
    { id: 'ing_o', name: 'Onion', unit: 'kg', on_hand: 0, low_at: 3, par: 12, unit_cost: 40, level: 'out', suggested: 12, estimated_cost: 480 },
    { id: 'ing_l', name: 'Oil', unit: 'l', on_hand: 1, low_at: 2, par: 0, unit_cost: null, level: 'low', suggested: null, estimated_cost: null }
  ],
  estimated_total: 480, unpriced: 1
};
const snapshot = (over = {}) => ({
  success: true, restaurant_id: 'r', revision: 3, units: ['g', 'kg', 'ml', 'l', 'pcs'],
  items: [ONION, OIL, RICE],
  recipes: [{ id: 'rec_1', item_id: 'dal', variant_id: null, item_name: 'Dal Tadka', on_menu: true, lines: [{ inventory_item_id: 'ing_r', qty: 0.3 }], cost: { cost: 27, complete: true, extras: {} } }],
  reorder: REORDER,
  summary: { ingredients: 3, out: 1, low: 1, reorder: 2, recipes: 1 },
  ...over
});
const MENU = { revision: 1, items: [{ id: 'dal', name: 'Dal Tadka', price: 220 }] };
const setup = (routes = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({ 'GET /admin/inventory': { body: snapshot() }, 'GET /menu': { body: MENU }, ...routes });
  render(<InventoryTab menu={MENU} notify={notify} />);
  return { hub, notify };
};
const openView = async name => {
  await screen.findByText('Onion');
  await userEvent.click(screen.getByRole('button', { name }));
};

describe('stock screen — cost and stock-up-to', () => {
  it('shows each ingredient\'s cost and level under its stock, and nothing where none is set', async () => {
    setup();
    await screen.findByText('Onion');
    expect(screen.getByText('₹40 per kg · stocks up to 12 kg')).toBeInTheDocument();
    expect(screen.getByText('₹90 per kg · stocks up to 20 kg')).toBeInTheDocument();
    const oil = screen.getByText('Oil', { selector: 'span.font-semibold' }).closest('li');
    expect(within(oil).queryByText(/per l/)).not.toBeInTheDocument();
  });

  it('the add form asks for both, labelled in the ingredient\'s own unit, and sends them', async () => {
    const { hub } = setup({ 'POST /admin/inventory/items': { status: 201, body: { success: true, item: { id: 'x' } } } });
    await screen.findByText('Onion');
    await userEvent.click(screen.getByRole('button', { name: /Add ingredient/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cashew');
    await userEvent.selectOptions(within(dialog).getByLabelText('Counted in'), 'kg');
    expect(within(dialog).getByLabelText('Stock up to (kg)')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Warn me when it gets low'), '1');
    await userEvent.type(within(dialog).getByLabelText('Stock up to (kg)'), '8');
    await userEvent.type(within(dialog).getByLabelText('Cost per kg (₹)'), '850');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient' }));

    expect(hub.calls('POST /admin/inventory/items')[0].body.item).toMatchObject({ name: 'Cashew', unit: 'kg', low_at: 1, par: 8, unit_cost: 850 });
  });

  it('a stock-up-to level that is not above the warning level is flagged before anything is sent', async () => {
    const { hub } = setup();
    await screen.findByText('Onion');
    await userEvent.click(screen.getByRole('button', { name: /Add ingredient/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Flour');
    await userEvent.type(within(dialog).getByLabelText('Warn me when it gets low'), '5');
    await userEvent.type(within(dialog).getByLabelText(/Stock up to/), '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient' }));
    expect(await within(dialog).findByText(/Must be more than the warning level/)).toBeInTheDocument();
    expect(hub.calls('POST /admin/inventory/items')).toHaveLength(0);
  });

  it('editing opens with the figures filled in, and clearing the cost sends null', async () => {
    const { hub } = setup({ 'PUT /admin/inventory/items/ing_r': { body: { success: true, item: {} } } });
    await screen.findByText('Onion');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Rice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Cost per kg (₹)')).toHaveValue('90');
    expect(within(dialog).getByLabelText('Stock up to (kg)')).toHaveValue('20');

    await userEvent.clear(within(dialog).getByLabelText('Cost per kg (₹)'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(hub.calls('PUT /admin/inventory/items/ing_r')[0].body.item).toMatchObject({ unit_cost: null, par: 20 });
  });

  it('the hub\'s refusal of a figure is shown in the dialog, in its words', async () => {
    setup({ 'POST /admin/inventory/items': { status: 400, body: { success: false, code: 'INVALID_INGREDIENT', error: 'cost must be zero or more' } } });
    await screen.findByText('Onion');
    await userEvent.click(screen.getByRole('button', { name: /Add ingredient/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cashew');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add ingredient' }));
    expect(await within(dialog).findByText('cost must be zero or more')).toBeInTheDocument();
  });
});

describe('stock screen — what a recipe costs', () => {
  it('shows the cost of a portion and its share of the price on the recipe row', async () => {
    setup();
    await openView('Recipes');
    expect(await screen.findByText('Costs ₹27 a portion · 12% of the ₹220 price')).toBeInTheDocument();
  });

  it('an incomplete cost says "at least" and shows no percentage', async () => {
    setup({ 'GET /admin/inventory': { body: snapshot({ recipes: [{ id: 'rec_1', item_id: 'dal', variant_id: null, item_name: 'Dal Tadka', on_menu: true, lines: [{ inventory_item_id: 'ing_r', qty: 0.3 }], cost: { cost: 27, complete: false, extras: {} } }] }) } });
    await openView('Recipes');
    const line = await screen.findByText(/At least ₹27 a portion/);
    expect(line.textContent).not.toMatch(/%/);
  });
});

describe('stock screen — the shopping list', () => {
  it('the button says how many things are on it', async () => {
    setup();
    await screen.findByText('Onion');
    expect(screen.getByRole('button', { name: 'Reorder (2)' })).toBeInTheDocument();
  });

  it('with nothing to buy the button is plain, and the list says so', async () => {
    setup({ 'GET /admin/inventory': { body: snapshot({ reorder: { items: [], estimated_total: 0, unpriced: 0 }, summary: { ingredients: 3, out: 0, low: 0, reorder: 0, recipes: 1 } }) } });
    await openView('Reorder');
    expect(await screen.findByText('Nothing to buy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy list' })).not.toBeInTheDocument();
  });

  it('lists what to buy, the emptiest first as the hub ordered it, with how much and about what it costs', async () => {
    setup();
    await openView('Reorder (2)');
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map(r => r.getAttribute('aria-label'))).toEqual(['Onion', 'Oil']);
    expect(within(rows[0]).getByText('Buy 12 kg')).toBeInTheDocument();
    expect(within(rows[0]).getByText('about ₹480')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Out')).toBeInTheDocument();
  });

  it('an item with no stock-up-to level is listed, and asks for one rather than inventing a quantity', async () => {
    setup();
    await openView('Reorder (2)');
    const oil = (await screen.findAllByRole('listitem'))[1];
    expect(within(oil).getByText('Set a stock-up-to level')).toBeInTheDocument();
    expect(within(oil).queryByText(/^Buy/)).not.toBeInTheDocument();
  });

  it('the total says what it leaves out', async () => {
    setup();
    await openView('Reorder (2)');
    expect(await screen.findByText('About ₹480 for 1 of 2 items, not counting the 1 without a cost or a quantity.')).toBeInTheDocument();
  });

  it('"Send on WhatsApp" opens a message with the list already written, to be sent to whoever the supplier is', async () => {
    setup();
    await openView('Reorder (2)');
    const link = await screen.findByRole('link', { name: /Send on WhatsApp/ });
    const url = new URL(link.getAttribute('href'));
    expect(url.origin + url.pathname).toBe('https://wa.me/');
    expect(url.searchParams.get('text')).toMatch(/^Shopping list — .+\n- Onion: 12 kg\n- Oil: \(how much\?\)$/);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('"Copy list" puts the same text on the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { notify } = setup();
    await openView('Reorder (2)');
    await userEvent.click(await screen.findByRole('button', { name: 'Copy list' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/- Onion: 12 kg/));
    expect(notify).toHaveBeenCalledWith('Shopping list copied.');
  });

  it('when copying is not possible it says so and points at the other way', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
    const { notify } = setup();
    await openView('Reorder (2)');
    await userEvent.click(await screen.findByRole('button', { name: 'Copy list' }));
    expect(notify).toHaveBeenCalledWith('Could not copy. Use Send on WhatsApp instead.');
  });
});
