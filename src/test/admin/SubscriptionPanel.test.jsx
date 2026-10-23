import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PlanTab } from '@/admin/PlanTab';
import { SubscriptionPanel } from '@/admin/SubscriptionPanel';
import { describeBilling } from '@/admin/lib/subscription';
import { fakeHub } from '../helpers/fakeHub';

// Starting, changing and cancelling the subscription from the reception laptop. Nothing here moves money: "Subscribe" opens a page
// at Razorpay where the owner authorises payment, and until they do nothing is charged. So the screen's job is to say clearly where
// things stand, to ask before anything that cannot be undone, and never to pretend a payment happened.

const PLAN = {
  success: true, plan: 'starter', requested_plan: 'starter', status: 'active', degraded: false, degraded_reason: null, in_grace: false, grace_ends_at: null,
  synced_at: '2026-10-23T09:00:00.000Z', limits: { devices: 3, waiters: 5, tables: null, printers: 1 }, usage: { devices: 1, waiters: 2, printers: 0 }, features: {}
};
const base = over => ({ success: true, configured: true, reachable: true, billing_configured: true, plans: ['pro', 'enterprise'], subscription: null, ...over });
const sub = over => ({
  id: 'sub_1', status: 'active', plan: 'pro', plan_change_to: null, current_end: '2026-11-23T00:00:00.000Z', cancel_requested_at: null, created_at: '2026-10-01T00:00:00Z', ...over
});
const ids = view => view.actions.map(a => a.id + (a.plan ? `:${a.plan}` : ''));

// --- what each situation says and offers ---------------------------------------------------------------------------------

describe('describeBilling', () => {
  it('a hub with no billing service says so, and offers nothing', () => {
    const v = describeBilling({ billing: { success: true, configured: false }, plan: PLAN });
    expect(v.kind).toBe('not_connected');
    expect(v.title).toMatch(/not connected/i);
    expect(v.actions).toEqual([]);
    expect(v.link).toBeUndefined();
  });

  it('a service that cannot be reached says why, in words for each reason, and offers nothing', () => {
    const why = reason => describeBilling({ billing: { success: true, configured: true, reachable: false, reason, message: 'm' }, plan: PLAN });
    expect(why('OFFLINE').text).toMatch(/internet/i);
    expect(why('NO_CLOUD_SESSION').text).toMatch(/signed in to the cloud/i);
    expect(why('BILLING_UNAVAILABLE').text).toMatch(/not answering|try again/i);
    expect(why('SOMETHING_NEW').text).toMatch(/could not be reached/i);
    for (const r of ['OFFLINE', 'NO_CLOUD_SESSION', 'BILLING_UNAVAILABLE']) {
      expect(why(r).kind).toBe('unreachable');
      expect(why(r).actions).toEqual([]);
    }
  });

  it('a read that failed outright is the same as unreachable, and says what the hub said', () => {
    const v = describeBilling({ billing: null, billingError: new Error('The hub did not answer.'), plan: PLAN });
    expect(v.kind).toBe('unreachable');
    expect(v.text).toMatch(/The hub did not answer/);
    expect(describeBilling({ billing: null, plan: PLAN }).text).toMatch(/could not be reached/i);
  });

  it('with no subscription, each plan on offer can be subscribed to', () => {
    const v = describeBilling({ billing: base(), plan: PLAN });
    expect(v.kind).toBe('none');
    expect(ids(v)).toEqual(['subscribe:pro', 'subscribe:enterprise']);
    expect(v.actions.map(a => a.label)).toEqual(['Subscribe to Pro', 'Subscribe to Enterprise']);
    expect(v.text).toMatch(/Nothing is charged until you authorise it/);
  });

  it('only the plans that are on offer are offered', () => {
    expect(ids(describeBilling({ billing: base({ plans: ['pro'] }), plan: PLAN }))).toEqual(['subscribe:pro']);
    const none = describeBilling({ billing: base({ plans: [] }), plan: PLAN });
    expect(none.actions).toEqual([]);
    expect(none.text).toMatch(/cannot be bought online yet/i);
  });

  it('a payment page that is open is offered again, and says nothing is charged until it is used', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ status: 'created', plan: 'pro', short_url: 'https://rzp.io/i/abc', current_end: null }) }), plan: PLAN });
    expect(v.kind).toBe('waiting');
    expect(v.link).toEqual({ href: 'https://rzp.io/i/abc', label: 'Open the payment page' });
    expect(v.text).toMatch(/Nothing is charged until you do/);
    expect(v.title).toMatch(/Pro/);
    expect(ids(v)).toEqual([], 'a different plan cannot be chosen while one is waiting to be paid');
  });

  it('a link that is not an https page is not offered', () => {
    for (const short_url of ['javascript:alert(1)', 'http://rzp.io/i/abc', '', undefined, 'ftp://x']) {
      const v = describeBilling({ billing: base({ subscription: sub({ status: 'created', short_url }) }), plan: PLAN });
      expect(v.link, String(short_url)).toBeUndefined();
    }
  });

  it('a running subscription says what it is, when it renews, and offers the other plan and cancelling', () => {
    const v = describeBilling({ billing: base({ subscription: sub() }), plan: { ...PLAN, plan: 'pro' } });
    expect(v.kind).toBe('active');
    expect(v.title).toMatch(/Pro/);
    expect(v.text).toMatch(/renews/i);
    expect(ids(v)).toEqual(['change:enterprise', 'cancel']);
    expect(v.actions.find(a => a.id === 'cancel').destructive).toBe(true);
    expect(v.actions.find(a => a.id === 'change').label).toBe('Switch to Enterprise');
  });

  it('a change that is already scheduled is said, and not offered again', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ plan_change_to: 'enterprise' }) }), plan: PLAN });
    expect(v.text).toMatch(/moves to Enterprise/i);
    expect(ids(v)).toEqual(['cancel']);
  });

  it('a cancellation that is under way says when it ends and offers nothing', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ cancel_requested_at: '2026-10-20T00:00:00Z' }) }), plan: PLAN });
    expect(v.kind).toBe('cancelling');
    expect(v.title).toMatch(/ends/i);
    expect(v.text).toMatch(/keeps working/i);
    expect(v.actions).toEqual([]);
  });

  it('a subscription that is set up but not yet charged can be cancelled but not switched', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ status: 'authenticated' }) }), plan: PLAN });
    expect(v.kind).toBe('active');
    expect(v.text).toMatch(/first payment/i);
    expect(ids(v)).toEqual(['cancel']);
  });

  it('a failed payment is said plainly and does not claim the plan is lost', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ status: 'pending' }) }), plan: PLAN });
    expect(v.kind).toBe('past_due');
    expect(v.title).toMatch(/payment failed/i);
    expect(v.text).toMatch(/grace/i);
    expect(ids(v)).toEqual(['cancel']);
  });

  it('a subscription that has ended can be replaced, and says it has ended', () => {
    for (const status of ['cancelled', 'completed', 'expired']) {
      const v = describeBilling({ billing: base({ subscription: sub({ status }) }), plan: PLAN });
      expect(v.kind, status).toBe('ended');
      expect(v.title, status).toMatch(/ended/i);
      expect(ids(v), status).toEqual(['subscribe:pro', 'subscribe:enterprise']);
    }
  });

  it('one that Razorpay gave up on says payments stopped, and can be replaced', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ status: 'halted' }) }), plan: PLAN });
    expect(v.kind).toBe('ended');
    expect(v.title).toMatch(/payments stopped/i);
    expect(ids(v)).toEqual(['subscribe:pro', 'subscribe:enterprise']);
  });

  it('a cancellation with no date still says when it ends', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ cancel_requested_at: '2026-10-20T00:00:00Z', current_end: null }) }), plan: PLAN });
    expect(v.title).toBe('Ends at the end of this period');
  });

  it('a subscription that is not yet charged, or whose payment failed, can be on its way out as well', () => {
    for (const status of ['authenticated', 'pending']) {
      const v = describeBilling({ billing: base({ subscription: sub({ status, cancel_requested_at: '2026-10-20T00:00:00Z' }) }), plan: PLAN });
      expect(v.kind, status).toBe('cancelling');
      expect(v.actions, status).toEqual([]);
    }
  });

  it('a cancellation asked for on a subscription that has since ended is just ended', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ status: 'cancelled', cancel_requested_at: '2026-10-20T00:00:00Z' }) }), plan: PLAN });
    expect(v.kind).toBe('ended');
  });

  it('a subscription row with no plan name takes the plan the hub is on', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ plan: null }) }), plan: { ...PLAN, plan: 'enterprise' } });
    expect(v.title).toMatch(/Enterprise/);
  });

  it('a date that cannot be read is left out rather than shown as nonsense', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ current_end: 'not a date' }) }), plan: PLAN });
    expect(v.text).not.toMatch(/Invalid|NaN/);
    expect(v.text).toMatch(/renews each period/i);
  });

  it('an unknown status is described as it is, with nothing to press', () => {
    const v = describeBilling({ billing: base({ subscription: sub({ status: 'something_new' }) }), plan: PLAN });
    expect(v.kind).toBe('unknown');
    expect(v.actions).toEqual([]);
  });
});

// --- the panel -----------------------------------------------------------------------------------------------------------

const panel = (billing, over = {}) => {
  const notify = vi.fn();
  const onChanged = vi.fn();
  render(<SubscriptionPanel view={describeBilling({ billing, plan: PLAN })} onChanged={onChanged} notify={notify} {...over} />);
  return { notify, onChanged };
};

describe('subscription panel', () => {
  it('says where things stand under a heading, and shows nothing to press when there is nothing to do', () => {
    panel({ success: true, configured: false });
    expect(screen.getByRole('heading', { name: 'Subscription' })).toBeInTheDocument();
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('subscribing sends the plan, says what to do next, and asks the screen to read again', async () => {
    const hub = fakeHub({ 'POST /admin/billing/subscribe': { status: 201, body: { success: true, subscription: { id: 'sub_9', status: 'created', short_url: 'https://rzp.io/i/x' } } } });
    const { notify, onChanged } = panel(base());
    await userEvent.click(screen.getByRole('button', { name: 'Subscribe to Pro' }));
    expect(hub.calls('POST /admin/billing/subscribe')[0].body).toEqual({ plan: 'pro' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith('Subscription started. Open the payment page to authorise payment.');
  });

  it('a refusal is said in the service\'s words and nothing is reloaded as if it had worked', async () => {
    fakeHub({ 'POST /admin/billing/subscribe': { status: 409, body: { success: false, code: 'ALREADY_SUBSCRIBED', error: 'This restaurant already has a subscription.' } } });
    const { notify, onChanged } = panel(base());
    await userEvent.click(screen.getByRole('button', { name: 'Subscribe to Enterprise' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('This restaurant already has a subscription.', 'error'));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('while it is waiting there is a link to the payment page that opens elsewhere', () => {
    panel(base({ subscription: sub({ status: 'created', short_url: 'https://rzp.io/i/abc' }) }));
    const link = screen.getByRole('link', { name: 'Open the payment page' });
    expect(link).toHaveAttribute('href', 'https://rzp.io/i/abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(screen.queryByRole('button', { name: /Subscribe/ })).toBeNull();
  });

  it('cancelling asks first, says what will happen, and does nothing if the answer is no', async () => {
    const hub = fakeHub({ 'POST /admin/billing/cancel': { body: { success: true, subscription: sub({ cancel_requested_at: '2026-10-23T10:00:00Z' }) } } });
    panel(base({ subscription: sub() }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cancel the subscription?')).toBeInTheDocument();
    expect(within(dialog).getByText(/keeps Pro until/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/never switched off/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep the subscription' }));
    expect(hub.calls('POST /admin/billing/cancel')).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('confirming sends the cancellation, says it ends at the end of the period, and reads again', async () => {
    const hub = fakeHub({ 'POST /admin/billing/cancel': { body: { success: true, subscription: sub({ cancel_requested_at: '2026-10-23T10:00:00Z' }) } } });
    const { notify, onChanged } = panel(base({ subscription: sub() }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel at the end of the period' }));
    await waitFor(() => expect(hub.calls('POST /admin/billing/cancel')).toHaveLength(1));
    expect(hub.calls('POST /admin/billing/cancel')[0].body).toEqual({});
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith('Cancelling: the plan runs to the end of the period.');
  });

  it('the cancellation question still makes sense when the end date is not known', async () => {
    fakeHub({});
    panel(base({ subscription: sub({ current_end: null }) }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    expect(within(await screen.findByRole('dialog')).getByText(/keeps Pro until the end of the paid period/i)).toBeInTheDocument();
  });

  it('switching plan asks first, names both plans, and sends only the plan', async () => {
    const hub = fakeHub({ 'POST /admin/billing/change-plan': { body: { success: true, subscription: sub({ plan_change_to: 'enterprise' }) } } });
    const { notify, onChanged } = panel(base({ subscription: sub() }));
    await userEvent.click(screen.getByRole('button', { name: 'Switch to Enterprise' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Switch to Enterprise?')).toBeInTheDocument();
    expect(within(dialog).getByText(/stay on Pro until/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/then move to Enterprise/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Switch plan' }));
    await waitFor(() => expect(hub.calls('POST /admin/billing/change-plan')).toHaveLength(1));
    expect(hub.calls('POST /admin/billing/change-plan')[0].body).toEqual({ plan: 'enterprise' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith('Plan change scheduled for the end of the period.');
  });

  it('a refused change or cancellation is said in the service\'s words, and the dialog is closed', async () => {
    fakeHub({ 'POST /admin/billing/change-plan': { status: 409, body: { success: false, code: 'NOT_ACTIVE', error: 'A plan can be changed once the first payment has gone through.' } } });
    const { notify } = panel(base({ subscription: sub() }));
    await userEvent.click(screen.getByRole('button', { name: 'Switch to Enterprise' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch plan' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('A plan can be changed once the first payment has gone through.', 'error'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the confirm button cannot be pressed twice either, and the dialog stays up until the answer is in', async () => {
    let release;
    const hub = fakeHub({ 'POST /admin/billing/cancel': () => new Promise(resolve => { release = () => resolve({ body: { success: true, subscription: {} } }); }) });
    panel(base({ subscription: sub() }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Cancel at the end of the period' });
    await userEvent.click(confirm);
    expect(within(dialog).getByRole('button', { name: 'Cancel at the end of the period' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Keep the subscription' })).toBeDisabled();
    await userEvent.click(confirm);
    expect(hub.calls('POST /admin/billing/cancel')).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a state is drawn with a dot in its colour: green when running, amber when it needs attention, none when neutral', () => {
    const dotOf = billing => {
      const { container, unmount } = render(<SubscriptionPanel view={describeBilling({ billing, plan: PLAN })} onChanged={vi.fn()} notify={vi.fn()} />);
      const dot = container.querySelector('span[aria-hidden="true"]');
      const colour = dot ? dot.style.background : null;
      unmount();
      return colour;
    };
    expect(dotOf(base({ subscription: sub() }))).toContain('--status-green-text');
    expect(dotOf(base({ subscription: sub({ status: 'pending' }) }))).toContain('--status-amber-text');
    expect(dotOf(base())).toBeNull();
  });

  it('buttons are disabled while a request is in flight, so a double press cannot send two', async () => {
    let release;
    const hub = fakeHub({ 'POST /admin/billing/subscribe': () => new Promise(resolve => { release = () => resolve({ status: 201, body: { success: true, subscription: {} } }); }) });
    panel(base());
    const pro = screen.getByRole('button', { name: 'Subscribe to Pro' });
    await userEvent.click(pro);
    expect(screen.getByRole('button', { name: 'Subscribe to Pro' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Subscribe to Enterprise' })).toBeDisabled();
    await userEvent.click(pro);
    expect(hub.calls('POST /admin/billing/subscribe')).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subscribe to Pro' })).toBeEnabled());
  });
});

// --- in the Plan tab ------------------------------------------------------------------------------------------------------

describe('plan tab with the subscription', () => {
  it('reads the billing first, with a refresh when the owner presses Refresh, so the plan it then shows is the one the cloud now holds', async () => {
    const order = [];
    const hub = fakeHub({
      'GET /admin/billing': () => { order.push('billing'); return { body: base() }; },
      'GET /plan': () => { order.push('plan'); return { body: PLAN }; }
    });
    render(<PlanTab notify={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Subscription' })).toBeInTheDocument();
    expect(hub.calls('GET /admin/billing')[0].url.searchParams.get('refresh')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(hub.calls('GET /admin/billing')).toHaveLength(2));
    expect(hub.calls('GET /admin/billing')[1].url.searchParams.get('refresh')).toBe('1');
    expect(order.slice(-2)).toEqual(['billing', 'plan']);
  });

  it('shows the subscription under the plan, and subscribing there reloads both', async () => {
    const hub = fakeHub({
      'GET /admin/billing': ({ call }) => ({ body: call === 1 ? base() : base({ subscription: sub({ status: 'created', short_url: 'https://rzp.io/i/x' }) }) }),
      'GET /plan': { body: PLAN },
      'POST /admin/billing/subscribe': { status: 201, body: { success: true, subscription: { id: 'sub_1' } } }
    });
    const notify = vi.fn();
    render(<PlanTab notify={notify} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Subscribe to Pro' }));
    expect(await screen.findByRole('link', { name: 'Open the payment page' })).toHaveAttribute('href', 'https://rzp.io/i/x');
    expect(hub.calls('GET /plan').length).toBeGreaterThanOrEqual(2);
    expect(notify).toHaveBeenCalledWith('Subscription started. Open the payment page to authorise payment.');
  });

  it('a billing read that fails after one that worked replaces it, rather than leaving stale buttons up', async () => {
    fakeHub({
      'GET /admin/billing': ({ call }) => (call === 1 ? { body: base({ subscription: sub() }) } : new TypeError('fetch failed')),
      'GET /plan': { body: PLAN }
    });
    render(<PlanTab notify={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel subscription' })).toBeNull());
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it('if the billing cannot be read the plan still shows, and the subscription says it could not be reached', async () => {
    fakeHub({ 'GET /admin/billing': new TypeError('fetch failed'), 'GET /plan': { body: PLAN } });
    render(<PlanTab notify={vi.fn()} />);
    expect(await screen.findByText('Starter')).toBeInTheDocument();
    const section = (await screen.findByRole('heading', { name: 'Subscription' })).closest('section');
    expect(within(section).getByText(/could not be reached/i)).toBeInTheDocument();
  });
});
