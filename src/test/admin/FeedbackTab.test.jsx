import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FeedbackTab } from '@/admin/FeedbackTab';
import { fakeHub } from '../helpers/fakeHub';

// Reception's view of what guests said. Every comment on it was typed by a stranger on a phone.

const entry = (id, rating, extra = {}) => ({
  id, rating, table: `T${id}`, invoice_number: null, comment: '', created_at: '2026-10-17T14:45:00.000Z', ...extra
});

// The shape GET /feedback answers with (hub_server/lib/feedbackStore.js summary() + list()).
const ANSWER = {
  count: 4,
  average: 3.3,
  distribution: { 1: 1, 2: 0, 3: 1, 4: 1, 5: 1 },
  entries: [
    entry(1, 5, { comment: 'Best dal in Nagpur', invoice_number: 'INV-0042' }),
    entry(2, 1, { comment: 'Starters came after the mains.' }),
    entry(3, 4),
    entry(4, 3, { comment: '   ' })
  ]
};

const shownRatings = () => screen.queryAllByRole('img').map(el => el.getAttribute('aria-label'));

describe('admin feedback tab', () => {
  it('shows the average, how it was arrived at, and every entry newest first', async () => {
    fakeHub({ 'GET /feedback': { body: ANSWER } });
    render(<FeedbackTab />);

    expect(await screen.findByText('3.3')).toBeInTheDocument();
    expect(screen.getByText('3.3 average from 4 ratings')).toBeInTheDocument();
    expect(shownRatings()).toEqual(['5 out of 5', '1 out of 5', '4 out of 5', '3 out of 5']);
  });

  it('draws the split from the hub\'s counts, best first', async () => {
    fakeHub({ 'GET /feedback': { body: ANSWER } });
    render(<FeedbackTab />);
    const split = await screen.findByRole('list', { name: 'How the ratings split' });
    const rows = within(split).getAllByRole('listitem').map(li => li.textContent.replace(/\s+/g, ' ').trim());
    expect(rows).toEqual(['5 ★1', '4 ★1', '3 ★1', '2 ★0', '1 ★1']);
  });

  it('names the bill a rating was matched to, and says when there was none', async () => {
    fakeHub({ 'GET /feedback': { body: ANSWER } });
    render(<FeedbackTab />);
    await screen.findByText('Best dal in Nagpur');
    expect(screen.getByText(/Table T1 · Bill INV-0042/)).toBeInTheDocument();
    expect(screen.getByText(/Table T2 · No bill matched/)).toBeInTheDocument();
  });

  it('"Needs attention" counts and shows only the low ratings', async () => {
    fakeHub({ 'GET /feedback': { body: ANSWER } });
    render(<FeedbackTab />);

    const button = await screen.findByRole('button', { name: 'Needs attention (1)' });
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(shownRatings()).toEqual(['1 out of 5']);
  });

  it('"With comments" leaves out a comment that is only spaces', async () => {
    fakeHub({ 'GET /feedback': { body: ANSWER } });
    render(<FeedbackTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'With comments' }));
    expect(shownRatings()).toEqual(['5 out of 5', '1 out of 5']);
  });

  it('a guest\'s comment is shown as the words they typed, never as markup', async () => {
    const hostile = '<img src=x onerror="window.__pwn=1"><b>Cold</b> food & rude service!';
    fakeHub({ 'GET /feedback': { body: { count: 1, average: 1, distribution: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 }, entries: [entry(9, 1, { comment: hostile })] } } });
    const { container } = render(<FeedbackTab />);

    expect(await screen.findByText(hostile)).toBeInTheDocument();
    // Not escaped twice either: reception must see "&", not "&amp;".
    expect(screen.queryByText(/&amp;/)).not.toBeInTheDocument();
    const list = container.querySelectorAll('li p');
    for (const p of list) expect(p.querySelector('img, b')).toBeNull();
    expect(window.__pwn).toBeUndefined();
  });

  it('when the list is capped, says the average and split still cover everything', async () => {
    fakeHub({ 'GET /feedback': { body: { ...ANSWER, count: 130 } } });
    render(<FeedbackTab />);
    expect(await screen.findByText('Showing the latest 4 of 130. The average and split above cover all of them.')).toBeInTheDocument();
  });

  it('with no feedback yet, tells reception where guests leave it', async () => {
    fakeHub({ 'GET /feedback': { body: { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, entries: [] } } });
    render(<FeedbackTab />);
    expect(await screen.findByText('No feedback yet')).toBeInTheDocument();
    expect(screen.getByText(/Print the codes from the Tables tab/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'How the ratings split' })).not.toBeInTheDocument();
  });

  it('opened somewhere other than the reception laptop, explains where to open it', async () => {
    fakeHub({ 'GET /feedback': { status: 403, body: { code: 'RECEPTION_ONLY', error: 'Reception only' } } });
    render(<FeedbackTab />);
    expect(await screen.findByText('Could not load guest feedback')).toBeInTheDocument();
    expect(screen.getByText(/only works on the reception laptop/)).toBeInTheDocument();
  });

  it('a failed refresh keeps the last answer on screen and says it is stale', async () => {
    fakeHub({
      'GET /feedback': ({ call }) => (call === 1 ? { body: ANSWER } : new TypeError('Failed to fetch'))
    });
    render(<FeedbackTab />);
    await screen.findByText('Best dal in Nagpur');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Showing the last answer from the hub/)).toBeInTheDocument();
    expect(screen.getByText('Best dal in Nagpur')).toBeInTheDocument();
  });
});
