import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PlanTab } from '@/admin/PlanTab';
import { featureRows, formatWhen, limitRows, planBanner, planLabel, usageTone } from '@/admin/lib/plan';
import { fakeHub } from '../helpers/fakeHub';

// The owner's view of the subscription. Read-only, served from the hub's own config, so it must say plainly
// what the restaurant is running on and why -- especially when that is not what it asked for.

const PLAN = {
  success: true,
  plan: 'pro',
  requested_plan: 'pro',
  status: 'active',
  degraded: false,
  degraded_reason: null,
  in_grace: false,
  grace_ends_at: null,
  synced_at: '2026-10-22T09:00:00.000Z',
  limits: { devices: 5, waiters: 10, tables: null, printers: 2 },
  usage: { devices: 3, waiters: 10, printers: 1 },
  features: { split_bill: true, refunds: true, modifiers: false }
};

describe('plan lib — banner', () => {
  it('says nothing when the subscription is healthy', () => {
    expect(planBanner(PLAN)).toBeNull();
    expect(planBanner(null)).toBeNull();
  });

  it('names what the restaurant is running on and why, in the owner\'s words, when it has dropped', () => {
    const b = planBanner({ ...PLAN, plan: 'starter', requested_plan: 'pro', degraded: true, degraded_reason: 'TRIAL_EXPIRED' });
    expect(b.tone).toBe('error');
    expect(b.title).toBe('Running on Starter, not Pro');
    expect(b.body).toMatch(/free trial has ended/);
    expect(b.body).toMatch(/never switched off/);
  });

  it('has a sentence for each reason and a safe one for a reason it does not know', () => {
    const why = reason => planBanner({ ...PLAN, plan: 'starter', degraded: true, degraded_reason: reason }).body;
    expect(why('PAYMENT_OVERDUE')).toMatch(/payment is overdue/);
    expect(why('SUSPENDED')).toMatch(/suspended/);
    expect(why('CANCELLED')).toMatch(/cancelled/);
    expect(why('SOMETHING_NEW')).toMatch(/not active/);
    expect(why(undefined)).toMatch(/not active/);
  });

  it('warns during the grace period, with the date when there is one', () => {
    const b = planBanner({ ...PLAN, in_grace: true, grace_ends_at: '2026-10-30T00:00:00.000Z' });
    expect(b.tone).toBe('warning');
    expect(b.title).toBe('Payment overdue');
    expect(b.body).toMatch(/Everything still works until /);
    expect(planBanner({ ...PLAN, in_grace: true }).body).toBe('Everything still works. After that this restaurant drops to Starter.');
  });

  it('degradation outranks grace: once it has dropped, "everything still works" would be wrong', () => {
    const b = planBanner({ ...PLAN, plan: 'starter', degraded: true, degraded_reason: 'PAYMENT_OVERDUE', in_grace: true });
    expect(b.tone).toBe('error');
    expect(b.body).not.toMatch(/Everything still works/);
  });
});

describe('plan lib — limits and features', () => {
  it('tones a row by how close it is to the cap: green, amber one below, rust at or over, none when uncapped', () => {
    expect(usageTone(2, 5)).toBe('green');
    expect(usageTone(4, 5)).toBe('amber');
    expect(usageTone(5, 5)).toBe('rust');
    expect(usageTone(7, 5)).toBe('rust');
    expect(usageTone(3, null)).toBe('none');
    expect(usageTone(3, undefined)).toBe('none');
    expect(usageTone(undefined, 5)).toBe('none');
  });

  it('draws one row per limit, with the count where the hub has one and a dash where it does not', () => {
    const rows = limitRows(PLAN);
    expect(rows.map(r => [r.label, r.text])).toEqual([
      ['Waiter handsets', '3 of 5'],
      ['Waiters', '10 of 10'],
      ['Tables', '– of unlimited'],
      ['Printers', '1 of 2']
    ]);
    expect(rows.map(r => r.tone)).toEqual(['green', 'rust', 'none', 'amber']);
    expect(rows.map(r => r.percent)).toEqual([60, 100, 0, 50]);
    expect(rows.find(r => r.key === 'tables').counted).toBe(false);
  });

  it('caps the bar at 100 and does not divide by a zero limit', () => {
    expect(limitRows({ limits: { devices: 2 }, usage: { devices: 9 } })[0].percent).toBe(100);
    expect(limitRows({ limits: { devices: 0 }, usage: { devices: 1 } })[0].percent).toBe(0);
  });

  it('shows a limit it has no label for under its own name, and survives a plan with nothing in it', () => {
    expect(limitRows({ limits: { kiosks: 1 }, usage: {} })[0].label).toBe('kiosks');
    expect(limitRows(null)).toEqual([]);
    expect(featureRows(undefined)).toEqual([]);
  });

  it('lists features as included or not on this plan', () => {
    expect(featureRows(PLAN).map(r => [r.label, r.text])).toEqual([
      ['Split a bill', 'Included'],
      ['Refunds', 'Included'],
      ['Dish options (spice, extras)', 'Not on this plan']
    ]);
  });

  it('names plans, and reads a missing or unparseable time as never', () => {
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('custom-deal')).toBe('custom-deal');
    expect(formatWhen(null)).toBe('never');
    expect(formatWhen('not a time')).toBe('never');
    expect(formatWhen('2026-10-22T09:00:00.000Z')).not.toBe('never');
  });
});

// These tests are about the plan. The subscription panel under it has its own file; here the hub simply has no billing service.
const NO_BILLING = { 'GET /admin/billing': { body: { success: true, configured: false } } };

describe('plan tab', () => {
  it('shows the plan, its limits and its features', async () => {
    const hub = fakeHub({ ...NO_BILLING, 'GET /plan': { body: PLAN } });
    render(<PlanTab />);
    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(hub.calls('GET /plan')).toHaveLength(1);

    const limits = screen.getByRole('heading', { name: 'What this plan allows' }).parentElement;
    expect(within(limits).getByText('3 of 5')).toBeInTheDocument();
    expect(within(limits).getByText('– of unlimited')).toBeInTheDocument();

    const features = screen.getByRole('heading', { name: 'Features' }).parentElement;
    expect(within(features).getAllByText('Included')).toHaveLength(2);
    expect(within(features).getByText('Not on this plan')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a grace period is a warning, not an alarm', async () => {
    fakeHub({ ...NO_BILLING, 'GET /plan': { body: { ...PLAN, in_grace: true, grace_ends_at: '2026-10-30T00:00:00.000Z' } } });
    render(<PlanTab />);
    expect(await screen.findByRole('status')).toHaveTextContent('Payment overdue');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a count is not kept on this hub rather than showing a zero', async () => {
    fakeHub({ ...NO_BILLING, 'GET /plan': { body: PLAN } });
    render(<PlanTab />);
    const row = (await screen.findByText('Tables')).closest('div.rounded-xl');
    expect(within(row).getByText('Checked when the restaurant is set up, not on this hub.')).toBeInTheDocument();
  });

  it('shows the degradation banner above everything when the plan has dropped', async () => {
    fakeHub({ ...NO_BILLING, 'GET /plan': { body: { ...PLAN, plan: 'starter', requested_plan: 'pro', degraded: true, degraded_reason: 'PAYMENT_OVERDUE' } } });
    render(<PlanTab />);
    const banner = await screen.findByRole('alert');   // a dropped plan is an error-toned notice, announced at once
    expect(banner).toHaveTextContent('Running on Starter, not Pro');
    expect(banner).toHaveTextContent(/payment is overdue/);
  });

  it('the usage bars are decoration: the numbers beside them carry the meaning', async () => {
    fakeHub({ ...NO_BILLING, 'GET /plan': { body: PLAN } });
    const { container } = render(<PlanTab />);
    await screen.findByText('Pro');
    const bars = container.querySelectorAll('[aria-hidden="true"]');
    expect(bars.length).toBeGreaterThanOrEqual(3);   // handsets, waiters, printers; not the uncapped Tables
  });

  it('an unreachable hub is explained, with a way to try again', async () => {
    let up = false;
    fakeHub({ ...NO_BILLING, 'GET /plan': () => (up ? { body: PLAN } : new TypeError('fetch failed')) });
    render(<PlanTab />);
    expect(await screen.findByText('Could not load the subscription')).toBeInTheDocument();
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Pro')).toBeInTheDocument();
  });

  it('a refresh that fails keeps the last answer on screen and says so', async () => {
    let calls = 0;
    fakeHub({ ...NO_BILLING, 'GET /plan': () => (++calls === 1 ? { body: PLAN } : new TypeError('fetch failed')) });
    render(<PlanTab />);
    await screen.findByText('Pro');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Showing the last answer from the hub/)).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
  });
});
