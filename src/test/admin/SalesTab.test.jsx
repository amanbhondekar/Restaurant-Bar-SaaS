import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SalesTab } from '@/admin/SalesTab';
import { deferred, fakeHub } from '../helpers/fakeHub';

// Reception's sales screen: the period against the one before it, who came, and the summaries the hub
// prepared. The sums are the hub's (tested there); this checks that what it says reaches the screen intact,
// that a slow answer to an old question never overwrites a new one, and that the owner's number and the
// "send" links do what they say.

const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, bills: 0, billed: 0 }));
hours[13] = { hour: 13, bills: 3, billed: 1500 };
hours[14] = { hour: 14, bills: 1, billed: 500 };
const d = (direction, pct = null) => ({ direction, pct, change: 0, current: 0, previous: 0 });

const REPORT = {
  success: true,
  currency: '₹',
  periods: ['today', 'week', 'month', 'custom'],
  period: { preset: 'today', label: 'Today so far', previous_label: 'yesterday so far' },
  current: {
    takings: { payments: 2000, refunds: 0, net: 2000, by_method: { cash: 800, upi: 1200 } },
    bills: { count: 4, billed: 2000, average: 500 },
    voided: { count: 0, total: 0 },
    top_dishes: [{ name: 'Dal Makhani', qty: 6, revenue: 1200 }, { name: 'Naan', qty: 1, revenue: 40 }],
    dish_count: 7,
    by_hour: hours,
    busiest_hour: 13
  },
  previous: {},
  comparison: { net: d('up', 25), bills: d('same'), average_bill: d('up', 25), refunds: d('same'), voided: d('same') },
  guests: { guests: 5, new: 2, returning: 3, previous: { guests: 4, new: 4 }, retention: { of: 4, returned: 1, pct: 25 } },
  cohorts: [{ month: '2026-10', guests: 6, returned: 2, returned_pct: 33 }, { month: '2026-09', guests: 4, returned: 3, returned_pct: 75 }]
};
const EMPTY = {
  ...REPORT,
  current: { ...REPORT.current, takings: { payments: 0, refunds: 0, net: 0, by_method: {} }, bills: { count: 0, billed: 0, average: null }, top_dishes: [], dish_count: 0, by_hour: hours.map(h => ({ ...h, bills: 0, billed: 0 })), busiest_hour: null },
  guests: { guests: 0, new: 0, returning: 0, previous: { guests: 0, new: 0 }, retention: null },
  cohorts: []
};
const SUMMARY = (over = {}) => ({
  id: 'day:2026-10-21', kind: 'day', key: '2026-10-21', title: 'Daily summary — Wed, 21 Oct', sent_at: null,
  text: 'Daily summary — Wed, 21 Oct\nTakings: ₹1,800', whatsapp: 'https://wa.me/?text=Daily', ...over
});
const REPORTS = (over = {}) => ({ success: true, contact: null, summaries: [SUMMARY()], ...over });

const setup = (routes = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({
    'GET /admin/sales': { body: REPORT },
    'GET /admin/reports': { body: REPORTS() },
    ...routes
  });
  render(<SalesTab notify={notify} />);
  return { hub, notify };
};
const ready = () => screen.findByText('Best sellers');
const queryOf = call => Object.fromEntries(call.url.searchParams);

describe('sales tab — the figures', () => {
  it('asks for today, and the summaries, as soon as it opens', async () => {
    const { hub } = setup();
    await ready();
    expect(queryOf(hub.calls('GET /admin/sales')[0])).toEqual({ period: 'today' });
    expect(hub.calls('GET /admin/reports')).toHaveLength(1);
  });

  it('shows takings, bills and the average bill, each with how it compares with the period before', async () => {
    setup();
    await ready();
    const card = label => screen.getByText(label).parentElement;
    expect(card('Takings')).toHaveTextContent('Takings₹2,000up 25% on yesterday so far');
    expect(card('Bills')).toHaveTextContent('Bills4the same as yesterday so far');
    expect(card('Average bill')).toHaveTextContent('Average bill₹500up 25% on yesterday so far');
    expect(screen.getByText('Today so far').parentElement).toHaveTextContent('Today so far, set against yesterday so far.');
  });

  it('says how the money was taken, and lists the best sellers with how many are not shown', async () => {
    setup();
    await ready();
    expect(screen.getByText('Taken by: UPI ₹1,200 · Cash ₹800')).toBeInTheDocument();
    expect(screen.getByText('Dal Makhani')).toBeInTheDocument();
    expect(screen.getByText('6 portions · ₹1,200')).toBeInTheDocument();
    expect(screen.getByText('1 portion · ₹40')).toBeInTheDocument();
    expect(screen.getByText('and 5 more dishes')).toBeInTheDocument();
  });

  it('shows only the hours that had business, as words, with the bars left out of the reading order', async () => {
    setup();
    await ready();
    const list = screen.getByRole('list', { name: 'Bills by hour' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(r => r.textContent)).toEqual(['1pm3 bills · ₹1,500', '2pm1 bill · ₹500']);
    expect(list.querySelectorAll('[aria-hidden="true"]').length).toBe(2);
  });

  it('says who came, how many returned, and how each month\'s first-time guests have fared', async () => {
    setup();
    await ready();
    expect(screen.getByText('5 guests: 2 new, 3 returning')).toBeInTheDocument();
    expect(screen.getByText('Of the 4 guests who were new in the period before, 1 came again (25%).')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Guests by the month of their first visit' });
    const cells = month => within(within(table).getByRole('row', { name: new RegExp(month) })).getAllByRole('cell').map(c => c.textContent);
    expect(cells('Oct 2026')).toEqual(['6', '2 (33%)']);
    expect(cells('Sep 2026')).toEqual(['4', '3 (75%)']);
  });

  it('shows refunds and voided bills only when there were some', async () => {
    setup();
    await ready();
    expect(screen.queryByText('Refunded')).toBeNull();
    expect(screen.queryByText('Voided bills')).toBeNull();
  });

  it('says so when nothing was sold, rather than a screen of zeros', async () => {
    setup({ 'GET /admin/sales': { body: EMPTY } });
    expect(await screen.findByText('No sales in this period')).toBeInTheDocument();
    expect(screen.queryByText('Best sellers')).toBeNull();
    expect(screen.getByText('No seated bookings or walk-ins recorded in this period.')).toBeInTheDocument();
    expect(screen.getByText('Average bill').nextSibling).toHaveTextContent('–');
  });
});

describe('sales tab — periods', () => {
  it('switches period, marks the pressed one, and asks the hub for it', async () => {
    const { hub } = setup({ 'GET /admin/sales': ({ url }) => ({ body: { ...REPORT, period: { ...REPORT.period, preset: url.searchParams.get('period'), label: url.searchParams.get('period') === 'week' ? 'This week so far' : 'Today so far' } } }) });
    await ready();
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(await screen.findByText(/This week so far/)).toBeInTheDocument();
    expect(queryOf(hub.calls('GET /admin/sales')[1])).toEqual({ period: 'week' });
    expect(screen.getByRole('button', { name: 'This week' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a slow answer to an earlier question never overwrites the one asked since', async () => {
    const slow = deferred();
    const answers = { week: slow.promise };
    setup({
      'GET /admin/sales': async ({ url }) => {
        const p = url.searchParams.get('period');
        if (answers[p]) await answers[p];
        return { body: { ...REPORT, period: { ...REPORT.period, preset: p, label: `label-${p}` } } };
      }
    });
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'This week' }));   // held open
    await userEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(await screen.findByText(/label-month/)).toBeInTheDocument();
    slow.resolve();
    await new Promise(r => setTimeout(r, 30));
    expect(screen.getByText(/label-month/)).toBeInTheDocument();
    expect(screen.queryByText(/label-week/)).toBeNull();
  });

  it('a custom range asks nothing until both days are chosen, then sends them as whole days', async () => {
    const { hub } = setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByText('Choose the first and last day to see the figures.')).toBeInTheDocument();
    expect(hub.calls('GET /admin/sales')).toHaveLength(1);

    await userEvent.type(screen.getByLabelText('From'), '2026-10-10');
    expect(hub.calls('GET /admin/sales')).toHaveLength(1);
    await userEvent.type(screen.getByLabelText('To (including this day)'), '2026-10-12');

    await waitFor(() => expect(hub.calls('GET /admin/sales')).toHaveLength(2));
    const q = queryOf(hub.calls('GET /admin/sales')[1]);
    expect(q.period).toBe('custom');
    expect(new Date(q.from).getTime()).toBe(new Date(2026, 9, 10).getTime());
    expect(new Date(q.to).getTime()).toBe(new Date(2026, 9, 13).getTime());
  });

  it('a last day before the first is explained and not sent', async () => {
    const { hub } = setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await userEvent.type(screen.getByLabelText('From'), '2026-10-12');
    await userEvent.type(screen.getByLabelText('To (including this day)'), '2026-10-10');
    expect(await screen.findByText('The last day cannot be before the first.')).toBeInTheDocument();
    expect(hub.calls('GET /admin/sales')).toHaveLength(1);
  });

  it('when the hub refuses a range, the page says what the hub said', async () => {
    setup({ 'GET /admin/sales': ({ url }) => (url.searchParams.get('period') === 'custom' ? { status: 400, body: { success: false, code: 'INVALID_RANGE', error: 'That range is longer than two years.' } } : { body: REPORT }) });
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await userEvent.type(screen.getByLabelText('From'), '2020-01-01');
    await userEvent.type(screen.getByLabelText('To (including this day)'), '2026-01-01');
    expect(await screen.findByText('That range is longer than two years.')).toBeInTheDocument();
  });

  it('an unreachable hub is explained with a way to try again', async () => {
    let up = false;
    setup({ 'GET /admin/sales': () => (up ? { body: REPORT } : new TypeError('fetch failed')) });
    expect(await screen.findByText('Could not load the figures')).toBeInTheDocument();
    up = true;
    await userEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(await screen.findByText('Best sellers')).toBeInTheDocument();
  });
});

describe('sales tab — summaries', () => {
  it('lists each with whether it has been sent, a link that opens WhatsApp, and the text to read', async () => {
    setup({ 'GET /admin/reports': { body: REPORTS({ summaries: [SUMMARY(), SUMMARY({ id: 'week:2026-10-12', title: 'Weekly summary — 12 Oct – 18 Oct', sent_at: '2026-10-19T04:00:00.000Z', whatsapp: 'https://wa.me/919876543210?text=Week' })] }) } });
    await ready();
    const day = (await screen.findByText('Daily summary — Wed, 21 Oct', { selector: 'div' })).closest('li');
    expect(within(day).getByText('Not sent yet')).toBeInTheDocument();
    const link = within(day).getByRole('link', { name: /Send Daily summary/ });
    expect(link).toHaveAttribute('href', 'https://wa.me/?text=Daily');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noreferrer/);

    const week = screen.getByText('Weekly summary — 12 Oct – 18 Oct', { selector: 'div' }).closest('li');
    expect(within(week).getByText(/Opened in WhatsApp/)).toBeInTheDocument();
    expect(within(week).getByRole('link', { name: /Send again/ })).toHaveAttribute('href', 'https://wa.me/919876543210?text=Week');
  });

  it('tapping Send notes it as sent without getting in the way of the link', async () => {
    const { hub } = setup({ 'POST /admin/reports/day%3A2026-10-21/sent': { body: { success: true, sent_at: '2026-10-22T09:00:00.000Z' } } });
    await ready();
    const link = await screen.findByRole('link', { name: /Send Daily summary/ });
    link.addEventListener('click', e => e.preventDefault());   // jsdom would try to navigate
    await userEvent.click(link);
    await waitFor(() => expect(hub.calls('POST /admin/reports/day%3A2026-10-21/sent')).toHaveLength(1));
    expect(await screen.findByText(/Opened in WhatsApp/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Send again/ })).toBeInTheDocument();
  });

  it('if the hub cannot note it, the person is told, and the link still worked', async () => {
    const { notify } = setup({ 'POST /admin/reports/day%3A2026-10-21/sent': { status: 500, body: { success: false } } });
    await ready();
    const link = await screen.findByRole('link', { name: /Send Daily summary/ });
    link.addEventListener('click', e => e.preventDefault());
    await userEvent.click(link);
    await waitFor(() => expect(notify).toHaveBeenCalledWith('WhatsApp opened, but the hub could not note that it was sent.', 'error'));
    expect(screen.getByText('Not sent yet')).toBeInTheDocument();
  });

  it('shows what the summary says as plain text, never as markup', async () => {
    setup({ 'GET /admin/reports': { body: REPORTS({ summaries: [SUMMARY({ text: 'Best sellers: <img src=x onerror=alert(1)> ×3' })] }) } });
    await ready();
    await screen.findByText('Daily summary — Wed, 21 Oct', { selector: 'div' });
    expect(screen.getByText(/Best sellers: <img src=x onerror=alert\(1\)> ×3/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the newest few and keeps the rest a tap away', async () => {
    const many = Array.from({ length: 10 }, (_, i) => SUMMARY({ id: `day:${i}`, title: `Daily summary ${i}` }));
    setup({ 'GET /admin/reports': { body: REPORTS({ summaries: many }) } });
    await ready();
    await screen.findByText('Daily summary 0');
    expect(screen.queryByText('Daily summary 6')).toBeNull();
    expect(screen.getByText('Daily summary 5')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show 4 older' }));
    expect(screen.getByText('Daily summary 9')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByText('Daily summary 9')).toBeNull();
  });

  it('offers no "older" button when everything is already shown', async () => {
    setup();
    await ready();
    await screen.findByText('Daily summary — Wed, 21 Oct', { selector: 'div' });
    expect(screen.queryByRole('button', { name: /older/ })).toBeNull();
  });

  it('says there is nothing yet, and when it cannot load, how to try again', async () => {
    setup({ 'GET /admin/reports': { body: REPORTS({ summaries: [] }) } });
    expect(await screen.findByText(/Nothing to summarise yet/)).toBeInTheDocument();
  });

  it('a failed summaries load does not take the figures down with it', async () => {
    setup({ 'GET /admin/reports': { status: 500, body: { success: false, error: 'boom' } } });
    expect(await screen.findByText('Could not load the summaries')).toBeInTheDocument();
    expect(screen.getByText('Best sellers')).toBeInTheDocument();
  });
});

describe('sales tab — the owner\'s number', () => {
  it('saves the number as typed, reloads the links, and says so', async () => {
    let contact = null;
    const { hub, notify } = setup({
      'GET /admin/reports': () => ({ body: REPORTS({ contact }) }),
      'PUT /admin/reports/contact': ({ body }) => { contact = '919876543210'; return { body: { success: true, contact } }; }
    });
    await ready();
    await userEvent.type(await screen.findByLabelText("Owner's WhatsApp number"), '98765 43210');
    await userEvent.click(screen.getByRole('button', { name: 'Save number' }));
    await waitFor(() => expect(hub.calls('PUT /admin/reports/contact')).toHaveLength(1));
    expect(hub.calls('PUT /admin/reports/contact')[0].body).toEqual({ phone: '98765 43210' });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Number saved. New links go straight to it.'));
    expect(hub.calls('GET /admin/reports')).toHaveLength(2);
    expect(screen.getByLabelText("Owner's WhatsApp number")).toHaveValue('+91 98765 43210');
  });

  it('shows the hub\'s reason beside the field when the number is no good', async () => {
    setup({ 'PUT /admin/reports/contact': { status: 400, body: { success: false, code: 'INVALID_PHONE', error: 'That does not look like a mobile number.' } } });
    await ready();
    await userEvent.type(await screen.findByLabelText("Owner's WhatsApp number"), '123');
    await userEvent.click(screen.getByRole('button', { name: 'Save number' }));
    expect(await screen.findByText('That does not look like a mobile number.')).toBeInTheDocument();
    expect(screen.getByLabelText("Owner's WhatsApp number")).toHaveAttribute('aria-invalid', 'true');

    // Typing again is correcting it: the complaint about the old text goes away.
    await userEvent.type(screen.getByLabelText("Owner's WhatsApp number"), '4');
    expect(screen.queryByText('That does not look like a mobile number.')).toBeNull();
    expect(screen.getByLabelText("Owner's WhatsApp number")).not.toHaveAttribute('aria-invalid');
  });

  it('a saved number can be removed by clearing the field', async () => {
    const { hub } = setup({
      'GET /admin/reports': { body: REPORTS({ contact: '919876543210' }) },
      'PUT /admin/reports/contact': { body: { success: true, contact: null } }
    });
    await ready();
    const field = await screen.findByLabelText("Owner's WhatsApp number");
    expect(field).toHaveValue('+91 98765 43210');
    await userEvent.clear(field);
    await userEvent.click(screen.getByRole('button', { name: 'Remove number' }));
    await waitFor(() => expect(hub.calls('PUT /admin/reports/contact')).toHaveLength(1));
    expect(hub.calls('PUT /admin/reports/contact')[0].body).toEqual({ phone: '' });
  });
});
