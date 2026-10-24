import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stationOf, groupOf, isFired, visibleLines, heldGroups, stationStates, onStationBoard, stationCounts, initialStation, lineDoneForStation
} from '../../src/lib/ticketView.js';
import { initCourseState, markStationReady, markAllReady, fireCourse } from '../lib/courses.js';

// The kitchen screen's view logic, fed with real tickets produced by the hub's own course module so the
// two can never drift apart.

const NOW = '2026-10-02T12:00:00.000Z';
const item = (name, station, course, qty = 1) => ({ id: name, name, station, course, qty });

function ticket(items, { staged = false, id = 't1' } = {}) {
  return { id, ticket_number: 101, status: 'in_progress', items, created_at: NOW, updated_at: NOW, ...initCourseState(items, { staged }, NOW) };
}

const MIXED = [item('Veg Crispy', 'hot', 1), item('Masala Chaas', 'bar', 1, 2), item('Dal Tadka', 'hot', 2), item('Gulab Jamun', 'cold', 3)];

test('view: stations and groups come from the lines, defaulting sensibly', () => {
  assert.equal(stationOf({ station: 'BAR' }), 'bar');
  assert.equal(stationOf({ station: 'garnish' }), 'hot');
  assert.equal(stationOf({}), 'hot');
  const normal = ticket(MIXED);
  const staged = ticket(MIXED, { staged: true });
  assert.equal(groupOf(normal, MIXED[2]), 1, 'a normal ticket has one group whatever the lines\' courses');
  assert.equal(groupOf(staged, MIXED[2]), 2);
  assert.equal(isFired(staged, MIXED[0]), true);
  assert.equal(isFired(staged, MIXED[2]), false);
});

test('view: a normal ticket shows every line; a staged one shows only what has been fired', () => {
  assert.equal(visibleLines(ticket(MIXED), 'all').length, 4);
  const staged = ticket(MIXED, { staged: true });
  assert.deepEqual(visibleLines(staged, 'all').map(l => l.item.name), ['Veg Crispy', 'Masala Chaas']);
  // Each line keeps its index into ticket.items, which the checklist is keyed by.
  assert.deepEqual(visibleLines(staged, 'all').map(l => l.idx), [0, 1]);
});

test('view: a station screen shows only that station\'s lines', () => {
  const t = ticket(MIXED);
  assert.deepEqual(visibleLines(t, 'bar').map(l => l.item.name), ['Masala Chaas']);
  assert.deepEqual(visibleLines(t, 'hot').map(l => l.item.name), ['Veg Crispy', 'Dal Tadka']);
  assert.deepEqual(visibleLines(t, 'cold').map(l => l.item.name), ['Gulab Jamun']);
  const staged = ticket(MIXED, { staged: true });
  assert.deepEqual(visibleLines(staged, 'hot').map(l => l.item.name), ['Veg Crispy'], 'the held main is not on the hot screen yet');
});

test('view: held courses are listed with the number of portions in each', () => {
  assert.deepEqual(heldGroups(ticket(MIXED)), []);
  assert.deepEqual(heldGroups(ticket(MIXED, { staged: true })), [{ course: 2, count: 1 }, { course: 3, count: 1 }]);
  const two = ticket([item('A', 'hot', 1), item('B', 'hot', 2, 3), item('C', 'hot', 2, 2)], { staged: true });
  assert.deepEqual(heldGroups(two), [{ course: 2, count: 5 }]);
});

test('view: station chips show every station with fired lines and whether it is done', () => {
  const t = ticket(MIXED);
  assert.deepEqual(stationStates(t).map(s => [s.station, s.done, s.lines]), [['hot', false, 2], ['cold', false, 1], ['bar', false, 1]]);
  const bar = markStationReady(t, 'bar', NOW).ticket;
  assert.equal(stationStates(bar).find(s => s.station === 'bar').done, true);
  assert.equal(lineDoneForStation(bar, MIXED[1]), true);
  assert.equal(lineDoneForStation(bar, MIXED[0]), false);
  // Tickets from an older hub have no course log: nothing counts as done, and nothing throws.
  assert.equal(lineDoneForStation({ items: MIXED }, MIXED[0]), false);
  assert.deepEqual(stationStates({ items: [item('X', 'bar', 1)] }).map(s => s.station), ['bar']);
});

test('view: a ticket is on a station\'s board only while that station has something left to cook', () => {
  const t = ticket(MIXED);
  assert.equal(onStationBoard(t, 'all'), true);
  assert.equal(onStationBoard(t, 'bar'), true);
  const barDone = markStationReady(t, 'bar', NOW).ticket;
  assert.equal(onStationBoard(barDone, 'bar'), false, 'the bar has reported, so it drops off the bar screen');
  assert.equal(onStationBoard(barDone, 'hot'), true);
  assert.equal(onStationBoard(ticket([item('Dal', 'hot', 1)]), 'bar'), false, 'a food-only ticket never shows on the bar');
  // A held course is not on any board until it is fired.
  const staged = ticket([item('Soup', 'hot', 1), item('Cake', 'cold', 2)], { staged: true });
  assert.equal(onStationBoard(staged, 'cold'), false);
  const fired = fireCourse(markAllReady(staged, NOW).ticket, undefined, NOW).ticket;
  assert.equal(onStationBoard(fired, 'cold'), true);
});

test('view: filter chip counts are the tickets waiting on each station', () => {
  const a = ticket(MIXED, { id: 'a' });
  const b = ticket([item('Dal', 'hot', 1)], { id: 'b' });
  const c = markStationReady(ticket([item('Chaas', 'bar', 1), item('Dal', 'hot', 1)], { id: 'c' }), 'bar', NOW).ticket;
  assert.deepEqual(stationCounts([a, b, c]), { all: 3, hot: 3, cold: 1, bar: 1 });
  assert.deepEqual(stationCounts([]), { all: 0, hot: 0, cold: 0, bar: 0 });
  assert.deepEqual(stationCounts(undefined), { all: 0, hot: 0, cold: 0, bar: 0 });
});

test('view: the station screen is chosen from the address first, then from storage, else all', () => {
  assert.equal(initialStation('?station=bar', 'hot'), 'bar');
  assert.equal(initialStation('', 'cold'), 'cold');
  assert.equal(initialStation('?station=garnish', 'hot'), 'hot', 'an unknown station in the address falls through to storage');
  assert.equal(initialStation('?station=garnish', 'nonsense'), 'all');
  assert.equal(initialStation('?station=ALL', null), 'all');
  assert.equal(initialStation('', null), 'all');
  assert.equal(initialStation('?x=1&station=hot', null), 'hot');
});
