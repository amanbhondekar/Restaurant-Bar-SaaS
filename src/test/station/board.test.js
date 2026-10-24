import { describe, expect, it } from 'vitest';

import {
  stationFromPath, upsertTicket, applyMessage, mergeFetched, pendingLines, board, waitingSince, minutesSince, urgencyOf, formatWait,
  pendingKeys, describeLine, WARN_AT, LATE_AT
} from '@/station/lib/board';
// Tickets are made with the hub's own course functions, so these tests break if the hub and the screen
// ever disagree about what a ticket looks like after a station reports or a course is fired.
import { initCourseState, markStationReady, fireCourse } from '../../../hub_server/lib/courses.js';

const T = (m, s = 0) => `2026-10-19T12:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const line = (name, station, course = 1, qty = 1, extra = {}) => ({ id: name.toLowerCase().replace(/\W+/g, '_'), name, qty, station, course, ...extra });
const make = (items, { staged = false, id = 't1', n = 101, at = T(0) } = {}) => ({
  id, ticket_number: n, table_name: 'T4', status: 'in_progress', items, created_at: at, updated_at: at, note: '',
  ...initCourseState(items, { staged }, at)
});

describe('station from the page address', () => {
  it('reads a known station, in any case, and nothing else', () => {
    expect(stationFromPath('/station/bar')).toBe('bar');
    expect(stationFromPath('/station/HOT')).toBe('hot');
    expect(stationFromPath('/station/cold/')).toBe('cold');
    for (const bad of ['/station/garnish', '/station/', '/station', '/', '/admin', '/station/bar/extra', '', undefined, null]) {
      expect(stationFromPath(bad), String(bad)).toBeNull();
    }
  });
});

describe('what a station still has to cook', () => {
  const t = make([line('Dal', 'hot'), line('Chaas', 'bar', 1, 2), line('Salad', 'cold')]);

  it('only its own station\'s lines, with their position on the ticket', () => {
    expect(pendingLines(t, 'bar').map(l => [l.item.name, l.idx])).toEqual([['Chaas', 1]]);
    expect(pendingLines(t, 'hot').map(l => l.item.name)).toEqual(['Dal']);
  });

  it('a line is no longer pending once the station has reported it', () => {
    const done = markStationReady(t, 'bar', T(3)).ticket;
    expect(pendingLines(done, 'bar')).toEqual([]);
    expect(pendingLines(done, 'hot')).toHaveLength(1);
  });

  it('a held course is not pending until it is fired, and a finished course is not shown beside the next', () => {
    const staged = make([line('Starter', 'hot', 1), line('Main', 'hot', 2)], { staged: true });
    expect(pendingLines(staged, 'hot').map(l => l.item.name)).toEqual(['Starter']);

    const starterDone = markStationReady(staged, 'hot', T(4)).ticket;
    expect(pendingLines(starterDone, 'hot')).toEqual([]);

    const mainFired = fireCourse(starterDone, 2, T(9)).ticket;
    expect(pendingLines(mainFired, 'hot').map(l => [l.item.name, l.group])).toEqual([['Main', 2]]);
  });
});

describe('the board', () => {
  it('shows a ticket only where the station has work on it', () => {
    const food = make([line('Dal', 'hot')], { id: 'a' });
    const mixed = make([line('Dal', 'hot'), line('Chaas', 'bar')], { id: 'b' });
    expect(board([food, mixed], 'bar').map(b => b.ticket.id)).toEqual(['b']);
    expect(board([food, mixed], 'hot').map(b => b.ticket.id).sort()).toEqual(['a', 'b']);
    expect(board([food, mixed], 'cold')).toEqual([]);
  });

  it('a ticket leaves a station\'s board when that station reports, and stays on the others\'', () => {
    const mixed = make([line('Dal', 'hot'), line('Chaas', 'bar')]);
    const afterBar = markStationReady(mixed, 'bar', T(2)).ticket;
    expect(board([afterBar], 'bar')).toEqual([]);
    expect(board([afterBar], 'hot')).toHaveLength(1);
  });

  it('puts the longest-waiting ticket first, because that is the order a kitchen works in', () => {
    const newer = make([line('Dal', 'hot')], { id: 'newer', at: T(8) });
    const older = make([line('Naan', 'hot')], { id: 'older', at: T(1) });
    expect(board([newer, older], 'hot').map(b => b.ticket.id)).toEqual(['older', 'newer']);
  });

  it('ignores a closed ticket', () => {
    expect(board([{ ...make([line('Dal', 'hot')]), status: 'completed' }], 'hot')).toEqual([]);
  });

  it('copes with nothing at all', () => {
    expect(board(undefined, 'hot')).toEqual([]);
    expect(board([], 'hot')).toEqual([]);
  });
});

describe('how long a ticket has been waiting', () => {
  it('counts from when the station\'s current work was sent to the kitchen', () => {
    expect(waitingSince(make([line('Dal', 'hot')], { at: T(5) }), 'hot')).toBe(T(5));
  });

  it('a course fired later starts its own clock, not the ticket\'s', () => {
    let t = make([line('Starter', 'hot', 1), line('Main', 'hot', 2)], { staged: true, at: T(0) });
    t = markStationReady(t, 'hot', T(10)).ticket;
    t = fireCourse(t, 2, T(40)).ticket;
    expect(waitingSince(t, 'hot')).toBe(T(40));
  });

  it('falls back to when the ticket was made when the course log is missing', () => {
    expect(waitingSince({ id: 'x', items: [line('Dal', 'hot')], created_at: T(7) }, 'hot')).toBe(T(7));
  });

  it('minutes are whole, never negative, and null when there is nothing to measure', () => {
    const now = Date.parse(T(30));
    expect(minutesSince(T(0), now)).toBe(30);
    expect(minutesSince(T(29, 31), now)).toBe(0);
    expect(minutesSince(T(45), now)).toBe(0);
    expect(minutesSince(undefined, now)).toBeNull();
    expect(minutesSince('not a time', now)).toBeNull();
  });

  it('is judged ok, worth a glance, or late, at the stated thresholds', () => {
    expect(urgencyOf(WARN_AT - 1)).toBe('ok');
    expect(urgencyOf(WARN_AT)).toBe('warn');
    expect(urgencyOf(LATE_AT - 1)).toBe('warn');
    expect(urgencyOf(LATE_AT)).toBe('late');
    expect(urgencyOf(null)).toBe('ok');
  });

  it('is worded for a glance', () => {
    expect(formatWait(0)).toBe('just now');
    expect(formatWait(7)).toBe('7 min');
    expect(formatWait(65)).toBe('1 h 05 min');
    expect(formatWait(null)).toBe('');
  });
});

describe('live messages from the hub', () => {
  const a = make([line('Dal', 'hot')], { id: 'a' });
  const b = make([line('Chaas', 'bar')], { id: 'b' });

  it('a new order is added, once, however many times it is announced', () => {
    const once = applyMessage([], { type: 'NEW_ORDER', payload: a });
    expect(once.tickets.map(t => t.id)).toEqual(['a']);
    // The hub announces it under two names, and a reconnect can repeat both.
    const twice = applyMessage(once.tickets, { type: 'order_created', payload: { ticket: a } });
    expect(twice.tickets).toHaveLength(1);
    expect(applyMessage(twice.tickets, { type: 'NEW_ORDER', payload: a }).tickets).toHaveLength(1);
  });

  it('an update replaces the ticket as the hub now has it', () => {
    const marked = markStationReady(a, 'hot', T(5)).ticket;
    const r = applyMessage([a, b], { type: 'TICKET_UPDATED', payload: { ticket: marked } });
    expect(r.tickets.find(t => t.id === 'a').course_log[1].stations_ready.hot).toBe(T(5));
    expect(r.tickets).toHaveLength(2);
    expect(r.refetch).toBe(false);
  });

  it('a fired course on a ticket the screen has not seen is added rather than lost', () => {
    const staged = make([line('Starter', 'hot', 1), line('Main', 'hot', 2)], { staged: true, id: 's' });
    const fired = fireCourse(markStationReady(staged, 'hot', T(3)).ticket, 2, T(8)).ticket;
    expect(applyMessage([], { type: 'COURSE_FIRED', payload: { ticket: fired } }).tickets.map(t => t.id)).toEqual(['s']);
  });

  it('every ticket-changing event the hub sends is understood', () => {
    for (const type of ['TICKET_UPDATED', 'COURSE_FIRED', 'STATION_READY', 'TICKET_RECALLED', 'TICKET_READY', 'order_ready']) {
      const r = applyMessage([a], { type, payload: { ticket: { ...a, note: type } } });
      expect(r.tickets[0].note, type).toBe(type);
    }
  });

  it('an old-style ready event with no ticket in it marks the one it names', () => {
    expect(applyMessage([a, b], { type: 'order_ready', payload: { ticket_id: 'b' } }).tickets.find(t => t.id === 'b').status).toBe('ready');
    expect(applyMessage([a], { type: 'order_ready', payload: {} }).tickets).toEqual([a]);
  });

  it('a table being cleared asks for a fresh read, since the message does not say which tickets went', () => {
    for (const type of ['CLEAR_TABLE', 'bill_cleared', 'order_cleared']) {
      expect(applyMessage([a], { type, payload: {} }).refetch, type).toBe(true);
    }
  });

  it('what it does not know it ignores, and junk cannot break it', () => {
    expect(applyMessage([a], { type: 'SOMETHING_NEW', payload: {} })).toEqual({ tickets: [a], refetch: false });
    expect(applyMessage([a], null)).toEqual({ tickets: [a], refetch: false });
    expect(applyMessage([a], { type: 'NEW_ORDER' })).toEqual({ tickets: [a], refetch: false });
    expect(applyMessage([a], { type: 'TICKET_UPDATED', payload: { ticket: { no: 'id' } } }).tickets).toEqual([a]);
  });

  it('upsert keeps the order of what is there and puts a newcomer first', () => {
    expect(upsertTicket([a, b], { ...a, note: 'x' }).map(t => t.id)).toEqual(['a', 'b']);
    expect(upsertTicket([a], b).map(t => t.id)).toEqual(['b', 'a']);
    expect(upsertTicket([a], null)).toEqual([a]);
  });
});

describe('merging a fresh read with what live messages brought in', () => {
  const at = (id, updated) => ({ id, updated_at: updated, items: [] });

  it('with nothing in memory, the fetched list is simply taken', () => {
    expect(mergeFetched([], [at('a', '1'), at('b', '1')]).map(t => t.id)).toEqual(['a', 'b']);
  });

  it('a ticket a live message brought in during the read survives an answer that predates it', () => {
    // The hub answered, THEN made ticket n, and the message beat the answer here.
    const merged = mergeFetched([at('n', '2')], [at('a', '1')], new Set(['n']));
    expect(merged.map(t => t.id).sort()).toEqual(['a', 'n']);
  });

  it('a ticket the hub no longer lists is dropped, because it was cleared', () => {
    expect(mergeFetched([at('gone', '1'), at('a', '1')], [at('a', '1')], new Set()).map(t => t.id)).toEqual(['a']);
  });

  it('of one ticket in both places, whichever the hub touched last wins', () => {
    const newer = { ...at('a', '2026-10-19T12:05:00.000Z'), note: 'from a message' };
    const older = { ...at('a', '2026-10-19T12:01:00.000Z'), note: 'from the read' };
    expect(mergeFetched([newer], [older])[0].note).toBe('from a message');
    expect(mergeFetched([older], [newer])[0].note).toBe('from a message');
  });

  it('an exact tie goes to the fetched copy', () => {
    expect(mergeFetched([{ ...at('a', '5'), note: 'held' }], [{ ...at('a', '5'), note: 'fetched' }])[0].note).toBe('fetched');
  });

  it('a ticket with no updated_at at all is replaced by the fetched one rather than crashing', () => {
    expect(mergeFetched([{ id: 'a' }], [{ id: 'a', note: 'x' }])[0].note).toBe('x');
  });

  it('copes with nothing at all', () => {
    expect(mergeFetched(undefined, undefined)).toEqual([]);
    expect(mergeFetched([at('a', '1')], [], new Set())).toEqual([]);
  });
});

describe('new work, for the sound', () => {
  it('a new order is new work for the station that has lines on it, and only that station', () => {
    const t = make([line('Dal', 'hot'), line('Chaas', 'bar')]);
    expect([...pendingKeys([t], 'bar')]).toEqual(['t1:1']);
    expect([...pendingKeys([t], 'cold')]).toEqual([]);
  });

  it('a held course being fired is new work, which is the moment the station needs to hear it', () => {
    const staged = make([line('Starter', 'hot', 1), line('Main', 'hot', 2)], { staged: true });
    const afterStarter = markStationReady(staged, 'hot', T(4)).ticket;
    const before = pendingKeys([afterStarter], 'hot');
    const after = pendingKeys([fireCourse(afterStarter, 2, T(9)).ticket], 'hot');
    expect([...before]).toEqual([]);
    expect([...after]).toEqual(['t1:2']);
  });

  it('finishing work is not new work', () => {
    const t = make([line('Dal', 'hot')]);
    const before = pendingKeys([t], 'hot');
    const after = pendingKeys([markStationReady(t, 'hot', T(3)).ticket], 'hot');
    expect([...after].filter(k => !before.has(k))).toEqual([]);
  });
});

describe('a line as it is printed on the card', () => {
  it('shows quantity, name, size and what was chosen', () => {
    expect(describeLine({ qty: 2, name: 'Biryani', variant_label: 'Full', modifiers: [{ option_label: 'Extra spicy' }, { option_label: 'No onion' }] }))
      .toEqual({ qty: 2, name: 'Biryani', size: 'Full', mods: ['Extra spicy', 'No onion'] });
  });
  it('defaults sensibly when fields are missing', () => {
    expect(describeLine({ name: 'Chai' })).toEqual({ qty: 1, name: 'Chai', size: '', mods: [] });
    expect(describeLine({ name: 'Chai', modifiers: 'nope' }).mods).toEqual([]);
    expect(describeLine(undefined)).toEqual({ qty: 1, name: '', size: '', mods: [] });
  });
});
