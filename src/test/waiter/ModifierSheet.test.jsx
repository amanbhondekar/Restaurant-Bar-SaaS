import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModifierSheet } from '@/waiter_mobile/ModifierSheet';

// The sheet a waiter fills in for a dish with choices. The hub re-prices every order and rejects
// drift, so a wrong number here does not reach the bill -- it reaches the waiter, as an order the
// hub refuses at the table. What it emits has to be what the hub will accept.
//
// Groups are written the way the hub's menuNormalize leaves them: min and max always present.

const ROW = {
  item_id: 'dal', name: 'Dal Tadka', price: 220, isVeg: true,
  modifier_groups: [
    {
      id: 'spice', label: 'Spice', min: 1, max: 1,
      options: [
        { id: 'mild', label: 'Mild', price_delta: 0 },
        { id: 'hot', label: 'Hot', price_delta: 0 }
      ]
    },
    {
      id: 'extras', label: 'Extras', min: 0, max: 2,
      options: [
        { id: 'ghee', label: 'Extra ghee', price_delta: 30 },
        { id: 'jeera', label: 'Jeera rice', price_delta: 80 },
        { id: 'papad', label: 'Papad', price_delta: 20 },
        { id: 'onion', label: 'No onion', price_delta: -10 },
        { id: 'butter', label: 'Butter', price_delta: 25, available: false }
      ]
    }
  ]
};

const option = label => screen.getByRole('button', { name: new RegExp(`^${label}`) });
const addButton = () => screen.getByRole('button', { name: /add to cart|^pick /i });
const perUnit = () => screen.getByText('Per unit').nextElementSibling.textContent;

const open = (row = ROW, props = {}) => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<ModifierSheet row={row} onConfirm={onConfirm} onClose={onClose} {...props} />);
  return { onConfirm, onClose };
};

describe('waiter modifier sheet', () => {
  it('will not add a dish until every required choice is made, and says which one', async () => {
    const { onConfirm } = open();
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveTextContent('Pick Spice');

    await userEvent.click(addButton());
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(option('Mild'));
    expect(addButton()).toBeEnabled();
    expect(addButton()).toHaveTextContent('Add to cart');
  });

  it('a pick-one group replaces the earlier pick rather than holding both', async () => {
    const { onConfirm } = open();
    await userEvent.click(option('Mild'));
    await userEvent.click(option('Hot'));
    await userEvent.click(addButton());

    const spice = onConfirm.mock.calls[0][0].modifiers.filter(m => m.group_id === 'spice');
    expect(spice.map(m => m.option_id)).toEqual(['hot']);
  });

  it('a pick-several group stops at its maximum: the rest go disabled, not hidden', async () => {
    open();
    await userEvent.click(option('Extra ghee'));
    await userEvent.click(option('Jeera rice'));

    expect(option('Papad')).toBeDisabled();
    expect(option('No onion')).toBeDisabled();
    // Still there to read, and the two picked can still be un-picked.
    expect(option('Extra ghee')).toBeEnabled();

    await userEvent.click(option('Extra ghee'));
    expect(option('Papad')).toBeEnabled();
  });

  it('an 86\'d option is shown but cannot be picked, and shows no price', async () => {
    const { onConfirm } = open();
    const butter = option('Butter');
    expect(butter).toBeDisabled();
    expect(butter).toHaveTextContent("86'D");
    expect(butter).not.toHaveTextContent('₹25');

    await userEvent.click(butter);
    await userEvent.click(option('Mild'));
    await userEvent.click(addButton());
    expect(onConfirm.mock.calls[0][0].modifiers.map(m => m.option_id)).not.toContain('butter');
  });

  it('shows what each choice adds or takes off, and nothing for a free one', () => {
    open();
    expect(option('Extra ghee')).toHaveTextContent('+₹30');
    expect(option('No onion')).toHaveTextContent('−₹10');
    expect(option('Mild').textContent).not.toMatch(/₹/);
  });

  it('keeps a live per-unit price, including a choice that takes money off', async () => {
    open();
    expect(perUnit()).toBe('₹220');

    await userEvent.click(option('Mild'));
    await userEvent.click(option('Extra ghee'));
    expect(perUnit()).toBe('₹250(₹220 + ₹30)');

    await userEvent.click(option('No onion'));
    expect(perUnit()).toBe('₹240(₹220 + ₹20)');
  });

  it('emits exactly what the hub prices an order from: the row, the picks, and base + Σ delta', async () => {
    const { onConfirm } = open();
    await userEvent.click(option('Hot'));
    await userEvent.click(option('Jeera rice'));
    await userEvent.click(option('No onion'));
    await userEvent.click(addButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const added = onConfirm.mock.calls[0][0];
    expect(added.item_id).toBe('dal');
    expect(added.price).toBe(290);
    // In menu order, group by group -- the shape hub_server/lib/pricing.js reads.
    expect(added.modifiers).toEqual([
      { group_id: 'spice', group_label: 'Spice', option_id: 'hot', option_label: 'Hot', price_delta: 0 },
      { group_id: 'extras', group_label: 'Extras', option_id: 'jeera', option_label: 'Jeera rice', price_delta: 80 },
      { group_id: 'extras', group_label: 'Extras', option_id: 'onion', option_label: 'No onion', price_delta: -10 }
    ]);
  });

  it('does not drift into floating-point pennies on a fractional price', async () => {
    const row = {
      item_id: 'chai', name: 'Chai', price: 0.1,
      modifier_groups: [{ id: 'g', label: 'Sugar', min: 0, max: 1, options: [{ id: 's', label: 'Extra sugar', price_delta: 0.2 }] }]
    };
    const { onConfirm } = open(row);
    await userEvent.click(option('Extra sugar'));
    await userEvent.click(addButton());
    // 0.1 + 0.2 is 0.30000000000000004 in JavaScript.
    expect(onConfirm.mock.calls[0][0].price).toBe(0.3);
  });

  it('a dish with no required choices can be added straight away at its own price', async () => {
    const row = { ...ROW, modifier_groups: [ROW.modifier_groups[1]] };
    const { onConfirm } = open(row);
    expect(addButton()).toBeEnabled();
    await userEvent.click(addButton());
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ price: 220, modifiers: [] });
  });

  it('shows the size already chosen, so the waiter knows which Biryani they are customising', () => {
    open({ ...ROW, name: 'Biryani', variant_label: 'Full' });
    expect(screen.getByText('· Full')).toBeInTheDocument();
  });

  it('closes from the cross or the backdrop, but not from a tap inside the sheet', async () => {
    const { onClose } = open();
    await userEvent.click(screen.getByText('Customize this dish'));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
