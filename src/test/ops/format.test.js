import { describe, expect, it } from 'vitest';

import {
  MIN, HOUR, DAY, relative, day, statusLabel, hubLabel, eventLabel, severityLabel, clockSkew, filterTenants, countViews, VIEWS,
  statusTone, hubTone, severityTone, billingLine
} from '@/ops/lib/format';

// How the operator console says things: when, how long ago, what a status or an event is called, and which restaurants a filter keeps. All
// plain functions of the moment they are given; none reads a clock.

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const at = ms => new Date(NOW + ms).toISOString();

describe('relative: how long ago, or how long until', () => {
  it('says just now for anything within 45 seconds either way', () => {
    expect(relative(at(0), NOW)).toBe('just now');
    expect(relative(at(-44 * 1000), NOW)).toBe('just now');
    expect(relative(at(44 * 1000), NOW)).toBe('just now');
  });

  it('counts minutes up to the hour, hours up to the day, days up to forty-five, then weeks', () => {
    expect(relative(at(-45 * 1000), NOW)).toBe('1 min ago');
    expect(relative(at(-96 * 1000), NOW)).toBe('1 min ago');
    expect(relative(at(96 * 1000), NOW)).toBe('in 1 min');
    expect(relative(at(-59 * MIN), NOW)).toBe('59 min ago');
    expect(relative(at(-HOUR), NOW)).toBe('1 hour ago');
    expect(relative(at(-5 * HOUR - 30 * MIN), NOW)).toBe('5 hours ago');
    expect(relative(at(-DAY), NOW)).toBe('1 day ago');
    expect(relative(at(-20 * DAY), NOW)).toBe('20 days ago');
    expect(relative(at(-45 * DAY + 1), NOW)).toBe('44 days ago');
    expect(relative(at(-45 * DAY), NOW)).toBe('6 weeks ago');
    expect(relative(at(-100 * DAY), NOW)).toBe('14 weeks ago');
    expect(relative(at(-53 * DAY), NOW)).toBe('7 weeks ago');
  });

  it('says the same of the future', () => {
    expect(relative(at(45 * 1000), NOW)).toBe('in 1 min');
    expect(relative(at(3 * HOUR), NOW)).toBe('in 3 hours');
    expect(relative(at(2 * DAY), NOW)).toBe('in 2 days');
    expect(relative(at(21 * DAY), NOW)).toBe('in 21 days');
    expect(relative(at(70 * DAY), NOW)).toBe('in 10 weeks');
  });

  it('says what it is told to for a time that is not one', () => {
    expect(relative(null, NOW)).toBe('—');
    expect(relative(undefined, NOW)).toBe('—');
    expect(relative('', NOW)).toBe('—');
    expect(relative('garbage', NOW)).toBe('—');
    expect(relative(null, NOW, 'never')).toBe('never');
  });
});

describe('day: a date, in the time zone it is asked for', () => {
  it('writes the day, month and year', () => {
    expect(day('2026-10-24T12:00:00.000Z', 'UTC')).toBe('24 Oct 2026');
    expect(day('2026-01-05T23:30:00.000Z', 'UTC')).toBe('5 Jan 2026');
  });

  it('is the viewer\'s own day unless told otherwise', () => {
    expect(day('2026-10-24T23:30:00.000Z', 'Asia/Kolkata')).toBe('25 Oct 2026');
  });

  it('is a dash for nothing', () => {
    expect(day(null)).toBe('—');
    expect(day('garbage')).toBe('—');
  });
});

describe('names', () => {
  it('names a billing state, and shows one it has never heard of as it is', () => {
    expect(['active', 'trialing', 'past_due', 'suspended', 'cancelled'].map(statusLabel)).toEqual(['Active', 'On trial', 'Overdue', 'Suspended', 'Cancelled']);
    expect(statusLabel('paused')).toBe('paused');
    expect(statusLabel(null)).toBe('—');
  });

  it('names how lately a hub was heard from', () => {
    expect(['live', 'quiet', 'silent', 'never'].map(hubLabel)).toEqual(['Live', 'Quiet', 'Silent', 'Never reported']);
    expect(hubLabel('odd')).toBe('odd');
  });

  it('names the severities', () => {
    expect([severityLabel('high'), severityLabel('medium'), severityLabel(null)]).toEqual(['High', 'Medium', '']);
  });

  it('says what a subscription event was in plain words, and an event it does not know as it is', () => {
    expect(eventLabel('subscription.charged')).toBe('Payment taken');
    expect(eventLabel('subscription.halted')).toBe('Payment failed, subscription halted');
    expect(eventLabel('subscription.activated')).toBe('Subscription started');
    expect(eventLabel('subscription.authenticated')).toBe('Payment authorised');
    expect(eventLabel('subscription.pending')).toBe('Payment pending');
    expect(eventLabel('subscription.cancelled')).toBe('Subscription cancelled');
    expect(eventLabel('subscription.completed')).toBe('Subscription ran its course');
    expect(eventLabel('subscription.paused')).toBe('Subscription paused');
    expect(eventLabel('subscription.resumed')).toBe('Subscription resumed');
    expect(eventLabel('subscription.updated')).toBe('Subscription changed');
    expect(eventLabel('payment.dispute.created')).toBe('payment.dispute.created');
  });
});

describe('tones: which colour each state is drawn in', () => {
  it('draws money owed and a suspension as bad, a trial as news, and the rest plainly', () => {
    expect(['active', 'trialing', 'past_due', 'suspended', 'cancelled', 'odd', null].map(statusTone)).toEqual(['good', 'info', 'bad', 'bad', 'muted', 'muted', 'muted']);
  });

  it('draws a live hub as good, a silent or missing one as a warning, and a quiet one plainly', () => {
    expect(['live', 'quiet', 'silent', 'never', 'odd'].map(hubTone)).toEqual(['good', 'muted', 'warning', 'warning', 'muted']);
  });

  it('draws high as bad and medium as a warning', () => {
    expect([severityTone('high'), severityTone('medium'), severityTone(null)]).toEqual(['bad', 'warning', 'muted']);
  });
});

describe('billingLine: what a restaurant says about its billing on one line', () => {
  const t = over => ({ plan_status: 'active', trial_ends_at: null, current_period_end: at(20 * DAY), subscription: null, ...over });
  it('says when a plan renews, or ended', () => {
    expect(billingLine(t(), NOW)).toBe('Renews in 20 days');
    expect(billingLine(t({ current_period_end: at(-4 * DAY) }), NOW)).toBe('Ended 4 days ago');
    expect(billingLine(t({ current_period_end: at(-1) }), NOW)).toBe('Ended just now');
    expect(billingLine(t({ current_period_end: at(0) }), NOW)).toBe('Renews just now');
  });

  it('says it ends, not renews, once cancelling has been asked for', () => {
    expect(billingLine(t({ subscription: { cancel_requested_at: at(-DAY) } }), NOW)).toBe('Ends in 20 days');
    expect(billingLine(t({ subscription: { cancel_requested_at: null } }), NOW)).toBe('Renews in 20 days');
  });

  it('says when a trial ends, or ended, in place of a renewal', () => {
    expect(billingLine(t({ plan_status: 'trialing', trial_ends_at: at(10 * DAY), current_period_end: null }), NOW)).toBe('Trial ends in 10 days');
    expect(billingLine(t({ plan_status: 'trialing', trial_ends_at: at(-3 * DAY), current_period_end: null }), NOW)).toBe('Trial ended 3 days ago');
    expect(billingLine(t({ plan_status: 'trialing', trial_ends_at: at(0), current_period_end: null }), NOW)).toBe('Trial ends just now');
    expect(billingLine(t({ plan_status: 'trialing', trial_ends_at: null, current_period_end: at(5 * DAY) }), NOW)).toBe('Renews in 5 days');
    expect(billingLine(t({ plan_status: 'active', trial_ends_at: at(10 * DAY) }), NOW)).toBe('Renews in 20 days');
  });

  it('says cancelled for someone who has left, and a dash when there is no date', () => {
    expect(billingLine(t({ plan_status: 'cancelled' }), NOW)).toBe('Cancelled');
    expect(billingLine(t({ current_period_end: null }), NOW)).toBe('—');
    expect(billingLine(t({ current_period_end: 'garbage' }), NOW)).toBe('—');
  });
});

describe('clockSkew: how far a hub\'s clock is from the database\'s', () => {
  const hub = (reported, seen) => ({ reported_at: reported, seen_at: seen });
  it('is nothing when the two agree to within five minutes, or when either is missing', () => {
    expect(clockSkew(hub(at(0), at(0)))).toBeNull();
    expect(clockSkew(hub(at(-5 * MIN), at(0)))).toBeNull();
    expect(clockSkew(hub(null, at(0)))).toBeNull();
    expect(clockSkew(hub(at(0), null))).toBeNull();
    expect(clockSkew(hub('x', 'y'))).toBeNull();
  });

  it('says how far and which way when it is more', () => {
    expect(clockSkew(hub(at(6 * MIN), at(0)))).toBe('6 minutes ahead');
    expect(clockSkew(hub(at(-90 * MIN), at(0)))).toBe('90 minutes behind');
    expect(clockSkew(hub(at(5 * HOUR), at(0)))).toBe('5 hours ahead');
    expect(clockSkew(hub(at(2 * HOUR), at(0)))).toBe('2 hours ahead');
    expect(clockSkew(hub(at(2 * HOUR - 1), at(0)))).toBe('119 minutes ahead');
    expect(clockSkew(hub(at(-5 * MIN - 1), at(0)))).toBe('5 minutes behind');
  });
});

describe('looking through the fleet', () => {
  const t = (id, name, over = {}) => ({
    id, name, slug: name.toLowerCase().replace(/\W+/g, '-'), city: 'Nagpur', phone: '98220 12345', plan_status: 'active', severity: null,
    hub: { state: 'live' }, ...over
  });
  const FLEET = [
    t('a', 'Hotel Mejwani', { severity: 'high', plan_status: 'past_due' }),
    t('b', 'Spice Garden', { city: 'Pune', phone: '+91 98765 43210', plan_status: 'trialing', severity: 'medium' }),
    t('c', 'Chai Point', { hub: { state: 'silent' } }),
    t('d', 'Dosa Corner', { hub: { state: 'never' }, plan_status: 'suspended', severity: 'high' }),
    t('e', 'Old Place', { hub: { state: 'silent' }, plan_status: 'cancelled' }),
    t('f', 'Quiet Bistro', { hub: { state: 'quiet' } })
  ];
  const names = list => list.map(x => x.name);

  it('keeps everyone with no filter', () => {
    expect(filterTenants(FLEET, {})).toHaveLength(6);
    expect(filterTenants(FLEET, { text: '   ', view: 'all' })).toHaveLength(6);
  });

  it('keeps those that need attention, those on trial, those overdue or suspended, and those whose hub has gone silent (but not those that left)', () => {
    expect(names(filterTenants(FLEET, { view: 'attention' }))).toEqual(['Hotel Mejwani', 'Spice Garden', 'Dosa Corner']);
    expect(names(filterTenants(FLEET, { view: 'trial' }))).toEqual(['Spice Garden']);
    expect(names(filterTenants(FLEET, { view: 'overdue' }))).toEqual(['Hotel Mejwani', 'Dosa Corner']);
    expect(names(filterTenants(FLEET, { view: 'silent' }))).toEqual(['Chai Point', 'Dosa Corner']);
  });

  it('searches the name, the city, the address slug and the phone number, ignoring capitals, spaces and punctuation', () => {
    expect(names(filterTenants(FLEET, { text: 'mejw' }))).toEqual(['Hotel Mejwani']);
    expect(names(filterTenants(FLEET, { text: 'PUNE' }))).toEqual(['Spice Garden']);
    expect(names(filterTenants(FLEET, { text: 'dosa-corner' }))).toEqual(['Dosa Corner']);
    expect(names(filterTenants(FLEET, { text: '9876543210' }))).toEqual(['Spice Garden']);
    expect(names(filterTenants(FLEET, { text: '98765 4321' }))).toEqual(['Spice Garden']);
    expect(names(filterTenants(FLEET, { text: 'nagpur' }))).toHaveLength(5);
    expect(filterTenants(FLEET, { text: 'nothing like it' })).toEqual([]);
  });

  it('searches phone numbers only with something that is a number, and with at least three digits of it', () => {
    expect(names(filterTenants(FLEET, { text: '987' }))).toEqual(['Spice Garden']);
    expect(names(filterTenants(FLEET, { text: '98' }))).toEqual([]);
    expect(names(filterTenants(FLEET, { text: '+91 987' }))).toEqual(['Spice Garden']);
    expect(names(filterTenants(FLEET, { text: 'cafe 987' }))).toEqual([]);
    expect(names(filterTenants(FLEET, { text: '(987)' }))).toEqual(['Spice Garden']);
    expect(names(filterTenants(FLEET, { text: '987-654' }))).toEqual(['Spice Garden']);
  });

  it('shows everyone for a view it has never heard of', () => {
    expect(filterTenants(FLEET, { view: 'nonsense' })).toHaveLength(6);
  });

  it('puts a search and a filter together, and does not mind a restaurant with nothing filled in', () => {
    expect(names(filterTenants(FLEET, { text: 'nagpur', view: 'overdue' }))).toEqual(['Hotel Mejwani', 'Dosa Corner']);
    expect(filterTenants([{ id: 'z', name: 'Bare', hub: { state: 'live' } }], { text: 'x' })).toEqual([]);
    expect(names(filterTenants([{ id: 'z', name: 'Bare', hub: { state: 'live' } }], { text: 'bare' }))).toEqual(['Bare']);
  });

  it('counts what each view would keep, whatever is typed', () => {
    expect(countViews(FLEET)).toEqual({ all: 6, attention: 3, trial: 1, overdue: 2, silent: 2 });
    expect(countViews([])).toEqual({ all: 0, attention: 0, trial: 0, overdue: 0, silent: 0 });
  });

  it('knows its views by name', () => {
    expect(VIEWS.map(v => v.id)).toEqual(['all', 'attention', 'trial', 'overdue', 'silent']);
    expect(VIEWS.map(v => v.label)).toEqual(['All', 'Needs attention', 'On trial', 'Overdue', 'Hub silent']);
  });
});
