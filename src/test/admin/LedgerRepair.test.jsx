import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LedgerRepair } from '@/admin/LedgerRepair';
import { fakeHub } from '../helpers/fakeHub';

// Reception's half of repairing a short ledger. It changes a restaurant's financial history, so what
// matters is that it never does so without showing exactly what it will add first.

const quiet = { body: { success: true, checked: true, invoices: 0, cashups: 0, short: false } };
const short = { body: { success: true, checked: true, invoices: 2, cashups: 1, short: true } };
const nothingMissing = { body: { success: true, ok: true, applied: false, changed: false, added: { invoices: 0, cashups: 0 }, invoice_numbers: [], summary: 'Nothing is missing. The hub already holds every bill and cash-up the cloud has.' } };
const twoMissing = {
  body: {
    success: true, ok: true, applied: false, changed: true,
    added: { invoices: 2, cashups: 1 }, invoice_numbers: ['INV-000001', 'INV-000002'],
    summary: '2 bills (INV-000001 to INV-000002) and 1 cash-up are in the cloud but not on this hub. Adding them changes nothing that is already here.'
  }
};

const setup = (routes = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({ 'GET /reconciliation/ledger-gap': quiet, ...routes });
  render(<LedgerRepair notify={notify} />);
  return { hub, notify };
};

describe('ledger repair', () => {
  it('says nothing is wrong when the ledgers agree -- no alarm on a healthy hub', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Ledger check' })).toBeInTheDocument();
    expect(screen.queryByText(/may be missing bills/)).not.toBeInTheDocument();
  });

  it('warns on its own when the cloud holds more than the hub', async () => {
    setup({ 'GET /reconciliation/ledger-gap': short });
    expect(await screen.findByText('This hub may be missing bills')).toBeInTheDocument();
    expect(screen.getByText(/holds 2 bills and 1 cash-up that are not on this hub/)).toBeInTheDocument();
  });

  it('the real check is always available, even when the counts look fine', async () => {
    // Counts can match while the ledgers differ (hub has 1 and 2, cloud has 2 and 3), so the button
    // is never hidden behind the warning.
    const { hub } = setup({ 'POST /reconciliation/ledger-repair': twoMissing });
    await userEvent.click(await screen.findByRole('button', { name: /Check against the cloud/ }));
    expect(hub.calls('POST /reconciliation/ledger-repair')[0].body).toEqual({ apply: false });
    expect(await screen.findByText(/2 bills \(INV-000001 to INV-000002\)/)).toBeInTheDocument();
  });

  it('a check never changes anything by itself: it asks, and waits', async () => {
    const { hub } = setup({ 'POST /reconciliation/ledger-repair': twoMissing });
    await userEvent.click(await screen.findByRole('button', { name: /Check against the cloud/ }));
    await screen.findByText(/2 bills/);
    expect(hub.calls('POST /reconciliation/ledger-repair').every(c => c.body.apply === false)).toBe(true);
  });

  it('adding them is confirmed first, with what will be added repeated in the question', async () => {
    const { hub, notify } = setup({
      'POST /reconciliation/ledger-repair': ({ body }) => (body.apply
        ? { body: { ...twoMissing.body, applied: true } }
        : twoMissing)
    });
    await userEvent.click(await screen.findByRole('button', { name: /Check against the cloud/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add them' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 bills \(INV-000001 to INV-000002\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/already settled in the cloud/)).toBeInTheDocument();
    expect(hub.calls('POST /reconciliation/ledger-repair').filter(c => c.body.apply)).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add them' }));
    expect(hub.calls('POST /reconciliation/ledger-repair').filter(c => c.body.apply)).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith('Added 2 bill(s) and 1 cash-up(s) from the cloud.');
  });

  it('cancelling the question changes nothing', async () => {
    const { hub } = setup({ 'POST /reconciliation/ledger-repair': twoMissing });
    await userEvent.click(await screen.findByRole('button', { name: /Check against the cloud/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add them' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(hub.calls('POST /reconciliation/ledger-repair').filter(c => c.body.apply)).toHaveLength(0);
  });

  it('a check that finds nothing offers nothing to add', async () => {
    setup({ 'POST /reconciliation/ledger-repair': nothingMissing });
    await userEvent.click(await screen.findByRole('button', { name: /Check against the cloud/ }));
    expect(await screen.findByText(/Nothing is missing/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add them' })).not.toBeInTheDocument();
  });

  it('an offline hub says why rather than looking like a healthy ledger', async () => {
    setup({ 'POST /reconciliation/ledger-repair': { status: 503, body: { success: false, code: 'OFFLINE', error: 'The hub cannot reach the internet, so it cannot compare its bills with the cloud. Try again when it is back.' } } });
    await userEvent.click(await screen.findByRole('button', { name: /Check against the cloud/ }));
    expect(await screen.findByText(/cannot reach the internet/)).toBeInTheDocument();
  });

  it('a hub that cannot even be asked for the counts still offers the check', async () => {
    setup({ 'GET /reconciliation/ledger-gap': new TypeError('Failed to fetch'), 'POST /reconciliation/ledger-repair': nothingMissing });
    expect(await screen.findByRole('button', { name: /Check against the cloud/ })).toBeEnabled();
    expect(screen.queryByText(/may be missing bills/)).not.toBeInTheDocument();
  });
});
