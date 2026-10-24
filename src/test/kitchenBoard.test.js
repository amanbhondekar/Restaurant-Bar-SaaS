import { describe, expect, it } from 'vitest';
import { applyLiveMessage, markedReady, statusAfterClose, statusAfterGrace } from '@/lib/kitchenBoard';

const t = (id, n, over = {}) => ({ id, ticket_number: n, status: 'in_progress', items: [], ...over });
const board = [t('a', 1), t('b', 2)];
const msg = (type, payload) => ({ type, payload });

describe('a new order', () => {
  it('goes to the top of the board, and the board is not re-read', () => {
    const r = applyLiveMessage(board, msg('NEW_ORDER', t('c', 3)));
    expect(r.tickets.map(x => x.id)).toEqual(['c', 'a', 'b']);
    expect(r).toMatchObject({ refetch: false, sync: null });
  });

  it('may arrive wrapped in a ticket (order_created) or as the ticket itself (NEW_ORDER)', () => {
    expect(applyLiveMessage(board, msg('order_created', { ticket: t('c', 3), table_name: 'T1' })).tickets[0].id).toBe('c');
    expect(applyLiveMessage(board, msg('NEW_ORDER', t('d', 4))).tickets[0].id).toBe('d');
  });

  it('is not added twice: the hub sends both NEW_ORDER and order_created for one order', () => {
    const once = applyLiveMessage(board, msg('NEW_ORDER', t('c', 3))).tickets;
    expect(applyLiveMessage(once, msg('order_created', { ticket: t('c', 3) })).tickets).toBe(once);
  });

  it('is recognised by its number when the id differs, and a number sent as text still matches', () => {
    expect(applyLiveMessage(board, msg('NEW_ORDER', t('zzz', '2'))).tickets).toBe(board);
  });

  it('with neither an id nor a number is ignored', () => {
    expect(applyLiveMessage(board, msg('NEW_ORDER', { table_name: 'T1' })).tickets).toBe(board);
    expect(applyLiveMessage(board, msg('order_created', {})).tickets).toBe(board);
  });
});

describe('a ticket marked ready', () => {
  it('turns ready, taking the hub\'s whole ticket so the course and station state are current', () => {
    const next = t('a', 1, { courses: { 1: 'done' }, note: 'no onion' });
    const r = applyLiveMessage(board, msg('TICKET_READY', { ticket_id: 'a', ticket: next }));
    expect(r.tickets[0]).toMatchObject({ id: 'a', status: 'ready', courses: { 1: 'done' }, note: 'no onion' });
    expect(r.tickets[1]).toBe(board[1]);
  });

  it('works with an old-style event that names only the ticket', () => {
    expect(applyLiveMessage(board, msg('order_ready', { ticket_id: 'b' })).tickets[1].status).toBe('ready');
    expect(applyLiveMessage(board, msg('TICKET_READY', { ticket_number: 2 })).tickets[1].status).toBe('ready');
    expect(applyLiveMessage(board, msg('TICKET_READY', { id: '2' })).tickets[1].status, 'matched by number as text').toBe('ready');
  });

  it('names nobody: nothing happens', () => {
    expect(applyLiveMessage(board, msg('TICKET_READY', {})).tickets).toBe(board);
  });
});

describe('a ticket updated', () => {
  it('is replaced by the hub\'s copy, matched by id', () => {
    const r = applyLiveMessage(board, msg('TICKET_UPDATED', { ticket: t('b', 2, { status: 'in_progress', fired: 2 }) }));
    expect(r.tickets[1].fired).toBe(2);
    expect(r.tickets[0]).toBe(board[0]);
  });

  it('is not added if this screen is not showing it, and an update without a ticket does nothing', () => {
    expect(applyLiveMessage(board, msg('TICKET_UPDATED', { ticket: t('x', 9) })).tickets).toEqual(board);
    expect(applyLiveMessage(board, msg('TICKET_UPDATED', {})).tickets).toBe(board);
  });
});

describe('a ticket cancelled', () => {
  it('comes off at once, and the board is re-read in case the message did not say everything', () => {
    const r = applyLiveMessage(board, msg('TICKET_CANCELLED', { ticket_id: 'a' }));
    expect(r.tickets.map(x => x.id)).toEqual(['b']);
    expect(r.refetch).toBe(true);
  });

  it('may name the ticket inside the ticket, and one that names nobody still asks for a re-read', () => {
    expect(applyLiveMessage(board, msg('TICKET_CANCELLED', { ticket: t('b', 2) })).tickets.map(x => x.id)).toEqual(['a']);
    const r = applyLiveMessage(board, msg('TICKET_CANCELLED', {}));
    expect(r.tickets).toBe(board);
    expect(r.refetch).toBe(true);
  });
});

describe('a table cleared and the sync status', () => {
  it('a cleared table re-reads the board, whichever of the three names the hub used', () => {
    for (const type of ['CLEAR_TABLE', 'bill_cleared', 'order_cleared']) {
      const r = applyLiveMessage(board, msg(type, { table_id: 1 }));
      expect(r, type).toMatchObject({ tickets: board, refetch: true, sync: null });
    }
  });

  it('a sync status is handed back for the screen to show, and the board is re-read', () => {
    const r = applyLiveMessage(board, msg('SYNC_STATUS_CHANGE', { queued: 3, online: false, isSyncing: false }));
    expect(r.sync).toEqual({ queued: 3, online: false, isSyncing: false });
    expect(r.refetch).toBe(true);
  });
});

describe('what it does not understand', () => {
  it('leaves the board alone: unknown events, no message, no payload', () => {
    for (const m of [msg('SOMETHING_NEW', {}), msg('menu_updated', { items: [] }), { type: 'CONNECTED' }, {}, null, undefined]) {
      const r = applyLiveMessage(board, m);
      expect(r.tickets).toBe(board);
      expect(r.refetch).toBe(false);
      expect(r.sync).toBeNull();
    }
  });

  it('never changes the array it was given', () => {
    const frozen = Object.freeze(board.map(x => Object.freeze({ ...x })));
    expect(() => applyLiveMessage(frozen, msg('NEW_ORDER', t('c', 3)))).not.toThrow();
    expect(() => applyLiveMessage(frozen, msg('TICKET_READY', { ticket_id: 'a' }))).not.toThrow();
    expect(() => applyLiveMessage(frozen, msg('TICKET_CANCELLED', { ticket_id: 'a' }))).not.toThrow();
  });
});

describe('markedReady', () => {
  it('marks the ticket ready and takes the hub\'s copy when there is one', () => {
    const r = markedReady(board, board[0], { ticket: { id: 'a', fired: 2 } });
    expect(r[0]).toMatchObject({ id: 'a', status: 'ready', fired: 2 });
    expect(r[1]).toBe(board[1]);
  });

  it('still marks it ready when the reply carried no ticket, and finds it by number', () => {
    expect(markedReady(board, { ticket_number: 2 }, {})[1].status).toBe('ready');
    expect(markedReady(board, board[0], undefined)[0].status).toBe('ready');
  });
});

describe('the connection light', () => {
  it('a socket that closes in the first seconds still reads "connecting", unless it has failed twice', () => {
    expect(statusAfterClose({ failures: 1, inGracePeriod: true })).toBe('connecting');
    expect(statusAfterClose({ failures: 2, inGracePeriod: true })).toBe('disconnected');
    expect(statusAfterClose({ failures: 5, inGracePeriod: true })).toBe('disconnected');
  });

  it('after the grace period a close is red at once', () => {
    expect(statusAfterClose({ failures: 1, inGracePeriod: false })).toBe('disconnected');
  });

  it('when the grace period ends the light turns red only if it has failed at least twice', () => {
    expect(statusAfterGrace({ failures: 2, current: 'connecting' })).toBe('disconnected');
    expect(statusAfterGrace({ failures: 1, current: 'connecting' })).toBe('connecting');
    expect(statusAfterGrace({ failures: 0, current: 'connected' })).toBe('connected');
  });
});
