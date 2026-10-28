import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The menu grid a waiter orders from. Only the context it reads is faked; the rows, chips and
// buttons are the real component. What is under test is how it shows a dish the kitchen cannot make.
const pos = { menu: [], tables: [{ id: 1, name: 'T1' }], currentRestaurant: { currency: '₹' } };
vi.mock('@/context/PosContext', () => ({ usePos: () => pos }));

const { RapidOrderBuilder } = await import('@/waiter_mobile/RapidOrderBuilder');

const dish = (over = {}) => ({ id: 'd', name: 'Dish', category: 'Mains', price: 200, effective_price: 200, isVeg: true, available: true, ...over });
const sizes = (...specs) => specs.map(([id, label, over]) => ({ id, label, price: 100, effective_price: 100, available: true, ...over }));

function show(menu) {
  pos.menu = menu;
  const onAddItem = vi.fn();
  render(<RapidOrderBuilder selectedTableId={1} draftItems={{}} onAddItem={onAddItem} onRemoveItem={() => {}} />);
  return { onAddItem };
}
/** The grid row for a dish, found by its visible name. */
const rowOf = name => {
  const heading = screen.getAllByText(new RegExp(`^${name}`)).find(el => el.className.includes('typography-title-md'));
  return heading.parentElement.parentElement.parentElement;
};

beforeEach(() => { pos.menu = []; });

describe('waiter grid — stock', () => {
  it('a dish that can be made has an Add button and no chip', async () => {
    const { onAddItem } = show([dish({ id: 'a', name: 'Paneer Tikka' })]);
    const r = rowOf('Paneer Tikka');
    expect(within(r).queryByText(/OUT OF STOCK|86'D/)).not.toBeInTheDocument();
    await userEvent.click(within(r).getByRole('button', { name: /add/i }));
    expect(onAddItem).toHaveBeenCalledTimes(1);
    expect(onAddItem.mock.calls[0][0]).toMatchObject({ item_id: 'a' });
  });

  it('a dish the kitchen has run out of stays on the grid, says so, and cannot be added', () => {
    const { onAddItem } = show([dish({ id: 'a', name: 'Paneer Tikka', stock_out: true })]);
    const r = rowOf('Paneer Tikka');
    expect(within(r).getByText('OUT OF STOCK')).toBeInTheDocument();
    expect(within(r).getByText('Unavailable')).toBeInTheDocument();
    expect(within(r).queryByRole('button')).not.toBeInTheDocument();
    expect(onAddItem).not.toHaveBeenCalled();
  });

  it('says why in words on hover, so a waiter does not have to guess', () => {
    show([dish({ id: 'a', name: 'Paneer Tikka', stock_out: true })]);
    expect(screen.getByTitle(/the kitchen has run out of something this needs/i)).toBeInTheDocument();
  });

  it('is told apart from a size reception 86\'d by hand', () => {
    show([dish({ id: 'b', name: 'Biryani', variants: sizes(['h', 'Half', { available: false }], ['f', 'Full', { stock_out: true }]) })]);
    expect(within(rowOf('Biryani')).queryAllByText("86'D")).toHaveLength(1);
    expect(screen.getAllByText('OUT OF STOCK')).toHaveLength(1);
  });

  it('a size that is both 86\'d by hand and out of stock reads as 86\'d: the hand switch is the one that needs undoing', () => {
    show([dish({ id: 'b', name: 'Biryani', variants: sizes(['h', 'Half', { available: false, stock_out: true }]) })]);
    expect(screen.getByText("86'D")).toBeInTheDocument();
    expect(screen.queryByText('OUT OF STOCK')).not.toBeInTheDocument();
  });

  it('sizes are shown one by one: the one that can be made is still orderable', async () => {
    const { onAddItem } = show([dish({ id: 'b', name: 'Biryani', variants: sizes(['h', 'Half'], ['f', 'Full', { stock_out: true }]) })]);
    const rows = screen.getAllByText(/^Biryani/).filter(el => el.className.includes('typography-title-md')).map(el => el.parentElement.parentElement.parentElement);
    expect(rows).toHaveLength(2);
    const [half, full] = rows;
    expect(within(full).getByText('OUT OF STOCK')).toBeInTheDocument();
    expect(within(full).queryByRole('button')).not.toBeInTheDocument();
    await userEvent.click(within(half).getByRole('button', { name: /add/i }));
    expect(onAddItem.mock.calls[0][0]).toMatchObject({ item_id: 'b', variant_id: 'h' });
  });

  it('a dish 86\'d by hand is still hidden from the grid, as it always was', () => {
    show([dish({ id: 'a', name: 'Gone', available: false }), dish({ id: 'c', name: 'Here' })]);
    expect(screen.queryByText('Gone')).not.toBeInTheDocument();
    expect(screen.getByText('Here')).toBeInTheDocument();
  });

  it('shows no price-promotion badge on a dish that cannot be ordered', () => {
    show([dish({ id: 'a', name: 'Paneer Tikka', stock_out: true, active_day_part: { id: 'dp', label: 'Lunch' } })]);
    expect(screen.queryByText('LUNCH')).not.toBeInTheDocument();
  });
});
