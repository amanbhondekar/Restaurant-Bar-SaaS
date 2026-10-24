import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TablesTab } from '@/admin/TablesTab';
import { deferred, fakeHub } from '../helpers/fakeHub';

// Reception's Tables tab. Every edit goes into a local draft and one save sends the whole floor, so what
// matters here is what that save says, which controls are switched off for a table with an open bill, how
// the hub's refusals are put next to the right row, and that unsaved work is never lost without asking.

const LAYOUT = {
  revision: 3,
  sections: ['Main Hall', 'Terrace'],
  tables: [
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 4 },
    { id: 2, name: 'T2', section: 'Main Hall', capacity: 2 },
    { id: 3, name: 'T3', section: 'Terrace', capacity: 6 }
  ]
};

const setup = (routes = {}, props = {}) => {
  const handlers = {
    onRetry: vi.fn(), onReload: vi.fn().mockResolvedValue(undefined), onRefreshLive: vi.fn(), onStale: vi.fn(), notify: vi.fn()
  };
  // The guest-ordering switch beside the QR codes reads this when the tab opens.
  const hub = fakeHub({ 'GET /public/ordering': { body: { success: true, ordering: false } }, ...routes });
  render(<TablesTab layout={LAYOUT} live={{ tables: [] }} error={null} {...handlers} {...props} />);
  return { hub, ...handlers };
};
const SAVED = { 'PUT /admin/tables/layout': { body: { success: true, revision: 4 } } };
const section = name => within(screen.getByRole('group', { name: `Section ${name}` }));
const name = t => screen.getByLabelText(`Name of table ${t}`);
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save layout' }));
// Holds the input rather than looking it up twice: a table's accessible label IS its name, so clearing it
// changes the label (to "this table") under the second lookup.
const rename = async (from, to) => {
  const input = name(from);
  await userEvent.clear(input);
  await userEvent.type(input, to);
};

describe('tables tab — states', () => {
  it('shows placeholders while the layout is on its way', () => {
    setup({}, { layout: null });
    expect(screen.queryByRole('button', { name: /Add section/ })).not.toBeInTheDocument();
  });

  it('a layout that could not be loaded says why and offers to try again', async () => {
    const { onRetry } = setup({}, { layout: null, error: { code: 'NETWORK' } });
    expect(screen.getByText('The tables could not be loaded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a hub with no floor yet switches editing off', () => {
    setup({}, { layout: { uninitialized: true } });
    expect(screen.getByText('This hub has no tables yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add section/ })).not.toBeInTheDocument();
  });

  it('a floor with nothing on it invites a first section', () => {
    setup({}, { layout: { revision: 1, sections: [], tables: [] } });
    expect(screen.getByText('No tables yet')).toBeInTheDocument();
    expect(screen.getByText(/Add a section such as Main Hall/)).toBeInTheDocument();
  });
});

describe('tables tab — the floor as it stands', () => {
  it('shows each section with its tables, and counts them', () => {
    setup();
    expect(screen.getByText(/3 tables in 2 sections/)).toBeInTheDocument();
    expect(section('Main Hall').getByLabelText('Name of table T1')).toHaveValue('T1');
    expect(section('Main Hall').getByLabelText('Name of table T2')).toHaveValue('T2');
    expect(section('Terrace').getByLabelText('Name of table T3')).toHaveValue('T3');
    expect(screen.getByLabelText('Number of seats for T3')).toHaveValue('6');
  });

  it('offers the printable table codes once there are tables, opening in a new tab', () => {
    setup();
    const link = screen.getByRole('link', { name: /Table QR codes/ });
    expect(link.getAttribute('href')).toMatch(/\/qr\/diner\/sheet$/);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('has no codes to print for an empty floor, and no guest-ordering switch to go with them', () => {
    setup({}, { layout: { revision: 1, sections: ['Main'], tables: [] } });
    expect(screen.queryByRole('link', { name: /Table QR codes/ })).not.toBeInTheDocument();
  });

  it('offers nothing to save until something changes', () => {
    setup();
    expect(screen.queryByRole('region', { name: 'Unsaved layout changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save layout' })).not.toBeInTheDocument();
  });
});

describe('tables tab — editing and saving', () => {
  it('a rename shows the unsaved bar, and saving sends the whole floor against the revision on screen', async () => {
    const { hub, onReload, notify } = setup(SAVED);
    await rename('T1', 'Window');
    expect(screen.getByRole('region', { name: 'Unsaved layout changes' })).toHaveTextContent('Unsaved changes');
    expect(hub.calls('PUT /admin/tables/layout')).toHaveLength(0);

    await save();
    expect(hub.calls('PUT /admin/tables/layout')[0].body).toEqual({
      base_revision: 3,
      sections: ['Main Hall', 'Terrace'],
      tables: [
        { id: 1, name: 'Window', section: 'Main Hall', capacity: 4 },
        { id: 2, name: 'T2', section: 'Main Hall', capacity: 2 },
        { id: 3, name: 'T3', section: 'Terrace', capacity: 6 }
      ]
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Layout saved.');
  });

  it('a new table goes in without an id, so the hub knows to make one', async () => {
    const { hub } = setup(SAVED);
    await userEvent.click(section('Terrace').getByRole('button', { name: 'Add table' }));
    await save();

    const tables = hub.calls('PUT /admin/tables/layout')[0].body.tables;
    expect(tables).toHaveLength(4);
    expect(tables[3]).toEqual({ name: 'T4', section: 'Terrace', capacity: 4 });
    expect(tables[3]).not.toHaveProperty('id');
  });

  it('a new section appears with a name to change, and can hold tables of its own', async () => {
    const { hub } = setup(SAVED);
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    expect(screen.getByRole('group', { name: 'Section New section' })).toBeInTheDocument();
    expect(screen.getByText('No tables in this section.')).toBeInTheDocument();

    await userEvent.click(section('New section').getByRole('button', { name: 'Add table' }));
    await save();
    const body = hub.calls('PUT /admin/tables/layout')[0].body;
    expect(body.sections).toEqual(['Main Hall', 'Terrace', 'New section']);
    expect(body.tables.at(-1)).toMatchObject({ section: 'New section' });
  });

  it('seats go up and down by one, and stop at 1 and 50', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'More seats for T2' }));
    expect(screen.getByLabelText('Number of seats for T2')).toHaveValue('3');
    await userEvent.click(screen.getByRole('button', { name: 'Fewer seats for T2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fewer seats for T2' }));
    expect(screen.getByLabelText('Number of seats for T2')).toHaveValue('1');
    expect(screen.getByRole('button', { name: 'Fewer seats for T2' })).toBeDisabled();

    const seats = screen.getByLabelText('Number of seats for T3');
    await userEvent.clear(seats);
    await userEvent.type(seats, '50');
    expect(screen.getByRole('button', { name: 'More seats for T3' })).toBeDisabled();
  });

  it('a table moves to another section, ending up last in it', async () => {
    const { hub } = setup(SAVED);
    await userEvent.selectOptions(screen.getByLabelText('Move T1 to another section'), 'Terrace');
    await save();
    const tables = hub.calls('PUT /admin/tables/layout')[0].body.tables;
    expect(tables.map(t => [t.name, t.section])).toEqual([['T2', 'Main Hall'], ['T3', 'Terrace'], ['T1', 'Terrace']]);
  });

  it('tables reorder within a section, and the first cannot go up nor the last down', async () => {
    const { hub } = setup(SAVED);
    expect(screen.getByRole('button', { name: 'Move T1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move T2 down' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Move T1 down' }));
    await save();
    expect(hub.calls('PUT /admin/tables/layout')[0].body.tables.map(t => t.name)).toEqual(['T2', 'T1', 'T3']);
  });

  it('sections reorder, and the first cannot go up nor the last down', async () => {
    const { hub } = setup(SAVED);
    expect(screen.getByRole('button', { name: 'Move section Main Hall up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move section Terrace down' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Move section Terrace up' }));
    await save();
    const body = hub.calls('PUT /admin/tables/layout')[0].body;
    expect(body.sections).toEqual(['Terrace', 'Main Hall']);
    expect(body.tables.map(t => t.name)).toEqual(['T3', 'T1', 'T2']);
  });

  it('a section can be moved down as well as up', async () => {
    const { hub } = setup(SAVED);
    await userEvent.click(screen.getByRole('button', { name: 'Move section Main Hall down' }));
    await save();
    expect(hub.calls('PUT /admin/tables/layout')[0].body.sections).toEqual(['Terrace', 'Main Hall']);
  });

  it('a section with tables cannot be deleted; an empty one can, and leaves the save', async () => {
    const { hub } = setup(SAVED);
    expect(screen.getByRole('button', { name: 'Delete section Terrace' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Add section' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete section New section' }));
    expect(screen.queryByRole('group', { name: 'Section New section' })).not.toBeInTheDocument();
    // Back to what is saved, so there is nothing left to save.
    expect(screen.queryByRole('button', { name: 'Save layout' })).not.toBeInTheDocument();
    expect(hub.calls('PUT /admin/tables/layout')).toHaveLength(0);
  });

  it('a table that is already on the hub is deleted only after asking, and only on Save', async () => {
    const { hub } = setup(SAVED);
    await userEvent.click(screen.getByRole('button', { name: 'Delete table T3' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete table T3?' });
    expect(within(dialog).getByText(/The hub refuses to delete a table that has an open bill/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name of table T3')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete table' }));
    expect(screen.queryByLabelText('Name of table T3')).not.toBeInTheDocument();
    expect(hub.calls('PUT /admin/tables/layout')).toHaveLength(0);

    await save();
    expect(hub.calls('PUT /admin/tables/layout')[0].body.tables.map(t => t.name)).toEqual(['T1', 'T2']);
  });

  it('a table added in this session is deleted without asking -- there is nothing on the hub to lose', async () => {
    setup();
    await userEvent.click(section('Terrace').getByRole('button', { name: 'Add table' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete table T4' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name of table T4')).not.toBeInTheDocument();
  });

  it('a section is renamed when the field is left, and its tables go with it', async () => {
    const { hub } = setup(SAVED);
    const field = screen.getByLabelText('Section name: Terrace');
    await userEvent.clear(field);
    await userEvent.type(field, 'Garden');
    await userEvent.tab();
    await save();

    const body = hub.calls('PUT /admin/tables/layout')[0].body;
    expect(body.sections).toEqual(['Main Hall', 'Garden']);
    expect(body.tables.at(-1)).toMatchObject({ name: 'T3', section: 'Garden' });
  });

  it('a section name is refused when empty or taken, and Escape puts the old one back', async () => {
    setup();
    const field = screen.getByLabelText('Section name: Terrace');
    await userEvent.clear(field);
    await userEvent.tab();
    expect(screen.getByText('A section needs a name.')).toBeInTheDocument();

    await userEvent.type(field, 'main hall');
    await userEvent.tab();
    expect(screen.getByText('Another section already has that name.')).toBeInTheDocument();

    await userEvent.type(field, '{Escape}');
    expect(field).toHaveValue('Terrace');
    expect(screen.queryByText('Another section already has that name.')).not.toBeInTheDocument();
  });
});

describe('tables tab — refusing a bad layout before asking the hub', () => {
  it('two tables with one name, or a blank seat count, switch Save off and say how many problems', async () => {
    const { hub } = setup(SAVED);
    await rename('T2', 'T1');
    const seats = screen.getByLabelText('Number of seats for T3');
    await userEvent.clear(seats);

    expect(screen.getByRole('button', { name: 'Save layout' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Unsaved layout changes' })).toHaveTextContent(/Fix \d+ problems? to save/);
    expect(hub.all().filter(c => c.key.startsWith('PUT'))).toHaveLength(0);
  });

  it('puts the explanation on EVERY table that clashes, in its own row', async () => {
    setup();
    await rename('T2', 'T1');
    const clashing = screen.getAllByLabelText('Name of table T1');
    expect(clashing).toHaveLength(2);
    for (const input of clashing) {
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(within(input.closest('li')).getByText('table name "T1" is used twice')).toBeInTheDocument();
    }
    expect(within(screen.getByLabelText('Name of table T3').closest('li')).queryByText(/is used twice/)).not.toBeInTheDocument();
  });
});

describe('tables tab — a table with an open bill', () => {
  const LIVE = { tables: [{ id: 2, status: 'occupied' }, { id: 1, status: 'available' }] };

  it('cannot be renamed or deleted while the bill is open, and says why', () => {
    setup({}, { live: LIVE });
    expect(name('T2')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete table T2' })).toBeDisabled();
    expect(within(name('T2').closest('li')).getByText('Open bill')).toBeInTheDocument();
    expect(name('T1')).toBeEnabled();
  });

  it('but can still be moved and given more or fewer seats -- those do not disturb the bill', async () => {
    setup({}, { live: LIVE });
    expect(screen.getByRole('button', { name: 'More seats for T2' })).toBeEnabled();
    expect(screen.getByLabelText('Move T2 to another section')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move T2 up' })).toBeDefined();
  });

  it('an available table is not locked, and neither is one the floor view has no news of', () => {
    setup({}, { live: { tables: [{ id: 1, status: 'available' }] } });
    expect(name('T1')).toBeEnabled();
    expect(name('T3')).toBeEnabled();
  });
});

describe('tables tab — when the hub refuses', () => {
  const edit = async () => { await rename('T1', 'Window'); await save(); };

  it('a menu that moved on hands over to the page\'s reload banner', async () => {
    const { onStale, notify } = setup({ 'PUT /admin/tables/layout': { status: 409, body: { success: false, code: 'STALE_REVISION', error: 'old' } } });
    await edit();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(screen.queryByText('The layout was not saved')).not.toBeInTheDocument();
  });

  it('a bad value is put beside the table the hub means, found by the position the save sent it in', async () => {
    setup({ 'PUT /admin/tables/layout': { status: 400, body: { success: false, code: 'INVALID_LAYOUT', errors: [{ field: 'tables[2].name', message: 'name is not allowed' }] } } });
    await edit();

    const t3 = (await screen.findByText('name is not allowed')).closest('li');
    expect(within(t3).getByLabelText('Name of table T3')).toBeInTheDocument();
    expect(screen.getByText('The layout was not saved')).toBeInTheDocument();
    expect(screen.getByText(/The messages are next to them/)).toBeInTheDocument();
  });

  it('a bad section is put on that section', async () => {
    setup({ 'PUT /admin/tables/layout': { status: 400, body: { success: false, code: 'INVALID_LAYOUT', errors: [{ field: 'sections[1]', message: 'section is reserved' }] } } });
    await edit();
    expect(within(screen.getByRole('group', { name: 'Section Terrace' })).getByText('section is reserved')).toBeInTheDocument();
  });

  it('an error that names no row is shown at the top rather than lost', async () => {
    setup({ 'PUT /admin/tables/layout': { status: 400, body: { success: false, code: 'INVALID_LAYOUT', errors: [{ field: 'layout', message: 'too many tables for your plan' }] } } });
    await edit();
    expect(await screen.findByText('too many tables for your plan')).toBeInTheDocument();
  });

  it('a table with an open bill is named, the floor view is refreshed, and the edits are kept', async () => {
    const { onRefreshLive } = setup({
      'PUT /admin/tables/layout': { status: 409, body: { success: false, code: 'TABLE_HAS_OPEN_BILL', error: 'A table has an open bill.', details: [{ name: 'T2', action: 'renamed' }] } }
    });
    await edit();

    expect(await screen.findByText('These tables have an open bill')).toBeInTheDocument();
    expect(screen.getByText(/T2 \(renamed\)\. Clear the bill first/)).toBeInTheDocument();
    expect(onRefreshLive).toHaveBeenCalledTimes(1);
    expect(name('Window')).toBeInTheDocument();
  });

  it('anything else is shown in plain words', async () => {
    setup({ 'PUT /admin/tables/layout': new TypeError('Failed to fetch') });
    await edit();
    expect(await screen.findByText(/The hub could not be reached/)).toBeInTheDocument();
  });

  it('typing again clears the old refusal, so a fixed form is not left looking broken', async () => {
    setup({ 'PUT /admin/tables/layout': { status: 400, body: { success: false, code: 'INVALID_LAYOUT', errors: [{ field: 'layout', message: 'too many tables for your plan' }] } } });
    await edit();
    await screen.findByText('too many tables for your plan');
    await userEvent.type(name('Window'), '2');
    expect(screen.queryByText('too many tables for your plan')).not.toBeInTheDocument();
  });

  it('while a save is in flight it cannot be sent twice or discarded', async () => {
    const gate = deferred();
    const { hub } = setup({ 'PUT /admin/tables/layout': () => gate.promise.then(() => ({ body: { success: true, revision: 4 } })) });
    await edit();

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add section' })).toBeDisabled();
    expect(hub.calls('PUT /admin/tables/layout')).toHaveLength(1);
    gate.resolve();
  });
});

describe('tables tab — not losing work', () => {
  it('Discard asks first, then puts the floor back to what the hub has', async () => {
    setup();
    await rename('T1', 'Window');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard all unsaved layout changes?' });
    expect(screen.getByLabelText('Name of table Window')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Name of table T1')).toHaveValue('T1');
    expect(screen.queryByRole('region', { name: 'Unsaved layout changes' })).not.toBeInTheDocument();
  });

  it('keeping the edits when asked to discard keeps them', async () => {
    setup();
    await rename('T1', 'Window');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Name of table Window')).toBeInTheDocument();
  });

  it('closing the page with unsaved work is stopped and asks; with nothing to lose it is not', async () => {
    setup();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    await rename('T1', 'Window');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it('a fresh layout from the hub (after a save, or Reload) replaces the draft', async () => {
    const handlers = { onRetry: vi.fn(), onReload: vi.fn(), onRefreshLive: vi.fn(), onStale: vi.fn(), notify: vi.fn() };
    fakeHub({ 'GET /public/ordering': { body: { success: true, ordering: false } } });
    const { rerender } = render(<TablesTab layout={LAYOUT} live={{ tables: [] }} error={null} {...handlers} />);
    await rename('T1', 'Window');

    rerender(<TablesTab layout={{ ...LAYOUT, revision: 4, tables: [{ id: 1, name: 'Hub name', section: 'Main Hall', capacity: 4 }] }} live={{ tables: [] }} error={null} {...handlers} />);
    expect(await screen.findByLabelText('Name of table Hub name')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Unsaved layout changes' })).not.toBeInTheDocument();
  });
});
