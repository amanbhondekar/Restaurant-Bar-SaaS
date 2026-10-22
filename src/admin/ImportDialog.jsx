import React, { useRef, useState } from 'react';
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { explainError, hubSend } from './api';
import { CloseButton, Notice, TextInput, formatPrice } from './ui';
import { MENU_COLUMNS, csvToRows, menuToCsv, rowsFromTable } from './lib/csv';

// "Import menu": read a .csv or .xlsx in the browser (the hub never sees the file), ask the hub for a
// dry-run preview, let the user review it, then commit. The review shows what each row would do; Replace
// shows how many items would go and needs REPLACE typed. The hub re-checks everything at commit time.

const MAX_ROWS = 2000; // the hub's limit per import
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const PAGE = 200;

const STATUS = {
  new: { label: 'New', tone: 'green' },
  updated: { label: 'Updated', tone: 'blue' },
  unchanged: { label: 'Unchanged', tone: 'muted' },
  error: { label: 'Error', tone: 'rust' }
};

const FIELD_LABELS = { name: 'Name', category: 'Category', price: 'Price', isVeg: 'Veg', available: 'Available', station: 'Station', variants: 'Variants' };

function showValue(field, value) {
  switch (field) {
    case 'isVeg': return value ? 'Veg' : 'Non-veg';
    case 'available': return value ? 'Available' : '86’d';
    case 'price': return formatPrice(value);
    case 'variants':
      return Array.isArray(value) && value.length > 0
        ? value.map(([, label, price, available]) => `${label} ${formatPrice(price)}${available === false ? ' (86’d)' : ''}`).join(', ')
        : 'none';
    default: return String(value ?? '');
  }
}

function StatusChip({ status }) {
  const { label, tone } = STATUS[status] ?? STATUS.unchanged;
  const style = tone === 'muted'
    ? { background: 'var(--color-surface-strong)', color: 'var(--color-muted)', borderColor: 'var(--color-hairline)' }
    : { background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` };
  return <span className="inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium" style={style}>{label}</span>;
}

// What the user is told when the hub (or the file) refuses something, in plain words.
function describeProblem(error) {
  switch (error?.code) {
    case 'PAYLOAD_TOO_LARGE':
      return { tone: 'error', title: 'That file is too large', message: 'It holds more data than the hub takes in one go (about 2 MB). Split it into smaller files.' };
    case 'NO_ROWS':
      return { tone: 'error', title: 'The file has no rows to import', message: 'The first row must be the column names, with one item per row below it.' };
    case 'TOO_MANY_ROWS':
      return { tone: 'error', title: 'Too many rows', message: `Imports are limited to ${MAX_ROWS} rows. Split the file into smaller ones.` };
    case 'INVALID_ROWS':
      return { tone: 'error', title: 'Some rows have errors', message: 'Fix them in the file and choose it again, or tick “Import valid rows only”.' };
    case 'NO_VALID_ROWS':
      return { tone: 'error', title: 'None of the rows is valid', message: 'Nothing was imported and nothing was changed. Fix the rows marked Error and choose the file again.' };
    case 'STALE_REVISION':
      return { tone: 'warning', title: 'The menu changed while you were reviewing', message: 'Nothing was imported. The review below has been refreshed against the latest menu: check it and commit again.' };
    case 'CONFIRM_REQUIRED':
      return { tone: 'error', title: 'Confirmation needed', message: 'Type REPLACE to confirm replacing the whole menu.' };
    default:
      return { tone: 'error', title: 'The import did not work', message: explainError(error) };
  }
}

async function readFileRows(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) {
    const buffer = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      text = new TextDecoder('windows-1252').decode(buffer); // a CSV saved by older Excel is not UTF-8
    }
    return csvToRows(text);
  }
  if (name.endsWith('.xlsx')) {
    // Loaded on demand so the page stays light for everyone who never imports a spreadsheet.
    const { readSheet } = await import('read-excel-file/browser');
    return rowsFromTable(await readSheet(file));
  }
  const failure = new Error('Use a .csv or .xlsx file.');
  failure.code = 'BAD_FILE_TYPE';
  throw failure;
}

function downloadMenuCsv(menu) {
  const blob = new Blob([menuToCsv(menu)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'menu.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ImportDialog({ menu, onClose, onImported }) {
  const [phase, setPhase] = useState('choose'); // choose | working | review | done
  const [busyText, setBusyText] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null); // { rows, columns }
  const [mode, setMode] = useState('merge');
  const [preview, setPreview] = useState(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [filter, setFilter] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const [problem, setProblem] = useState(null);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  const resetToChoose = () => {
    setPhase('choose');
    setParsed(null);
    setPreview(null);
    setFileName('');
    setConfirmText('');
    setSkipInvalid(false);
    setFilter('all');
    setShown(PAGE);
    if (inputRef.current) inputRef.current.value = '';
  };

  const runPreview = async (rows, nextMode, { keepProblem = false } = {}) => {
    setPhase('working');
    setBusyText('Checking the rows against your menu…');
    if (!keepProblem) setProblem(null);
    try {
      const data = await hubSend('POST', '/admin/menu/import/preview', { rows, mode: nextMode });
      setPreview(data);
      setPhase('review');
      return true;
    } catch (error) {
      setProblem(describeProblem(error));
      setPhase(preview ? 'review' : 'choose');
      return false;
    }
  };

  const onFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setProblem(null);
    setResult(null);
    setPreview(null);
    setConfirmText('');
    setSkipInvalid(false);
    setFilter('all');
    setShown(PAGE);
    setMode('merge'); // every new file starts as a merge: Replace is chosen on purpose, per file
    setFileName(file.name);
    if (file.size > MAX_FILE_BYTES) {
      setProblem({ tone: 'error', title: 'That file is too large', message: 'Files over 8 MB cannot be imported. A menu is a few hundred kilobytes at most: check that it is the right file.' });
      return;
    }
    setPhase('working');
    setBusyText('Reading the file…');
    let table;
    try {
      table = await readFileRows(file);
    } catch (error) {
      setProblem({
        tone: 'error',
        title: error.code === 'BAD_FILE_TYPE' ? 'That is not a CSV or Excel file' : 'The file could not be read',
        message: error.code === 'BAD_FILE_TYPE'
          ? 'Choose a .csv or .xlsx file. In Excel, use Save As and pick CSV or Excel Workbook.'
          : 'It may be damaged or not really a spreadsheet. If it is an Excel file, try saving it again as .xlsx or as CSV.'
      });
      setPhase('choose');
      return;
    }
    setParsed(table);
    if (table.rows.length === 0) {
      setProblem(describeProblem({ code: 'NO_ROWS' }));
      setPhase('choose');
      return;
    }
    if (table.rows.length > MAX_ROWS) {
      setProblem({ ...describeProblem({ code: 'TOO_MANY_ROWS' }), message: `This file has ${table.rows.length} rows. Imports are limited to ${MAX_ROWS}: split it into smaller files.` });
      setPhase('choose');
      return;
    }
    if (!table.columns.includes('name') && !table.columns.includes('id')) {
      setProblem({ tone: 'error', title: 'No “name” column found', message: `The first row must hold the column names: ${MENU_COLUMNS.join(', ')}. Use “Download template” for a file in the right shape.` });
      setPhase('choose');
      return;
    }
    await runPreview(table.rows, 'merge');
  };

  const changeMode = async next => {
    if (next === mode || phase === 'working') return;
    const before = mode;
    setMode(next);
    setConfirmText('');
    if (!parsed) return;
    // The review on screen belongs to the mode it was worked out for. If the hub cannot answer for the new one,
    // go back to the old mode rather than leave Replace selected over a merge's counts ("0 items will be
    // removed") with a box that would accept REPLACE.
    if (!(await runPreview(parsed.rows, next))) setMode(before);
  };

  const commit = async () => {
    setPhase('working');
    setBusyText('Importing…');
    setProblem(null);
    try {
      const data = await hubSend('POST', '/admin/menu/import/commit', {
        base_revision: preview.revision,
        rows: parsed.rows,
        mode,
        skip_invalid: skipInvalid,
        ...(mode === 'replace' ? { confirm_replace: true } : {})
      });
      setResult(data);
      setPhase('done');
      await onImported(data);
    } catch (error) {
      setProblem(describeProblem(error));
      if (error.code === 'STALE_REVISION' || error.code === 'INVALID_ROWS' || error.code === 'NO_VALID_ROWS') {
        // The review no longer matches the hub: look again so the numbers on screen are true.
        await runPreview(parsed.rows, mode, { keepProblem: true });
      } else {
        setPhase('review');
      }
    }
  };

  const counts = preview?.counts;
  const validRows = counts ? counts.new + counts.updated + counts.unchanged : 0;
  // Replace removes what the file leaves out, but only if some row is valid: with none, the hub refuses the
  // whole import, so no removal is pending and none is shown.
  const removals = counts && mode === 'replace' && validRows > 0 ? counts.removed : 0;
  const work = counts ? counts.new + counts.updated + removals : 0;
  const errorsBlock = counts ? counts.error > 0 && !skipInvalid : false;
  const needsTyping = mode === 'replace' && confirmText.trim() !== 'REPLACE';
  const canCommit = phase === 'review' && Boolean(counts) && validRows > 0 && work > 0 && !errorsBlock && !needsTyping;
  const ignoredColumns = parsed ? parsed.columns.filter(c => !MENU_COLUMNS.includes(c)) : [];

  const rows = (preview?.rows ?? []).filter(r => filter === 'all' || r.status === filter);
  const visibleRows = rows.slice(0, shown);
  const working = phase === 'working';

  let hint = '';
  if (phase === 'review' && counts && !canCommit) {
    if (validRows === 0) hint = 'No row is valid, so there is nothing to import.';
    else if (errorsBlock) hint = 'Some rows have errors. Tick “Import valid rows only” to go ahead without them.';
    else if (work === 0) hint = 'Nothing would change: every row matches the menu as it is.';
    else if (needsTyping) hint = 'Type REPLACE to confirm.';
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !working) onClose(); }}>
      <DialogContent showCloseButton={false} className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <CloseButton onClick={onClose} disabled={working} />
        <DialogHeader>
          <DialogTitle>Import menu</DialogTitle>
          <DialogDescription>
            Choose a .csv or .xlsx file. The columns are {MENU_COLUMNS.join(', ')}. A blank cell or a missing column never changes what the menu already has, and new items need a veg column. Modifier groups and day-part prices are not in the file: they stay as they are.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-60 flex-1">
            <TextInput ref={inputRef} type="file" accept=".csv,.xlsx" aria-label="Menu file (.csv or .xlsx)" onChange={onFile} disabled={working || phase === 'done'} data-testid="import-file" />
          </div>
          <Button type="button" variant="outline" className="h-10" onClick={() => downloadMenuCsv(menu)} title="The current menu as a CSV: a template and a backup">
            <Download aria-hidden="true" /> Download template
          </Button>
        </div>

        {problem && <Notice tone={problem.tone} title={problem.title}>{problem.message}</Notice>}

        {working && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="spin size-4" aria-hidden="true" /> {busyText}
          </div>
        )}

        {phase === 'done' && result && (
          <Notice tone="success" title="Import finished">
            {result.counts.new} new, {result.counts.updated} updated{mode === 'replace' ? `, ${result.counts.removed} removed` : ''}.
            {result.skipped > 0 ? ` ${result.skipped} ${result.skipped === 1 ? 'row was' : 'rows were'} skipped because of errors.` : ''} The menu behind this window is up to date.
          </Notice>
        )}

        {parsed && phase !== 'choose' && (
          <p className="text-xs text-muted-foreground">
            <FileSpreadsheet className="mr-1 inline size-3.5" aria-hidden="true" />
            {fileName}: {parsed.rows.length} {parsed.rows.length === 1 ? 'row' : 'rows'}. Columns used: {parsed.columns.filter(c => MENU_COLUMNS.includes(c)).join(', ') || 'none'}.
            {ignoredColumns.length > 0 && ` Ignored: ${ignoredColumns.join(', ')}.`}
          </p>
        )}

        {counts && phase !== 'done' && (
          <>
            <div className="flex flex-wrap items-center gap-2" aria-label="Review summary">
              {[['all', 'All', parsed.rows.length], ['new', 'New', counts.new], ['updated', 'Updated', counts.updated], ['unchanged', 'Unchanged', counts.unchanged], ['error', 'Errors', counts.error]].map(([key, label, n]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => { setFilter(key); setShown(PAGE); }}
                  className={cn(
                    'h-10 rounded-lg border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                    filter === key ? 'border-primary bg-accent font-medium text-accent-foreground' : 'border-input bg-background hover:bg-muted'
                  )}
                >{label} <span className="tabular-nums text-muted-foreground">{n}</span></button>
              ))}
            </div>

            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Import mode</legend>
              {[['merge', 'Merge', 'Add new items and update matching ones. Nothing is removed.'], ['replace', 'Replace entire menu', 'The menu becomes exactly what is in the file: items it leaves out are removed.']].map(([value, title, text]) => (
                <label
                  key={value}
                  className={cn(
                    'flex cursor-pointer flex-col gap-0.5 rounded-lg border border-input px-3 py-2 text-sm',
                    'has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-3 has-focus-visible:ring-ring/50',
                    working && 'pointer-events-none opacity-60'
                  )}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="import-mode" value={value} checked={mode === value} onChange={() => changeMode(value)} disabled={working} className="size-4 accent-[var(--color-primary)]" />
                    {title}
                  </span>
                  <span className="pl-6 text-xs text-muted-foreground">{text}</span>
                </label>
              ))}
            </fieldset>

            {mode === 'replace' && (
              validRows > 0 ? (
                <Notice tone="warning" title={`${counts.removed} ${counts.removed === 1 ? 'item' : 'items'} will be removed`}>
                  Items the file does not mention are deleted, and categories left empty go too. Bills that are already open keep their lines. Type REPLACE to go ahead.
                  <TextInput
                    className="mt-2 max-w-60 bg-background"
                    aria-label="Type REPLACE to confirm"
                    placeholder="REPLACE"
                    value={confirmText}
                    onChange={e => setConfirmText(e.target.value)}
                    autoComplete="off"
                  />
                </Notice>
              ) : (
                <Notice tone="warning" title="Nothing will be removed">No row in the file is valid, so a replace would not run.</Notice>
              )
            )}

            {counts.error > 0 && (
              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={skipInvalid} onCheckedChange={checked => setSkipInvalid(Boolean(checked))} aria-label="Import valid rows only" />
                Import valid rows only <span className="text-muted-foreground">({counts.error} {counts.error === 1 ? 'row' : 'rows'} with errors will be skipped)</span>
              </label>
            )}

            <div className="max-h-[40vh] overflow-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">Row</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">Item</th>
                    <th className="px-2 py-2 font-medium">What changes</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(r => (
                    <tr key={`${r.row}-${r.name}`} className="border-t border-border align-top">
                      <td className="px-2 py-2 tabular-nums text-muted-foreground">{r.row}</td>
                      <td className="px-2 py-2"><StatusChip status={r.status} /></td>
                      <td className="px-2 py-2">
                        <div className="font-medium">{r.name || <span className="text-muted-foreground">(no name)</span>}</div>
                        <div className="text-xs text-muted-foreground">{r.category}</div>
                      </td>
                      <td className="px-2 py-2">
                        {r.status === 'error' && r.errors.map(message => <div key={message} className="text-destructive">{message}</div>)}
                        {r.status === 'updated' && r.changes.map(c => (
                          <div key={c.field}><span className="text-muted-foreground">{FIELD_LABELS[c.field] ?? c.field}:</span> {showValue(c.field, c.from)} → <span className="font-medium">{showValue(c.field, c.to)}</span></div>
                        ))}
                        {r.status === 'new' && <span className="text-muted-foreground">Will be added</span>}
                        {r.status === 'unchanged' && <span className="text-muted-foreground">Already matches the menu</span>}
                      </td>
                    </tr>
                  ))}
                  {visibleRows.length === 0 && (
                    <tr><td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">No rows with this status.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {rows.length > visibleRows.length && (
              <Button type="button" variant="outline" className="h-10 self-start" onClick={() => setShown(n => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - visibleRows.length)} more of {rows.length - visibleRows.length}
              </Button>
            )}
          </>
        )}

        <DialogFooter className="items-center">
          {hint && <span className="mr-auto text-xs text-muted-foreground">{hint}</span>}
          {phase === 'review' && (
            <Button type="button" variant="outline" className="h-10" onClick={resetToChoose}>Choose another file</Button>
          )}
          <Button type="button" variant="outline" className="h-10" onClick={onClose} disabled={working}>{phase === 'done' ? 'Close' : 'Cancel'}</Button>
          {phase !== 'done' && (
            <Button type="button" className="h-10" onClick={commit} disabled={!canCommit}>
              {mode === 'replace' ? 'Replace menu' : 'Import'}
              {canCommit && counts ? ` (${work})` : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
