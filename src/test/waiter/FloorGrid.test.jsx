import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { deferred } from '../helpers/fakeHub';

// The waiter's floor: every table, its state, what is sitting in a draft there, and the one irreversible act on it,
// clearing a settled bill. Only the context it falls back to is faked; props are passed as WaiterApp passes them.

vi.mock('@/context/PosContext', () => ({ usePos: () => ({}) }));
vi.mock('../../context/PosContext', () => ({ usePos: () => ({}) }));

const { FloorGrid, FloorGridSkeleton } = await import('@/waiter_mobile/FloorGrid');

const T = (id, over = {}) => ({ id, name: `T${id}`, capacity: 4, section: 'Main', status: 'available', ...over });
const NOW = new Date('2026-10-22T12:00:00.000Z').getTime();

// A draft as WaiterApp keeps it: line key -> the row, which carries its quantity.
const draftOf = (...qtys) => Object.fromEntries(qtys.map((qty, i) => [`item${i}|dp_none`, { item_id: `item${i}`, name: `Dish ${i}`, price: 100, qty }]));

const setup = (props = {}) => {
  const onSelectTable = vi.fn();
  const onClearTableBill = vi.fn(async () => {});
  const view = render(<FloorGrid tables={[T(1), T(2)]} onSelectTable={onSelectTable} onClearTableBill={onClearTableBill} {...props} />);
  return { onSelectTable, onClearTableBill, ...view };
};
const card = name => screen.getByText(name, { selector: '.typography-title-md' }).closest('.table-card');

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('floor grid — the tables', () => {
  it('shows each table with its capacity and what state it is in', () => {
    setup({ tables: [T(1), T(2, { status: 'occupied' }), T(3, { status: 'kot' }), T(4, { status: 'ready', capacity: 2 })] });
    expect(within(card('T1')).getByText('Open')).toBeInTheDocument();
    expect(within(card('T2')).getByText('Dining')).toBeInTheDocument();
    expect(within(card('T3')).getByText('In Kitchen')).toBeInTheDocument();
    expect(within(card('T4')).getByText('Bill Ready')).toBeInTheDocument();
    expect(card('T4')).toHaveTextContent('2p');
  });

  it('a state it does not know reads as open rather than breaking the grid', () => {
    setup({ tables: [T(1, { status: 'mystery' })] });
    expect(within(card('T1')).getByText('Open')).toBeInTheDocument();
  });

  it('tapping a table selects it, and the selected one is marked', async () => {
    const { onSelectTable } = setup({ selectedTable: 2 });
    await userEvent.click(card('T1'));
    expect(onSelectTable).toHaveBeenCalledWith(1);
    expect(card('T2')).toHaveClass('selected');
    expect(card('T1')).not.toHaveClass('selected');
  });

  it('shows what an open bill comes to, and how long the table has been sitting', () => {
    setup({ tables: [T(1, { status: 'occupied', activeOrderTotal: 640, occupiedSince: new Date(NOW - 25 * 60000).toISOString() }), T(2, { status: 'kot', activeOrderTotal: 90, occupiedSince: new Date(NOW - 20000).toISOString() }), T(3), T(4, { status: 'occupied', activeOrderTotal: 0 })] });
    expect(card('T1')).toHaveTextContent('₹640');
    expect(card('T1')).toHaveTextContent('25m');
    expect(card('T2')).toHaveTextContent('Just in');
    expect(card('T3')).not.toHaveTextContent('₹');
    expect(card('T4')).not.toHaveTextContent('₹');   // seated, nothing ordered yet
    expect(card('T3')).not.toHaveTextContent(/m$|Just in/);
  });
});

describe('floor grid — what is waiting in a draft', () => {
  it('shows how many pieces are in a table\'s draft: the quantities on its lines added up', () => {
    // Found by looking: the grid added the lines' ROWS together, not their quantities, which made the sum a
    // string that is never greater than zero, so no badge was ever drawn.
    setup({ tables: [T(1), T(2)], drafts: { 1: draftOf(2, 3), 2: draftOf(1) } });
    expect(within(card('T1')).getByText('5')).toBeInTheDocument();
    expect(within(card('T2')).getByText('1')).toBeInTheDocument();
  });

  it('draws nothing for a table with no draft, or whose draft has been emptied', () => {
    setup({ tables: [T(1), T(2)], drafts: { 2: {} } });
    expect(card('T1').querySelector('.font-mono')).toBeNull();
    expect(card('T2').querySelector('.font-mono')).toBeNull();
  });

  it('ignores a line that has lost its quantity rather than showing NaN', () => {
    setup({ tables: [T(1)], drafts: { 1: { a: { item_id: 'a', name: 'A' }, b: { item_id: 'b', name: 'B', qty: 2 } } } });
    expect(within(card('T1')).getByText('2')).toBeInTheDocument();
    expect(card('T1')).not.toHaveTextContent('NaN');
  });
});

describe('floor grid — sections', () => {
  const tables = [T(1, { section: 'Main' }), T(2, { section: 'Terrace' }), T(3, { section: 'Terrace' })];

  it('offers All plus each section the tables use, and filters to one', async () => {
    setup({ tables });
    expect(screen.getAllByRole('button', { name: /^(All|Main|Terrace)$/ }).map(b => b.textContent)).toEqual(['All', 'Main', 'Terrace']);
    await userEvent.click(screen.getByRole('button', { name: 'Terrace' }));
    expect(screen.queryByText('T1', { selector: '.typography-title-md' })).toBeNull();
    expect(card('T2')).toBeInTheDocument();
    expect(card('T3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terrace' })).toHaveClass('active');
  });

  it('follows the sections the hub reports, including an empty one reception has just added', () => {
    setup({ tables, sections: ['Main', 'Terrace', 'Rooftop'] });
    expect(screen.getByRole('button', { name: 'Rooftop' })).toBeInTheDocument();
  });

  it('says a section has no tables, without offering to connect, when it is just empty', async () => {
    setup({ tables, sections: ['Main', 'Terrace', 'Rooftop'], onOpenPairing: vi.fn() });
    await userEvent.click(screen.getByRole('button', { name: 'Rooftop' }));
    expect(screen.getByText('No tables in this section')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect to Hub|Enter Enrollment Code/ })).toBeNull();
  });

  it('a section removed while it is selected falls back to All instead of leaving a blank grid', async () => {
    const { rerender, onSelectTable } = setup({ tables, sections: ['Main', 'Terrace'] });
    await userEvent.click(screen.getByRole('button', { name: 'Terrace' }));
    rerender(<FloorGrid tables={[T(1)]} sections={['Main']} onSelectTable={onSelectTable} />);
    await waitFor(() => expect(card('T1')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'All' })).toHaveClass('active');
  });
});

describe('floor grid — when there is nothing to show', () => {
  it('a handset that has not been enrolled says so and offers the way in', async () => {
    const onOpenPairing = vi.fn();
    setup({ tables: [], isEnrolled: false, onOpenPairing });
    expect(screen.getByText('Handset Not Enrolled')).toBeInTheDocument();
    expect(screen.getByText(/6-character enrollment code/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Enter Enrollment Code' }));
    expect(onOpenPairing).toHaveBeenCalledTimes(1);
  });

  it('a hub that refused the token reads the same, even when the handset thinks it is enrolled', () => {
    setup({ tables: [], connStatus: 'unauthorized', isEnrolled: true, onOpenPairing: vi.fn() });
    expect(screen.getByText('Handset Not Enrolled')).toBeInTheDocument();
  });

  it('a hub that cannot be reached says no tables are loaded, and offers to connect', async () => {
    const onOpenPairing = vi.fn();
    setup({ tables: [], hubConnected: false, onOpenPairing });
    expect(screen.getByText('No tables loaded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect to Hub' }));
    expect(onOpenPairing).toHaveBeenCalledTimes(1);
  });

  it('offers no button when it has nothing to open', () => {
    setup({ tables: [], hubConnected: false });
    expect(screen.queryByRole('button', { name: /Connect|Enroll/ })).toBeNull();
  });

  it('while loading it draws placeholders, not an empty-state message', () => {
    const { container } = setup({ tables: [], isLoading: true });
    expect(screen.queryByText(/No tables/)).toBeNull();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(6);
    expect(container.querySelector('.floor-grid')).toBeNull();
    expect(FloorGridSkeleton).toBeTypeOf('function');
  });
});

describe('floor grid — clearing a settled bill', () => {
  const ready = () => setup({ tables: [T(1, { status: 'ready' }), T(2, { status: 'occupied' })] });
  const clearButton = () => within(card('T1')).getByRole('button', { name: /Clear Bill|Clearing/ });

  it('is offered only on a table whose bill is ready', () => {
    ready();
    expect(within(card('T1')).getByRole('button', { name: 'Clear Bill' })).toBeInTheDocument();
    expect(within(card('T2')).queryByRole('button')).toBeNull();
  });

  it('asks first, and does nothing if the answer is no', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onClearTableBill } = ready();
    await userEvent.click(clearButton());
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/cannot be undone/));
    expect(onClearTableBill).not.toHaveBeenCalled();
    expect(clearButton()).toHaveTextContent('Clear Bill');
  });

  it('clears that table on a yes, without also selecting the table underneath', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onClearTableBill, onSelectTable } = ready();
    await userEvent.click(clearButton());
    expect(onClearTableBill).toHaveBeenCalledWith(1);
    expect(onSelectTable).not.toHaveBeenCalled();
  });

  it('shows Clearing and ignores a second tap while it is in flight, then comes back', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const gate = deferred();
    const onClearTableBill = vi.fn(() => gate.promise);
    setup({ tables: [T(1, { status: 'ready' })], onClearTableBill });
    await userEvent.click(clearButton());
    expect(clearButton()).toHaveTextContent('Clearing…');
    expect(clearButton()).toBeDisabled();
    await userEvent.click(clearButton());
    expect(onClearTableBill).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitFor(() => expect(clearButton()).toHaveTextContent('Clear Bill'));
  });
});
