import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromLayout, toPayload, addSection, renameSection, moveSection, deleteSection,
  addTable, renameTable, setCapacity, moveTableToSection, moveTableWithin, deleteTable,
  validateDraft, isDirty, tablesIn, orderedTables
} from '../../src/admin/lib/layoutDraft.js';
import { applyLayout } from '../lib/tablesAdmin.js';

// The local draft behind the Tables tab: edits pile up here and one PUT /admin/tables/layout commits them.

const layout = () => ({
  revision: 4,
  sections: ['Main Hall', 'AC Room', 'Patio'],
  tables: [
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
    { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 },
    { id: 3, name: 'T3', section: 'AC Room', capacity: 4 },
    { id: 4, name: 'T4', section: 'Main Hall', capacity: 6 }
  ]
});

const deepFreeze = o => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
};
const names = (draft, section) => tablesIn(draft, section).map(t => t.name);
const payloadNames = draft => toPayload(draft).tables.map(t => t.name);
const keyOf = (draft, name) => draft.tables.find(t => t.name === name).key;

// ---------------------------------------------------------------- draftFromLayout

test('draftFromLayout keeps the sections and tables, with a stable client key per table', () => {
  const draft = draftFromLayout(layout());
  assert.deepEqual(draft.sections, ['Main Hall', 'AC Room', 'Patio']);
  assert.deepEqual(draft.tables.map(t => t.key), ['id:1', 'id:2', 'id:3', 'id:4']);
  assert.deepEqual(draft.tables[1], { key: 'id:2', id: 2, name: 'T2', section: 'Main Hall', capacity: 4 });
});

test('draftFromLayout keeps string ids (cloud UUIDs) as they are', () => {
  const draft = draftFromLayout({ sections: ['A'], tables: [{ id: 'b3f1-uuid', name: 'T1', section: 'A', capacity: 4 }] });
  assert.equal(draft.tables[0].key, 'id:b3f1-uuid');
  assert.equal(draft.tables[0].id, 'b3f1-uuid');
});

test('draftFromLayout adds a section a table uses but the list lacks, and names a blank one "Unsectioned" so no table is lost', () => {
  const draft = draftFromLayout({
    sections: ['Main Hall'],
    tables: [
      { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
      { id: 2, name: 'T2', section: 'Garden', capacity: 2 },
      { id: 3, name: 'T3', section: '', capacity: 2 },
      { id: 4, name: 'T4', capacity: 2 }
    ]
  });
  assert.deepEqual(draft.sections, ['Main Hall', 'Garden', 'Unsectioned']);
  assert.deepEqual(draft.tables.map(t => t.section), ['Main Hall', 'Garden', 'Unsectioned', 'Unsectioned']);
});

test('draftFromLayout copes with a missing or empty layout', () => {
  assert.deepEqual(draftFromLayout(undefined), { sections: [], tables: [] });
  assert.deepEqual(draftFromLayout({ tables: [] }), { sections: [], tables: [] });
});

// ---------------------------------------------------------------- toPayload

test('toPayload orders tables section by section in the sections order and keeps the order within a section', () => {
  const payload = toPayload(draftFromLayout(layout()));
  assert.deepEqual(payload.sections, ['Main Hall', 'AC Room', 'Patio']);
  // T4 sits after T3 (AC Room) in the flat list but belongs to Main Hall.
  assert.deepEqual(payload.tables.map(t => t.name), ['T1', 'T2', 'T4', 'T3']);
  assert.deepEqual(payload.tables[0], { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 });
});

test('orderedTables is the tables in the exact order toPayload sends them, so error rows can be found by payload index', () => {
  let draft = draftFromLayout(layout());
  draft = moveTableWithin(draft, 'id:4', -1);
  draft = addTable(draft, 'Patio');
  const ordered = orderedTables(draft);
  assert.deepEqual(ordered.map(t => t.name), toPayload(draft).tables.map(t => t.name));
  assert.deepEqual(ordered.map(t => t.key), ['id:1', 'id:4', 'id:2', 'id:3', 'new:1']);
  // a table in an unlisted section is still there, last
  const ghost = { sections: ['A'], tables: [{ key: 'id:1', id: 1, name: 'T1', section: 'Ghost', capacity: 2 }, { key: 'id:2', id: 2, name: 'T2', section: 'A', capacity: 2 }] };
  assert.deepEqual(orderedTables(ghost).map(t => t.key), ['id:2', 'id:1']);
});

test('toPayload gives new tables no id and trims names and sections', () => {
  let draft = draftFromLayout(layout());
  draft = addTable(draft, 'Patio');
  draft = renameTable(draft, 'new:1', '  Garden 1  ');
  draft = renameSection(draft, 'Patio', ' Terrace ');
  const payload = toPayload(draft);
  const added = payload.tables.find(t => t.name === 'Garden 1');
  assert.deepEqual(added, { name: 'Garden 1', section: 'Terrace', capacity: 4 });
  assert.ok(!('id' in added));
  assert.deepEqual(payload.sections, ['Main Hall', 'AC Room', 'Terrace']);
});

test('toPayload never drops a table whose section is missing from the list: the server gets to say no', () => {
  const draft = { sections: ['A'], tables: [{ key: 'id:1', id: 1, name: 'T1', section: 'Ghost', capacity: 2 }, { key: 'id:2', id: 2, name: 'T2', section: 'A', capacity: 2 }] };
  assert.deepEqual(toPayload(draft).tables.map(t => t.name), ['T2', 'T1']);
});

// ---------------------------------------------------------------- sections

test('addSection appends a section, with a unique default name', () => {
  let draft = draftFromLayout(layout());
  draft = addSection(draft);
  assert.deepEqual(draft.sections, ['Main Hall', 'AC Room', 'Patio', 'New section']);
  draft = addSection(draft);
  assert.equal(draft.sections.at(-1), 'New section 2');
  draft = addSection(draft, '  Rooftop ');
  assert.equal(draft.sections.at(-1), 'Rooftop');
  draft = addSection(draft, 'patio');
  assert.equal(draft.sections.at(-1), 'patio 2', 'a name that clashes case-insensitively is made unique');
});

test('renameSection renames it in place and retargets its tables', () => {
  const draft = renameSection(draftFromLayout(layout()), 'Main Hall', 'Dining');
  assert.deepEqual(draft.sections, ['Dining', 'AC Room', 'Patio']);
  assert.deepEqual(names(draft, 'Dining'), ['T1', 'T2', 'T4']);
  assert.deepEqual(names(draft, 'AC Room'), ['T3']);
});

test('renameSection is a no-op for an unknown section or a name another section already has, but a case change of its own name is fine', () => {
  const draft = draftFromLayout(layout());
  assert.equal(renameSection(draft, 'Nowhere', 'X'), draft);
  assert.equal(renameSection(draft, 'Patio', 'ac room'), draft);
  assert.equal(renameSection(draft, 'Patio', 'Patio'), draft);
  assert.deepEqual(renameSection(draft, 'Patio', 'patio').sections, ['Main Hall', 'AC Room', 'patio']);
});

test('moveSection moves a section up or down and stops at the ends', () => {
  const draft = draftFromLayout(layout());
  assert.deepEqual(moveSection(draft, 'Patio', -1).sections, ['Main Hall', 'Patio', 'AC Room']);
  assert.deepEqual(moveSection(draft, 'Main Hall', 1).sections, ['AC Room', 'Main Hall', 'Patio']);
  assert.equal(moveSection(draft, 'Main Hall', -1), draft);
  assert.equal(moveSection(draft, 'Patio', 1), draft);
  assert.equal(moveSection(draft, 'Nowhere', 1), draft);
});

test('deleteSection only deletes an empty section', () => {
  const draft = draftFromLayout(layout());
  assert.deepEqual(deleteSection(draft, 'Patio').sections, ['Main Hall', 'AC Room']);
  assert.equal(deleteSection(draft, 'Main Hall'), draft);
  assert.equal(deleteSection(draft, 'Nowhere'), draft);
});

// ---------------------------------------------------------------- tables

test('addTable appends at the end of the section with a unique default name, a new: key and 4 seats', () => {
  let draft = draftFromLayout(layout());
  draft = addTable(draft, 'Patio');
  draft = addTable(draft, 'Main Hall');
  assert.deepEqual(draft.tables.slice(-2).map(t => [t.key, t.name, t.section, t.capacity]), [
    ['new:1', 'T5', 'Patio', 4],
    ['new:2', 'T6', 'Main Hall', 4]
  ]);
  assert.ok(draft.tables.slice(-2).every(t => !('id' in t) || t.id === undefined));
  assert.deepEqual(names(draft, 'Main Hall'), ['T1', 'T2', 'T4', 'T6']);
});

test('addTable skips a default name that is taken, whatever its case, and ignores an unknown section', () => {
  let draft = draftFromLayout({ sections: ['A'], tables: [{ id: 1, name: 't2', section: 'A', capacity: 2 }, { id: 2, name: 'T3', section: 'A', capacity: 2 }] });
  draft = addTable(draft, 'A');
  assert.equal(draft.tables.at(-1).name, 'T4');
  assert.equal(addTable(draft, 'Nowhere'), draft);
});

test('addTable numbers its keys past the highest new: key even after a delete', () => {
  let draft = draftFromLayout(layout());
  draft = addTable(addTable(draft, 'Patio'), 'Patio'); // new:1, new:2
  draft = deleteTable(draft, 'new:1');
  draft = addTable(draft, 'Patio');
  assert.deepEqual(draft.tables.filter(t => t.key.startsWith('new:')).map(t => t.key), ['new:2', 'new:3']);
});

test('renameTable and setCapacity change one table and nothing else', () => {
  let draft = draftFromLayout(layout());
  draft = renameTable(draft, 'id:2', 'Window 2');
  draft = setCapacity(draft, 'id:2', 8);
  assert.deepEqual(draft.tables[1], { key: 'id:2', id: 2, name: 'Window 2', section: 'Main Hall', capacity: 8 });
  assert.deepEqual(draft.tables[0], { key: 'id:1', id: 1, name: 'T1', section: 'Main Hall', capacity: 2 });
  assert.equal(renameTable(draft, 'id:99', 'x'), draft);
  assert.equal(setCapacity(draft, 'id:99', 3), draft);
});

test('setCapacity turns text into a number and a blank into NaN, which validateDraft refuses', () => {
  let draft = setCapacity(draftFromLayout(layout()), 'id:1', '6');
  assert.equal(draft.tables[0].capacity, 6);
  draft = setCapacity(draft, 'id:1', '');
  assert.ok(Number.isNaN(draft.tables[0].capacity));
  assert.equal(validateDraft(draft).ok, false);
});

test('moveTableToSection puts the table at the end of the other section', () => {
  const draft = moveTableToSection(draftFromLayout(layout()), 'id:1', 'AC Room');
  assert.deepEqual(names(draft, 'AC Room'), ['T3', 'T1']);
  assert.deepEqual(names(draft, 'Main Hall'), ['T2', 'T4']);
  assert.equal(draft.tables.find(t => t.key === 'id:1').section, 'AC Room');
  assert.equal(moveTableToSection(draft, 'id:1', 'AC Room'), draft, 'already there');
  assert.equal(moveTableToSection(draft, 'id:1', 'Nowhere'), draft);
  assert.equal(moveTableToSection(draft, 'id:99', 'Patio'), draft);
});

test('moveTableWithin moves a table up or down inside its section only and stops at the ends', () => {
  const draft = draftFromLayout(layout());
  // T4 follows T3 (another section) in the flat list; only the Main Hall order may change.
  const up = moveTableWithin(draft, 'id:4', -1);
  assert.deepEqual(payloadNames(up), ['T1', 'T4', 'T2', 'T3']);
  assert.deepEqual(names(up, 'AC Room'), ['T3']);
  assert.deepEqual(payloadNames(moveTableWithin(draft, 'id:1', 1)), ['T2', 'T1', 'T4', 'T3']);
  assert.deepEqual(payloadNames(moveTableWithin(draft, 'id:1', 2)), ['T2', 'T4', 'T1', 'T3']);
  assert.equal(moveTableWithin(draft, 'id:1', -1), draft);
  assert.equal(moveTableWithin(draft, 'id:4', 1), draft);
  assert.equal(moveTableWithin(draft, 'id:3', 1), draft, 'a lone table has nowhere to go');
  assert.equal(moveTableWithin(draft, 'id:99', 1), draft);
});

test('deleteTable removes just that table', () => {
  const draft = deleteTable(draftFromLayout(layout()), 'id:2');
  assert.deepEqual(draft.tables.map(t => t.key), ['id:1', 'id:3', 'id:4']);
  assert.equal(deleteTable(draft, 'id:2'), draft);
});

test('no helper changes the draft it is given', () => {
  const draft = deepFreeze(draftFromLayout(layout()));
  const withNew = deepFreeze(addTable(draft, 'Patio'));
  for (const run of [
    () => addSection(draft, 'X'), () => renameSection(draft, 'Patio', 'P2'), () => moveSection(draft, 'Patio', -1),
    () => deleteSection(draft, 'Patio'), () => addTable(draft, 'Patio'), () => renameTable(draft, 'id:1', 'Z'),
    () => setCapacity(draft, 'id:1', 9), () => moveTableToSection(draft, 'id:1', 'Patio'),
    () => moveTableWithin(draft, 'id:4', -1), () => deleteTable(draft, 'id:1'), () => deleteTable(withNew, 'new:1'),
    () => toPayload(draft), () => validateDraft(draft), () => isDirty(layout(), draft)
  ]) {
    assert.doesNotThrow(run); // a frozen draft throws in strict mode if anything writes to it
  }
});

// ---------------------------------------------------------------- validateDraft

test('validateDraft accepts a clean draft', () => {
  assert.deepEqual(validateDraft(draftFromLayout(layout())), { ok: true, tableErrors: {}, sectionErrors: {} });
  assert.equal(validateDraft({ sections: [], tables: [] }).ok, true, 'an empty floor is allowed');
});

test('validateDraft checks table names: required, at most 50 characters, unique ignoring case', () => {
  let draft = draftFromLayout(layout());
  draft = renameTable(draft, 'id:1', '   ');
  draft = renameTable(draft, 'id:2', 'x'.repeat(51));
  draft = renameTable(draft, 'id:3', 'Same');
  draft = renameTable(draft, 'id:4', ' same ');
  const v = validateDraft(draft);
  assert.equal(v.ok, false);
  assert.match(v.tableErrors['id:1'][0], /name is required/);
  assert.match(v.tableErrors['id:2'][0], /1.50 characters/);
  assert.match(v.tableErrors['id:3'][0], /"Same" is used twice/);
  assert.match(v.tableErrors['id:4'][0], /"same" is used twice/);
  assert.deepEqual(v.sectionErrors, {});
});

test('validateDraft allows a name of exactly 50 characters', () => {
  assert.equal(validateDraft(renameTable(draftFromLayout(layout()), 'id:1', 'x'.repeat(50))).ok, true);
});

test('validateDraft checks seats: a whole number from 1 to 50', () => {
  const base = draftFromLayout(layout());
  for (const bad of [0, -1, 51, 2.5, NaN]) {
    const v = validateDraft(setCapacity(base, 'id:1', bad));
    assert.equal(v.ok, false, `seats ${bad}`);
    assert.match(v.tableErrors['id:1'][0], /seats must be a whole number from 1 to 50/);
  }
  for (const good of [1, 50]) assert.equal(validateDraft(setCapacity(base, 'id:1', good)).ok, true, `seats ${good}`);
});

test('validateDraft checks that every table sits in a listed section', () => {
  const draft = { sections: ['A'], tables: [{ key: 'id:1', id: 1, name: 'T1', section: 'Ghost', capacity: 2 }] };
  const v = validateDraft(draft);
  assert.equal(v.ok, false);
  assert.match(v.tableErrors['id:1'][0], /section "Ghost" is not in the sections list/);
});

test('validateDraft checks section names: required, at most 60 characters, not "All", unique ignoring case', () => {
  const t = (key, section) => ({ key, id: key, name: key, section, capacity: 2 });
  const draft = {
    sections: ['', 'y'.repeat(61), 'All', ' all ', 'Dup', 'dup', 'All Day Cafe', 'Allergy Free'],
    tables: [t('t1', 'Dup')]
  };
  const v = validateDraft(draft);
  assert.equal(v.ok, false);
  assert.match(v.sectionErrors[''][0], /section name is required/);
  assert.match(v.sectionErrors['y'.repeat(61)][0], /1.60 characters/);
  assert.match(v.sectionErrors['All'][0], /reserved/);
  assert.match(v.sectionErrors[' all '][0], /reserved/);
  assert.match(v.sectionErrors['dup'][0], /"dup" is listed twice/);
  assert.equal(v.sectionErrors['Dup'], undefined, 'the first of two clashing sections is fine; the later one is the duplicate');
  assert.equal(v.sectionErrors['All Day Cafe'], undefined);
  assert.equal(v.sectionErrors['Allergy Free'], undefined);
});

test('validateDraft agrees with the hub: a draft it accepts is saved, one it refuses is refused', () => {
  const hub = draft => applyLayout({ tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 2 }, { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 }, { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }, { id: 4, name: 'T4', section: 'Main Hall', capacity: 6 }], sections: ['Main Hall', 'AC Room', 'Patio'] }, toPayload(draft)).ok;
  const base = draftFromLayout(layout());
  const cases = [
    base,
    addTable(base, 'Patio'),
    renameTable(base, 'id:1', 'Table One'),
    moveTableToSection(base, 'id:1', 'Patio'),
    renameSection(base, 'Main Hall', 'Dining'),
    deleteTable(base, 'id:1'),
    renameTable(base, 'id:1', ''),
    renameTable(base, 'id:1', 't2'),
    renameTable(base, 'id:1', 'x'.repeat(51)),
    setCapacity(base, 'id:1', 0),
    setCapacity(base, 'id:1', 51),
    setCapacity(base, 'id:1', 3.5),
    renameSection(base, 'Patio', 'All'),
    renameSection(base, 'Patio', ' '),
    addSection(base, 'z'.repeat(61)),
    { ...base, sections: ['Main Hall', 'AC Room', 'ac room'] }
  ];
  for (const [i, draft] of cases.entries()) {
    assert.equal(validateDraft(draft).ok, hub(draft), `case ${i}: ${JSON.stringify(toPayload(draft))}`);
  }
});

// ---------------------------------------------------------------- isDirty

test('isDirty is false for a fresh draft and true after a real change', () => {
  const l = layout();
  const fresh = draftFromLayout(l);
  assert.equal(isDirty(l, fresh), false);
  assert.equal(isDirty(l, renameTable(fresh, 'id:1', 'Other')), true);
  assert.equal(isDirty(l, setCapacity(fresh, 'id:1', 3)), true);
  assert.equal(isDirty(l, moveTableToSection(fresh, 'id:1', 'Patio')), true);
  assert.equal(isDirty(l, moveTableWithin(fresh, 'id:4', -1)), true);
  assert.equal(isDirty(l, moveSection(fresh, 'Patio', -1)), true);
  assert.equal(isDirty(l, addSection(fresh)), true);
  assert.equal(isDirty(l, addTable(fresh, 'Patio')), true);
  assert.equal(isDirty(l, deleteTable(fresh, 'id:1')), true);
  assert.equal(isDirty(l, renameSection(fresh, 'Patio', 'Garden')), true);
});

test('isDirty goes back to false when the edits cancel out or only add stray spaces', () => {
  const l = layout();
  const fresh = draftFromLayout(l);
  assert.equal(isDirty(l, renameTable(renameTable(fresh, 'id:1', 'Other'), 'id:1', 'T1')), false);
  assert.equal(isDirty(l, renameTable(fresh, 'id:1', ' T1 ')), false);
  assert.equal(isDirty(l, deleteTable(addTable(fresh, 'Patio'), 'new:1')), false);
  assert.equal(isDirty(l, moveTableWithin(moveTableWithin(fresh, 'id:4', -1), 'id:4', 1)), false);
  assert.equal(isDirty(l, moveTableToSection(moveTableToSection(fresh, 'id:1', 'Patio'), 'id:1', 'Main Hall')), true, 'back in the section but now last: the order did change');
});
