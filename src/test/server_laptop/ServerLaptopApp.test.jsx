import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TAB_IDS } from '@/admin/lib/tabs';

// The old reception shell. Its Waitlist and Analytics tabs drew from the browser's own storage, which shares
// nothing with the hub, so they were retired: the tabs now send reception to the admin console's Bookings and
// Sales tabs. Only the context the shell reads is faked.
const pos = {
  tables: [], tickets: [], waitlist: [], cloudQueue: [], hubStatus: { isHubConnected: true, online: true, queued: 0 },
  currentRestaurant: { name: 'Test Kitchen', currency: '₹', plan: 'pro', city: 'Nagpur', pairingCode: 'TST-0001' },
  hasModuleAccess: () => true, changeRestaurantPlan: () => {}, isMenuUninitialized: false, markTicketReady: () => {}
};
vi.mock('@/context/PosContext', () => ({ usePos: () => pos }));
vi.mock('../../context/PosContext', () => ({ usePos: () => pos }));

const { ServerLaptopApp } = await import('@/server_laptop/ServerLaptopApp');

describe('reception shell — retired tabs', () => {
  it('Bookings points at the admin console\'s Bookings tab, which exists', async () => {
    render(<ServerLaptopApp />);
    await userEvent.click(screen.getByRole('button', { name: /^Bookings/ }));
    expect(screen.getByText('Bookings and the walk-in queue are in the admin console')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open the Bookings tab/ });
    expect(link).toHaveAttribute('href', '/admin#bookings');
    expect(TAB_IDS).toContain('bookings');
  });

  it('Sales points at the admin console\'s Sales tab, which exists', async () => {
    render(<ServerLaptopApp />);
    await userEvent.click(screen.getByRole('button', { name: /^Sales/ }));
    expect(screen.getByText('Sales figures are in the admin console')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the Sales tab/ })).toHaveAttribute('href', '/admin#sales');
    expect(TAB_IDS).toContain('sales');
  });

  it('no longer shows a demo list or a total of its own', async () => {
    render(<ServerLaptopApp />);
    await userEvent.click(screen.getByRole('button', { name: /^Bookings/ }));
    expect(screen.queryByText(/Add to waitlist|Quote wait|Waitlist/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Sales/ }));
    expect(screen.queryByText(/Total Revenue|Average Order|Popular/i)).toBeNull();
  });
});
