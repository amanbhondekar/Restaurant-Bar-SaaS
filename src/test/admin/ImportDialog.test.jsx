import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImportDialog } from '@/admin/ImportDialog';
import { deferred, fakeHub } from '../helpers/fakeHub';

// "Import menu": a file is read in the browser, the hub is asked what it WOULD do, the person reviews it, then
// commits. Replace removes dishes, so the rule worth the most here is that it cannot happen by accident: not on
// the first file, not without typing REPLACE, not with errors unresolved. The hub's own arithmetic is tested on
// the hub; this tests what the page sends, what it shows, and what it refuses to let through.

const MENU = { revision: 7, items: [{ id: 'i1', name: 'Dal', category: 'Mains', price: 200, isVeg: true, available: true, station: 'hot' }] };

const HEADER = 'name,category,price,veg\n';
const csv = (...lines) => HEADER + lines.join('\n') + '\n';
const file = (text, name = 'menu.csv') => new File([text], name, { type: 'text/csv' });

// A stand-in for the hub's preview. The name decides the status: NEW.., UPD.., SAME.., ERR..
const rowFor = (r, i) => {
  const name = String(r.name ?? '');
  const row = { row: i + 2, name, category: r.category ?? '' };
  if (name.startsWith('ERR')) return { ...row, status: 'error', errors: ['Price must be a number.'] };
  if (name.startsWith('UPD')) return { ...row, status: 'updated', changes: [{ field: 'price', from: 100, to: 120 }] };
  if (name.startsWith('SAME')) return { ...row, status: 'unchanged' };
  return { ...row, status: 'new' };
};
const previewFor = (rows, mode, removed = 3) => {
  const list = rows.map(rowFor);
  const n = s => list.filter(r => r.status === s).length;
  return { success: true, revision: 7, counts: { new: n('new'), updated: n('updated'), unchanged: n('unchanged'), error: n('error'), removed: mode === 'replace' ? removed : 0 }, rows: list };
};
const PREVIEW = ({ body }) => ({ body: previewFor(body.rows, body.mode) });
const COMMITTED = ({ body }) => { const p = previewFor(body.rows, body.mode); return { body: { success: true, revision: 8, counts: p.counts, skipped: body.skip_invalid ? p.counts.error : 0 } }; };

// jsdom's Blob has no arrayBuffer() or text(), which every real browser does. The page reads files with them, so
// give the test environment the same two methods, built on the FileReader jsdom does have.
const readBlob = (blob, how) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader[how](blob);
});
if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function arrayBuffer() { return readBlob(this, 'readAsArrayBuffer'); };
if (!Blob.prototype.text) Blob.prototype.text = function text() { return readBlob(this, 'readAsText'); };

let user;
const setup =(routes = {}, props = {}) => {
  const onClose = vi.fn();
  const onImported = vi.fn();
  const hub = fakeHub({ 'POST /admin/menu/import/preview': PREVIEW, 'POST /admin/menu/import/commit': COMMITTED, ...routes });
  render(<ImportDialog menu={MENU} onClose={onClose} onImported={onImported} {...props} />);
  return { hub, onClose, onImported };
};
const chooser = () => screen.getByTestId('import-file');
const choose = (text, name) => user.upload(chooser(), file(text, name));
const reviewed = () => screen.findByLabelText('Review summary');
const importButton = () => screen.getByRole('button', { name: /^Import( \(\d+\))?$/ });
const replaceButton = () => screen.getByRole('button', { name: /^Replace menu/ });
const mode = name => user.click(screen.getByRole('radio', { name }));

beforeEach(() => { user = userEvent.setup({ applyAccept: false }); });
afterEach(() => vi.unstubAllGlobals());

describe('import dialog — choosing a file', () => {
  it('starts with nothing to commit, takes only spreadsheets, and offers the current menu as a template', () => {
    setup();
    expect(chooser()).toHaveAttribute('accept', '.csv,.xlsx');
    expect(importButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: /Download template/ })).toBeInTheDocument();
    expect(screen.getByText(/A blank cell or a missing column never changes what the menu already has/)).toBeInTheDocument();
  });

  it('reads a CSV in the browser and asks the hub what it would do, as a merge', async () => {
    const { hub } = setup();
    await choose(csv('NEW Paneer,Mains,300,yes', 'UPD Dal,Mains,120,yes'));
    await reviewed();
    const sent = hub.calls('POST /admin/menu/import/preview');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.mode).toBe('merge');
    expect(sent[0].body.rows).toEqual([
      { name: 'NEW Paneer', category: 'Mains', price: '300', veg: 'yes', __row: 2 },
      { name: 'UPD Dal', category: 'Mains', price: '120', veg: 'yes', __row: 3 }   // the row number in the FILE, so the review matches it
    ]);
    expect(screen.getByText(/menu\.csv: 2 rows\. Columns used: name, category, price, veg\./)).toBeInTheDocument();
  });

  it('reads an older Excel CSV that is not UTF-8, so an accented name arrives intact', async () => {
    const { hub } = setup();
    const bytes = new Uint8Array([...new TextEncoder().encode(HEADER + 'Caf'), 0xe9, ...new TextEncoder().encode(',Drinks,80,yes\n')]);   // "Café", windows-1252
    await user.upload(chooser(), new File([bytes], 'old.csv', { type: 'text/csv' }));
    await reviewed();
    expect(hub.calls('POST /admin/menu/import/preview')[0].body.rows[0].name).toBe('Café');
  });

  it('names the columns it will ignore', async () => {
    setup();
    await choose('name,category,price,veg,notes\nNEW A,Mains,10,yes,hello\n');
    await reviewed();
    expect(screen.getByText(/Ignored: notes\./)).toBeInTheDocument();
  });

  it('turns away a file that is not a spreadsheet without bothering the hub', async () => {
    const { hub } = setup();
    await choose('hello', 'notes.txt');
    expect(await screen.findByText('That is not a CSV or Excel file')).toBeInTheDocument();
    expect(hub.calls('POST /admin/menu/import/preview')).toHaveLength(0);
    expect(importButton()).toBeDisabled();
  });

  it('explains a file with no rows, no name column, too many rows and too much data', async () => {
    const { hub } = setup();
    await choose(HEADER);
    expect(await screen.findByText('The file has no rows to import')).toBeInTheDocument();

    await choose('category,price\nMains,10\n');
    expect(await screen.findByText('No “name” column found')).toBeInTheDocument();

    await choose(csv(...Array.from({ length: 2001 }, (_, i) => `NEW ${i},Mains,10,yes`)));
    expect(await screen.findByText('Too many rows')).toBeInTheDocument();
    expect(screen.getByText(/This file has 2001 rows\. Imports are limited to 2000/)).toBeInTheDocument();

    const big = file(csv('NEW A,Mains,10,yes'));
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 });
    await user.upload(chooser(), big);
    expect(await screen.findByText('That file is too large')).toBeInTheDocument();
    expect(screen.getByText(/Files over 8 MB cannot be imported/)).toBeInTheDocument();

    expect(hub.calls('POST /admin/menu/import/preview')).toHaveLength(0);
  });

  it('an id column is enough to identify rows, even without names', async () => {
    const { hub } = setup();
    await choose('id,price\ni1,120\n');
    await reviewed();
    expect(hub.calls('POST /admin/menu/import/preview')).toHaveLength(1);
  });

  it('reads an Excel workbook through the same path', async () => {
    vi.doMock('read-excel-file/browser', () => ({ readSheet: async () => [['name', 'category', 'price', 'veg'], ['NEW Tea', 'Drinks', 20, 'yes']] }));
    const { hub } = setup();
    await user.upload(chooser(), new File(['x'], 'menu.xlsx'));
    await reviewed();
    expect(hub.calls('POST /admin/menu/import/preview')[0].body.rows[0].name).toBe('NEW Tea');
    vi.doUnmock('read-excel-file/browser');
  });
});

describe('import dialog — reviewing', () => {
  const FILE = csv('NEW Paneer,Mains,300,yes', 'UPD Dal,Mains,120,yes', 'SAME Roti,Breads,30,yes', 'ERR Soup,Starters,abc,yes');

  it('says what each row would do', async () => {
    setup();
    await choose(FILE);
    await reviewed();
    const row = name => screen.getByText(name).closest('tr');
    expect(within(row('NEW Paneer')).getByText('Will be added')).toBeInTheDocument();
    expect(within(row('UPD Dal')).getByText(/Price:/).parentElement).toHaveTextContent('Price: ₹100 → ₹120');
    expect(within(row('SAME Roti')).getByText('Already matches the menu')).toBeInTheDocument();
    expect(within(row('ERR Soup')).getByText('Price must be a number.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^All 4$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Errors 1$/ })).toBeInTheDocument();
  });

  it('filters by status, and says when none has it', async () => {
    setup();
    await choose(csv('NEW A,Mains,1,yes', 'SAME B,Mains,1,yes'));
    await reviewed();
    await user.click(screen.getByRole('button', { name: /^Errors 0$/ }));
    expect(screen.getByText('No rows with this status.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^New 1$/ }));
    expect(screen.getByText('NEW A')).toBeInTheDocument();
    expect(screen.queryByText('SAME B')).toBeNull();
    expect(screen.getByRole('button', { name: /^New 1$/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a long review a page at a time', async () => {
    setup();
    await choose(csv(...Array.from({ length: 450 }, (_, i) => `NEW ${String(i).padStart(3, '0')},Mains,10,yes`)));
    await reviewed();
    expect(screen.getAllByRole('row')).toHaveLength(1 + 200);
    await user.click(screen.getByRole('button', { name: 'Show 200 more of 250' }));
    expect(screen.getAllByRole('row')).toHaveLength(1 + 400);
    await user.click(screen.getByRole('button', { name: 'Show 50 more of 50' }));
    expect(screen.getAllByRole('row')).toHaveLength(1 + 450);
    expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull();
  });

  it('starts the next filter at the first page, not wherever the last one had got to', async () => {
    setup();
    await choose(csv(...Array.from({ length: 450 }, (_, i) => `NEW ${String(i).padStart(3, '0')},Mains,10,yes`)));
    await reviewed();
    await user.click(screen.getByRole('button', { name: 'Show 200 more of 250' }));
    expect(screen.getAllByRole('row')).toHaveLength(1 + 400);
    await user.click(screen.getByRole('button', { name: /^New 450$/ }));
    expect(screen.getAllByRole('row')).toHaveLength(1 + 200);
    expect(screen.getByRole('button', { name: 'Show 200 more of 250' })).toBeInTheDocument();
  });

  it('shows a variants change in words, and a row with no name as such', async () => {
    setup({ 'POST /admin/menu/import/preview': { body: { success: true, revision: 7, counts: { new: 0, updated: 1, unchanged: 0, error: 1, removed: 0 }, rows: [
      { row: 2, status: 'updated', name: 'Pizza', category: 'Mains', changes: [{ field: 'variants', from: [], to: [['v1', 'Large', 400, true], ['v2', 'Small', 250, false]] }, { field: 'available', from: true, to: false }, { field: 'isVeg', from: true, to: false }] },
      { row: 3, status: 'error', name: '', category: '', errors: ['A name is required.'] }
    ] } } });
    await choose(csv('Pizza,Mains,1,yes'));
    await reviewed();
    expect(screen.getByText(/Variants:/).parentElement).toHaveTextContent('Variants: none → Large ₹400, Small ₹250 (86’d)');
    expect(screen.getByText(/Available:/).parentElement).toHaveTextContent('Available: Available → 86’d');
    expect(screen.getByText(/Veg:/).parentElement).toHaveTextContent('Veg: Veg → Non-veg');
    expect(screen.getByText('(no name)')).toBeInTheDocument();
  });
});

describe('import dialog — committing a merge', () => {
  it('imports what would change, says how many, and sends the revision it reviewed', async () => {
    const { hub, onImported } = setup();
    await choose(csv('NEW Paneer,Mains,300,yes', 'UPD Dal,Mains,120,yes', 'SAME Roti,Breads,30,yes'));
    await reviewed();
    expect(importButton()).toHaveTextContent('Import (2)');
    await user.click(importButton());

    await waitFor(() => expect(hub.calls('POST /admin/menu/import/commit')).toHaveLength(1));
    const sent = hub.calls('POST /admin/menu/import/commit')[0].body;
    expect(sent).toMatchObject({ base_revision: 7, mode: 'merge', skip_invalid: false });
    expect(sent.rows).toHaveLength(3);
    expect('confirm_replace' in sent).toBe(false);   // a merge never carries the word that authorises a replace

    expect(await screen.findByText('Import finished')).toHaveTextContent('Import finished');
    expect(screen.getByText(/1 new, 1 updated\./)).toBeInTheDocument();
    expect(screen.queryByText(/removed/)).toBeNull();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);   // the corner button and the footer's
    expect(chooser()).toBeDisabled();
  });

  it('will not import when nothing would change', async () => {
    setup();
    await choose(csv('SAME Roti,Breads,30,yes'));
    await reviewed();
    expect(importButton()).toBeDisabled();
    expect(screen.getByText('Nothing would change: every row matches the menu as it is.')).toBeInTheDocument();
  });

  it('will not go ahead while rows have errors, until the person says to skip them', async () => {
    const { hub } = setup();
    await choose(csv('NEW A,Mains,1,yes', 'ERR B,Mains,x,yes'));
    await reviewed();
    expect(importButton()).toBeDisabled();
    expect(screen.getByText(/Some rows have errors\. Tick “Import valid rows only”/)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /^Import valid rows only/ }));
    expect(importButton()).toBeEnabled();
    await user.click(importButton());
    await waitFor(() => expect(hub.calls('POST /admin/menu/import/commit')).toHaveLength(1));
    expect(hub.calls('POST /admin/menu/import/commit')[0].body.skip_invalid).toBe(true);
    expect(await screen.findByText(/1 row was skipped because of errors\./)).toBeInTheDocument();
  });

  it('will not import when no row is valid, even with the skip box ticked', async () => {
    setup();
    await choose(csv('ERR A,Mains,x,yes', 'ERR B,Mains,y,yes'));
    await reviewed();
    await user.click(screen.getByRole('checkbox', { name: /^Import valid rows only/ }));
    expect(importButton()).toBeDisabled();
    expect(screen.getByText('No row is valid, so there is nothing to import.')).toBeInTheDocument();
  });
});

describe('import dialog — replacing the whole menu', () => {
  const open = async () => {
    const hub = setup();
    await choose(csv('NEW Paneer,Mains,300,yes', 'UPD Dal,Mains,120,yes'));
    await reviewed();
    return hub;
  };

  it('every file starts as a merge: Replace is chosen on purpose, and again for the next file', async () => {
    await open();
    expect(screen.getByRole('radio', { name: /^Merge/ })).toBeChecked();
    await mode(/^Replace entire menu/);
    expect(screen.getByRole('radio', { name: /^Replace entire menu/ })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Choose another file' }));
    await choose(csv('NEW Other,Mains,5,yes'));
    await reviewed();
    expect(screen.getByRole('radio', { name: /^Merge/ })).toBeChecked();
  });

  it('asks the hub again in the new mode, and says how many dishes would go', async () => {
    const { hub } = await open();
    await mode(/^Replace entire menu/);
    await waitFor(() => expect(hub.calls('POST /admin/menu/import/preview')).toHaveLength(2));
    expect(hub.calls('POST /admin/menu/import/preview')[1].body.mode).toBe('replace');
    expect(await screen.findByText('3 items will be removed')).toBeInTheDocument();
    expect(screen.getByText(/Bills that are already open keep their lines/)).toBeInTheDocument();
  });

  it('cannot be committed until REPLACE is typed exactly, and says so', async () => {
    await open();
    await mode(/^Replace entire menu/);
    await screen.findByText('3 items will be removed');
    expect(replaceButton()).toBeDisabled();
    expect(screen.getByText('Type REPLACE to confirm.')).toBeInTheDocument();

    const box = screen.getByLabelText('Type REPLACE to confirm');
    await user.type(box, 'replace');
    expect(replaceButton()).toBeDisabled();
    await user.clear(box);
    await user.type(box, 'REPLAC');
    expect(replaceButton()).toBeDisabled();
    await user.type(box, 'E');
    expect(replaceButton()).toBeEnabled();
  });

  it('counts the removals in the button, and sends both the mode and the confirmation', async () => {
    const { hub } = await open();
    await mode(/^Replace entire menu/);
    await user.type(await screen.findByLabelText('Type REPLACE to confirm'), '  REPLACE ');
    expect(replaceButton()).toHaveTextContent('Replace menu (5)');   // 1 new + 1 updated + 3 removed
    await user.click(replaceButton());
    await waitFor(() => expect(hub.calls('POST /admin/menu/import/commit')).toHaveLength(1));
    expect(hub.calls('POST /admin/menu/import/commit')[0].body).toMatchObject({ mode: 'replace', confirm_replace: true, base_revision: 7 });
    expect(await screen.findByText(/1 new, 1 updated, 3 removed\./)).toBeInTheDocument();
  });

  it('typing is forgotten when the mode changes, so a confirmation never carries over', async () => {
    await open();
    await mode(/^Replace entire menu/);
    await user.type(await screen.findByLabelText('Type REPLACE to confirm'), 'REPLACE');
    expect(replaceButton()).toBeEnabled();
    await mode(/^Merge/);
    await mode(/^Replace entire menu/);
    expect(await screen.findByLabelText('Type REPLACE to confirm')).toHaveValue('');
    expect(replaceButton()).toBeDisabled();
  });

  it('with no valid row a replace would not run, so it says nothing will be removed and offers no way to', async () => {
    setup();
    await choose(csv('ERR A,Mains,x,yes'));
    await reviewed();
    await mode(/^Replace entire menu/);
    expect(await screen.findByText('Nothing will be removed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Type REPLACE to confirm')).toBeNull();
    expect(replaceButton()).toBeDisabled();
  });

  it('if the hub cannot work out what a replace would remove, the page stays a merge instead of guessing "0 items"', async () => {
    // The review on screen is the merge's. Switching to Replace must not leave the Replace radio on, the merge's
    // counts under it, and a box that would accept REPLACE: the person would confirm removing "0 items".
    setup({ 'POST /admin/menu/import/preview': ({ body }) => (body.mode === 'replace' ? new TypeError('fetch failed') : PREVIEW({ body })) });
    await choose(csv('NEW A,Mains,1,yes'));
    await reviewed();
    await mode(/^Replace entire menu/);

    expect(await screen.findByText('The import did not work')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Merge/ })).toBeChecked();
    expect(screen.queryByText(/will be removed/)).toBeNull();
    expect(screen.queryByLabelText('Type REPLACE to confirm')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Replace menu/ })).not.toBeInTheDocument();
    expect(importButton()).toBeEnabled();   // the merge review is still good and still importable
  });

  it('the modes cannot be switched while the hub is still working out the last one', async () => {
    const gate = deferred();
    setup({ 'POST /admin/menu/import/preview': async ({ body }) => { if (body.mode === 'replace') await gate.promise; return PREVIEW({ body }); } });
    await choose(csv('NEW A,Mains,1,yes'));
    await reviewed();
    await mode(/^Replace entire menu/);
    expect(await screen.findByText('Checking the rows against your menu…')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Merge/ })).toBeDisabled();
    gate.resolve();
    await screen.findByText('3 items will be removed');
  });
});

describe('import dialog — when the hub refuses', () => {
  it('a menu that changed while it was being reviewed is not imported, and the review is refreshed', async () => {
    let revision = 7;
    const { hub, onImported } = setup({
      'POST /admin/menu/import/preview': ({ body }) => ({ body: { ...previewFor(body.rows, body.mode), revision } }),
      'POST /admin/menu/import/commit': ({ body, call }) => (call === 1
        ? { status: 409, body: { success: false, code: 'STALE_REVISION', error: 'The menu changed.' } }
        : COMMITTED({ body }))
    });
    await choose(csv('NEW A,Mains,1,yes'));
    await reviewed();
    revision = 9;
    await user.click(importButton());

    expect(await screen.findByText('The menu changed while you were reviewing')).toBeInTheDocument();
    expect(screen.getByText(/Nothing was imported\. The review below has been refreshed/)).toBeInTheDocument();
    await waitFor(() => expect(hub.calls('POST /admin/menu/import/preview')).toHaveLength(2));
    await reviewed();
    expect(onImported).not.toHaveBeenCalled();

    // Committing again goes against the refreshed revision, not the one first reviewed, and then it works.
    await user.click(importButton());
    await waitFor(() => expect(hub.calls('POST /admin/menu/import/commit')).toHaveLength(2));
    expect(hub.calls('POST /admin/menu/import/commit').map(c => c.body.base_revision)).toEqual([7, 9]);
    expect(await screen.findByText('Import finished')).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('a refused commit puts the person back at the review, with the hub\'s reason, and imports nothing', async () => {
    const { onImported } = setup({ 'POST /admin/menu/import/commit': { status: 500, body: { success: false, code: 'INTERNAL', error: 'The hub could not save.' } } });
    await choose(csv('NEW A,Mains,1,yes'));
    await reviewed();
    await user.click(importButton());
    expect(await screen.findByText('The import did not work')).toBeInTheDocument();
    expect(screen.getByText('The hub could not save.')).toBeInTheDocument();
    expect(await reviewed()).toBeInTheDocument();
    expect(importButton()).toBeEnabled();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('a refused preview says why and goes back to choosing a file', async () => {
    setup({ 'POST /admin/menu/import/preview': { status: 413, body: { success: false, code: 'PAYLOAD_TOO_LARGE', error: 'Request is too large.' } } });
    await choose(csv('NEW A,Mains,1,yes'));
    expect(await screen.findByText('That file is too large')).toBeInTheDocument();
    expect(screen.getByText(/about 2 MB/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Review summary')).toBeNull();
    expect(chooser()).toBeEnabled();
    // Still choosing, not reviewing: there is no review to start over from.
    expect(screen.queryByRole('button', { name: 'Choose another file' })).toBeNull();
  });

  it('an unreachable hub is explained', async () => {
    setup({ 'POST /admin/menu/import/preview': new TypeError('fetch failed') });
    await choose(csv('NEW A,Mains,1,yes'));
    expect(await screen.findByText('The import did not work')).toBeInTheDocument();
    expect(screen.getByText(/The hub could not be reached/)).toBeInTheDocument();
  });
});

describe('import dialog — leaving', () => {
  it('Cancel and the close button leave, and "Choose another file" starts over', async () => {
    const { onClose } = setup();
    await choose(csv('NEW A,Mains,1,yes'));
    await reviewed();
    await user.click(screen.getByRole('button', { name: 'Choose another file' }));
    expect(screen.queryByLabelText('Review summary')).toBeNull();
    expect(importButton()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot be closed while the hub is working, so a half-finished commit is never abandoned on screen', async () => {
    const gate = deferred();
    const { onClose } = setup({ 'POST /admin/menu/import/commit': async () => { await gate.promise; return { body: { success: true, revision: 8, counts: { new: 1, updated: 0, unchanged: 0, error: 0, removed: 0 }, skipped: 0 } }; } });
    await choose(csv('NEW A,Mains,1,yes'));
    await reviewed();
    await user.click(importButton());
    expect(await screen.findByText('Importing…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(chooser()).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');   // the other way out of a dialog
    expect(onClose).not.toHaveBeenCalled();
    gate.resolve();
    expect(await screen.findByText('Import finished')).toBeInTheDocument();
  });

  it('Escape leaves when nothing is in flight', async () => {
    const { onClose } = setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('import dialog — the template', () => {
  it('downloads the current menu as a CSV file named menu.csv', async () => {
    let made;
    vi.stubGlobal('URL', Object.assign(function URLStub() {}, { createObjectURL: blob => { made = blob; return 'blob:menu'; }, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { click.mock.lastDownload = this.download; });
    setup();
    await user.click(screen.getByRole('button', { name: /Download template/ }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.lastDownload).toBe('menu.csv');
    expect(made.type).toMatch(/text\/csv/);
    const text = await made.text();
    expect(text.split(/\r?\n/)[0]).toContain('name,category,price');
    expect(text).toContain('Dal');
    click.mockRestore();
  });
});
