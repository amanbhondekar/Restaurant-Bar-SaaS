import React, { useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { VegBadge } from '@/components/VegBadge';
import { explainError, hubSend } from './api';
import { CloseButton, ConfirmDialog, Field, NativeSelect, Notice, TextInput } from './ui';
import { blankForm, changedPayload, createPayload, itemToForm, makeId, validateForm } from './lib/itemForm';

// The item editor: a sheet with the basics, variants, modifier groups and day-part prices of one item.
// A save sends only the keys that changed (hub merges them), so editing the price can never drop the
// variants, modifier groups or day-parts. The form logic lives in lib/itemForm.js.

const NEW_CATEGORY = '__new__';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // index = Date.getDay()

function Section({ title, description, error, children }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <div>
        <h3 className="font-heading text-base font-medium">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {children}
    </section>
  );
}

function AvailableSwitch({ checked, onChange, label }) {
  return (
    <label className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
      <span className="w-14">{checked ? 'Available' : '86’d'}</span>
    </label>
  );
}

const RemoveButton = ({ label, onClick }) => (
  <Button type="button" variant="ghost" size="icon" className="size-10 shrink-0 text-muted-foreground hover:text-destructive" aria-label={label} title={label} onClick={onClick}>
    <Trash2 aria-hidden="true" />
  </Button>
);

export function ItemEditor({ item, menu, defaultCategory, onClose, onSaved, onStale }) {
  const isNew = !item;
  const [initial] = useState(() => (item ? itemToForm(item) : blankForm(defaultCategory)));
  const [form, setForm] = useState(initial);
  const [newCategory, setNewCategory] = useState(() => menu.categories.length === 0);
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [topError, setTopError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'discard' | 'delete'
  const bodyRef = useRef(null);

  const checks = useMemo(() => validateForm(form, { original: item }), [form, item]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const hasChanges = isNew || Object.keys(changedPayload(item, form)).length > 0;
  const err = path => serverErrors[path] ?? (showErrors ? checks.errors[path] : undefined);
  // Every edit is applied to the latest form (never to a copy captured by an earlier render), so quick
  // successive clicks cannot undo each other. `change` and `patch` are either an object or a function
  // of the current form / row that returns one.
  const edit = change => setForm(prev => ({ ...prev, ...(typeof change === 'function' ? change(prev) : change) }));
  const editList = (key, index, patch) => setForm(prev => ({
    ...prev,
    [key]: prev[key].map((row, i) => (i === index ? { ...row, ...(typeof patch === 'function' ? patch(row) : patch) } : row))
  }));
  const removeFrom = (key, index) => setForm(prev => ({ ...prev, [key]: prev[key].filter((_, i) => i !== index) }));

  const categories = menu.categories;
  const categoryChoices = form.category === '' || categories.includes(form.category) ? categories : [...categories, form.category];

  const requestClose = () => { if (dirty && !saving) setConfirm('discard'); else onClose(); };

  const save = async () => {
    setShowErrors(true);
    setTopError(null);
    setServerErrors({});
    if (!checks.ok) {
      // Once the errors have rendered, take the user to the first one.
      setTimeout(() => bodyRef.current?.querySelector('[aria-invalid="true"]')?.focus(), 60);
      return;
    }
    const body = isNew ? createPayload(form) : changedPayload(item, form);
    if (Object.keys(body).length === 0) { onClose(); return; }

    setSaving(true);
    try {
      await hubSend(
        isNew ? 'POST' : 'PUT',
        isNew ? '/admin/menu/items' : `/admin/menu/items/${encodeURIComponent(item.id)}`,
        { base_revision: menu.revision, item: body }
      );
      await onSaved(`${isNew ? 'Added' : 'Saved'} “${form.name.trim()}”.`);
    } catch (error) {
      if (error.code === 'STALE_REVISION') {
        onStale();
        setTopError('The menu changed on the hub after you opened this item. Reload the page with the button at the top, then make the change again.');
      } else if (error.code === 'DUPLICATE_ITEM') {
        setServerErrors({ name: error.error });
      } else if (Array.isArray(error.errors) && error.errors.length > 0) {
        setServerErrors(Object.fromEntries(error.errors.map(e => [e.field, e.message])));
        setTopError('The hub did not accept some of these values. The messages are next to the fields.');
      } else {
        setTopError(explainError(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await hubSend('DELETE', `/admin/menu/items/${encodeURIComponent(item.id)}?base_revision=${menu.revision}`);
      await onSaved(`Deleted “${item.name}”.`);
    } catch (error) {
      setConfirm(null);
      if (error.code === 'STALE_REVISION') onStale();
      setTopError(error.code === 'STALE_REVISION'
        ? 'The menu changed on the hub after you opened this item. Reload the page with the button at the top.'
        : explainError(error));
    } finally {
      setSaving(false);
    }
  };

  const optionIds = prev => prev.modifier_groups.flatMap(g => g.options.map(o => o.id));
  const addVariant = () => edit(prev => ({ variants: [...prev.variants, { id: makeId('v', prev.variants.map(v => v.id)), label: '', price: '', available: true }] }));
  const addGroup = () => edit(prev => ({
    modifier_groups: [...prev.modifier_groups, {
      id: makeId('g', prev.modifier_groups.map(g => g.id)), label: '', min: '0', max: '1',
      options: [{ id: makeId('o', optionIds(prev)), label: '', price_delta: '0', available: true }]
    }]
  }));
  const addOption = gi => edit(prev => ({
    modifier_groups: prev.modifier_groups.map((g, i) => (i === gi
      ? { ...g, options: [...g.options, { id: makeId('o', optionIds(prev)), label: '', price_delta: '0', available: true }] }
      : g))
  }));
  const editOption = (gi, oi, patch) => editList('modifier_groups', gi, row => ({
    options: row.options.map((o, j) => (j === oi ? { ...o, ...patch } : o))
  }));
  const addDayPart = () => edit(prev => ({
    day_parts: [...prev.day_parts, { id: makeId('d', prev.day_parts.map(d => d.id)), label: '', starts_at: '', ends_at: '', days: [], price: '', variant_prices: {} }]
  }));
  const toggleDay = (di, day) => editList('day_parts', di, row => ({
    days: row.days.includes(day) ? row.days.filter(n => n !== day) : [...row.days, day]
  }));

  return (
    <Sheet open onOpenChange={open => { if (!open) requestClose(); }}>
      <SheetContent showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <CloseButton onClick={requestClose} />
        <SheetHeader className="border-b border-border p-4 pr-14">
          <SheetTitle>{isNew ? 'New item' : 'Edit item'}</SheetTitle>
          <SheetDescription>
            {isNew ? 'Add a dish to the menu.' : 'Only what you change is saved. Variants, modifier groups and day-part prices you do not touch stay as they are.'}
          </SheetDescription>
        </SheetHeader>

        <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          {topError && <Notice tone="error">{topError}</Notice>}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="item-name" error={err('name')} className="sm:col-span-2">
              <TextInput id="item-name" value={form.name} onChange={e => edit({ name: e.target.value })} invalid={Boolean(err('name'))} autoComplete="off" />
            </Field>

            <Field label="Category" htmlFor="item-category" error={err('category')}>
              {newCategory ? (
                <div className="flex gap-2">
                  <TextInput id="item-category" value={form.category} onChange={e => edit({ category: e.target.value })} placeholder="New category name" invalid={Boolean(err('category'))} autoComplete="off" />
                  {categories.length > 0 && (
                    <Button type="button" variant="outline" className="h-10" onClick={() => { setNewCategory(false); edit({ category: categories.includes(initial.category) ? initial.category : '' }); }}>Choose</Button>
                  )}
                </div>
              ) : (
                <NativeSelect
                  id="item-category"
                  value={form.category}
                  invalid={Boolean(err('category'))}
                  onChange={e => {
                    if (e.target.value === NEW_CATEGORY) { setNewCategory(true); edit({ category: '' }); } else edit({ category: e.target.value });
                  }}
                >
                  {form.category === '' && <option value="">Choose a category</option>}
                  {categoryChoices.map(c => <option key={c} value={c}>{c}</option>)}
                  <option value={NEW_CATEGORY}>New category…</option>
                </NativeSelect>
              )}
            </Field>

            <Field label="Price (₹)" htmlFor="item-price" error={err('price')} hint={form.variants.length > 0 ? 'Optional: with variants, orders use the variant prices.' : undefined}>
              <TextInput id="item-price" inputMode="decimal" value={form.price} onChange={e => edit({ price: e.target.value })} invalid={Boolean(err('price'))} placeholder="e.g. 120" autoComplete="off" />
            </Field>

            <Field label="Veg or non-veg" error={err('isVeg')}>
              <div role="radiogroup" aria-label="Veg or non-veg" className="flex gap-2">
                {[[true, 'Veg'], [false, 'Non-veg']].map(([value, text]) => (
                  <label
                    key={text}
                    className={cn(
                      'flex h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-input px-3 text-sm',
                      'has-checked:border-primary has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50',
                      err('isVeg') && 'border-destructive'
                    )}
                  >
                    <input type="radio" name="item-veg" className="sr-only" checked={form.isVeg === value} onChange={() => edit({ isVeg: value })} />
                    <VegBadge isVeg={value} />
                    {text}
                  </label>
                ))}
              </div>
            </Field>

            <Field label="Kitchen station" htmlFor="item-station" error={err('station')} hint="Where the order ticket prints.">
              <NativeSelect id="item-station" value={form.station} onChange={e => edit({ station: e.target.value })}>
                {initial.station === '' && <option value="">Default (hot kitchen)</option>}
                <option value="hot">Hot kitchen</option>
                <option value="cold">Cold line</option>
                <option value="bar">Bar</option>
              </NativeSelect>
            </Field>

            <Field label="Serving course" htmlFor="item-course" error={err('course')} hint="Used when a waiter serves an order in courses: 1 starters, 2 mains, 3 desserts.">
              <NativeSelect id="item-course" value={form.course} onChange={e => edit({ course: e.target.value })}>
                {initial.course === '' && <option value="">Default (course 1)</option>}
                <option value="1">Course 1: starters</option>
                <option value="2">Course 2: mains</option>
                <option value="3">Course 3: desserts</option>
                <option value="4">Course 4</option>
                <option value="5">Course 5</option>
              </NativeSelect>
            </Field>

            <div className="flex items-center sm:col-span-2">
              <AvailableSwitch checked={form.available} onChange={available => edit({ available })} label="Available" />
              <span className="text-xs text-muted-foreground">Switch off to 86 it: it stays on the menu but cannot be ordered.</span>
            </div>
          </div>

          <Section title="Variants" description="Sizes or portions, such as Half and Full. The guest picks one, and its price is used." error={serverErrors.variants}>
            {form.variants.length === 0 && <p className="text-sm text-muted-foreground">No variants: the item has one price.</p>}
            {form.variants.map((v, i) => (
              <div key={v.id} className="flex flex-wrap items-start gap-2">
                <Field className="flex-1 basis-40" error={err(`variants.${i}.label`)}>
                  <TextInput aria-label={`Variant ${i + 1} name`} placeholder="Name, e.g. Half" value={v.label} onChange={e => editList('variants', i, { label: e.target.value })} invalid={Boolean(err(`variants.${i}.label`))} autoComplete="off" />
                </Field>
                <Field className="w-28" error={err(`variants.${i}.price`)}>
                  <TextInput aria-label={`Variant ${i + 1} price`} inputMode="decimal" placeholder="Price" value={v.price} onChange={e => editList('variants', i, { price: e.target.value })} invalid={Boolean(err(`variants.${i}.price`))} autoComplete="off" />
                </Field>
                <AvailableSwitch checked={v.available} onChange={available => editList('variants', i, { available })} label={`Variant ${i + 1} available`} />
                <RemoveButton label={`Remove variant ${i + 1}`} onClick={() => removeFrom('variants', i)} />
              </div>
            ))}
            <Button type="button" variant="outline" className="h-10 self-start" onClick={addVariant}><Plus aria-hidden="true" /> Add variant</Button>
          </Section>

          <Section title="Modifier groups" description="Extras and choices, such as spice level or add-ons. A minimum of 1 or more makes the guest choose." error={serverErrors.modifier_groups}>
            {form.modifier_groups.length === 0 && <p className="text-sm text-muted-foreground">No modifier groups.</p>}
            {form.modifier_groups.map((g, gi) => (
              <div key={g.id} className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <Field label="Group name" className="flex-1 basis-44" error={err(`modifier_groups.${gi}.label`)}>
                    <TextInput value={g.label} placeholder="e.g. Spice level" onChange={e => editList('modifier_groups', gi, { label: e.target.value })} invalid={Boolean(err(`modifier_groups.${gi}.label`))} autoComplete="off" />
                  </Field>
                  <Field label="Min" className="w-20" error={err(`modifier_groups.${gi}.min`)}>
                    <TextInput inputMode="numeric" value={g.min} onChange={e => editList('modifier_groups', gi, { min: e.target.value })} invalid={Boolean(err(`modifier_groups.${gi}.min`))} autoComplete="off" />
                  </Field>
                  <Field label="Max" className="w-20" error={err(`modifier_groups.${gi}.max`)}>
                    <TextInput inputMode="numeric" value={g.max} onChange={e => editList('modifier_groups', gi, { max: e.target.value })} invalid={Boolean(err(`modifier_groups.${gi}.max`))} autoComplete="off" />
                  </Field>
                  <div className="pt-[1.625rem]"><RemoveButton label={`Remove modifier group ${gi + 1}`} onClick={() => removeFrom('modifier_groups', gi)} /></div>
                </div>
                {err(`modifier_groups.${gi}.options`) && <p className="text-xs text-destructive">{err(`modifier_groups.${gi}.options`)}</p>}
                {g.options.map((o, oi) => (
                  <div key={o.id} className="flex flex-wrap items-start gap-2">
                    <Field className="flex-1 basis-36" error={err(`modifier_groups.${gi}.options.${oi}.label`)}>
                      <TextInput aria-label={`Group ${gi + 1} option ${oi + 1} name`} placeholder="Option, e.g. Extra cheese" value={o.label} onChange={e => editOption(gi, oi, { label: e.target.value })} invalid={Boolean(err(`modifier_groups.${gi}.options.${oi}.label`))} autoComplete="off" />
                    </Field>
                    <Field className="w-28" error={err(`modifier_groups.${gi}.options.${oi}.price_delta`)}>
                      <TextInput aria-label={`Group ${gi + 1} option ${oi + 1} extra price`} inputMode="decimal" placeholder="+ price" value={o.price_delta} onChange={e => editOption(gi, oi, { price_delta: e.target.value })} invalid={Boolean(err(`modifier_groups.${gi}.options.${oi}.price_delta`))} autoComplete="off" />
                    </Field>
                    <AvailableSwitch checked={o.available} onChange={available => editOption(gi, oi, { available })} label={`Group ${gi + 1} option ${oi + 1} available`} />
                    <RemoveButton
                      label={`Remove option ${oi + 1}`}
                      onClick={() => editList('modifier_groups', gi, row => ({ options: row.options.filter((_, j) => j !== oi) }))}
                    />
                  </div>
                ))}
                <Button type="button" variant="outline" className="h-10 self-start" onClick={() => addOption(gi)}><Plus aria-hidden="true" /> Add option</Button>
              </div>
            ))}
            <Button type="button" variant="outline" className="h-10 self-start" onClick={addGroup}><Plus aria-hidden="true" /> Add modifier group</Button>
          </Section>

          <Section title="Day-part prices" description="A different price during part of the day, such as a happy hour. A window past midnight (22:00 to 02:00) works too." error={serverErrors.day_parts}>
            {form.day_parts.length === 0 && <p className="text-sm text-muted-foreground">No day-part prices.</p>}
            {form.day_parts.map((d, di) => (
              <div key={d.id} className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <Field label="Window name" className="flex-1 basis-40" error={err(`day_parts.${di}.label`)}>
                    <TextInput value={d.label} placeholder="e.g. Happy hour" onChange={e => editList('day_parts', di, { label: e.target.value })} invalid={Boolean(err(`day_parts.${di}.label`))} autoComplete="off" />
                  </Field>
                  <Field label="From" className="w-32" error={err(`day_parts.${di}.starts_at`)}>
                    <TextInput type="time" value={d.starts_at} onChange={e => editList('day_parts', di, { starts_at: e.target.value })} invalid={Boolean(err(`day_parts.${di}.starts_at`))} />
                  </Field>
                  <Field label="To" className="w-32" error={err(`day_parts.${di}.ends_at`)}>
                    <TextInput type="time" value={d.ends_at} onChange={e => editList('day_parts', di, { ends_at: e.target.value })} invalid={Boolean(err(`day_parts.${di}.ends_at`))} />
                  </Field>
                  <div className="pt-[1.625rem]"><RemoveButton label={`Remove day-part ${di + 1}`} onClick={() => removeFrom('day_parts', di)} /></div>
                </div>
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1.5 text-sm font-medium">Days <span className="font-normal text-muted-foreground">(none selected means every day)</span></legend>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS.map((name, day) => (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={d.days.includes(day)}
                        onClick={() => toggleDay(di, day)}
                        className={cn(
                          'h-10 min-w-12 rounded-lg border border-input px-2 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
                          d.days.includes(day) ? 'border-primary bg-accent font-medium text-accent-foreground' : 'bg-background hover:bg-muted'
                        )}
                      >{name}</button>
                    ))}
                  </div>
                  {err(`day_parts.${di}.days`) && <p className="text-xs text-destructive">{err(`day_parts.${di}.days`)}</p>}
                </fieldset>
                <div className="flex flex-wrap items-start gap-2">
                  <Field label={form.variants.length > 0 ? 'One price for all sizes (₹)' : 'Price (₹)'} className="w-44" error={err(`day_parts.${di}.price`)}>
                    <TextInput inputMode="decimal" value={d.price} onChange={e => editList('day_parts', di, { price: e.target.value })} invalid={Boolean(err(`day_parts.${di}.price`))} placeholder="e.g. 80" autoComplete="off" />
                  </Field>
                  {form.variants.map((v, vi) => (
                    <Field key={v.id} label={`${v.label.trim() || `Variant ${vi + 1}`} (₹)`} className="w-32" error={err(`day_parts.${di}.variant_prices.${v.id}`)}>
                      <TextInput
                        inputMode="decimal"
                        value={d.variant_prices[v.id] ?? ''}
                        onChange={e => { const { value } = e.target; editList('day_parts', di, row => ({ variant_prices: { ...row.variant_prices, [v.id]: value } })); }}
                        invalid={Boolean(err(`day_parts.${di}.variant_prices.${v.id}`))}
                        placeholder="optional"
                        autoComplete="off"
                      />
                    </Field>
                  ))}
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" className="h-10 self-start" onClick={addDayPart}><Plus aria-hidden="true" /> Add day-part price</Button>
          </Section>
        </div>

        <SheetFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t border-border">
          {isNew ? <span /> : (
            <Button type="button" variant="destructive" className="h-10" onClick={() => setConfirm('delete')} disabled={saving}><Trash2 aria-hidden="true" /> Delete</Button>
          )}
          <div className="flex items-center gap-2">
            {showErrors && !checks.ok && <span className="text-xs text-destructive">Fix the highlighted fields.</span>}
            <Button type="button" variant="outline" className="h-10" onClick={requestClose} disabled={saving}>Cancel</Button>
            <Button type="button" className="h-10" onClick={save} disabled={saving || !hasChanges} title={hasChanges ? undefined : 'No changes to save'}>
              {saving && <Loader2 className="spin" aria-hidden="true" />}
              {isNew ? 'Add item' : 'Save changes'}
            </Button>
          </div>
        </SheetFooter>

        <ConfirmDialog
          open={confirm === 'discard'}
          title="Discard your changes?"
          confirmLabel="Discard"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); onClose(); }}
        >
          What you typed in this item will be lost.
        </ConfirmDialog>
        <ConfirmDialog
          open={confirm === 'delete'}
          title={`Delete “${item?.name ?? ''}”?`}
          busy={saving}
          onCancel={() => setConfirm(null)}
          onConfirm={remove}
        >
          It is removed from the menu for good. Bills that are already open keep their lines.
        </ConfirmDialog>
      </SheetContent>
    </Sheet>
  );
}
