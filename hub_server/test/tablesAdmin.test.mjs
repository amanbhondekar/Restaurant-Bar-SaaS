import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLayout } from '../lib/tablesAdmin.js';

const current = () => ({
  restaurant_id: 'r', revision: 1, count: 3, next_id: 4,
  sections: ['Main Hall', 'AC Room'],
  tables: [
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
    { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 },
    { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }
  ]
});

test('rename, move, reorder, add and delete in one save', () => {
  const r = applyLayout(current(), {
    sections: ['AC Room', 'Main Hall', 'Patio'],
    tables: [
      { id: 3, name: 'Window 1', section: 'AC Room', capacity: 6 },
      { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
      { name: 'P1', section: 'Patio', capacity: 4 }
    ]
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.sections, ['AC Room', 'Main Hall', 'Patio']);
  assert.deepEqual(r.data.tables, [
    { id: 3, name: 'Window 1', section: 'AC Room', capacity: 6 },
    { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
    { id: 4, name: 'P1', section: 'Patio', capacity: 4 }
  ]);
  assert.equal(r.data.count, 3);
  assert.equal(r.data.next_id, 5);
  assert.equal(r.data.revision, 1, 'revision is bumped by the store, not here');
});

test('ids are never reused, even after deleting the highest table', () => {
  const r = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 2 }, { name: 'New', section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r.data.tables[1].id, 4, 'T3 (id 3) was deleted but 4 is next, not 3');

  const noCounter = current();
  delete noCounter.next_id;
  const r2 = applyLayout(noCounter, {
    sections: ['Main Hall'],
    tables: [{ name: 'New', section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r2.data.tables[0].id, 4, 'falls back to max(existing ids) + 1');
});

test('section and table names are trimmed and matched case-insensitively to the section list', () => {
  const r = applyLayout(current(), {
    sections: [' Main Hall '],
    tables: [{ id: 1, name: ' T1 ', section: 'main hall', capacity: 2 }]
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.tables[0], { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 });
});

test('duplicate table names (case-insensitive) are rejected', () => {
  const r = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 2 }, { id: 2, name: 't1', section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'INVALID_LAYOUT');
  assert.equal(r.errors[0].field, 'tables[1].name');
});

test('invalid sections, ids and capacities are rejected with field paths', () => {
  const run = (sections, tables) => applyLayout(current(), { sections, tables });
  assert.equal(run(['A', 'a'], []).errors[0].field, 'sections[1]');
  assert.equal(run([''], []).errors[0].field, 'sections[0]');
  assert.equal(run(['A'], [{ name: 'X', section: 'B', capacity: 2 }]).errors[0].field, 'tables[0].section');
  assert.equal(run(['A'], [{ id: 99, name: 'X', section: 'A', capacity: 2 }]).errors[0].field, 'tables[0].id');
  assert.equal(run(['A'], [{ id: 1, name: 'X', section: 'A', capacity: 2 }, { id: 1, name: 'Y', section: 'A', capacity: 2 }]).errors[0].field, 'tables[1].id');
  assert.equal(run(['A'], [{ name: 'X', section: 'A', capacity: 0 }]).errors[0].field, 'tables[0].capacity');
  assert.equal(run(['A'], [{ name: 'X', section: 'A', capacity: 2.5 }]).errors[0].field, 'tables[0].capacity');
  assert.equal(run(['A'], [{ name: 'X', section: 'A', capacity: 51 }]).errors[0].field, 'tables[0].capacity');
  assert.equal(applyLayout(current(), { sections: 'nope', tables: [] }).code, 'INVALID_LAYOUT');
  assert.equal(applyLayout(current(), null).code, 'INVALID_LAYOUT');
});

test('the section name "All" is reserved for the floor filter, in any case', () => {
  // The floor grid puts its own "All" chip first; a section with that name would be a second,
  // indistinguishable chip, and its tables could never be isolated.
  for (const name of ['All', 'all', 'ALL', ' All ']) {
    const r = applyLayout(current(), { sections: [name], tables: [] });
    assert.equal(r.ok, false, `section ${JSON.stringify(name)} must be refused`);
    assert.equal(r.status, 400);
    assert.equal(r.code, 'INVALID_LAYOUT');
    assert.equal(r.errors[0].field, 'sections[0]');
  }

  const second = applyLayout(current(), { sections: ['Main Hall', 'All'], tables: [] });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'INVALID_LAYOUT');
  assert.equal(second.errors[0].field, 'sections[1]', 'reported at its own position');

  // Only the whole word is reserved.
  const fine = applyLayout(current(), { sections: ['All Day Cafe', 'Allergy Free'], tables: [] });
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.data.sections, ['All Day Cafe', 'Allergy Free']);
});

test('a table with an open bill cannot be renamed or deleted, but can change seats and section', () => {
  const open = new Set(['1']);

  const renamed = applyLayout(current(), {
    sections: ['Main Hall', 'AC Room'],
    tables: [
      { id: 1, name: 'Window', section: 'Main Hall', capacity: 2 },
      { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 },
      { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }
    ]
  }, open);
  assert.equal(renamed.ok, false);
  assert.equal(renamed.status, 409);
  assert.equal(renamed.code, 'TABLE_HAS_OPEN_BILL');
  assert.deepEqual(renamed.details, [{ id: 1, name: 'T1', action: 'rename' }]);
  assert.match(renamed.error, /T1 \(rename\)/);

  const deleted = applyLayout(current(), {
    sections: ['Main Hall', 'AC Room'],
    tables: [{ id: 2, name: 'T2', section: 'Main Hall', capacity: 4 }, { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }]
  }, open);
  assert.deepEqual(deleted.details, [{ id: 1, name: 'T1', action: 'delete' }]);

  const moved = applyLayout(current(), {
    sections: ['Main Hall', 'AC Room'],
    tables: [
      { id: 1, name: 'T1', section: 'AC Room', capacity: 8 },
      { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 },
      { id: 3, name: 'T3', section: 'AC Room', capacity: 4 }
    ]
  }, open);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.data.tables[0], { id: 1, name: 'T1', section: 'AC Room', capacity: 8 });
});

test('a layout with no tables is valid', () => {
  const r = applyLayout(current(), { sections: ['Main Hall'], tables: [] });
  assert.equal(r.ok, true);
  assert.equal(r.data.count, 0);
  assert.deepEqual(r.data.tables, []);
  assert.equal(r.data.next_id, 4);
});

// Additional tests for hostile input and mutation detection

test('hostile input: invalid types do not throw and do not mutate', () => {
  const snap = current();
  const snapBefore = JSON.parse(JSON.stringify(snap));

  const r1 = applyLayout(snap, { sections: ['A'], tables: [null, 5, 'x', [], {}, { name: 'T', section: 'A', capacity: 2, id: {} }] });
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 400);
  assert.equal(r1.code, 'INVALID_LAYOUT');
  assert.deepEqual(snap, snapBefore, 'input object was not mutated by hostile table list');

  const r2 = applyLayout(snap, { sections: [null, 5, {}, ['x']], tables: [] });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 400);
  assert.equal(r2.code, 'INVALID_LAYOUT');
  assert.deepEqual(snap, snapBefore, 'input object was not mutated by hostile sections list');
});

test('happy path rename/move/reorder/add does not mutate input', () => {
  const snap = current();
  const snapBefore = JSON.parse(JSON.stringify(snap));

  const r = applyLayout(snap, {
    sections: ['AC Room', 'Main Hall', 'Patio'],
    tables: [
      { id: 3, name: 'Window 1', section: 'AC Room', capacity: 6 },
      { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
      { name: 'P1', section: 'Patio', capacity: 4 }
    ]
  });
  assert.equal(r.ok, true);
  assert.deepEqual(snap, snapBefore, 'happy path also did not mutate current object');
});

test('next_id counter is respected when higher than max(existing ids) + 1', () => {
  const curr = {
    restaurant_id: 'r', revision: 1, count: 2, next_id: 10,
    sections: ['Main Hall'],
    tables: [
      { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
      { id: 2, name: 'T2', section: 'Main Hall', capacity: 4 }
    ]
  };
  const r = applyLayout(curr, {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 2 }, { name: 'New', section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r.data.tables[1].id, 10);
  assert.equal(r.data.next_id, 11);
});

// Fix round 1: boundary and type guard tests
test('table name limit: 50 chars accepted, 51 rejected', () => {
  const name50 = 'a'.repeat(50);
  const name51 = 'a'.repeat(51);
  const r50 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: name50, section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r50.ok, true, '50-char name accepted');

  const r51 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: name51, section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r51.ok, false, '51-char name rejected');
  assert.equal(r51.status, 400);
  assert.equal(r51.code, 'INVALID_LAYOUT');
  assert.equal(r51.errors[0].field, 'tables[0].name');
});

test('section limit: 60 chars accepted, 61 rejected', () => {
  const sec60 = 'a'.repeat(60);
  const sec61 = 'a'.repeat(61);
  const r60 = applyLayout(current(), {
    sections: [sec60],
    tables: [{ id: 1, name: 'T1', section: sec60, capacity: 2 }]
  });
  assert.equal(r60.ok, true, '60-char section accepted');

  const r61 = applyLayout(current(), {
    sections: [sec61],
    tables: [{ id: 1, name: 'T1', section: sec61, capacity: 2 }]
  });
  assert.equal(r61.ok, false, '61-char section rejected');
  assert.equal(r61.status, 400);
  assert.equal(r61.code, 'INVALID_LAYOUT');
  assert.equal(r61.errors[0].field, 'sections[0]');
});

test('capacity boundary: 1 and 50 accepted, 0 and 51 rejected', () => {
  const r1 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 1 }]
  });
  assert.equal(r1.ok, true, 'capacity 1 accepted');

  const r50 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 50 }]
  });
  assert.equal(r50.ok, true, 'capacity 50 accepted');

  const r0 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 0 }]
  });
  assert.equal(r0.ok, false);
  assert.equal(r0.status, 400);
  assert.equal(r0.code, 'INVALID_LAYOUT');
  assert.equal(r0.errors[0].field, 'tables[0].capacity');

  const r51 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'T1', section: 'Main Hall', capacity: 51 }]
  });
  assert.equal(r51.ok, false);
  assert.equal(r51.status, 400);
  assert.equal(r51.code, 'INVALID_LAYOUT');
  assert.equal(r51.errors[0].field, 'tables[0].capacity');
});

test('type guards reject non-string/number capacity, name, and section', () => {
  const run = (sections, tables) => applyLayout(current(), { sections, tables });

  const capStr = run(['Main Hall'], [{ id: 1, name: 'T1', section: 'Main Hall', capacity: '4' }]);
  assert.equal(capStr.ok, false);
  assert.equal(capStr.status, 400);
  assert.equal(capStr.code, 'INVALID_LAYOUT');
  assert.equal(capStr.errors[0].field, 'tables[0].capacity');

  const nameNum = run(['Main Hall'], [{ id: 1, name: 5, section: 'Main Hall', capacity: 2 }]);
  assert.equal(nameNum.ok, false);
  assert.equal(nameNum.status, 400);
  assert.equal(nameNum.code, 'INVALID_LAYOUT');
  assert.equal(nameNum.errors[0].field, 'tables[0].name');

  const sectNum = run(['Main Hall'], [{ id: 1, name: 'T1', section: 5, capacity: 2 }]);
  assert.equal(sectNum.ok, false);
  assert.equal(sectNum.status, 400);
  assert.equal(sectNum.code, 'INVALID_LAYOUT');
  assert.equal(sectNum.errors[0].field, 'tables[0].section');
});

test('sections array type guard: reject non-string section names', () => {
  const run = (sections) => applyLayout(current(), { sections, tables: [] });

  const numSect = run([5]);
  assert.equal(numSect.ok, false);
  assert.equal(numSect.status, 400);
  assert.equal(numSect.code, 'INVALID_LAYOUT');
  assert.equal(numSect.errors[0].field, 'sections[0]');

  const objSect = run([{}]);
  assert.equal(objSect.ok, false);
  assert.equal(objSect.status, 400);
  assert.equal(objSect.code, 'INVALID_LAYOUT');
  assert.equal(objSect.errors[0].field, 'sections[0]');
});

test('id type guard: reject non-number/string ids, accept numeric strings', () => {
  const run = (tables) => applyLayout(current(), { sections: ['Main Hall'], tables });

  // Reject object id with bad toString
  const objId = run([{ id: { toString: 1 }, name: 'T', section: 'Main Hall', capacity: 2 }]);
  assert.equal(objId.ok, false);
  assert.equal(objId.status, 400);
  assert.equal(objId.code, 'INVALID_LAYOUT');
  assert.equal(objId.errors[0].field, 'tables[0].id');

  // Reject array id
  const arrId = run([{ id: [1], name: 'T', section: 'Main Hall', capacity: 2 }]);
  assert.equal(arrId.ok, false);
  assert.equal(arrId.status, 400);
  assert.equal(arrId.code, 'INVALID_LAYOUT');
  assert.equal(arrId.errors[0].field, 'tables[0].id');

  // Accept numeric string id
  const strId = run([{ id: '1', name: 'T', section: 'Main Hall', capacity: 2 }]);
  assert.equal(strId.ok, true);
});

test('id type guard: JSON.parse hostile cases do not throw', () => {
  const hostile = JSON.parse('{"id":{"toString":1},"name":"T","section":"Main Hall","capacity":2}');
  const r = applyLayout(current(), { sections: ['Main Hall'], tables: [hostile] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 'INVALID_LAYOUT');
  assert.equal(r.errors[0].field, 'tables[0].id');
});

test('open-bill lock works with numeric Set, array, null, and undefined', () => {
  const open1 = new Set([1]); // numeric Set
  const r1 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'Changed', section: 'Main Hall', capacity: 2 }]
  }, open1);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 409);
  assert.equal(r1.code, 'TABLE_HAS_OPEN_BILL');

  // Array should work like iterable
  const r2 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'Changed', section: 'Main Hall', capacity: 2 }]
  }, [1]);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 409);
  assert.equal(r2.code, 'TABLE_HAS_OPEN_BILL');

  // null should not throw
  const r3 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'Changed', section: 'Main Hall', capacity: 2 }]
  }, null);
  assert.equal(r3.ok, true, 'null open set does not throw and lock is closed');

  // undefined (default) should work
  const r4 = applyLayout(current(), {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'Changed', section: 'Main Hall', capacity: 2 }]
  });
  assert.equal(r4.ok, true, 'undefined open set uses default');
});

test('rename detection with leading whitespace in stored name', () => {
  const curr = {
    restaurant_id: 'r', revision: 1, count: 1, next_id: 2,
    sections: ['Main Hall'],
    tables: [{ id: 1, name: ' T1', section: 'Main Hall', capacity: 2 }]
  };
  const open = new Set(['1']);

  // Resending the same name (with whitespace) should not trigger rename
  const sameRaw = applyLayout(curr, {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: ' T1', section: 'Main Hall', capacity: 2 }]
  }, open);
  assert.equal(sameRaw.ok, true, 'resending stored name unchanged (with space) is ok');

  // Renaming to different should trigger lock
  const renamed = applyLayout(curr, {
    sections: ['Main Hall'],
    tables: [{ id: 1, name: 'Other', section: 'Main Hall', capacity: 2 }]
  }, open);
  assert.equal(renamed.ok, false);
  assert.equal(renamed.status, 409);
  assert.equal(renamed.code, 'TABLE_HAS_OPEN_BILL');
  assert.deepEqual(renamed.details[0].action, 'rename');
});

test('happy path with deep freeze of both current and input to catch mutations', () => {
  function deepFreeze(obj) {
    Object.freeze(obj);
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object') {
        deepFreeze(obj[key]);
      }
    }
    return obj;
  }

  const snap = current();
  const input = {
    sections: ['AC Room', 'Main Hall', 'Patio'],
    tables: [
      { id: 3, name: 'Window 1', section: 'AC Room', capacity: 6 },
      { id: 1, name: 'T1', section: 'Main Hall', capacity: 2 },
      { name: 'P1', section: 'Patio', capacity: 4 }
    ]
  };

  const snapFrozen = deepFreeze(JSON.parse(JSON.stringify(snap)));
  const inputFrozen = deepFreeze(JSON.parse(JSON.stringify(input)));

  const r = applyLayout(snapFrozen, inputFrozen);
  assert.equal(r.ok, true);
  // Both should still be frozen (mutations would throw)
  assert.deepEqual(snapFrozen, JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(inputFrozen, JSON.parse(JSON.stringify(input)));
});
