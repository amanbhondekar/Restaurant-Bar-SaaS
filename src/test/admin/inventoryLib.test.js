import { describe, expect, it } from 'vitest';

import {
  formatQty, parseQuantity, validateIngredientForm, blankIngredient, ingredientToForm, validateAdjustment, afterAdjustment,
  describeMovement, recipeSubjects, subjectKey, recipeSummary, validateRecipeLines, blankLine, dishesOutOfStock, outOfStockLine, summaryLine
} from '@/admin/lib/inventory';

// What a person types into the Inventory tab, and what it says back. The hub re-checks everything;
// these decide whether reception hears about a mistake beside the field instead of after a round trip.

describe('formatQty', () => {
  it('uses Indian digit grouping and never shows trailing zeros', () => {
    expect(formatQty(1000, 'g')).toBe('1,000 g');
    expect(formatQty(125000, 'g')).toBe('1,25,000 g');
    expect(formatQty(0.25, 'kg')).toBe('0.25 kg');
    expect(formatQty(2, 'kg')).toBe('2 kg');
    expect(formatQty(0.1 + 0.2, 'l')).toBe('0.3 l');
  });
  it('says nothing for something that is not a number', () => {
    expect(formatQty(undefined, 'g')).toBe('');
    expect(formatQty('lots', 'g')).toBe('');
  });
  it('works without a unit', () => {
    expect(formatQty(12)).toBe('12');
  });
});

describe('parseQuantity', () => {
  it('accepts whole numbers and decimals', () => {
    expect(parseQuantity('150')).toEqual({ ok: true, value: 150 });
    expect(parseQuantity(' 0.25 ')).toEqual({ ok: true, value: 0.25 });
    expect(parseQuantity('0.001')).toEqual({ ok: true, value: 0.001 });
  });
  it('refuses what a person is likely to type by mistake, each with its own reason', () => {
    expect(parseQuantity('').error).toMatch(/Enter a quantity/);
    expect(parseQuantity('   ').error).toMatch(/Enter a quantity/);
    for (const bad of ['1,5', '1e3', '-5', '+5', '5 kg', 'ten', '.5', '5.', '0x10']) {
      expect(parseQuantity(bad).ok, bad).toBe(false);
      expect(parseQuantity(bad).error, bad).toMatch(/digits only/);
    }
    expect(parseQuantity('0.0001').error).toMatch(/3 decimal/);
    expect(parseQuantity('2000000000').error).toMatch(/more than the hub accepts/);
  });
  it('treats zero as an error unless zero is meaningful', () => {
    expect(parseQuantity('0').error).toMatch(/more than zero/);
    expect(parseQuantity('0.000').error).toMatch(/more than zero/);
    expect(parseQuantity('0', { allowZero: true })).toEqual({ ok: true, value: 0 });
  });
  it('copes with values that are not strings at all', () => {
    expect(parseQuantity(null).ok).toBe(false);
    expect(parseQuantity(undefined).ok).toBe(false);
    expect(parseQuantity(12)).toEqual({ ok: true, value: 12 });
  });
});

describe('ingredient form', () => {
  const form = (over = {}) => ({ ...blankIngredient(), name: 'Paneer', unit: 'g', ...over });

  it('a name and a unit are enough: stock and warning level are optional and default to zero', () => {
    const { errors, payload } = validateIngredientForm(form());
    expect(errors).toEqual({});
    expect(payload).toEqual({ name: 'Paneer', unit: 'g', low_at: 0, par: 0, unit_cost: null, on_hand: 0 });
  });
  it('sends what was typed, trimmed', () => {
    const { payload } = validateIngredientForm(form({ name: '  Paneer  ', on_hand: '1000', low_at: '200' }));
    expect(payload).toEqual({ name: 'Paneer', unit: 'g', low_at: 200, par: 0, unit_cost: null, on_hand: 1000 });
  });
  it('reports every problem at once, beside the right field', () => {
    const { errors } = validateIngredientForm(form({ name: '  ', on_hand: '-4', low_at: 'x' }));
    expect(Object.keys(errors).sort()).toEqual(['low_at', 'name', 'on_hand']);
  });
  it('refuses a name that is already on the list, in any case, but not the ingredient\'s own', () => {
    expect(validateIngredientForm(form({ name: 'ONION' }), { others: ['Onion', 'Rice'] }).errors.name).toMatch(/already on the list/);
    expect(validateIngredientForm(form({ name: 'Paneer' }), { others: ['Onion'] }).errors).toEqual({});
  });
  it('a name over 80 characters is refused', () => {
    expect(validateIngredientForm(form({ name: 'x'.repeat(81) })).errors.name).toMatch(/80/);
  });
  it('editing never sends how much is on hand: that is a delivery, waste or a count', () => {
    const { payload, errors } = validateIngredientForm(form({ on_hand: 'garbage' }), { editing: true });
    expect(errors.on_hand).toBeUndefined();
    expect('on_hand' in payload).toBe(false);
  });
  it('opens an existing ingredient with its warning level filled in and no stock field to edit', () => {
    expect(ingredientToForm({ name: 'Paneer', unit: 'g', on_hand: 800, low_at: 200 })).toEqual({ name: 'Paneer', unit: 'g', on_hand: '', low_at: '200', par: '', unit_cost: '' });
    expect(ingredientToForm({ name: 'Salt', unit: 'g', on_hand: 5, low_at: 0 }).low_at).toBe('');
  });
});

describe('adjustments', () => {
  const paneer = { name: 'Paneer', unit: 'g', on_hand: 800 };

  it('a delivery and waste need more than zero; a count may be zero', () => {
    expect(validateAdjustment('receive', '0', paneer).ok).toBe(false);
    expect(validateAdjustment('waste', '0', paneer).ok).toBe(false);
    expect(validateAdjustment('count', '0', paneer)).toEqual({ ok: true, value: 0 });
  });
  it('waste cannot take more than is on hand, and says how to fix a wrong figure instead', () => {
    const r = validateAdjustment('waste', '801', paneer);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Only 800 g is on hand/);
    expect(r.error).toMatch(/Correct the count/);
    expect(validateAdjustment('waste', '800', paneer).ok).toBe(true);
  });
  it('a delivery may be any size', () => {
    expect(validateAdjustment('receive', '99999', paneer).ok).toBe(true);
  });
  it('previews what will be on hand afterwards, without float drift', () => {
    expect(afterAdjustment('receive', 200, paneer)).toBe(1000);
    expect(afterAdjustment('waste', 250, paneer)).toBe(550);
    expect(afterAdjustment('count', 90, paneer)).toBe(90);
    expect(afterAdjustment('receive', 0.2, { on_hand: 0.1 })).toBe(0.3);
  });
});

describe('history lines', () => {
  it('says what happened, how much, what is left, and whose ticket', () => {
    const d = describeMovement({ id: 'm', at: '2026-10-19T12:00:00Z', reason: 'sale', delta: -300, on_hand_after: 700, ref: '#142', by: 'Asha' }, 'g');
    expect(d.reason).toBe('Used in orders');
    expect(d.change).toBe('−300 g');
    expect(d.after).toBe('700 g');
    expect(d.detail).toBe('Ticket #142 · Asha');
  });
  it('a delivery is signed positive and carries its note', () => {
    const d = describeMovement({ id: 'm', reason: 'receive', delta: 1500, on_hand_after: 2200, note: 'Tuesday delivery' }, 'g');
    expect(d.change).toBe('+1,500 g');
    expect(d.detail).toBe('Tuesday delivery');
  });
  it('an unknown reason is shown as it came rather than hidden', () => {
    expect(describeMovement({ id: 'm', reason: 'mystery', delta: 0, on_hand_after: 5 }, 'g').reason).toBe('mystery');
  });
});

describe('recipe subjects', () => {
  const menu = [
    { id: 'dal', name: 'Dal Tadka' },
    { id: 'bir', name: 'Biryani', variants: [{ id: 'h', label: 'Half' }, { id: 'f', label: 'Full' }] }
  ];
  it('a dish with no sizes is one subject; one with sizes gets "every size" and each size', () => {
    expect(recipeSubjects(menu).map(s => s.label)).toEqual(['Dal Tadka', 'Biryani · every size', 'Biryani · Half', 'Biryani · Full']);
  });
  it('carries the ids the hub wants, with null for the dish-wide recipe', () => {
    const [dal, every, half] = recipeSubjects(menu);
    expect([dal.item_id, dal.variant_id]).toEqual(['dal', null]);
    expect([every.item_id, every.variant_id]).toEqual(['bir', null]);
    expect([half.item_id, half.variant_id]).toEqual(['bir', 'h']);
    expect(dal.key).toBe(subjectKey('dal', null));
  });
  it('an empty or missing menu gives nothing', () => {
    expect(recipeSubjects([])).toEqual([]);
    expect(recipeSubjects(undefined)).toEqual([]);
  });
});

describe('recipe lines', () => {
  const ings = [{ id: 'a', name: 'Paneer', unit: 'g' }, { id: 'b', name: 'Onion', unit: 'kg' }];

  it('summarises a recipe in words, and says so when an ingredient has gone', () => {
    expect(recipeSummary({ lines: [{ inventory_item_id: 'a', qty: 150 }, { inventory_item_id: 'b', qty: 0.1 }] }, ings)).toBe('Paneer 150 g · Onion 0.1 kg');
    expect(recipeSummary({ lines: [{ inventory_item_id: 'zzz', qty: 1 }] }, ings)).toBe('(removed ingredient)');
  });
  it('valid lines become the payload; an empty list is allowed and removes the recipe', () => {
    expect(validateRecipeLines([{ inventory_item_id: 'a', qty: '150' }], ings)).toEqual({ errors: {}, payload: [{ inventory_item_id: 'a', qty: 150 }] });
    expect(validateRecipeLines([], ings)).toEqual({ errors: {}, payload: [] });
  });
  it('each problem is attached to its own line', () => {
    const { errors } = validateRecipeLines([
      { inventory_item_id: '', qty: '5' },
      { inventory_item_id: 'a', qty: '0' },
      { inventory_item_id: 'ghost', qty: '5' }
    ], ings);
    expect(errors[0].ingredient).toMatch(/Choose/);
    expect(errors[1].qty).toMatch(/more than zero/);
    expect(errors[2].ingredient).toMatch(/no longer exists/);
  });
  it('an ingredient listed twice is flagged on the second line only', () => {
    const { errors } = validateRecipeLines([{ inventory_item_id: 'a', qty: '1' }, { inventory_item_id: 'a', qty: '2' }], ings);
    expect(errors[0]).toBeUndefined();
    expect(errors[1].ingredient).toMatch(/once/);
  });
  it('more than thirty lines is refused', () => {
    const many = Array.from({ length: 31 }, () => ({ inventory_item_id: 'a', qty: '1' }));
    expect(validateRecipeLines(many, ings).errors.form).toMatch(/30/);
  });
  it('a new row starts blank', () => {
    expect(blankLine()).toEqual({ inventory_item_id: '', qty: '' });
  });
});

describe('what is out of stock', () => {
  it('finds dishes and sizes the hub flagged, and leaves the rest', () => {
    const menu = [
      { id: 'a', name: 'Paneer Tikka', stock_out: true },
      { id: 'b', name: 'Biryani', variants: [{ id: 'h', label: 'Half' }, { id: 'f', label: 'Full', stock_out: true }] },
      { id: 'c', name: 'Dal' }
    ];
    expect(dishesOutOfStock(menu).map(d => d.label)).toEqual(['Paneer Tikka', 'Biryani · Full']);
  });
  it('does not list the sizes of a dish that is already listed whole', () => {
    expect(dishesOutOfStock([{ id: 'b', name: 'Biryani', stock_out: true, variants: [{ id: 'h', label: 'Half', stock_out: true }] }])).toHaveLength(1);
  });
  it('words the sentence for one, two and many', () => {
    expect(outOfStockLine([])).toBe('');
    expect(outOfStockLine([{ label: 'Paneer' }])).toBe('Paneer cannot be ordered until restocked.');
    expect(outOfStockLine([{ label: 'Paneer' }, { label: 'Dal' }])).toBe('Paneer and Dal cannot be ordered until restocked.');
    expect(outOfStockLine([{ label: 'A' }, { label: 'B' }, { label: 'C' }])).toBe('A, B and C cannot be ordered until restocked.');
  });
  it('summarises the header, leaving out what is zero', () => {
    expect(summaryLine({ ingredients: 0, out: 0, low: 0, recipes: 0 })).toBe('No ingredients yet.');
    expect(summaryLine({ ingredients: 1, out: 0, low: 0, recipes: 0 })).toBe('1 ingredient · 0 recipes');
    expect(summaryLine({ ingredients: 12, out: 1, low: 2, recipes: 5 })).toBe('12 ingredients · 2 low · 1 out of stock · 5 recipes');
    expect(summaryLine(undefined)).toBe('No ingredients yet.');
  });
});
