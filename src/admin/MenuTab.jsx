import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Search, Trash2, Upload, UtensilsCrossed } from 'lucide-react';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { VegBadge } from '@/components/VegBadge';
import { explainError, hubSend } from './api';
import { ConfirmDialog, EmptyState, Field, ListSkeleton, Notice, TextInput, formatPrice, useLastValue } from './ui';
import { ItemEditor } from './ItemEditor';
import { ImportDialog } from './ImportDialog';

// The Menu tab: a category rail beside the item table. Every action is one write to the hub followed
// by a fresh read of the menu (the hub's answer carries only the new revision), and writes are
// serialised by `busy` so each one uses the revision the previous one produced.

const ALL = '__all__';
const norm = s => String(s ?? '').trim().toLowerCase();

function priceLabel(item) {
  const prices = (item.variants || []).map(v => Number(v.price)).filter(Number.isFinite);
  if (prices.length === 0) return formatPrice(item.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? formatPrice(lo) : `${formatPrice(lo)}–${formatPrice(hi)}`;
}

const railButton = selected => cn(
  'flex h-10 shrink-0 items-center justify-between gap-3 rounded-lg border px-3 text-left text-sm outline-none transition-colors',
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
  selected ? 'border-primary/50 bg-accent font-medium text-accent-foreground' : 'border-border bg-card hover:bg-muted'
);

export function MenuTab({ menu, error, onRetry, onReload, onStale, notify }) {
  const [selected, setSelected] = useState(ALL);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // { item } (item null for a new one)
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [renaming, setRenaming] = useState(null); // { from, to, error }
  const [deletingCategory, setDeletingCategory] = useState(null);
  const deletingShown = useLastValue(deletingCategory);
  const renamingShown = useLastValue(renaming);
  const [newCategory, setNewCategory] = useState('');
  const [newCategoryError, setNewCategoryError] = useState('');

  const categories = menu?.categories ?? [];
  const items = menu?.items ?? [];
  const counts = useMemo(() => {
    const byCategory = new Map();
    for (const item of items) byCategory.set(norm(item.category), (byCategory.get(norm(item.category)) ?? 0) + 1);
    return byCategory;
  }, [items]);
  const countOf = name => counts.get(norm(name)) ?? 0;
  const current = selected === ALL || categories.includes(selected) ? selected : ALL;
  const q = norm(query);
  const visible = useMemo(
    () => items.filter(i => (q ? norm(i.name).includes(q) || norm(i.category).includes(q) : current === ALL || norm(i.category) === norm(current))),
    [items, q, current]
  );

  if (!menu) {
    return error ? (
      <Notice tone="error" title="The menu could not be loaded" action={<Button className="h-10" onClick={onRetry}>Retry</Button>}>
        {explainError(error)}
      </Notice>
    ) : (
      <div className="grid gap-4 md:grid-cols-[17rem_minmax(0,1fr)]">
        <ListSkeleton rows={6} />
        <ListSkeleton rows={8} />
      </div>
    );
  }

  if (menu.uninitialized) {
    return (
      <Notice tone="warning" title="This hub has no menu yet">
        The hub has not downloaded your restaurant&apos;s menu. Connect it to the internet once, give it a minute, then reload this page. Editing is switched off until then.
      </Notice>
    );
  }

  // One write, then a fresh read. A 409 STALE_REVISION means the hub moved on: the page shows its reload banner.
  const write = async (method, path, body, doneMessage) => {
    setBusy(true);
    setActionError(null);
    try {
      await hubSend(method, path, body);
      await onReload();
      if (doneMessage) notify(doneMessage);
      return true;
    } catch (failure) {
      if (failure.code === 'STALE_REVISION') onStale();
      else setActionError(explainError(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleAvailable = item => write(
    'PUT',
    `/admin/menu/items/${encodeURIComponent(item.id)}`,
    { base_revision: menu.revision, item: { available: item.available === false } },
    item.available === false ? `${item.name} is available again.` : `${item.name} is 86’d.`
  );

  const submitNewCategory = async event => {
    event.preventDefault();
    const name = newCategory.trim();
    if (!name) return setNewCategoryError('Type a category name.');
    if (name.length > 60) return setNewCategoryError('Use at most 60 characters.');
    if (categories.some(c => norm(c) === norm(name))) return setNewCategoryError('That category already exists.');
    setNewCategoryError('');
    if (await write('POST', '/admin/menu/categories', { base_revision: menu.revision, name }, `Added category “${name}”.`)) {
      setNewCategory('');
      setSelected(name);
    }
    return undefined;
  };

  const submitRename = async event => {
    event.preventDefault();
    const { from } = renaming;
    const to = renaming.to.trim();
    let problem = '';
    if (!to) problem = 'Type a name.';
    else if (to.length > 60) problem = 'Use at most 60 characters.';
    else if (categories.some(c => c !== from && norm(c) === norm(to))) problem = 'Another category already has that name.';
    if (problem) return setRenaming({ ...renaming, error: problem });
    if (to === from) return setRenaming(null);
    const done = await write('PUT', '/admin/menu/categories', { base_revision: menu.revision, from, to }, `Renamed to “${to}”.`);
    setRenaming(null);
    if (done) setSelected(to);
    return undefined;
  };

  const moveCategory = delta => {
    const from = categories.indexOf(current);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= categories.length) return;
    const names = [...categories];
    [names[from], names[to]] = [names[to], names[from]];
    write('PUT', '/admin/menu/categories/order', { base_revision: menu.revision, names });
  };

  const deleteCategory = async () => {
    const name = deletingCategory;
    const done = await write(
      'DELETE',
      `/admin/menu/categories?name=${encodeURIComponent(name)}&base_revision=${menu.revision}`,
      undefined,
      `Deleted category “${name}”.`
    );
    setDeletingCategory(null);
    if (done) setSelected(ALL);
  };

  const onItemSaved = async message => {
    await onReload();
    notify(message);
    setEditing(null);
  };

  const onImported = async () => {
    await onReload();
    notify('Menu imported.');
  };

  const position = categories.indexOf(current);
  const heading = q ? `Results for “${query.trim()}”` : current === ALL ? 'All items' : current;

  return (
    <div className="flex flex-col gap-4">
      {error && <Notice tone="error" action={<Button className="h-10" onClick={onRetry}>Retry</Button>}>{explainError(error)}</Notice>}
      {actionError && (
        <Notice tone="error" action={<Button variant="outline" className="h-10" onClick={() => setActionError(null)}>Dismiss</Button>}>
          {actionError}
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-3" aria-label="Categories">
          <nav className="flex gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0" aria-label="Menu categories">
            <button type="button" className={railButton(current === ALL)} aria-pressed={current === ALL} onClick={() => setSelected(ALL)}>
              <span>All items</span>
              <span className="text-xs text-muted-foreground">{items.length}</span>
            </button>
            {categories.map(name => (
              <button key={name} type="button" className={railButton(current === name)} aria-pressed={current === name} onClick={() => setSelected(name)}>
                <span className="truncate">{name}</span>
                <span className="text-xs text-muted-foreground">{countOf(name)}</span>
              </button>
            ))}
          </nav>

          {current !== ALL && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Actions for ${current}`}>
              <Button type="button" variant="outline" size="icon" className="size-10" aria-label="Move category up" title="Move up" disabled={busy || position <= 0} onClick={() => moveCategory(-1)}><ArrowUp aria-hidden="true" /></Button>
              <Button type="button" variant="outline" size="icon" className="size-10" aria-label="Move category down" title="Move down" disabled={busy || position < 0 || position >= categories.length - 1} onClick={() => moveCategory(1)}><ArrowDown aria-hidden="true" /></Button>
              <Button type="button" variant="outline" className="h-10" disabled={busy} onClick={() => setRenaming({ from: current, to: current, error: '' })}><Pencil aria-hidden="true" /> Rename</Button>
              <Button
                type="button"
                variant="outline"
                className="h-10"
                disabled={busy || countOf(current) > 0}
                title={countOf(current) > 0 ? 'Move or delete its items first' : 'Delete this empty category'}
                onClick={() => setDeletingCategory(current)}
              ><Trash2 aria-hidden="true" /> Delete</Button>
            </div>
          )}

          <form onSubmit={submitNewCategory} className="flex flex-col gap-1.5" noValidate>
            <div className="flex gap-2">
              <TextInput aria-label="New category name" placeholder="New category" value={newCategory} onChange={e => setNewCategory(e.target.value)} invalid={Boolean(newCategoryError)} autoComplete="off" />
              <Button type="submit" variant="outline" className="h-10" disabled={busy}><Plus aria-hidden="true" /> Add</Button>
            </div>
            {newCategoryError && <p className="text-xs text-destructive">{newCategoryError}</p>}
          </form>
        </aside>

        <section className="flex min-w-0 flex-col gap-3" aria-label="Items">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <TextInput type="search" aria-label="Search items" placeholder="Search items" value={query} onChange={e => setQuery(e.target.value)} className="pl-9" autoComplete="off" />
            </div>
            <Button type="button" variant="outline" className="h-10" disabled={busy} onClick={() => setImporting(true)}><Upload aria-hidden="true" /> Import menu</Button>
            <Button type="button" className="h-10" disabled={busy} onClick={() => setEditing({ item: null })}><Plus aria-hidden="true" /> Add item</Button>
          </div>

          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-heading text-base font-medium">{heading}</h2>
            <span className="text-xs text-muted-foreground">{visible.length} {visible.length === 1 ? 'item' : 'items'}{q ? ', all categories' : ''}</span>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={UtensilsCrossed}
              title={q ? 'No items match your search' : items.length === 0 ? 'The menu is empty' : 'No items in this category'}
              action={!q && (
                <Button type="button" className="h-10" onClick={() => setEditing({ item: null })}><Plus aria-hidden="true" /> Add item</Button>
              )}
            >
              {q ? 'Try a different spelling, or clear the search.' : items.length === 0 ? 'Add your first dish, or import a spreadsheet.' : 'Add an item here, or delete the category if you do not need it.'}
            </EmptyState>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="w-12 text-center">Veg</TableHead>
                    <TableHead className="hidden md:table-cell">Station</TableHead>
                    <TableHead>Available</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map(item => {
                    const available = item.available !== false;
                    const variants = item.variants?.length ?? 0;
                    const modifiers = item.modifier_groups?.length ?? 0;
                    const dayParts = item.day_parts?.length ?? 0;
                    return (
                      <TableRow key={item.id} className="cursor-pointer" onClick={() => setEditing({ item })}>
                        <TableCell className="max-w-[20rem] whitespace-normal">
                          <button
                            type="button"
                            onClick={() => setEditing({ item })}
                            className={cn('rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50', !available && 'text-muted-foreground line-through')}
                          >{item.name}</button>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {(q || current === ALL) && <span className="text-xs text-muted-foreground">{item.category}</span>}
                            {variants > 0 && <Badge variant="outline">{variants} {variants === 1 ? 'variant' : 'variants'}</Badge>}
                            {modifiers > 0 && <Badge variant="outline">{modifiers} {modifiers === 1 ? 'modifier group' : 'modifier groups'}</Badge>}
                            {dayParts > 0 && <Badge variant="outline">{dayParts} day-part {dayParts === 1 ? 'price' : 'prices'}</Badge>}
                            {/* Set by the hub from stock, not by a switch here: it clears itself on a delivery. */}
                            {item.stock_out && (
                              <Badge
                                variant="outline"
                                title="The kitchen has run out of something this needs. It comes back by itself when stock is recorded."
                                style={{ background: 'var(--status-rust-bg)', color: 'var(--status-rust-text)', borderColor: 'var(--status-rust-border)' }}
                              >Out of stock</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{priceLabel(item)}</TableCell>
                        <TableCell className="text-center"><span className="inline-flex" title={item.isVeg === false ? 'Non-veg' : 'Veg'}><VegBadge isVeg={item.isVeg !== false} /></span></TableCell>
                        <TableCell className="hidden capitalize md:table-cell">{item.station || <span className="text-muted-foreground">hot</span>}</TableCell>
                        <TableCell onClick={event => event.stopPropagation()}>
                          <label className="inline-flex h-10 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                            <Switch checked={available} disabled={busy} onCheckedChange={() => toggleAvailable(item)} aria-label={`${item.name}: ${available ? 'available' : '86’d'}`} />
                            <span className="w-14">{available ? 'Available' : '86’d'}</span>
                          </label>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>

      {editing && (
        <ItemEditor
          key={editing.item?.id ?? 'new'}
          item={editing.item}
          menu={menu}
          defaultCategory={current === ALL ? categories[0] ?? '' : current}
          onClose={() => setEditing(null)}
          onSaved={onItemSaved}
          onStale={onStale}
        />
      )}

      {importing && <ImportDialog menu={menu} onClose={() => setImporting(false)} onImported={onImported} />}

      <Dialog open={Boolean(renaming)} onOpenChange={open => { if (!open) setRenaming(null); }}>
        <DialogContent showCloseButton={false}>
          <form onSubmit={submitRename} className="grid gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Rename category</DialogTitle>
              <DialogDescription>Every item in “{renamingShown?.from}” moves to the new name.</DialogDescription>
            </DialogHeader>
            <Field label="Name" htmlFor="rename-category" error={renaming?.error}>
              <TextInput id="rename-category" value={renaming?.to ?? ''} onChange={e => setRenaming({ ...renaming, to: e.target.value, error: '' })} invalid={Boolean(renaming?.error)} autoComplete="off" autoFocus />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" className="h-10" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="submit" className="h-10" disabled={busy}>Rename</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deletingCategory)}
        title={`Delete “${deletingShown ?? ''}”?`}
        busy={busy}
        onCancel={() => setDeletingCategory(null)}
        onConfirm={deleteCategory}
      >
        The category is empty, so no items are affected.
      </ConfirmDialog>
    </div>
  );
}
