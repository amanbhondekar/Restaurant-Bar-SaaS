import React, { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnimatePresence } from 'framer-motion';

import { initCourseState } from '../../../hub_server/lib/courses.js';
import { TicketCard } from '../../kitchen/TicketCard';

// The rail animates tickets in and out with AnimatePresence in "popLayout" mode, which measures the element it is
// animating through a ref it hands to its child. A card that does not pass that ref on still renders, and every other
// test passes, but the cards beside an exiting ticket jump instead of sliding. So the contract is tested on its own.

const ITEMS = [{ id: 'dal', name: 'Dal', qty: 1, station: 'hot', course: 1 }];
const TICKET = { id: 't1', ticket_number: 101, table_id: 1, table_name: 'T1', status: 'in_progress', items: ITEMS, created_at: 'a', updated_at: 'a', ...initCourseState(ITEMS, {}, 'a') };
const props = over => ({
  ticket: TICKET, stationFilter: 'all', allCheckedFor: () => false, shouldReduceMotion: true, checkedItems: {},
  toggleCheck: vi.fn(), handleFire: vi.fn(), handleStationReady: vi.fn(), handleMarkReady: vi.fn(), openBill: vi.fn(), ...over
});

describe('TicketCard', () => {
  it('hands its ref to the card itself, so AnimatePresence can measure it', () => {
    const ref = createRef();
    render(<TicketCard {...props()} ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLElement);
    expect(ref.current).toContainElement(screen.getByText('TICKET #101'));
    expect(ref.current.parentElement).toBe(document.body.firstElementChild);   // the card is the outermost element, not something inside it
  });

  it('works as a child of AnimatePresence in popLayout mode without complaint', () => {
    const complaints = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => complaints.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => complaints.push(a.join(' ')));
    const { rerender } = render(<AnimatePresence mode="popLayout"><TicketCard key="t1" {...props()} /></AnimatePresence>);
    rerender(<AnimatePresence mode="popLayout" />);
    expect(complaints.filter(c => !/Reduced Motion/.test(c))).toEqual([]);
  });

  it('draws what a cook needs and calls back with the right ticket', () => {
    const p = props();
    render(<TicketCard {...p} />);
    expect(screen.getByText('Dal')).toBeInTheDocument();
    screen.getByRole('button', { name: /Bill/ }).click();
    expect(p.openBill).toHaveBeenCalledWith(1);
  });
});
