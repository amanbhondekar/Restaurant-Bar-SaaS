import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AdminApp } from '@/admin/AdminApp';
import { DEFAULT_TAB, TAB_IDS, tabFromHash } from '@/admin/lib/tabs';
import { fakeHub } from '../helpers/fakeHub';

// Which tab the admin console opens on. The old reception shell links to /admin#bookings and /admin#sales, so
// a link has to land where it says, and a fragment it does not know must land on the default.

const REPORT = {
  success: true, currency: '₹', periods: ['today', 'week', 'month', 'custom'],
  period: { preset: 'today', label: 'Today so far', previous_label: 'yesterday so far' },
  current: { takings: { payments: 0, refunds: 0, net: 0, by_method: {} }, bills: { count: 0, billed: 0, average: null }, voided: { count: 0, total: 0 }, top_dishes: [], dish_count: 0, by_hour: [], busiest_hour: null },
  previous: {}, comparison: {}, guests: { guests: 0, new: 0, returning: 0, previous: { guests: 0, new: 0 }, retention: null }, cohorts: []
};
const hub = () => fakeHub({
  'GET /menu': { body: { revision: 1, categories: [], items: [] } },
  'GET /tables/layout': { body: { revision: 1, tables: [], sections: [] } },
  'GET /tables': { body: [] },
  'GET /pairing-info': { body: { name: 'Test Kitchen' } },
  'GET /admin/sync-status': { body: { online: true } },
  'GET /admin/sales': { body: REPORT },
  'GET /admin/reports': { body: { success: true, contact: null, summaries: [] } },
  'GET /admin/bookings': { body: { success: true, reservations: [], waitlist: [] } }
});

// jsdom has no matchMedia, which the theme toggle in the header asks for.
beforeAll(() => {
  window.matchMedia ??= query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
});
afterEach(() => { window.location.hash = ''; });

describe('tabFromHash', () => {
  it('names the tab a link asks for, in any case', () => {
    expect(tabFromHash('#sales')).toBe('sales');
    expect(tabFromHash('#Bookings')).toBe('bookings');
    expect(tabFromHash('plan')).toBe('plan');
  });
  it('falls back to the default for nothing, nonsense, or anything that is not a tab', () => {
    for (const bad of ['', '#', undefined, null, '#nope', '#sales/../x', '#<script>', '#constructor', '#__proto__']) {
      expect(tabFromHash(bad)).toBe(DEFAULT_TAB);
    }
  });
});

describe('the tab list', () => {
  it('is exactly the tabs the console shows, in order, so a link can never name one that is not there', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../admin/AdminApp.jsx'), 'utf8');
    const shown = [...source.matchAll(/<TabsTrigger value="([a-z]+)"/g)].map(m => m[1]);
    expect(TAB_IDS).toEqual(shown);
  });
});

describe('admin console — opening on a link', () => {
  it('opens on Menu by default', async () => {
    hub();
    render(<AdminApp />);
    expect(await screen.findByRole('tab', { name: 'Menu' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the Sales tab for /admin#sales', async () => {
    window.location.hash = '#sales';
    hub();
    render(<AdminApp />);
    expect(await screen.findByRole('tab', { name: 'Sales' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Menu' })).toHaveAttribute('aria-selected', 'false');
    expect(await screen.findByText('No sales in this period')).toBeInTheDocument();
  });

  it('opens on Bookings for /admin#bookings, and on Menu for a fragment it does not know', async () => {
    window.location.hash = '#bookings';
    hub();
    const first = render(<AdminApp />);
    expect(await screen.findByRole('tab', { name: 'Bookings' })).toHaveAttribute('aria-selected', 'true');
    first.unmount();

    window.location.hash = '#nonsense';
    hub();
    render(<AdminApp />);
    expect(await screen.findByRole('tab', { name: 'Menu' })).toHaveAttribute('aria-selected', 'true');
  });
});
