import { norm } from './menuAdmin.js';

// Whole-layout save for the floor: the editor keeps a local draft (many drags and
// renames) and commits once. Pure; restaurantCache.updateCatalog persists it.

export const TABLE_LIMITS = { name: 50, section: 60, capacity: 50 };

const bad = errors => ({ ok: false, status: 400, code: 'INVALID_LAYOUT', error: errors[0].message, errors });

/**
 * @param current        tables cache `{ tables, sections?, next_id?, … }`
 * @param input          `{ sections: string[], tables: [{ id?, name, section, capacity }] }`
 * @param openTableIds   Set of table ids (as strings) that currently have an open bill
 */
export function applyLayout(current, input, openTableIds = new Set()) {
  if (!input || !Array.isArray(input.sections) || !Array.isArray(input.tables)) {
    return bad([{ field: 'layout', message: 'sections and tables must both be arrays' }]);
  }
  const errors = [];

  // Normalize openTableIds early: convert to Set of string ids, handle null/undefined/array/Set
  const open = new Set([...(openTableIds ?? [])].map(String));

  const sections = [];
  input.sections.forEach((s, i) => {
    const name = typeof s === 'string' ? s.trim() : '';
    if (!name || name.length > TABLE_LIMITS.section) {
      errors.push({ field: `sections[${i}]`, message: `section name is required (1–${TABLE_LIMITS.section} characters)` });
    } else if (norm(name) === 'all') {
      // The floor grid puts its own "All" filter chip first; a section called that would be a
      // second, indistinguishable chip whose tables could never be isolated.
      errors.push({ field: `sections[${i}]`, message: `"${name}" is reserved for the floor filter; choose another section name` });
    } else if (sections.some(x => norm(x) === norm(name))) {
      errors.push({ field: `sections[${i}]`, message: `section "${name}" is listed twice` });
    } else {
      sections.push(name);
    }
  });

  const existingById = new Map(current.tables.map(t => [String(t.id), t]));
  const maxId = Math.max(0, ...current.tables.map(t => Number(t.id) || 0));
  // The counter only ever moves forward, so an id can never alias a deleted
  // table's history.
  let nextId = Math.max(Number(current.next_id) || 1, maxId + 1);

  const usedNames = new Set();
  const usedIds = new Set();
  const rows = input.tables.map((t, i) => {
    const at = k => `tables[${i}].${k}`;
    const name = typeof t?.name === 'string' ? t.name.trim() : '';
    const sectionRaw = typeof t?.section === 'string' ? t.section.trim() : '';
    const section = sections.find(s => norm(s) === norm(sectionRaw));

    if (!name || name.length > TABLE_LIMITS.name) {
      errors.push({ field: at('name'), message: `table name is required (1–${TABLE_LIMITS.name} characters)` });
    } else if (usedNames.has(norm(name))) {
      errors.push({ field: at('name'), message: `table name "${name}" is used twice` });
    } else {
      usedNames.add(norm(name));
    }
    if (!section) {
      errors.push({ field: at('section'), message: `section "${sectionRaw}" is not in the sections list` });
    }
    if (!Number.isInteger(t?.capacity) || t.capacity < 1 || t.capacity > TABLE_LIMITS.capacity) {
      errors.push({ field: at('capacity'), message: `seats must be a whole number from 1 to ${TABLE_LIMITS.capacity}` });
    }

    let id;
    if (t?.id !== undefined && t?.id !== null) {
      // Type guard: reject id if not typeof 'number' or 'string' before calling String()
      if (typeof t.id !== 'number' && typeof t.id !== 'string') {
        errors.push({ field: at('id'), message: 'table id must be a number or a string' });
      } else {
        const existing = existingById.get(String(t.id));
        if (!existing) errors.push({ field: at('id'), message: `unknown table id ${t.id}` });
        else if (usedIds.has(String(existing.id))) errors.push({ field: at('id'), message: `table id ${t.id} appears twice` });
        else {
          id = existing.id;
          usedIds.add(String(existing.id));
        }
      }
    }
    return { id, name, section, capacity: t?.capacity };
  });
  if (errors.length) return bad(errors);

  // Open-bill lock: tickets are matched to tables by id *or* name, so renaming or
  // deleting a table mid-service would orphan or misattribute its bill.
  const blocked = [];
  for (const t of current.tables) {
    if (!open.has(String(t.id))) continue;
    const next = rows.find(r => r.id !== undefined && String(r.id) === String(t.id));
    if (!next) blocked.push({ id: t.id, name: t.name, action: 'delete' });
    else if (next.name !== String(t.name).trim()) blocked.push({ id: t.id, name: t.name, action: 'rename' });
  }
  if (blocked.length) {
    const names = blocked.map(b => `${b.name} (${b.action})`).join(', ');
    return { ok: false, status: 409, code: 'TABLE_HAS_OPEN_BILL', error: `Clear the open bill first: ${names}.`, details: blocked };
  }

  const tables = rows.map(r => ({ id: r.id ?? nextId++, name: r.name, section: r.section, capacity: r.capacity }));
  return { ok: true, data: { ...current, tables, sections, count: tables.length, next_id: nextId } };
}
