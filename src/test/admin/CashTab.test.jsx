import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CashTab } from '@/admin/CashTab';
import { deferred, fakeHub } from '../helpers/fakeHub';

// Reception's cash screen: what the system says was taken, what the drawer and the statements say, and
// the one irreversible act -- closing the shift. The hub does the real arithmetic at close; the figures on
// this screen are a preview so the difference is seen BEFORE committing, which is the thing to get right.

const method = (payments_total, payments_count, refunds_total = 0, refunds_count = 0) => ({
  payments_total, payments_count, refunds_total, refunds_count, net: payments_total - refunds_total
});
const PREVIEW = {
  success: true,
  since_last_close: true,
  last_record: { number: 'REC-0003', closed_at: '2026-10-21T20:00:00.000Z' },
  period_start: '2026-10-21T20:00:00.000Z',
  suggested_opening_float: 1000,
  by_method: { cash: method(5000, 12, 200, 1), upi: method(3000, 8), card: method(2000, 5), other: method(0, 0) },
  totals: { payments_total: 10000, refunds_total: 200, net: 9800 },
  unpaid: { count: 0, total: 0 },
  voided: { count: 0, total: 0 }
};
const RECORD = {
  id: 'r3', number: 'REC-0003', period_start: '2026-10-20T20:00:00.000Z', period_end: '2026-10-21T20:00:00.000Z',
  closed_by: 'Asha', expected_cash: 5600, counted_cash: 5600, cash_variance: 0, notes: ''
};

const QUIET = { body: { success: true, checked: true, invoices: 0, cashups: 0, short: false } };
const CLOSED = { status: 201, body: { success: true, record: { number: 'REC-0004', has_variance: false } } };
const routes = (over = {}) => ({
  'GET /reconciliation/preview': { body: PREVIEW },
  'GET /reconciliations': { body: { success: true, records: [RECORD] } },
  'GET /reconciliation/ledger-gap': QUIET,
  ...over
});
const setup = (over = {}) => {
  const notify = vi.fn();
  const hub = fakeHub(routes(over));
  render(<CashTab notify={notify} />);
  return { hub, notify };
};
const ready = () => screen.findByRole('heading', { name: 'This shift' });
const type = async (label, text) => {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  if (text !== '') await userEvent.type(input, text);
};
const rowOf = name => screen.getByRole('cell', { name }).closest('tr');
// The strip under the form: expected, counted, and the verdict. The closed-shift list below has badges of its own.
const strip = () => within(screen.getByText('Expected in drawer:').parentElement);
const closeShift = () => userEvent.click(screen.getByRole('button', { name: 'Close shift' }));

describe('cash tab — loading', () => {
  it('asks for the preview and the last thirty closed shifts together', async () => {
    const { hub } = setup();
    await ready();
    expect(hub.calls('GET /reconciliation/preview')).toHaveLength(1);
    expect(hub.calls('GET /reconciliations')[0].url.searchParams.get('limit')).toBe('30');
  });

  it('a hub that cannot be reached says so and offers to try again', async () => {
    let attempts = 0;
    const { hub } = setup({ 'GET /reconciliation/preview': () => (++attempts === 1 ? new TypeError('Failed to fetch') : { body: PREVIEW }) });
    expect(await screen.findByText('Could not load the cash screen')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await ready();
    expect(hub.calls('GET /reconciliation/preview')).toHaveLength(2);
  });
});

describe('cash tab — this shift', () => {
  it('says where the shift started: after the last close, or from the first payment, or not at all', async () => {
    setup();
    expect(await screen.findByText(/Since REC-0003, closed/)).toBeInTheDocument();
  });

  it('a first-ever shift is counted from the first payment', async () => {
    setup({ 'GET /reconciliation/preview': { body: { ...PREVIEW, since_last_close: false, last_record: null } } });
    expect(await screen.findByText(/Since the first payment/)).toBeInTheDocument();
  });

  it('a hub with no payments at all says so', async () => {
    setup({ 'GET /reconciliation/preview': { body: { ...PREVIEW, since_last_close: false, last_record: null, period_start: null } } });
    expect(await screen.findByText('No payments recorded yet')).toBeInTheDocument();
  });

  it('shows what each method took, what was refunded and what is left, with counts', async () => {
    setup();
    await ready();
    const cash = within(rowOf('Cash'));
    expect(cash.getByText(/₹5000/)).toBeInTheDocument();
    expect(cash.getByText('(12)')).toBeInTheDocument();
    expect(cash.getByText(/−₹200/)).toBeInTheDocument();
    expect(cash.getByText('₹4800')).toBeInTheDocument();
    // With no refunds, what UPI took and what is left are the same figure, in two cells.
    expect(within(rowOf('UPI')).getAllByText('₹3000')).toHaveLength(2);
    expect(within(rowOf('Total')).getByText('₹9800')).toBeInTheDocument();
  });

  it('a method with no refunds shows a dash, not a zero that looks like a figure', async () => {
    setup();
    await ready();
    expect(within(rowOf('UPI')).getAllByText('–').length).toBeGreaterThan(0);
  });

  it('warns that unpaid bills are not in the totals, in the singular and the plural', async () => {
    setup({ 'GET /reconciliation/preview': { body: { ...PREVIEW, unpaid: { count: 1, total: 320 } } } });
    expect(await screen.findByText('1 bill not paid yet (₹320)')).toBeInTheDocument();
    expect(screen.getByText(/Unpaid bills are not in these totals/)).toBeInTheDocument();
  });

  it('and for several', async () => {
    setup({ 'GET /reconciliation/preview': { body: { ...PREVIEW, unpaid: { count: 3, total: 960 } } } });
    expect(await screen.findByText('3 bills not paid yet (₹960)')).toBeInTheDocument();
  });

  it('says nothing about unpaid bills when there are none', async () => {
    setup();
    await ready();
    expect(screen.queryByText(/not paid yet/)).not.toBeInTheDocument();
  });

  it('mentions voided bills, and that they are not counted as payments', async () => {
    setup({ 'GET /reconciliation/preview': { body: { ...PREVIEW, voided: { count: 2, total: 440 } } } });
    expect(await screen.findByText(/2 bills voided this shift \(₹440\), not counted as payments/)).toBeInTheDocument();
  });

  it('links the whole ledger as a CSV', async () => {
    setup();
    await ready();
    expect(screen.getByRole('link', { name: /Ledger CSV/ }).getAttribute('href')).toMatch(/\/reconciliation\/ledger\.csv$/);
  });

  it('Refresh asks the hub again', async () => {
    const { hub } = setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByText(/Since REC-0003/);
    expect(hub.calls('GET /reconciliation/preview')).toHaveLength(2);
  });
});

describe('cash tab — the preview before closing', () => {
  it('offers the last close\'s float as the opening float, and the cash expected is that plus what cash took', async () => {
    setup();
    await ready();
    expect(screen.getByLabelText('Opening float')).toHaveValue('1000');
    expect(screen.getByText('Expected in drawer:').parentElement).toHaveTextContent('₹5800');   // 1000 + 4800
  });

  it('changing the float changes what is expected', async () => {
    setup();
    await ready();
    await type('Opening float', '500');
    expect(screen.getByText('Expected in drawer:').parentElement).toHaveTextContent('₹5300');
  });

  it('a refresh does not overwrite a float that was typed', async () => {
    setup();
    await ready();
    await type('Opening float', '750');
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByText(/Since REC-0003/);
    expect(screen.getByLabelText('Opening float')).toHaveValue('750');
  });

  it('closing is not possible until the drawer has been counted', async () => {
    setup();
    await ready();
    expect(screen.getByRole('button', { name: 'Close shift' })).toBeDisabled();
    await type('Cash counted now', '5800');
    expect(screen.getByRole('button', { name: 'Close shift' })).toBeEnabled();
  });

  it('a count that matches is "Balanced"', async () => {
    setup();
    await ready();
    await type('Cash counted now', '5800');
    expect(strip().getByText('Balanced')).toBeInTheDocument();
  });

  it('a count below what is expected is "Short" by how much, and above is "Over"', async () => {
    setup();
    await ready();
    await type('Cash counted now', '5750');
    expect(strip().getByText('Short ₹50')).toBeInTheDocument();
    await type('Cash counted now', '5825.5');
    expect(strip().getByText('Over ₹25.50')).toBeInTheDocument();
  });

  it('shows no verdict at all before anything is counted', async () => {
    setup();
    await ready();
    expect(strip().queryByText('Balanced')).not.toBeInTheDocument();
    expect(strip().queryByText(/^Short|^Over/)).not.toBeInTheDocument();
  });

  it('a note is optional when everything balances, and required the moment anything does not', async () => {
    setup();
    await ready();
    await type('Cash counted now', '5800');
    expect(screen.getByLabelText('Note (optional)')).toBeInTheDocument();

    await type('Cash counted now', '5700');
    expect(screen.getByLabelText('Note: explain the difference (required)')).toBeInTheDocument();
  });

  it('a UPI or card statement that disagrees counts as a difference too, even with the cash right', async () => {
    setup();
    await ready();
    await type('Cash counted now', '5800');
    await type('UPI total on your statement', '2990');
    expect(screen.getByLabelText('Note: explain the difference (required)')).toBeInTheDocument();

    await type('UPI total on your statement', '3000');
    await type('Card total on the terminal', '2000');
    expect(screen.getByLabelText('Note (optional)')).toBeInTheDocument();
  });
});

describe('cash tab — closing the shift', () => {
  const fill = async () => {
    await ready();
    await type('Cash counted now', '5800');
  };

  it('asks first, and says plainly that a closed shift cannot be changed', async () => {
    const { hub } = setup({ 'POST /reconciliation/close': CLOSED });
    await fill();
    await closeShift();
    const dialog = await screen.findByRole('dialog', { name: 'Close this shift?' });
    expect(within(dialog).getByText(/Everything balances\. A closed shift is saved as a permanent record and cannot be changed/)).toBeInTheDocument();
    expect(hub.calls('POST /reconciliation/close')).toHaveLength(0);
  });

  it('when the counts do not match, the question says so', async () => {
    setup({ 'POST /reconciliation/close': CLOSED });
    await ready();
    await type('Cash counted now', '5700');
    await closeShift();
    expect(await screen.findByText(/The counts do not match the system/)).toBeInTheDocument();
  });

  it('backing out sends nothing', async () => {
    const { hub } = setup({ 'POST /reconciliation/close': CLOSED });
    await fill();
    await closeShift();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(hub.calls('POST /reconciliation/close')).toHaveLength(0);
  });

  it('sends exactly what was typed, with blanks as zero or left out, and reports "balanced"', async () => {
    const { hub, notify } = setup({ 'POST /reconciliation/close': CLOSED });
    await fill();
    await type('Closed by', 'Asha');
    await closeShift();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close shift' }));

    expect(hub.calls('POST /reconciliation/close')[0].body).toEqual({
      opening_float: 1000,
      counted_cash: 5800,
      cash_removed: 0,
      reported: {},
      notes: '',
      closed_by: 'Asha'
    });
    expect(notify).toHaveBeenCalledWith('REC-0004 closed: everything balanced.', 'success');
  });

  it('statement totals go in "reported" only when they were typed', async () => {
    const { hub } = setup({ 'POST /reconciliation/close': CLOSED });
    await fill();
    await type('UPI total on your statement', '3000');
    await type('Cash taken out', '4000');
    await closeShift();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close shift' }));

    const body = hub.calls('POST /reconciliation/close')[0].body;
    expect(body.reported).toEqual({ upi: 3000 });
    expect(body.cash_removed).toBe(4000);
  });

  it('a close with a difference is reported as one, as a warning', async () => {
    const { notify } = setup({ 'POST /reconciliation/close': { status: 201, body: { success: true, record: { number: 'REC-0004', has_variance: true } } } });
    await ready();
    await type('Cash counted now', '5700');
    await type('Note: explain the difference (required)', 'Float miscounted');
    await closeShift();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close shift' }));

    expect(notify).toHaveBeenCalledWith('REC-0004 closed with a difference.', 'warning');
  });

  it('afterwards the form is cleared for the next shift, keeping only who is closing, and the screen is re-read', async () => {
    const { hub } = setup({ 'POST /reconciliation/close': CLOSED });
    await fill();
    await type('Closed by', 'Asha');
    await type('Note (optional)', 'quiet night');
    await closeShift();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close shift' }));

    await screen.findByText(/Since REC-0003/);
    expect(screen.getByLabelText('Cash counted now')).toHaveValue('');
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Closed by')).toHaveValue('Asha');
    expect(hub.calls('GET /reconciliation/preview')).toHaveLength(2);
  });

  it('while the close is in flight it cannot be sent twice', async () => {
    const gate = deferred();
    const { hub } = setup({ 'POST /reconciliation/close': () => gate.promise.then(() => CLOSED) });
    await fill();
    await closeShift();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close shift' }));

    expect(screen.getAllByRole('button', { name: 'Close shift' }).every(b => b.disabled)).toBe(true);
    expect(hub.calls('POST /reconciliation/close')).toHaveLength(1);
    gate.resolve();
  });
});

describe('cash tab — when the hub refuses the close', () => {
  const attempt = async () => {
    await ready();
    await type('Cash counted now', '5700');
    await closeShift();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close shift' }));
  };

  it('a missing explanation is put on the note field, not as a general error', async () => {
    setup({ 'POST /reconciliation/close': { status: 400, body: { success: false, code: 'NOTES_REQUIRED_FOR_VARIANCE', error: 'Explain the difference in the note.' } } });
    await attempt();

    expect(await screen.findByText('Explain the difference in the note.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Note: explain the difference/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByText('Explain the difference in the note.')).toHaveLength(1);
  });

  it('a bad figure is put on the field it is about', async () => {
    setup({ 'POST /reconciliation/close': { status: 400, body: { success: false, code: 'INVALID_CLOSE', error: 'Some figures are not valid.', errors: [{ field: 'cash_removed', error: 'Cash taken out cannot be more than was counted.' }, { field: 'reported.upi', error: 'UPI must be a number.' }] } } });
    await attempt();

    expect(await screen.findByText('Cash taken out cannot be more than was counted.')).toBeInTheDocument();
    expect(screen.getByLabelText('Cash taken out')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('UPI must be a number.')).toBeInTheDocument();
  });

  it('anything else is shown in plain words, and typing again clears it', async () => {
    setup({ 'POST /reconciliation/close': new TypeError('Failed to fetch') });
    await attempt();
    expect(await screen.findByText(/The hub could not be reached/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Closed by'), 'A');
    expect(screen.queryByText(/The hub could not be reached/)).not.toBeInTheDocument();
  });

  it('nothing is cleared when the close fails -- what was typed is still there to correct', async () => {
    setup({ 'POST /reconciliation/close': { status: 400, body: { success: false, code: 'INVALID_CLOSE', error: 'No.' } } });
    await attempt();
    await screen.findByText('No.');
    expect(screen.getByLabelText('Cash counted now')).toHaveValue('5700');
  });
});

describe('cash tab — closed shifts', () => {
  it('lists each with its number, who closed it, what was expected and counted, and its variance', async () => {
    setup({
      'GET /reconciliations': { body: { success: true, records: [
        { ...RECORD, number: 'REC-0003', cash_variance: 0 },
        { ...RECORD, id: 'r2', number: 'REC-0002', cash_variance: -150, expected_cash: 4000, counted_cash: 3850, notes: 'Float miscounted', closed_by: 'Bhavna' }
      ] } }
    });
    await ready();
    const first = within(screen.getByText('REC-0003', { selector: 'span.font-semibold' }).closest('li'));
    expect(first.getByText('Balanced')).toBeInTheDocument();
    expect(first.getByText(/Asha/)).toBeInTheDocument();

    const second = within(screen.getByText('REC-0002').closest('li'));
    expect(second.getByText('Short ₹150')).toBeInTheDocument();
    expect(second.getByText(/expected ₹4000, counted ₹3850/)).toBeInTheDocument();
    expect(second.getByText('“Float miscounted”')).toBeInTheDocument();
  });

  it('each one links the ledger for exactly its own period', async () => {
    setup();
    await ready();
    const href = screen.getByRole('link', { name: 'Download the ledger for REC-0003' }).getAttribute('href');
    const url = new URL(href, 'http://hub.local');
    expect(url.pathname).toMatch(/ledger\.csv$/);
    expect(url.searchParams.get('from')).toBe(RECORD.period_start);
    expect(url.searchParams.get('to')).toBe(RECORD.period_end);
  });

  it('the first shift\'s link has no start, rather than an empty one', async () => {
    setup({ 'GET /reconciliations': { body: { success: true, records: [{ ...RECORD, period_start: null }] } } });
    await ready();
    const url = new URL(screen.getByRole('link', { name: /Download the ledger/ }).getAttribute('href'), 'http://hub.local');
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.get('to')).toBe(RECORD.period_end);
  });

  it('before the first close, says that the first close starts the record', async () => {
    setup({ 'GET /reconciliations': { body: { success: true, records: [] } } });
    expect(await screen.findByText(/No shift has been closed yet\. The first close starts the record/)).toBeInTheDocument();
  });

  it('carries the ledger check, which says nothing when the ledgers agree', async () => {
    setup();
    await ready();
    expect(await screen.findByRole('heading', { name: 'Ledger check' })).toBeInTheDocument();
    expect(screen.queryByText(/may be missing bills/)).not.toBeInTheDocument();
  });
});
