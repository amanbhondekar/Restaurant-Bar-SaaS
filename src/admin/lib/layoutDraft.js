// The local draft behind the Tables tab. Every edit (rename, reseat, move, reorder, add, delete) is
// applied to this draft with the helpers below, and one PUT /admin/tables/layout commits the lot.
// Plain ESM with no DOM and no React; every helper returns a new draft and leaves its input alone.
// A helper that cannot do what it is asked (unknown table, nothing to change, a rename onto another
// section's name) returns the SAME draft object it was given, so callers can compare with ===.
//
// Draft = {
//   sections: string[],                                      // display order
//   tables:   [{ key, id?, name, section, capacity }]        // flat list; the order within a section is
// }                                                          // the order those tables appear in this list
// `key` is the table's stable client key: `id:<id>` for a table the hub already has, `new:<n>` for one
// added in this draft (it has no id until the hub saves it).

// Mirrors TABLE_LIMITS and the rules in hub_server/lib/tablesAdmin.js: the hub rejects what the draft
// refuses here, so Save is only offered for a layout the hub will accept.
const LIMITS = { name: 50, section: 60, seats: 50 };
const RESERVED_SECTION = 'all'; // the floor grid's own filter chip
const DEFAULT_SECTION = 'Unsectioned'; // a home for a table the hub knows no section for
const NEW_SECTION = 'New section';

const norm = s => String(s ?? '').trim().toLowerCase();

/** The tables of one section, in display order. */
export const tablesIn = (draft, section) => draft.tables.filter(t => t.section === section);

/** Builds a draft from `GET /tables/layout` (`{ sections, tables }`). */
export function draftFromLayout(layout) {
  const tables = (Array.isArray(layout?.tables) ? layout.tables : []).map(t => ({
    key: `id:${t.id}`,
    id: t.id,
    name: String(t.name ?? ''),
    section: typeof t.section === 'string' && t.section.trim() !== '' ? t.section : DEFAULT_SECTION,
    capacity: Number(t.capacity)
  }));
  const sections = [];
  for (const s of Array.isArray(layout?.sections) ? layout.sections : []) {
    if (typeof s === 'string' && s.trim() !== '' && !sections.includes(s)) sections.push(s);
  }
  // A table must never be left without a section card to live in (it would vanish from the page and
  // from the save), so a section only the tables know about joins the list.
  for (const t of tables) if (!sections.includes(t.section)) sections.push(t.section);
  return { sections, tables };
}

/**
 * The tables in the order a save sends them: section by section in the sections order, with the
 * within-section order kept. The hub reports a bad table as `tables[i]`, and i is the index in this
 * list. The whole floor goes in one call, so a table left out is a table deleted: one whose section
 * is not in the list is therefore sent last (the hub refuses it by name) rather than dropped.
 */
export function orderedTables(draft) {
  const ordered = [];
  const placed = new Set();
  for (const section of draft.sections) {
    for (const t of draft.tables) {
      if (t.section === section && !placed.has(t.key)) {
        placed.add(t.key);
        ordered.push(t);
      }
    }
  }
  for (const t of draft.tables) if (!placed.has(t.key)) ordered.push(t);
  return ordered;
}

/**
 * The body of `PUT /admin/tables/layout`, minus `base_revision`: sections in order, then the tables
 * as orderedTables lists them. New tables carry no id.
 */
export function toPayload(draft) {
  return {
    sections: draft.sections.map(s => String(s).trim()),
    tables: orderedTables(draft).map(t => ({
      ...(t.id !== undefined ? { id: t.id } : {}),
      name: String(t.name ?? '').trim(),
      section: String(t.section ?? '').trim(),
      capacity: t.capacity
    }))
  };
}

// ---------------------------------------------------------------- sections

function uniqueName(base, taken) {
  let name = base;
  for (let n = 2; taken.some(x => norm(x) === norm(name)); n++) name = `${base} ${n}`;
  return name;
}

/** Appends a section (default "New section"); a name that clashes ignoring case gets " 2", " 3"... */
export function addSection(draft, name) {
  const base = String(name ?? '').trim() || NEW_SECTION;
  return { ...draft, sections: [...draft.sections, uniqueName(base, draft.sections)] };
}

/** Renames a section in place and moves its tables with it. Refused (same draft back) when another section already has that name. */
export function renameSection(draft, from, to) {
  if (!draft.sections.includes(from) || to === from) return draft;
  if (draft.sections.some(s => s !== from && norm(s) === norm(to))) return draft;
  return {
    sections: draft.sections.map(s => (s === from ? to : s)),
    tables: draft.tables.map(t => (t.section === from ? { ...t, section: to } : t))
  };
}

/** Moves a section up (delta -1) or down (+1) the list; it stops at the ends. */
export function moveSection(draft, name, delta) {
  const from = draft.sections.indexOf(name);
  if (from === -1) return draft;
  const to = Math.min(Math.max(from + delta, 0), draft.sections.length - 1);
  if (to === from) return draft;
  const sections = [...draft.sections];
  sections.splice(to, 0, sections.splice(from, 1)[0]);
  return { ...draft, sections };
}

/** Deletes a section, but only an empty one. */
export function deleteSection(draft, name) {
  if (!draft.sections.includes(name) || draft.tables.some(t => t.section === name)) return draft;
  return { ...draft, sections: draft.sections.filter(s => s !== name) };
}

// ---------------------------------------------------------------- tables

const changeTable = (draft, key, change) => {
  const i = draft.tables.findIndex(t => t.key === key);
  if (i === -1) return draft;
  const tables = [...draft.tables];
  tables[i] = { ...tables[i], ...change };
  return { ...draft, tables };
};

/** Adds a table at the end of a section: key `new:<n>`, 4 seats, and the first free name "T<n>". */
export function addTable(draft, section) {
  if (!draft.sections.includes(section)) return draft;
  const newest = Math.max(0, ...draft.tables.map(t => Number(/^new:(\d+)$/.exec(t.key)?.[1] ?? 0)));
  const taken = new Set(draft.tables.map(t => norm(t.name)));
  let n = draft.tables.length + 1;
  while (taken.has(`t${n}`)) n++;
  return { ...draft, tables: [...draft.tables, { key: `new:${newest + 1}`, name: `T${n}`, section, capacity: 4 }] };
}

export const renameTable = (draft, key, name) => changeTable(draft, key, { name: String(name ?? '') });

// Text from an input becomes a number; a blank becomes NaN so validateDraft refuses it.
const toSeats = v => (typeof v === 'number' ? v : (v === '' || v === null || v === undefined ? NaN : Number(v)));
export const setCapacity = (draft, key, capacity) => changeTable(draft, key, { capacity: toSeats(capacity) });

/** Moves a table to the end of another section. */
export function moveTableToSection(draft, key, section) {
  const table = draft.tables.find(t => t.key === key);
  if (!table || table.section === section || !draft.sections.includes(section)) return draft;
  return { ...draft, tables: [...draft.tables.filter(t => t.key !== key), { ...table, section }] };
}

/** Moves a table up (delta -1) or down (+1) among the tables of its own section; it stops at the ends. */
export function moveTableWithin(draft, key, delta) {
  const table = draft.tables.find(t => t.key === key);
  if (!table) return draft;
  const group = tablesIn(draft, table.section);
  const from = group.findIndex(t => t.key === key);
  const to = Math.min(Math.max(from + delta, 0), group.length - 1);
  if (to === from) return draft;
  const reordered = [...group];
  reordered.splice(to, 0, reordered.splice(from, 1)[0]);
  // The section's tables keep their slots in the flat list; only who stands in which slot changes.
  let next = 0;
  return { ...draft, tables: draft.tables.map(t => (t.section === table.section ? reordered[next++] : t)) };
}

export function deleteTable(draft, key) {
  if (!draft.tables.some(t => t.key === key)) return draft;
  return { ...draft, tables: draft.tables.filter(t => t.key !== key) };
}

// ---------------------------------------------------------------- checks

/**
 * Client mirror of the hub's layout rules, so Save is only offered for a layout the hub accepts.
 * Errors are keyed by the table's `key` and by the section's name exactly as it is in the draft.
 * Where two tables or two sections clash, every clashing table is flagged but only the later of two
 * sections is (the hub reports the same one).
 * @returns {{ ok: boolean, tableErrors: Record<string, string[]>, sectionErrors: Record<string, string[]> }}
 */
export function validateDraft(draft) {
  const tableErrors = {};
  const sectionErrors = {};
  const add = (bucket, key, message) => { (bucket[key] ||= []).push(message); };

  const accepted = [];
  for (const section of draft.sections) {
    const name = String(section ?? '').trim();
    if (!name || name.length > LIMITS.section) {
      add(sectionErrors, section, `section name is required (1–${LIMITS.section} characters)`);
    } else if (norm(name) === RESERVED_SECTION) {
      add(sectionErrors, section, `"${name}" is reserved for the floor filter; choose another section name`);
    } else if (accepted.some(x => norm(x) === norm(name))) {
      add(sectionErrors, section, `section "${name}" is listed twice`);
    } else {
      accepted.push(name);
    }
  }

  const uses = new Map();
  for (const t of draft.tables) {
    const key = norm(t.name);
    if (key) uses.set(key, (uses.get(key) || 0) + 1);
  }
  for (const t of draft.tables) {
    const name = String(t.name ?? '').trim();
    if (!name || name.length > LIMITS.name) {
      add(tableErrors, t.key, `table name is required (1–${LIMITS.name} characters)`);
    } else if (uses.get(norm(name)) > 1) {
      add(tableErrors, t.key, `table name "${name}" is used twice`);
    }
    // A table in a section that is listed but wrong (reserved, duplicate) is covered by that section's error.
    if (!draft.sections.some(s => norm(s) === norm(t.section))) {
      add(tableErrors, t.key, `section "${String(t.section ?? '').trim()}" is not in the sections list`);
    }
    if (!Number.isInteger(t.capacity) || t.capacity < 1 || t.capacity > LIMITS.seats) {
      add(tableErrors, t.key, `seats must be a whole number from 1 to ${LIMITS.seats}`);
    }
  }

  return { ok: Object.keys(tableErrors).length === 0 && Object.keys(sectionErrors).length === 0, tableErrors, sectionErrors };
}

/** Does the draft differ from the layout it came from? Stray spaces and edits that cancel out do not count. */
export function isDirty(layout, draft) {
  return JSON.stringify(toPayload(draft)) !== JSON.stringify(toPayload(draftFromLayout(layout)));
}
