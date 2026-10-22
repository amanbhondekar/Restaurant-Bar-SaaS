import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { History, Loader2, Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { explainError, hubGet, hubSend } from './api';
import { ConfirmDialog, EmptyState, Field, ListSkeleton, NativeSelect, Notice, TextInput } from './ui';
import {
  ADJUSTMENTS, LEVELS, UNIT_NAMES, afterAdjustment, blankIngredient, blankLine, describeMovement, dishesOutOfStock,
  formatQty, ingredientToForm, outOfStockLine, recipeSubjects, recipeSummary, recipeToExtras, recipeToLines, subjectKey, summaryLine,
  validateAdjustment, validateIngredientForm, validateRecipe
} from './lib/inventory';
import { formatWhen } from './lib/plan';

// Stock and recipes for reception (M2 · inventory). The hub owns the figures and takes ingredients
// out as orders arrive; this is where reception sets up what a dish uses, records deliveries and
// waste, and corrects a count. All wording and arithmetic live in ./lib/inventory.
//
// A dish that cannot be made from what is on hand is flagged by the hub on every menu by itself, and
// comes back by itself when stock does. Nothing here switches a dish off.

const levelBadge = level => {
  const { label, tone } = LEVELS[level] || LEVELS.ok;
  return (
    <Badge variant="outline" style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` }}>
      {label}
    </Badge>
  );
};

/** A small form in a dialog: a title, a body, and Cancel / confirm. */
function FormDialog({ open, title, description, confirmLabel, busy, canConfirm = true, onConfirm, onCancel, children }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onCancel(); }}>
      <DialogContent className="max-w-lg" showCloseButton={false}>
        <form onSubmit={e => { e.preventDefault(); if (canConfirm && !busy) onConfirm(); }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="flex flex-col gap-3 py-3">{children}</div>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button type="submit" className="h-10" disabled={busy || !canConfirm}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IngredientDialog({ editing, ingredients, onSave, onCancel, busy, serverError }) {
  const [form, setForm] = useState(() => (editing.id ? ingredientToForm(editing) : blankIngredient()));
  const [showErrors, setShowErrors] = useState(false);
  const isEdit = Boolean(editing.id);
  const others = ingredients.filter(i => i.id !== editing.id).map(i => i.name);
  const { errors, payload } = validateIngredientForm(form, { editing: isEdit, others });
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));
  const err = key => (showErrors ? errors[key] : undefined);

  return (
    <FormDialog
      open
      title={isEdit ? `Edit ${editing.name}` : 'Add an ingredient'}
      description={isEdit ? 'To change how much is on hand, record a delivery, waste or a count instead, so the history says why.' : 'Anything the kitchen counts and cooks with.'}
      confirmLabel={isEdit ? 'Save' : 'Add ingredient'}
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => { setShowErrors(true); if (Object.keys(errors).length === 0) onSave(payload); }}
    >
      <Field label="Name" htmlFor="ing-name" error={err('name')}>
        <TextInput id="ing-name" value={form.name} onChange={set('name')} maxLength={80} invalid={Boolean(err('name'))} autoFocus />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Counted in" htmlFor="ing-unit" hint="Recipes use this same unit.">
          <NativeSelect id="ing-unit" value={form.unit} onChange={set('unit')}>
            {Object.entries(UNIT_NAMES).map(([u, label]) => <option key={u} value={u}>{label}</option>)}
          </NativeSelect>
        </Field>
        {!isEdit && (
          <Field label="On hand now" htmlFor="ing-have" error={err('on_hand')} hint="Optional. You can record it later.">
            <TextInput id="ing-have" inputMode="decimal" value={form.on_hand} onChange={set('on_hand')} invalid={Boolean(err('on_hand'))} />
          </Field>
        )}
      </div>
      <Field label="Warn me when it gets low" htmlFor="ing-low" error={err('low_at')} hint="Optional. Leave empty for no warning.">
        <TextInput id="ing-low" inputMode="decimal" value={form.low_at} onChange={set('low_at')} invalid={Boolean(err('low_at'))} />
      </Field>
      {serverError && <Notice tone="error">{serverError}</Notice>}
    </FormDialog>
  );
}

function AdjustDialog({ kind, ingredient, onSave, onCancel, busy, serverError }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const spec = ADJUSTMENTS[kind];
  const check = validateAdjustment(kind, text, ingredient);
  const after = check.ok ? afterAdjustment(kind, check.value, ingredient) : null;

  return (
    <FormDialog
      open
      title={`${spec.title}: ${ingredient.name}`}
      description={`On hand now: ${formatQty(ingredient.on_hand, ingredient.unit)}.`}
      confirmLabel={spec.verb}
      busy={busy}
      canConfirm={check.ok}
      onCancel={onCancel}
      onConfirm={() => onSave({ kind, qty: check.value, ...(note.trim() ? { note: note.trim() } : {}) })}
    >
      <Field label={`${spec.placeholder} (${ingredient.unit})`} htmlFor="adj-qty" error={touched && !check.ok ? check.error : undefined} hint={spec.hint}>
        <TextInput id="adj-qty" inputMode="decimal" value={text} autoFocus onChange={e => { setText(e.target.value); setTouched(true); }} invalid={touched && !check.ok} />
      </Field>
      <Field label="Note (optional)" htmlFor="adj-note">
        <TextInput id="adj-note" value={note} onChange={e => setNote(e.target.value)} maxLength={200} placeholder={kind === 'receive' ? 'Supplier, bill number…' : kind === 'waste' ? 'Why…' : ''} />
      </Field>
      {check.ok && <p className="text-sm text-muted-foreground" aria-live="polite">After this: <strong className="text-foreground">{formatQty(after, ingredient.unit)}</strong> on hand.</p>}
      {serverError && <Notice tone="error">{serverError}</Notice>}
    </FormDialog>
  );
}

function HistoryDialog({ ingredient, onClose }) {
  const [moves, setMoves] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    hubGet(`/admin/inventory/movements?item_id=${encodeURIComponent(ingredient.id)}&limit=50`)
      .then(d => { if (live) setMoves(d.movements); }, e => { if (live) setError(e); });
    return () => { live = false; };
  }, [ingredient.id]);

  return (
    <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>History: {ingredient.name}</DialogTitle>
          <DialogDescription>The most recent changes, newest first.</DialogDescription>
        </DialogHeader>
        <div className="max-h-96 overflow-y-auto">
          {error ? <Notice tone="error">{explainError(error)}</Notice>
            : !moves ? <ListSkeleton rows={3} />
              : moves.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">Nothing recorded yet.</p>
                : (
                  <ul className="flex flex-col divide-y divide-border">
                    {moves.map(m => {
                      const d = describeMovement(m, ingredient.unit);
                      return (
                        <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-sm">
                          <span className="font-medium">{d.reason}</span>
                          <span className="tabular-nums">{d.change} <span className="text-muted-foreground">→ {d.after}</span></span>
                          <span className="basis-full text-xs text-muted-foreground">{formatWhen(d.at)}{d.detail ? ` · ${d.detail}` : ''}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
        </div>
        <DialogFooter><Button className="h-10" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// One list of ingredient rows: the dish's own, or one extra's. The base list keeps its original labels
// ("Ingredient 1") so a screen reader hears what it always did; an extra's say which extra they belong to.
function RecipeLines({ lines, setLines, ingredients, errors, showErrors, label = '' }) {
  const byId = new Map(ingredients.map(i => [i.id, i]));
  const edit = (i, patch) => setLines(ls => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const suffix = label ? ` for ${label}` : '';
  return (
    <>
      {lines.map((l, i) => {
        const ing = byId.get(l.inventory_item_id);
        const e = showErrors ? errors?.[i] : undefined;
        return (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-start gap-2">
            <Field error={e?.ingredient}>
              <NativeSelect aria-label={`Ingredient ${i + 1}${suffix}`} value={l.inventory_item_id} onChange={ev => edit(i, { inventory_item_id: ev.target.value })} invalid={Boolean(e?.ingredient)}>
                <option value="">Choose…</option>
                {ingredients.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </NativeSelect>
            </Field>
            <Field error={e?.qty}>
              <div className="flex items-center gap-1.5">
                <TextInput aria-label={`Quantity ${i + 1}${suffix}`} inputMode="decimal" value={l.qty} onChange={ev => edit(i, { qty: ev.target.value })} invalid={Boolean(e?.qty)} />
                <span className="w-8 text-xs text-muted-foreground">{ing?.unit ?? ''}</span>
              </div>
            </Field>
            <Button type="button" variant="outline" className="h-10" aria-label={`Remove ingredient ${i + 1}${suffix}`} onClick={() => setLines(ls => ls.filter((_, n) => n !== i))}>
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      <div>
        <Button type="button" variant="outline" className="h-9" aria-label={label ? `Add ingredient${suffix}` : undefined} onClick={() => setLines(ls => [...ls, blankLine()])}>
          <Plus className="size-4" aria-hidden="true" />Add ingredient
        </Button>
      </div>
    </>
  );
}

function RecipeDialog({ subjects, ingredients, existing, preset, onSave, onCancel, busy, serverError }) {
  const [subjectId, setSubjectId] = useState(preset?.key ?? '');
  const recipeFor = key => existing.find(r => subjectKey(r.item_id, r.variant_id) === key);
  const [lines, setLines] = useState(() => (preset && recipeFor(preset.key) ? recipeToLines(recipeFor(preset.key)) : [blankLine()]));
  // Each extra's own rows, { 'group|option': [rows] }. Only extras that already use stock start open.
  const [extras, setExtras] = useState(() => (preset && recipeFor(preset.key) ? recipeToExtras(recipeFor(preset.key)) : {}));
  const [showErrors, setShowErrors] = useState(false);
  const subject = subjects.find(s => s.key === subjectId);
  const offered = subject?.extras ?? [];
  const { errors, extraErrors, payload } = validateRecipe(lines, extras, offered, ingredients);
  const anyError = Object.keys(errors).length > 0 || Object.keys(extraErrors).length > 0;
  // Nothing listed anywhere: saving that removes the recipe, which is worth saying before it happens.
  const noRows = lines.length === 0 && offered.every(x => (extras[x.key] ?? []).length === 0);

  const pick = key => {
    setSubjectId(key);
    const r = recipeFor(key);
    setLines(r ? recipeToLines(r) : [blankLine()]);
    setExtras(r ? recipeToExtras(r) : {});
    setShowErrors(false);
  };
  const setExtraRows = (key, update) => setExtras(all => ({ ...all, [key]: typeof update === 'function' ? update(all[key] ?? []) : update }));

  return (
    <FormDialog
      open
      title={preset ? `Recipe: ${preset.label}` : 'Set up a recipe'}
      description="What ONE portion uses. Orders take this out of stock, and the dish is marked out of stock when there is not enough for one portion."
      confirmLabel="Save recipe"
      busy={busy}
      canConfirm={Boolean(subject)}
      onCancel={onCancel}
      onConfirm={() => {
        setShowErrors(true);
        if (!anyError) onSave({ item_id: subject.item_id, ...(subject.variant_id ? { variant_id: subject.variant_id } : {}), lines: payload });
      }}
    >
      <Field label="Dish" htmlFor="rec-subject" hint={subject ? undefined : 'Choose the dish, or one size of it.'}>
        <NativeSelect id="rec-subject" value={subjectId} disabled={Boolean(preset)} onChange={e => pick(e.target.value)}>
          <option value="">Choose a dish…</option>
          {subjects.map(s => <option key={s.key} value={s.key}>{s.label}{recipeFor(s.key) ? ' (has a recipe)' : ''}</option>)}
        </NativeSelect>
      </Field>

      {subject && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Uses, per portion</legend>
          <RecipeLines lines={lines} setLines={setLines} ingredients={ingredients} errors={errors} showErrors={showErrors} />
          {showErrors && errors.form && <p className="text-xs text-destructive">{errors.form}</p>}
          {noRows && recipeFor(subject.key) && (
            <Notice tone="warning">Saving with no ingredients removes this recipe, and the dish stops being tracked.</Notice>
          )}
        </fieldset>
      )}

      {offered.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Extras</legend>
          <p className="text-xs text-muted-foreground">
            What a choice adds, on top of the above, for each portion that picks it. Leave it empty and the choice uses no stock.
          </p>
          {offered.map(x => {
            const rows = extras[x.key] ?? [];
            return (
              <details key={x.key} open={rows.length > 0} className="rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">
                  {x.label}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{x.group_label}</span>
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <RecipeLines
                    lines={rows}
                    setLines={update => setExtraRows(x.key, update)}
                    ingredients={ingredients}
                    errors={extraErrors[x.key]}
                    showErrors={showErrors}
                    label={x.label}
                  />
                </div>
              </details>
            );
          })}
        </fieldset>
      )}
      {serverError && <Notice tone="error">{serverError}</Notice>}
    </FormDialog>
  );
}

export function InventoryTab({ menu, notify }) {
  const [data, setData] = useState(null);
  const [liveMenu, setLiveMenu] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('stock');
  const [dialog, setDialog] = useState(null);     // { type, ... }
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [removing, setRemoving] = useState(null);

  const load = useCallback(async () => {
    try {
      const [inv, shown] = await Promise.all([hubGet('/admin/inventory'), hubGet('/menu').catch(() => null)]);
      setData(inv);
      setLiveMenu(shown);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const ingredients = data?.items ?? [];
  // Recipes are written against the dishes on the menu. This tab's own read is the fresher one (and
  // carries the hub's stock flags); the page's copy is the fallback if that read failed.
  const subjects = useMemo(() => recipeSubjects(liveMenu?.items ?? menu?.items ?? []), [menu, liveMenu]);
  const outDishes = useMemo(() => dishesOutOfStock(liveMenu?.items ?? []), [liveMenu]);

  const close = () => { setDialog(null); setServerError(null); };

  /** Run a write, then reload. A refusal stays in the dialog with the hub's own words. */
  const run = async (send, done) => {
    setBusy(true);
    setServerError(null);
    try {
      await send();
      close();
      setRemoving(null);
      if (done) notify(done);
      await load();
    } catch (e) {
      setServerError(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return <Notice tone="error" title="Could not load stock" action={<Button className="h-10" onClick={load}>Try again</Button>}>{explainError(error)}</Notice>;
  }
  if (!data) return <ListSkeleton rows={4} className="pt-2" />;

  const recipes = data.recipes;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Stock &amp; recipes</div>
          <div className="mt-1 text-sm" aria-live="polite">{summaryLine(data.summary)}</div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {[['stock', 'Stock'], ['recipes', 'Recipes']].map(([id, label]) => (
            <Button key={id} type="button" variant={view === id ? 'default' : 'outline'} className="h-10" aria-pressed={view === id} onClick={() => setView(id)}>{label}</Button>
          ))}
        </div>
      </div>

      {outDishes.length > 0 && (
        <Notice tone="warning" title="Out of stock right now">
          {outOfStockLine(outDishes)} They come back on their own when you record a delivery.
        </Notice>
      )}

      {view === 'stock' && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="stock-h">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="stock-h" className="typography-title-md">Ingredients</h2>
            <Button className="h-10" onClick={() => setDialog({ type: 'ingredient', editing: {} })}><Plus className="size-4" aria-hidden="true" />Add ingredient</Button>
          </div>
          {ingredients.length === 0 ? (
            <EmptyState icon={Package} title="No ingredients yet">
              Add what the kitchen counts, then say which dishes use it. Dishes without a recipe are never held up by stock.
            </EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {ingredients.map(i => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold">{i.name}</span>
                      {levelBadge(i.level)}
                    </div>
                    <div className="text-sm tabular-nums text-muted-foreground">
                      {formatQty(i.on_hand, i.unit)} on hand{i.low_at > 0 ? ` · warns at ${formatQty(i.low_at, i.unit)}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" className="h-9" onClick={() => setDialog({ type: 'adjust', kind: 'receive', ingredient: i })}>Delivery</Button>
                    <Button variant="outline" className="h-9" onClick={() => setDialog({ type: 'adjust', kind: 'waste', ingredient: i })}>Waste</Button>
                    <Button variant="outline" className="h-9" onClick={() => setDialog({ type: 'adjust', kind: 'count', ingredient: i })}>Count</Button>
                    <Button variant="outline" className="h-9" aria-label={`History of ${i.name}`} onClick={() => setDialog({ type: 'history', ingredient: i })}><History className="size-4" aria-hidden="true" /></Button>
                    <Button variant="outline" className="h-9" aria-label={`Edit ${i.name}`} onClick={() => setDialog({ type: 'ingredient', editing: i })}><Pencil className="size-4" aria-hidden="true" /></Button>
                    <Button variant="outline" className="h-9" aria-label={`Delete ${i.name}`} onClick={() => setRemoving(i)}><Trash2 className="size-4" aria-hidden="true" /></Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {view === 'recipes' && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="rec-h">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="rec-h" className="typography-title-md">Recipes</h2>
            <Button className="h-10" disabled={ingredients.length === 0} onClick={() => setDialog({ type: 'recipe', preset: null })}><Plus className="size-4" aria-hidden="true" />Set up a recipe</Button>
          </div>
          {ingredients.length === 0 && <p className="text-sm text-muted-foreground">Add some ingredients first, then say which dishes use them.</p>}
          {ingredients.length > 0 && recipes.length === 0 && (
            <EmptyState icon={Package} title="No recipes yet">A dish with no recipe is not tracked: it never runs out and is never held up.</EmptyState>
          )}
          {recipes.length > 0 && (
            <ul className="flex flex-col divide-y divide-border">
              {recipes.map(r => {
                const subject = subjects.find(s => s.key === subjectKey(r.item_id, r.variant_id));
                const label = subject?.label ?? r.item_name ?? 'A dish that is no longer on the menu';
                return (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-semibold">{label}</span>
                        {!subject && <Badge variant="outline">Not on the menu</Badge>}
                      </div>
                      <div className="text-sm text-muted-foreground">{recipeSummary(r, ingredients, subject?.extras)}</div>
                    </div>
                    {subject && <Button variant="outline" className="h-9" aria-label={`Edit the recipe for ${label}`} onClick={() => setDialog({ type: 'recipe', preset: subject })}><Pencil className="size-4" aria-hidden="true" />Edit</Button>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {dialog?.type === 'ingredient' && (
        <IngredientDialog
          editing={dialog.editing}
          ingredients={ingredients}
          busy={busy}
          serverError={serverError}
          onCancel={close}
          onSave={payload => (dialog.editing.id
            ? run(() => hubSend('PUT', `/admin/inventory/items/${encodeURIComponent(dialog.editing.id)}`, { item: payload }), `${payload.name} saved.`)
            : run(() => hubSend('POST', '/admin/inventory/items', { item: payload }), `${payload.name} added.`))}
        />
      )}
      {dialog?.type === 'adjust' && (
        <AdjustDialog
          kind={dialog.kind}
          ingredient={dialog.ingredient}
          busy={busy}
          serverError={serverError}
          onCancel={close}
          onSave={body => run(() => hubSend('POST', `/admin/inventory/items/${encodeURIComponent(dialog.ingredient.id)}/adjust`, body), `${dialog.ingredient.name} updated.`)}
        />
      )}
      {dialog?.type === 'history' && <HistoryDialog ingredient={dialog.ingredient} onClose={close} />}
      {dialog?.type === 'recipe' && (
        <RecipeDialog
          subjects={subjects}
          ingredients={ingredients}
          existing={recipes}
          preset={dialog.preset}
          busy={busy}
          serverError={serverError}
          onCancel={close}
          onSave={body => run(() => hubSend('PUT', '/admin/inventory/recipes', body), body.lines.length ? 'Recipe saved.' : 'Recipe removed.')}
        />
      )}

      <ConfirmDialog
        open={Boolean(removing)}
        title={`Delete ${removing?.name ?? ''}?`}
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => { setRemoving(null); setServerError(null); }}
        onConfirm={() => run(() => hubSend('DELETE', `/admin/inventory/items/${encodeURIComponent(removing.id)}`), `${removing.name} deleted.`)}
      >
        {serverError ? serverError : 'Its history is deleted with it. An ingredient a recipe uses cannot be deleted until it is taken out of that recipe.'}
      </ConfirmDialog>
    </div>
  );
}
