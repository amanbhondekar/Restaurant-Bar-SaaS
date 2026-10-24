import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PrintersTab } from '@/admin/PrintersTab';
import { fakeHub } from '../helpers/fakeHub';

// Printer setup: see what is configured, send a test page, add a network, USB or device printer, remove one.
// What matters is what the page SENDS (the hub adds printers from it) and that a refusal or a failed test page
// is said in words, because the person at the counter has a queue behind them.

const RECEIPT = { id: 'p_1', role: 'receipt', transport: 'usb', name: 'Counter', system_name: 'EPSON TM-T82' };
const KOT = { id: 'p_2', role: 'kot', transport: 'tcp', name: 'Bar printer', host: '192.168.1.60', port: 9100, station: 'bar' };
const DEVICE = { id: 'p_3', role: 'kot', transport: 'device', name: '', device_path: '/dev/usb/lp0' };
const SYSTEM = { success: true, platform: 'win32', printers: [{ name: 'EPSON TM-T82' }, { name: 'Microsoft Print to PDF' }] };

const setup = (over = {}) => {
  const notify = vi.fn();
  const hub = fakeHub({
    'GET /printers': { body: { success: true, printers: [RECEIPT, KOT] } },
    'GET /printers/system': { body: SYSTEM },
    ...over
  });
  render(<PrintersTab notify={notify} />);
  return { hub, notify };
};
const ready = () => screen.findByRole('heading', { name: 'Configured printers' });
const pick = (label, value) => userEvent.selectOptions(screen.getByLabelText(label), value);
const type = async (label, text) => {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  if (text) await userEvent.type(input, text);
};
const addButton = () => screen.getByRole('button', { name: 'Add printer' });

describe('printers tab — what is configured', () => {
  it('lists each printer with what it prints, which station it serves and how it is connected', async () => {
    setup({ 'GET /printers': { body: { success: true, printers: [RECEIPT, KOT, DEVICE] } } });
    await ready();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Counter');
    expect(rows[0]).toHaveTextContent('Customer receipts');
    expect(rows[0]).toHaveTextContent('USB · EPSON TM-T82');
    expect(rows[1]).toHaveTextContent('Bar printer');
    expect(rows[1]).toHaveTextContent('Kitchen tickets · Bar only');
    expect(rows[1]).toHaveTextContent('Network · 192.168.1.60:9100');
    expect(rows[2]).toHaveTextContent('p_3');   // no label: its id stands in
    expect(rows[2]).toHaveTextContent('Device · /dev/usb/lp0');
  });

  it('says tickets and receipts show on screen only when nothing is set up', async () => {
    setup({ 'GET /printers': { body: { success: true, printers: [] } } });
    expect(await screen.findByText(/No printer is set up, so tickets and receipts show on screen only/)).toBeInTheDocument();
  });

  it('an unreachable hub is explained, with a way to try again', async () => {
    let up = false;
    setup({ 'GET /printers': () => (up ? { body: { success: true, printers: [RECEIPT] } } : new TypeError('fetch failed')) });
    expect(await screen.findByText('Could not load printers')).toBeInTheDocument();
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await ready()).toBeInTheDocument();
  });
});

describe('printers tab — adding a USB printer', () => {
  it('offers the printers this computer knows, and will not add until one is chosen', async () => {
    setup();
    await ready();
    const select = await screen.findByLabelText('Printer');
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Choose a printer…', 'EPSON TM-T82', 'Microsoft Print to PDF']);
    expect(addButton()).toBeDisabled();
    await pick('Printer', 'EPSON TM-T82');
    expect(addButton()).toBeEnabled();
  });

  it('sends the role, the transport and the queue name, tells the person, clears the form and reads the list again', async () => {
    const { hub, notify } = setup({ 'POST /printers': { status: 201, body: { success: true } } });
    await ready();
    await screen.findByRole('option', { name: 'EPSON TM-T82' });
    await pick('Printer', 'EPSON TM-T82');
    await userEvent.click(addButton());

    await waitFor(() => expect(hub.calls('POST /printers')).toHaveLength(1));
    expect(hub.calls('POST /printers')[0].body).toEqual({ role: 'receipt', transport: 'usb', system_name: 'EPSON TM-T82' });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Printer added. Print a test page to check it.'));
    expect(hub.calls('GET /printers')).toHaveLength(2);
    expect(screen.getByLabelText('Printer')).toHaveValue('');
    expect(addButton()).toBeDisabled();
  });

  it('can look for printers again, and says so when the computer cannot list them', async () => {
    let answer = { success: false, printers: [], error: 'No print spooler was found on this computer.' };
    const { hub } = setup({ 'GET /printers/system': () => ({ body: answer }) });
    await ready();
    expect(await screen.findByText('No print spooler was found on this computer.')).toBeInTheDocument();

    answer = SYSTEM;
    await userEvent.click(screen.getByRole('button', { name: 'Look for printers again' }));
    expect(await screen.findByRole('option', { name: 'EPSON TM-T82' })).toBeInTheDocument();
    expect(hub.calls('GET /printers/system')).toHaveLength(2);
    expect(screen.queryByText('No print spooler was found on this computer.')).toBeNull();
  });

  it('that warning is about USB printers, so it goes away when a network printer is being added', async () => {
    setup({ 'GET /printers/system': { body: { success: false, printers: [], error: 'No print spooler was found on this computer.' } } });
    await ready();
    expect(await screen.findByText('No print spooler was found on this computer.')).toBeInTheDocument();
    await pick('How is it connected?', 'tcp');
    expect(screen.queryByText('No print spooler was found on this computer.')).toBeNull();
  });

  it('an unreachable hub while looking is explained in the same place', async () => {
    setup({ 'GET /printers/system': new TypeError('fetch failed') });
    await ready();
    expect(await screen.findByText(/The hub could not be reached/)).toBeInTheDocument();
  });
});

describe('printers tab — adding a network or device printer', () => {
  it('a network printer needs an address; the port is 9100 unless said otherwise; a blank label is not sent', async () => {
    const { hub } = setup({ 'POST /printers': { status: 201, body: { success: true } } });
    await ready();
    await pick('How is it connected?', 'tcp');
    expect(addButton()).toBeDisabled();

    await type('IP address or host', '  192.168.1.77 ');
    expect(addButton()).toBeEnabled();
    await userEvent.click(addButton());
    await waitFor(() => expect(hub.calls('POST /printers')).toHaveLength(1));
    expect(hub.calls('POST /printers')[0].body).toEqual({ role: 'receipt', transport: 'tcp', host: '192.168.1.77', port: 9100 });
  });

  it('sends the port and the label when they are given, and falls back to 9100 for a port that is not a number', async () => {
    const { hub } = setup({ 'POST /printers': { status: 201, body: { success: true } } });
    await ready();
    await pick('How is it connected?', 'tcp');
    await type('IP address or host', '10.0.0.9');
    await type('Port', '9101');
    await type('Label (optional)', 'Pass');
    await userEvent.click(addButton());
    await waitFor(() => expect(hub.calls('POST /printers')).toHaveLength(1));
    expect(hub.calls('POST /printers')[0].body).toEqual({ role: 'receipt', transport: 'tcp', name: 'Pass', host: '10.0.0.9', port: 9101 });

    await pick('How is it connected?', 'tcp');
    await type('IP address or host', '10.0.0.9');
    await type('Port', 'abc');
    await userEvent.click(addButton());
    await waitFor(() => expect(hub.calls('POST /printers')).toHaveLength(2));
    expect(hub.calls('POST /printers')[1].body.port).toBe(9100);
  });

  it('a Linux device is added by its path', async () => {
    const { hub } = setup({ 'POST /printers': { status: 201, body: { success: true } } });
    await ready();
    await pick('How is it connected?', 'device');
    expect(screen.getByLabelText('Device path')).toHaveValue('/dev/usb/lp0');
    await type('Device path', '/dev/usb/lp1');
    await userEvent.click(addButton());
    await waitFor(() => expect(hub.calls('POST /printers')).toHaveLength(1));
    expect(hub.calls('POST /printers')[0].body).toEqual({ role: 'receipt', transport: 'device', device_path: '/dev/usb/lp1' });
  });

  it('will not add a device with its path cleared', async () => {
    setup();
    await ready();
    await pick('How is it connected?', 'device');
    await type('Device path', '');
    expect(addButton()).toBeDisabled();
  });
});

describe('printers tab — kitchen ticket printers and stations', () => {
  const addKot = async hub => {
    await pick('How is it connected?', 'tcp');
    await type('IP address or host', '10.0.0.9');
    await userEvent.click(addButton());
    await waitFor(() => expect(hub.calls('POST /printers')).toHaveLength(1));
    return hub.calls('POST /printers')[0].body;
  };

  it('offers a station only for kitchen tickets, and sends it', async () => {
    const { hub } = setup({ 'POST /printers': { status: 201, body: { success: true } } });
    await ready();
    expect(screen.queryByLabelText('Only this station')).toBeNull();
    await pick('What does it print?', 'kot');
    await pick('Only this station', 'bar');
    expect((await addKot(hub))).toEqual({ role: 'kot', transport: 'tcp', host: '10.0.0.9', port: 9100, station: 'bar' });
  });

  it('a printer for all stations sends no station', async () => {
    const { hub } = setup({ 'POST /printers': { status: 201, body: { success: true } } });
    await ready();
    await pick('What does it print?', 'kot');
    expect((await addKot(hub)).station).toBeUndefined();
  });

  it('a station chosen and then abandoned by switching to receipts is not sent with the receipt printer', async () => {
    const { hub } = setup({ 'POST /printers': { status: 201, body: { success: true } } });
    await ready();
    await pick('What does it print?', 'kot');
    await pick('Only this station', 'hot');
    await pick('What does it print?', 'receipt');
    expect(screen.queryByLabelText('Only this station')).toBeNull();
    expect((await addKot(hub)).station).toBeUndefined();
  });
});

describe('printers tab — when the hub refuses', () => {
  it('says why beside the form, keeps what was typed, and clears the message once the person edits', async () => {
    const { notify } = setup({ 'POST /printers': { status: 400, body: { success: false, code: 'INVALID_PRINTER', error: 'That address is not a valid IP address.' } } });
    await ready();
    await pick('How is it connected?', 'tcp');
    await type('IP address or host', 'not-an-address');
    await userEvent.click(addButton());

    expect(await screen.findByText('That address is not a valid IP address.')).toBeInTheDocument();
    expect(screen.getByLabelText('IP address or host')).toHaveValue('not-an-address');
    expect(notify).not.toHaveBeenCalled();
    expect(addButton()).toBeEnabled();

    await userEvent.type(screen.getByLabelText('IP address or host'), '1');
    expect(screen.queryByText('That address is not a valid IP address.')).toBeNull();
  });
});

describe('printers tab — test pages', () => {
  it('sends a test page to the printer and says which', async () => {
    const { hub, notify } = setup({ 'POST /printers/p_2/test': { body: { success: true } } });
    await ready();
    const row = screen.getByText('Bar printer').closest('li');
    await userEvent.click(within(row).getByRole('button', { name: 'Test page' }));
    await waitFor(() => expect(hub.calls('POST /printers/p_2/test')).toHaveLength(1));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Test page sent to Bar printer.'));
  });

  it('a printer that fails to print is named with the reason, as an error', async () => {
    const { notify } = setup({ 'POST /printers/p_1/test': { status: 502, body: { success: false, code: 'PRINT_FAILED', error: 'The printer is offline.' } } });
    await ready();
    await userEvent.click(within(screen.getByText('Counter').closest('li')).getByRole('button', { name: 'Test page' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Counter: The printer is offline.', 'error'));
  });

  it('while one test page is being sent nothing else can be started', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    setup({ 'POST /printers/p_1/test': async () => { await gate; return { body: { success: true } }; } });
    await ready();
    await userEvent.click(within(screen.getByText('Counter').closest('li')).getByRole('button', { name: 'Test page' }));
    for (const b of screen.getAllByRole('button', { name: 'Test page' })) expect(b).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Counter' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Test page' })[0]).toBeEnabled());
  });

  it('puts an id that needs escaping in the address safely', async () => {
    const odd = { ...RECEIPT, id: 'p/1 ?x', name: 'Odd' };
    const { hub } = setup({ 'GET /printers': { body: { success: true, printers: [odd] } }, 'POST /printers/p%2F1%20%3Fx/test': { body: { success: true } } });
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Test page' }));
    await waitFor(() => expect(hub.calls('POST /printers/p%2F1%20%3Fx/test')).toHaveLength(1));
  });
});

describe('printers tab — removing', () => {
  it('asks first, and says the printer itself is not affected; cancelling removes nothing', async () => {
    const { hub } = setup();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Counter' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove Counter?')).toBeInTheDocument();
    expect(within(dialog).getByText(/The printer itself is not affected/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(hub.calls('DELETE /printers/p_1')).toHaveLength(0);
  });

  it('removes it on confirmation, says so, and reads the list again', async () => {
    let printers = [RECEIPT, KOT];
    const { hub, notify } = setup({
      'GET /printers': () => ({ body: { success: true, printers } }),
      'DELETE /printers/p_1': () => { printers = [KOT]; return { body: { success: true } }; }
    });
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Counter' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(hub.calls('DELETE /printers/p_1')).toHaveLength(1));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Counter removed.'));
    await waitFor(() => expect(screen.queryByText('Counter')).toBeNull());
    expect(screen.getByText('Bar printer')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());   // the question is answered, so it goes away
  });

  it('puts an id that needs escaping in the address safely', async () => {
    const odd = { ...RECEIPT, id: 'p/1 ?x', name: 'Odd' };
    const { hub } = setup({ 'GET /printers': { body: { success: true, printers: [odd] } }, 'DELETE /printers/p%2F1%20%3Fx': { body: { success: true } } });
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Odd' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(hub.calls('DELETE /printers/p%2F1%20%3Fx')).toHaveLength(1));
  });

  it('a removal the hub refuses is reported and the printer stays', async () => {
    const { notify } = setup({ 'DELETE /printers/p_1': { status: 404, body: { success: false, code: 'NOT_FOUND', error: 'No such printer.' } } });
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Counter' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('No such printer.', 'error'));
    expect(screen.getByText('Counter')).toBeInTheDocument();
  });
});
