import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OwnerApp } from '@/owner/OwnerApp';

// The owner's remote view: signing in, what the dashboard shows, and what it will not do. The cloud is a fake client;
// the real schema and row-level security are exercised against the same data layer in hub_server/test/ownerData.test.mjs.

beforeAll(() => {
  // jsdom has no matchMedia, which the theme toggle in the header asks for.
  window.matchMedia ??= query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
});

// "Today's" figures are of the local day, and these fixtures put bills minutes and hours before "now": in the first half hour after midnight
// that is yesterday, and the dashboard (rightly) shows nothing for today. So the clock is held at mid-afternoon on a fixed day.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 23, 15, 0, 0));
});
afterAll(() => { vi.useRealTimers(); });

const now = () => new Date();
const ago = mins => new Date(Date.now() - mins * 60000).toISOString();
const RESTAURANT = { id: 'r1', name: 'Spice Garden', city: 'Pune', currency: '₹', plan: 'pro', plan_status: 'active', trial_ends_at: null };
const bill = (i, over = {}) => ({
  id: `u${i}`, hub_ref: `inv_${i}`, restaurant_id: 'r1', invoice_number: `INV-${i}`, grand_total: 500, payment_status: 'paid', payment_method: 'cash',
  issued_at: ago(30), paid_at: ago(25), synced_at: ago(2), items: [{ name: 'Dal Makhani', qty: 2, price: 250, line_total: 500 }], ...over
});
const cashup = (n, over = {}) => ({ id: `c${n}`, hub_ref: `rec_${n}`, restaurant_id: 'r1', seq: n, number: `REC-${n}`, period_start: ago(600), period_end: ago(60), status: 'balanced', has_variance: false, cash_variance: 0, closed_by: 'Priya', methods: {}, totals: {}, voided: {}, unpaid_at_close: {}, ...over });

/** A cloud that answers from fixed tables, remembers what was selected, and counts any attempt to write. */
function fakeClient({ session = null, tables = {}, failing = [], signIn = null } = {}) {
  const state = { session, selects: [], writes: [], listeners: [] };
  const emit = (event, next) => { state.session = next; state.listeners.forEach(cb => cb(event, next)); };
  const base = {
    restaurants: [RESTAURANT], invoices: [bill(1), bill(2, { grand_total: 300, payment_method: 'upi' })], reconciliations: [cashup(2), cashup(1)],
    inventory_items: [], guest_feedback: []
  };
  const client = {
    state,
    auth: {
      getSession: async () => ({ data: { session: state.session } }),
      onAuthStateChange: cb => { state.listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: vi.fn(async creds => {
        if (signIn) return signIn(creds);
        emit('SIGNED_IN', { user: { id: 'owner' } });
        return { data: {}, error: null };
      }),
      signOut: vi.fn(async () => { emit('SIGNED_OUT', null); return { error: null }; })
    },
    from(table) {
      const q = { skip: 0, max: Infinity };
      const rows = () => (tables[table] ?? base[table] ?? []);
      const api = {
        select: cols => { state.selects.push([table, cols]); return api; },
        eq: () => api, order: () => api, or: () => api,
        limit: n => { q.max = n; return api; },
        range: (a, b) => { q.skip = a; q.max = b - a + 1; return api; },
        insert: () => { state.writes.push([table, 'insert']); return api; },
        update: () => { state.writes.push([table, 'update']); return api; },
        upsert: () => { state.writes.push([table, 'upsert']); return api; },
        delete: () => { state.writes.push([table, 'delete']); return api; },
        then: (ok, no) => Promise.resolve(failing.includes(table)
          ? { data: null, error: { message: `${table} is unavailable`, code: 'XX000' } }
          : { data: rows().slice(q.skip, q.skip + q.max), error: null }).then(ok, no)
      };
      return api;
    }
  };
  return client;
}
const signedIn = over => fakeClient({ session: { user: { id: 'owner' } }, ...over });
const ready = () => screen.findByRole('heading', { name: 'Sales' });

describe('owner view — signing in', () => {
  it('says so when the page has not been given a project to read from', () => {
    render(<OwnerApp client={null} />);
    expect(screen.getByText(/not connected to your restaurant's account yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('asks for an email and password, signs in with what was typed (the email trimmed), and shows the restaurant', async () => {
    const client = fakeClient();
    render(<OwnerApp client={client} />);
    await userEvent.type(await screen.findByLabelText('Email'), '  owner@spice.test ');
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'owner@spice.test', password: 'correct horse' });
    expect(await screen.findByRole('heading', { name: 'Spice Garden' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('will not try to sign in until both fields have something in them', async () => {
    render(<OwnerApp client={fakeClient()} />);
    const button = await screen.findByRole('button', { name: 'Sign in' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.test');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    expect(button).toBeEnabled();
  });

  it('a wrong password is said plainly, a service error in its own words, and a network failure as one', async () => {
    const attempt = async signIn => {
      const { unmount } = render(<OwnerApp client={fakeClient({ signIn })} />);
      await userEvent.type(await screen.findByLabelText('Email'), 'a@b.test');
      await userEvent.type(screen.getByLabelText('Password'), 'x');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      return unmount;
    };
    let unmount = await attempt(async () => ({ data: {}, error: { message: 'Invalid login credentials' } }));
    expect(await screen.findByText('That email or password is not right.')).toBeInTheDocument();
    unmount();
    unmount = await attempt(async () => ({ data: {}, error: { message: 'Email not confirmed' } }));
    expect(await screen.findByText('Email not confirmed')).toBeInTheDocument();
    unmount();
    await attempt(async () => { throw new TypeError('fetch failed'); });
    expect(await screen.findByText(/Could not reach the service/)).toBeInTheDocument();
  });

  it('an existing session goes straight to the dashboard, with no sign-in form', async () => {
    render(<OwnerApp client={signedIn()} />);
    expect(await ready()).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('signing out ends the session and returns to the sign-in form', async () => {
    const client = signedIn();
    render(<OwnerApp client={client} />);
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });
});

describe('owner view — the dashboard', () => {
  it('names the restaurant, its plan and its city', async () => {
    render(<OwnerApp client={signedIn()} />);
    expect(await screen.findByRole('heading', { name: 'Spice Garden' })).toBeInTheDocument();
    expect(screen.getByText('Owner view · read-only')).toBeInTheDocument();
    expect(screen.getByText('Pune · Pro plan, active')).toBeInTheDocument();
  });

  it('says a trial is a trial, and until when', async () => {
    const trial = { ...RESTAURANT, plan_status: 'trialing', trial_ends_at: '2026-11-05T00:00:00.000Z' };
    render(<OwnerApp client={signedIn({ tables: { restaurants: [trial] } })} />);
    expect(await screen.findByText(/Pro plan, trialing until /)).toBeInTheDocument();
  });

  it('shows today\'s takings, bills and average, how the money came in, and the best sellers', async () => {
    render(<OwnerApp client={signedIn()} />);
    await ready();
    const card = label => screen.getByText(label).parentElement;
    expect(card('Takings')).toHaveTextContent('₹800');
    expect(card('Bills')).toHaveTextContent('2');
    expect(card('Average bill')).toHaveTextContent('₹400');
    expect(screen.getByText('Taken by: Cash ₹500 · UPI ₹300')).toBeInTheDocument();
    expect(screen.getByText('Dal Makhani')).toBeInTheDocument();
    expect(screen.getByText('4 portions · ₹1,000')).toBeInTheDocument();
  });

  it('switches between today, this week and this month, marking the one shown', async () => {
    render(<OwnerApp client={signedIn()} />);
    await ready();
    expect(screen.getByText(/Today so far, set against yesterday so far/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(screen.getByText(/This month so far, set against last month so far/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This month' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('says how long ago the restaurant last sent anything, and warns when that is long enough to matter', async () => {
    const { unmount } = render(<OwnerApp client={signedIn({ tables: { invoices: [bill(1, { synced_at: ago(2) })] } })} />);
    expect(await screen.findByText('Updated 2 min ago')).toBeInTheDocument();
    unmount();
    render(<OwnerApp client={signedIn({ tables: { invoices: [bill(1, { synced_at: ago(8 * 60) })] } })} />);
    expect(await screen.findByText('The restaurant last sent anything 8 h ago')).toBeInTheDocument();
    expect(screen.getByText(/its laptop may be off or without internet/)).toBeInTheDocument();
  });

  it('says plainly when nothing has arrived from the restaurant yet', async () => {
    render(<OwnerApp client={signedIn({ tables: { invoices: [] } })} />);
    expect(await screen.findByText('Nothing has arrived from the restaurant yet')).toBeInTheDocument();
  });

  it('lists the last closed shifts, balanced or short', async () => {
    const tables = { reconciliations: [cashup(3, { has_variance: true, cash_variance: -50 }), cashup(2), cashup(1, { has_variance: true, cash_variance: 20 })] };
    render(<OwnerApp client={signedIn({ tables })} />);
    await ready();
    const till = screen.getByRole('heading', { name: 'The till' }).closest('section');
    expect(within(till).getByText('REC-3').closest('li')).toHaveTextContent('₹50 short');
    expect(within(till).getByText('REC-2').closest('li')).toHaveTextContent('Balanced');
    expect(within(till).getByText('REC-1').closest('li')).toHaveTextContent('₹20 over');
  });

  it('says what is out of stock and what is running low, and says so when nothing is', async () => {
    const stock = (name, on_hand, low_at) => ({ hub_ref: name, name, unit: 'g', on_hand, low_at, par: null, unit_cost: null });
    const { unmount } = render(<OwnerApp client={signedIn({ tables: { inventory_items: [stock('Cheese', 0, 10), stock('Rice', 4, 5), stock('Oil', 50, 5)] } })} />);
    await ready();
    const section = screen.getByRole('heading', { name: 'Stock' }).closest('section');
    expect(within(section).getByText('Cheese').closest('li')).toHaveTextContent('Out');
    expect(within(section).getByText('Rice').closest('li')).toHaveTextContent('Low: 4 g left');
    expect(within(section).queryByText('Oil')).toBeNull();
    unmount();
    render(<OwnerApp client={signedIn({ tables: { inventory_items: [stock('Oil', 50, 5)] } })} />);
    expect(await screen.findByText('Nothing is out or running low.')).toBeInTheDocument();
  });

  it('gives the average rating and the low ones, with what the guest wrote shown as text and never as markup', async () => {
    const fb = (i, rating, comment) => ({ hub_ref: `fb${i}`, rating, comment, table_label: 'T4', invoice_number: null, created_at: ago(300) });
    render(<OwnerApp client={signedIn({ tables: { guest_feedback: [fb(1, 5, 'Great'), fb(2, 1, '<img src=x onerror=alert(1)> cold')] } })} />);
    await ready();
    expect(await screen.findByText(/average from 2/)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> cold/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('owner view — when something is wrong', () => {
  it('a login attached to no restaurant is told so, and that its password is fine', async () => {
    render(<OwnerApp client={signedIn({ tables: { restaurants: [] } })} />);
    expect(await screen.findByText('This login is not attached to a restaurant')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is wrong with your password/)).toBeInTheDocument();
  });

  it('a restaurant that cannot be read is an error with a way to try again, not "attached to none"', async () => {
    const failing = ['restaurants'];   // read afresh on every request, so emptying it later is the service coming back
    render(<OwnerApp client={signedIn({ failing })} />);
    expect(await screen.findByText('Could not load your restaurant')).toBeInTheDocument();
    expect(screen.getByText('restaurants is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('This login is not attached to a restaurant')).toBeNull();
    failing.length = 0;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await ready()).toBeInTheDocument();
  });

  it('one section failing is named and leaves the rest standing', async () => {
    render(<OwnerApp client={signedIn({ failing: ['inventory_items'] })} />);
    await ready();
    expect(screen.getByText('inventory_items is unavailable')).toBeInTheDocument();
    expect(screen.getByText('Spice Garden')).toBeInTheDocument();
    expect(screen.getByText('REC-2')).toBeInTheDocument();
  });

  it('sales failing to load says so in its own place instead of showing zeros, and the rest still shows', async () => {
    render(<OwnerApp client={signedIn({ failing: ['invoices'] })} />);
    expect(await screen.findByText('Sales could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('invoices is unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sales' })).toBeNull();
    expect(screen.queryByText('Nothing has arrived from the restaurant yet')).toBeNull();
    expect(screen.getByText('REC-2')).toBeInTheDocument();
  });

  it('a ledger too long to read at once says its figures may be short', async () => {
    const many = Array.from({ length: 20000 }, (_, i) => bill(i));
    render(<OwnerApp client={signedIn({ tables: { invoices: many } })} />);
    expect(await screen.findByText(/more bills than this page reads at once/)).toBeInTheDocument();
  });

  it('refreshing reads the restaurant again', async () => {
    const client = signedIn();
    render(<OwnerApp client={client} />);
    await ready();
    const before = client.state.selects.filter(([t]) => t === 'restaurants').length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(client.state.selects.filter(([t]) => t === 'restaurants').length).toBe(before + 1));
  });
});

describe('owner view — what it will not do', () => {
  it('never writes anything, whatever is pressed', async () => {
    const client = signedIn();
    render(<OwnerApp client={client} />);
    await ready();
    for (const name of ['This week', 'This month', 'Today', 'Refresh']) await userEvent.click(screen.getByRole('button', { name }));
    await act(async () => {});
    expect(client.state.writes).toEqual([]);
  });

  it('never asks for the hub\'s secret, a PIN hash, or every column of the restaurant', async () => {
    const client = signedIn();
    render(<OwnerApp client={client} />);
    await ready();
    const asked = client.state.selects.filter(([t]) => t === 'restaurants' || t === 'staff_users');
    expect(asked.length).toBeGreaterThan(0);
    for (const [, cols] of asked) expect(cols).not.toMatch(/[*]|secret|pin_hash/);
    expect(client.state.selects.some(([t]) => t === 'staff_users')).toBe(false);
  });

  it('has no control that edits anything: a sign-out, a refresh and the period buttons are all there is', async () => {
    render(<OwnerApp client={signedIn()} />);
    await ready();
    const names = screen.getAllByRole('button').map(b => b.textContent.trim()).filter(Boolean).sort();
    expect(names).toEqual(['Refresh', 'This month', 'This week', 'Today', 'Sign out'].sort());
  });
});
