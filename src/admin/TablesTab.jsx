import React, { useEffect, useMemo, useState } from 'react';
import { Armchair, ArrowDown, ArrowUp, Lock, Minus, Plus, QrCode, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from 'cn';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { explainError, hubBase, hubSend } from './api';
import { ConfirmDialog, EmptyState, ListSkeleton, NativeSelect, Notice, TextInput, useLastValue } from './ui';
import {
  addSection, addTable, deleteSection, deleteTable, draftFromLayout, isDirty, moveSection, moveTableToSection,
  moveTableWithin, orderedTables, renameSection, renameTable, setCapacity, tablesIn, toPayload, validateDraft
} from './lib/layoutDraft';

// The Tables tab. Every edit (rename, seats, move, reorder, add, delete) goes into a local draft
// (lib/layoutDraft.js); nothing reaches the hub until "Save layout", which sends the whole floor in one
// call. A table with an open bill cannot be renamed or deleted (the hub refuses, and the controls are
// off), but can still be moved and given more or fewer seats.

const NO_SERVER_ERRORS = { tables: {}, sections: {}, blocked: [], general: null };
const norm = s => String(s ?? '').trim().toLowerCase();

// The hub reports a bad table as tables[i].field and a bad section as sections[i]; i counts in the order the
// save sent them, so look the row up there.
function mapInvalidLayout(errors, tableKeys, sections) {
  const mapped = { tables: {}, sections: {}, blocked: [], general: null };
  for (const { field, message } of errors ?? []) {
    const table = /^tables\[(\d+)\]\./.exec(field ?? '');
    const section = /^sections\[(\d+)\]$/.exec(field ?? '');
    if (table && tableKeys[Number(table[1])]) (mapped.tables[tableKeys[Number(table[1])]] ||= []).push(message);
    else if (section && sections[Number(section[1])] !== undefined) (mapped.sections[sections[Number(section[1])]] ||= []).push(message);
    else mapped.general = [mapped.general, message].filter(Boolean).join(' ');
  }
  return mapped;
}

function SectionName({ name, sections, errors, onRename }) {
  const [text, setText] = useState(name);
  const [problem, setProblem] = useState('');
  useEffect(() => { setText(name); setProblem(''); }, [name]);

  // Renaming a section moves its tables with it, so it is applied when the field is left (or on Enter),
  // never keystroke by keystroke: half-typed names must not collide with another section.
  const commit = () => {
    const next = text.trim();
    if (next === name.trim()) { setText(name); setProblem(''); return; }
    if (!next) { setProblem('A section needs a name.'); return; }
    if (sections.some(s => s !== name && norm(s) === norm(next))) { setProblem('Another section already has that name.'); return; }
    setProblem('');
    onRename(next);
  };

  const message = problem || errors?.[0];
  return (
    <div className="min-w-0 flex-1 basis-40">
      <TextInput
        aria-label={`Section name: ${name}`}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setText(name); setProblem(''); }
        }}
        invalid={Boolean(message)}
        className="font-medium"
        autoComplete="off"
      />
      {message && <p className="mt-1 text-xs text-destructive">{message}</p>}
    </div>
  );
}

function SeatStepper({ value, name, onChange }) {
  const n = Number.isFinite(value) ? value : 0;
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`Seats for ${name}`}>
      <Button type="button" variant="outline" size="icon" className="size-10" aria-label={`Fewer seats for ${name}`} disabled={n <= 1} onClick={() => onChange(n - 1)}><Minus aria-hidden="true" /></Button>
      <TextInput
        className="w-14 px-1 text-center tabular-nums"
        inputMode="numeric"
        aria-label={`Number of seats for ${name}`}
        value={Number.isFinite(value) ? String(value) : ''}
        onChange={e => onChange(e.target.value)}
        invalid={!Number.isInteger(value) || value < 1 || value > 50}
        autoComplete="off"
      />
      <Button type="button" variant="outline" size="icon" className="size-10" aria-label={`More seats for ${name}`} disabled={n >= 50} onClick={() => onChange(n + 1)}><Plus aria-hidden="true" /></Button>
    </div>
  );
}

export function TablesTab({ layout, live, error, onRetry, onReload, onRefreshLive, onStale, notify }) {
  const [draft, setDraft] = useState(() => draftFromLayout(layout));
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState(NO_SERVER_ERRORS);
  const [deletingTable, setDeletingTable] = useState(null); // { key, name }
  const [discarding, setDiscarding] = useState(false);
  const deletingShown = useLastValue(deletingTable);

  // A fresh read of the layout (first load, after a save, after "Reload") replaces the draft.
  useEffect(() => {
    setDraft(draftFromLayout(layout));
    setServerErrors(NO_SERVER_ERRORS);
  }, [layout]);

  const checks = useMemo(() => validateDraft(draft), [draft]);
  const dirty = Boolean(layout) && isDirty(layout, draft);
  const problems = Object.keys(checks.tableErrors).length + Object.keys(checks.sectionErrors).length;

  const lockedIds = useMemo(() => {
    const ids = new Set();
    for (const t of live?.tables ?? []) if (t.status && t.status !== 'available') ids.add(String(t.id));
    return ids;
  }, [live]);
  const isLocked = table => table.id !== undefined && lockedIds.has(String(table.id));

  // Leaving the page with unsaved layout work asks first.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!layout) {
    return error ? (
      <Notice tone="error" title="The tables could not be loaded" action={<Button className="h-10" onClick={onRetry}>Retry</Button>}>
        {explainError(error)}
      </Notice>
    ) : (
      <ListSkeleton rows={5} />
    );
  }

  if (layout.uninitialized) {
    return (
      <Notice tone="warning" title="This hub has no tables yet">
        The hub has not downloaded your restaurant&apos;s floor. Connect it to the internet once, give it a minute, then reload this page. Editing is switched off until then.
      </Notice>
    );
  }

  // `change` is a function from the current draft to the next one, so quick successive edits never work from a stale draft.
  const edit = change => {
    setDraft(change);
    setServerErrors(NO_SERVER_ERRORS);
  };
  const tableProblems = key => [...(checks.tableErrors[key] ?? []), ...(serverErrors.tables[key] ?? [])];
  const sectionProblems = name => [...(checks.sectionErrors[name] ?? []), ...(serverErrors.sections[name] ?? [])];

  const save = async () => {
    if (!checks.ok || saving) return;
    const payload = toPayload(draft);
    const keys = orderedTables(draft).map(t => t.key);
    const sections = [...draft.sections];
    setSaving(true);
    setServerErrors(NO_SERVER_ERRORS);
    try {
      await hubSend('PUT', '/admin/tables/layout', { base_revision: layout.revision, ...payload });
      await onReload(); // the new layout arrives as a prop and resets the draft
      notify('Layout saved.');
    } catch (failure) {
      if (failure.code === 'STALE_REVISION') {
        onStale();
      } else if (failure.code === 'INVALID_LAYOUT') {
        const mapped = mapInvalidLayout(failure.errors, keys, sections);
        setServerErrors({ ...mapped, general: mapped.general ?? 'The hub did not accept some of these values. The messages are next to them.' });
      } else if (failure.code === 'TABLE_HAS_OPEN_BILL') {
        setServerErrors({ ...NO_SERVER_ERRORS, blocked: failure.details ?? [], general: failure.error });
        onRefreshLive();
      } else {
        setServerErrors({ ...NO_SERVER_ERRORS, general: explainError(failure) });
      }
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(draftFromLayout(layout));
    setServerErrors(NO_SERVER_ERRORS);
    setDiscarding(false);
  };

  const tableCount = draft.tables.length;

  return (
    <div className="flex flex-col gap-4">
      {error && <Notice tone="error" action={<Button className="h-10" onClick={onRetry}>Retry</Button>}>{explainError(error)}</Notice>}
      {serverErrors.general && (
        <Notice tone="error" title={serverErrors.blocked.length > 0 ? 'These tables have an open bill' : 'The layout was not saved'}>
          {serverErrors.blocked.length > 0
            ? `${serverErrors.blocked.map(b => `${b.name} (${b.action})`).join(', ')}. Clear the bill first, or press Discard to drop your edits. Moving a table and changing its seats are always allowed.`
            : serverErrors.general}
        </Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {tableCount} {tableCount === 1 ? 'table' : 'tables'} in {draft.sections.length} {draft.sections.length === 1 ? 'section' : 'sections'}. Changes are saved when you press Save layout.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* Opens the printable sheet of diner QR codes, one per table. A new tab rather than
              an in-page view: its job is to be printed, and it is served by the hub. */}
          {tableCount > 0 && (
            <a
              href={`${hubBase()}/qr/diner/sheet`}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: 'outline' }), 'h-10')}
            >
              <QrCode aria-hidden="true" /> Table QR codes
            </a>
          )}
          <Button type="button" variant="outline" className="h-10" onClick={() => edit(d => addSection(d))} disabled={saving}><Plus aria-hidden="true" /> Add section</Button>
        </div>
      </div>

      {draft.sections.length === 0 ? (
        <EmptyState
          icon={Armchair}
          title="No tables yet"
          action={<Button type="button" className="h-10" onClick={() => edit(d => addSection(d))}><Plus aria-hidden="true" /> Add section</Button>}
        >
          Add a section such as Main Hall, then add its tables.
        </EmptyState>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {draft.sections.map((section, sectionIndex) => {
            const tables = tablesIn(draft, section);
            const others = draft.sections.filter(s => s !== section);
            return (
              <Card key={section} className="min-w-0" role="group" aria-label={`Section ${section}`}>
                <CardHeader>
                  <div className="flex flex-wrap items-start gap-2">
                    <SectionName name={section} sections={draft.sections} errors={sectionProblems(section)} onRename={next => edit(d => renameSection(d, section, next))} />
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="icon" className="size-10" aria-label={`Move section ${section} up`} title="Move section up" disabled={sectionIndex === 0} onClick={() => edit(d => moveSection(d, section, -1))}><ArrowUp aria-hidden="true" /></Button>
                      <Button type="button" variant="outline" size="icon" className="size-10" aria-label={`Move section ${section} down`} title="Move section down" disabled={sectionIndex === draft.sections.length - 1} onClick={() => edit(d => moveSection(d, section, 1))}><ArrowDown aria-hidden="true" /></Button>
                      <span title={tables.length > 0 ? 'Move or delete its tables first' : 'Delete this empty section'}>
                        <Button type="button" variant="outline" size="icon" className="size-10" aria-label={`Delete section ${section}`} disabled={tables.length > 0} onClick={() => edit(d => deleteSection(d, section))}><Trash2 aria-hidden="true" /></Button>
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {tables.length === 0 && <p className="rounded-lg border border-dashed border-border p-3 text-center text-sm text-muted-foreground">No tables in this section.</p>}
                  <ul className="flex flex-col gap-2">
                    {tables.map((table, position) => {
                      const locked = isLocked(table);
                      const problemsHere = tableProblems(table.key);
                      const label = table.name.trim() || 'this table';
                      return (
                        <li key={table.key} className="flex flex-wrap items-start gap-2 rounded-lg border border-border p-2">
                          <div className="min-w-32 flex-1 basis-36" title={locked ? 'This table has an open bill. Clear it before renaming or deleting.' : undefined}>
                            <TextInput
                              aria-label={`Name of table ${label}`}
                              value={table.name}
                              onChange={e => { const { value } = e.target; edit(d => renameTable(d, table.key, value)); }}
                              disabled={locked}
                              invalid={problemsHere.some(m => /name/.test(m))}
                              autoComplete="off"
                            />
                            {locked && <Badge variant="outline" className="mt-1 gap-1 text-[var(--status-amber-text)]"><Lock aria-hidden="true" /> Open bill</Badge>}
                          </div>
                          <SeatStepper value={table.capacity} name={label} onChange={value => edit(d => setCapacity(d, table.key, value))} />
                          <NativeSelect
                            className="w-36"
                            aria-label={`Move ${label} to another section`}
                            value=""
                            disabled={others.length === 0}
                            onChange={e => { const { value } = e.target; if (value) edit(d => moveTableToSection(d, table.key, value)); }}
                          >
                            <option value="">Move to…</option>
                            {others.map(s => <option key={s} value={s}>{s}</option>)}
                          </NativeSelect>
                          <div className="flex items-center gap-1">
                            <Button type="button" variant="outline" size="icon" className="size-10" aria-label={`Move ${label} up`} title="Move up" disabled={position === 0} onClick={() => edit(d => moveTableWithin(d, table.key, -1))}><ArrowUp aria-hidden="true" /></Button>
                            <Button type="button" variant="outline" size="icon" className="size-10" aria-label={`Move ${label} down`} title="Move down" disabled={position === tables.length - 1} onClick={() => edit(d => moveTableWithin(d, table.key, 1))}><ArrowDown aria-hidden="true" /></Button>
                            <span title={locked ? 'This table has an open bill. Clear it before deleting.' : 'Delete table'}>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="size-10 text-destructive"
                                aria-label={`Delete table ${label}`}
                                disabled={locked}
                                onClick={() => (table.id === undefined ? edit(d => deleteTable(d, table.key)) : setDeletingTable({ key: table.key, name: table.name }))}
                              ><Trash2 aria-hidden="true" /></Button>
                            </span>
                          </div>
                          {problemsHere.map(message => <p key={message} className="basis-full text-xs text-destructive">{message}</p>)}
                        </li>
                      );
                    })}
                  </ul>
                  <Button type="button" variant="outline" className="h-10 self-start" onClick={() => edit(d => addTable(d, section))}><Plus aria-hidden="true" /> Add table</Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {dirty && (
        <div className="sticky bottom-0 z-40 -mx-4 border-t border-border bg-card px-4 py-3 shadow-lg sm:-mx-6 sm:px-6" role="region" aria-label="Unsaved layout changes">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="font-medium">Unsaved changes</span>
              {!checks.ok && <span className="text-destructive"> · Fix {problems} {problems === 1 ? 'problem' : 'problems'} to save</span>}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" className="h-10" onClick={() => setDiscarding(true)} disabled={saving}>Discard</Button>
              <Button type="button" className="h-10" onClick={save} disabled={!checks.ok || saving}>{saving ? 'Saving…' : 'Save layout'}</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deletingTable)}
        title={`Delete table ${deletingShown?.name ?? ''}?`}
        confirmLabel="Delete table"
        onCancel={() => setDeletingTable(null)}
        onConfirm={() => { const { key } = deletingTable; edit(d => deleteTable(d, key)); setDeletingTable(null); }}
      >
        It leaves the floor when you press Save layout. The hub refuses to delete a table that has an open bill.
      </ConfirmDialog>
      <ConfirmDialog
        open={discarding}
        title="Discard all unsaved layout changes?"
        confirmLabel="Discard"
        onCancel={() => setDiscarding(false)}
        onConfirm={discard}
      >
        The layout goes back to what is saved on the hub.
      </ConfirmDialog>
    </div>
  );
}
