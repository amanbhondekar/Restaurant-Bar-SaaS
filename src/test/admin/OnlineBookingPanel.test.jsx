import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OnlineBookingPanel } from '@/admin/OnlineBookingPanel';
import { fakeHub, deferred } from '../helpers/fakeHub';

// The switch for the public booking page (§4.6), and its address. The page is served by the operator service, so without that the panel
// can only say what is missing; the page itself lives in the cloud, so changing it needs the internet and the panel says so when it has
// none. Guests only ever ASK through the page: this panel says that too, because it is what an owner worries about before turning it on.

const PAGE = 'GET /admin/booking-page';
const URL_A = 'https://ops.example.com/book/abcdefghij12';
const OFF = { body: { success: true, configured: true, enabled: false, code: null, url: null, reachable: true } };
const ON = { body: { success: true, configured: true, enabled: true, code: 'abcdefghij12', url: URL_A, reachable: true } };
const view = (over = {}) => ({ body: { ...ON.body, ...over } });

function setup(routes = {}, props = {}) {
  const notify = vi.fn();
  const onCheck = vi.fn();
  const hub = fakeHub({ [PAGE]: ON, ...routes });
  render(<OnlineBookingPanel notify={notify} onCheck={onCheck} {...props} />);
  return { hub, notify, onCheck };
}
const heading = () => screen.findByRole('heading', { name: 'Online booking requests' });

describe('what it says', () => {
  it('explains that guests only ask and the restaurant decides', async () => {
    setup();
    await heading();
    expect(screen.getByText(/Guests ask; you decide/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is booked until you accept/)).toBeInTheDocument();
  });

  it('with no operator service says what is missing and offers nothing to press', async () => {
    setup({ [PAGE]: view({ configured: false, enabled: false, code: null, url: null }) });
    await heading();
    expect(screen.getByText(/needs the operator service/i)).toBeInTheDocument();
    expect(screen.getByText(/OPERATOR_SERVICE_URL/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('off: says so, and offers to turn it on', async () => {
    setup({ [PAGE]: OFF });
    await heading();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled();
    expect(screen.queryByLabelText('Address of the booking page')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
  });

  it('on: says so, shows the address to copy, and offers to check, turn off or change the address', async () => {
    setup();
    await heading();
    expect(screen.getByText('On')).toBeInTheDocument();
    const address = screen.getByLabelText('Address of the booking page');
    expect(address).toHaveValue(URL_A);
    expect(address).toHaveAttribute('readonly');
    for (const name of ['Copy', 'Check for new requests', 'Turn off', 'New address']) expect(screen.getByRole('button', { name })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument();
  });

  it('a page that is on but has no address to give says what is missing, and shows none', async () => {
    setup({ [PAGE]: view({ configured: false, url: null, needs_operator_url: true }) });
    await heading();
    expect(screen.getByText(/OPERATOR_SERVICE_URL/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Address of the booking page')).not.toBeInTheDocument();
  });

  it('with no internet it shows what the hub last knew, says so, and cannot change anything', async () => {
    setup({ [PAGE]: view({ reachable: false, message: 'The hub could not reach the cloud, so this is what it knew last.' }) });
    await heading();
    expect(screen.getByText(/this is what it knew last/)).toBeInTheDocument();
    expect(screen.getByLabelText('Address of the booking page')).toHaveValue(URL_A);
    for (const name of ['Turn off', 'New address']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled();
  });

  it('with no internet and nothing known, it does not offer to turn anything on', async () => {
    setup({ [PAGE]: view({ enabled: false, code: null, url: null, reachable: false, message: 'The hub could not reach the cloud, so this is what it knew last.' }) });
    await heading();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeDisabled();
  });

  it('if the hub cannot be read it says so and can try again', async () => {
    let up = false;
    setup({ [PAGE]: () => (up ? ON : new TypeError('fetch failed')) });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not read the booking page settings/);
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await heading()).toBeInTheDocument();
  });
});

describe('turning it on and off', () => {
  it('turning on tells the hub, says so, and shows the address', async () => {
    const { hub, notify } = setup({ [PAGE]: OFF, 'PUT /admin/booking-page': ON });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(hub.calls('PUT /admin/booking-page')).toHaveLength(1));
    expect(hub.calls('PUT /admin/booking-page')[0].body).toEqual({ enabled: true });
    expect(notify).toHaveBeenCalledWith('Online booking is on.');
    expect(await screen.findByLabelText('Address of the booking page')).toHaveValue(URL_A);
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
  });

  it('turning off tells the hub, says so, and takes the address away', async () => {
    const { hub, notify } = setup({ 'PUT /admin/booking-page': view({ enabled: false }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(hub.calls('PUT /admin/booking-page')).toHaveLength(1));
    expect(hub.calls('PUT /admin/booking-page')[0].body).toEqual({ enabled: false });
    expect(notify).toHaveBeenCalledWith('Online booking is off.');
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Address of the booking page')).not.toBeInTheDocument();
  });

  it('a refusal is said in the hub\'s words and the panel stays as it was', async () => {
    const { notify } = setup({ [PAGE]: OFF, 'PUT /admin/booking-page': { status: 503, body: { success: false, code: 'CLOUD', error: 'The hub could not reach the cloud. Check the internet connection and try again.' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('The hub could not reach the cloud. Check the internet connection and try again.'));
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('the buttons are off while the hub is being asked, so a double press sends once', async () => {
    const slow = deferred();
    const { hub } = setup({ [PAGE]: OFF, 'PUT /admin/booking-page': () => slow.promise });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(hub.calls('PUT /admin/booking-page')).toHaveLength(1);
    slow.resolve(ON);
    await screen.findByLabelText('Address of the booking page');
  });
});

describe('the address', () => {
  it('copies to the clipboard and says so', async () => {
    const user = userEvent.setup();
    const { notify } = setup();
    await heading();
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(write).toHaveBeenCalledWith(URL_A);
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Address copied.'));
  });

  it('if the browser will not copy, it selects the address and says to copy it by hand', async () => {
    const user = userEvent.setup();
    const { notify } = setup();
    await heading();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('The address is selected. Copy it by hand.'));
    const field = screen.getByLabelText('Address of the booking page');
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(URL_A.length);
  });

  it('a new address asks first, saying what it breaks, and does nothing if the answer is no', async () => {
    const { hub } = setup({ 'POST /admin/booking-page/new-address': view({ code: 'zzzzzzzzzz12', url: 'https://ops.example.com/book/zzzzzzzzzz12' }) });
    await userEvent.click(await screen.findByRole('button', { name: 'New address' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Give the page a new address?')).toBeInTheDocument();
    expect(within(dialog).getByText(/old address stops working at once/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep this one' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(hub.calls('POST /admin/booking-page/new-address')).toHaveLength(0);
    expect(screen.getByLabelText('Address of the booking page')).toHaveValue(URL_A);
  });

  it('confirming gives the page a new address, shows it, and says the old one no longer works', async () => {
    const next = 'https://ops.example.com/book/zzzzzzzzzz12';
    const { hub, notify } = setup({ 'POST /admin/booking-page/new-address': view({ code: 'zzzzzzzzzz12', url: next }) });
    await userEvent.click(await screen.findByRole('button', { name: 'New address' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'New address' }));
    await waitFor(() => expect(hub.calls('POST /admin/booking-page/new-address')).toHaveLength(1));
    expect(notify).toHaveBeenCalledWith('New address made. The old one no longer works.');
    await waitFor(() => expect(screen.getByLabelText('Address of the booking page')).toHaveValue(next));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a refusal is said in the hub\'s words, the dialog closes and the address is unchanged', async () => {
    const { notify } = setup({ 'POST /admin/booking-page/new-address': { status: 503, body: { success: false, code: 'CLOUD', error: 'The hub could not reach the cloud. Check the internet connection and try again.' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'New address' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'New address' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('The hub could not reach the cloud. Check the internet connection and try again.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Address of the booking page')).toHaveValue(URL_A);
  });
});

describe('checking for requests', () => {
  it('asks the list to look in the cloud now', async () => {
    const { onCheck } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Check for new requests' }));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it('is only offered while the page is on', async () => {
    setup({ [PAGE]: OFF });
    await heading();
    expect(screen.queryByRole('button', { name: 'Check for new requests' })).not.toBeInTheDocument();
  });
});

describe('what a mutation pass found', () => {
  it('a page that is on with nowhere to serve it from can still be switched off, and offers no new address', async () => {
    setup({
      [PAGE]: view({ configured: false, enabled: true, url: null, needs_operator_url: true }),
      'PUT /admin/booking-page': view({ configured: false, enabled: false, url: null })
    });
    await heading();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'New address' })).not.toBeInTheDocument();
  });

  it('switching off cannot be pressed twice either', async () => {
    const slow = deferred();
    const { hub } = setup({ 'PUT /admin/booking-page': () => slow.promise });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(hub.calls('PUT /admin/booking-page')).toHaveLength(1);
    slow.resolve(view({ enabled: false }));
    await screen.findByRole('button', { name: 'Turn on' });
  });

  it('tells the host where to put the address', async () => {
    setup();
    await heading();
    expect(screen.getByText(/Put this address on a card, a table sign or your menu/)).toBeInTheDocument();
  });
});
