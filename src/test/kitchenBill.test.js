import { describe, expect, it } from 'vitest';
import {
  amountSplitPayload, buildAdjustmentBody, equalSplitRows, initialItemAssignments, itemSplitPayload, mergeTicketInto, ticketKey
} from '@/lib/kitchenBill';

const form = over => ({ discount_type: 'percent', discount_value: '', discount_reason: '', service_charge_percent: '', ...over });

describe('buildAdjustmentBody', () => {
  it('an untouched form adjusts nothing', () => {
    expect(buildAdjustmentBody(form())).toEqual({});
  });

  it('a discount carries its type, its value as a number and its trimmed reason', () => {
    expect(buildAdjustmentBody(form({ discount_value: '10', discount_reason: '  regular guest ' }))).toEqual({
      discounts: [{ type: 'percent', value: 10, reason: 'regular guest' }]
    });
    expect(buildAdjustmentBody(form({ discount_type: 'flat', discount_value: '50.5' })).discounts[0]).toEqual({ type: 'flat', value: 50.5, reason: undefined });
  });

  it('a blank, zero, negative or non-numeric discount adds none', () => {
    for (const v of ['', '0', '-5', 'abc', 'Infinity', '  ']) expect(buildAdjustmentBody(form({ discount_value: v })), JSON.stringify(v)).toEqual({});
  });

  it('a service charge of nothing is no change, but zero is an instruction to waive it', () => {
    expect(buildAdjustmentBody(form({ service_charge_percent: '' }))).toEqual({});
    expect(buildAdjustmentBody(form({ service_charge_percent: '0' }))).toEqual({ service_charge_percent: 0 });
    expect(buildAdjustmentBody(form({ service_charge_percent: '5' }))).toEqual({ service_charge_percent: 5 });
  });

  it('a negative or non-numeric service charge is ignored rather than sent', () => {
    for (const v of ['-1', 'x']) expect(buildAdjustmentBody(form({ service_charge_percent: v })), v).toEqual({});
  });

  it('both together', () => {
    expect(buildAdjustmentBody(form({ discount_value: '15', service_charge_percent: '0' }))).toEqual({
      discounts: [{ type: 'percent', value: 15, reason: undefined }], service_charge_percent: 0
    });
  });
});

describe('equalSplitRows', () => {
  const shares = (total, n) => equalSplitRows(total, n).map(r => Number(r.share_amount));
  const sum = list => Math.round(list.reduce((s, x) => s + x, 0) * 100) / 100;

  it('splits a round bill evenly', () => {
    expect(equalSplitRows(500, 2)).toEqual([{ label: '', share_amount: '250' }, { label: '', share_amount: '250' }]);
  });

  it('gives the odd rupees to the first rows so the shares add up to the bill exactly', () => {
    expect(shares(497, 2)).toEqual([249, 248]);
    expect(shares(100, 3)).toEqual([34, 33, 33]);
    expect(shares(10, 4)).toEqual([3, 3, 2, 2]);
  });

  it('always adds up to the bill, for any size of bill and party', () => {
    for (const total of [1, 7, 99, 100, 496, 1234, 99999]) {
      for (const n of [1, 2, 3, 4, 5, 7, 12]) expect(sum(shares(total, n)), `${total} / ${n}`).toBe(total);
    }
  });

  it('works in paise, so a bill with a fraction cannot drift', () => {
    expect(shares(496.5, 2)).toEqual([248.25, 248.25]);
    expect(shares(100.01, 3)).toEqual([33.34, 33.34, 33.33]);
    for (const total of [0.01, 0.1, 19.99, 496.5, 1234.56]) expect(sum(shares(total, 3)), String(total)).toBe(total);
  });

  it('gives nothing to split for a bill that is nothing, or a party that is not a number of people', () => {
    expect(equalSplitRows(0, 2)).toEqual([]);
    expect(equalSplitRows(undefined, 2)).toEqual([]);
    expect(equalSplitRows(-50, 2)).toEqual([]);
    expect(equalSplitRows(100, 0)).toEqual([]);
    expect(equalSplitRows(100, 2.5)).toEqual([]);
  });

  it('starts from the same shares the screen always showed for a whole-rupee bill', () => {
    // The old arithmetic: floor(total / n), with the remainder one rupee each to the first rows.
    const old = (grand, count) => { const base = Math.floor(grand / count); const rem = grand - base * count; return Array.from({ length: count }, (_, i) => String(i < rem ? base + 1 : base)); };
    for (const total of [1, 5, 99, 496, 1001]) for (const n of [2, 3, 4, 6]) expect(equalSplitRows(total, n).map(r => r.share_amount), `${total}/${n}`).toEqual(old(total, n));
  });
});

describe('amountSplitPayload', () => {
  it('sends each amount as a number, trims labels, and omits a blank label', () => {
    expect(amountSplitPayload([{ label: ' Asha ', share_amount: '300' }, { label: '', share_amount: '196.5' }])).toEqual({
      splits: [{ label: 'Asha', share_amount: 300 }, { label: undefined, share_amount: 196.5 }]
    });
  });

  it('leaves out a row with no amount, so a person can remove a share by clearing it', () => {
    expect(amountSplitPayload([{ label: 'A', share_amount: '100' }, { label: 'B', share_amount: '' }]).splits).toHaveLength(1);
  });

  it('keeps a typed amount of zero, which the hub then refuses by name rather than this screen guessing', () => {
    expect(amountSplitPayload([{ label: '', share_amount: '0' }]).splits).toEqual([{ label: undefined, share_amount: 0 }]);
  });
});

describe('itemSplitPayload', () => {
  it('files each line under the split it is assigned to, with numbered labels', () => {
    expect(itemSplitPayload(2, [0, 1, 0, 1, 1])).toEqual({
      splits: [{ label: 'Split 1', item_indices: [0, 2] }, { label: 'Split 2', item_indices: [1, 3, 4] }]
    });
  });

  it('a split nobody was assigned to is sent empty, for the hub to refuse', () => {
    expect(itemSplitPayload(3, [0, 0]).splits.map(s => s.item_indices)).toEqual([[0, 1], [], []]);
  });

  it('a line assigned to a split that does not exist is in none, never quietly under another', () => {
    const { splits } = itemSplitPayload(2, [0, 5, -1, 1]);
    expect(splits.map(s => s.item_indices)).toEqual([[0], [3]]);
  });

  it('every line starts on the first split', () => {
    expect(initialItemAssignments(3)).toEqual([0, 0, 0]);
    expect(itemSplitPayload(2, initialItemAssignments(3)).splits[0].item_indices).toEqual([0, 1, 2]);
  });
});

describe('ticketKey', () => {
  it('uses the id, falls back to the number, and is safe in a path', () => {
    expect(ticketKey({ id: 't_1', ticket_number: 101 })).toBe('t_1');
    expect(ticketKey({ ticket_number: 101 })).toBe('101');
    expect(ticketKey({ id: 'a/b ?c' })).toBe('a%2Fb%20%3Fc');
  });
});

describe('mergeTicketInto', () => {
  const board = [{ id: 'a', status: 'in_progress', items: [1] }, { id: 'b', status: 'in_progress' }];

  it('replaces the matching ticket with the hub\'s copy, keeping what the reply did not mention', () => {
    const next = mergeTicketInto(board, { id: 'a', status: 'ready' });
    expect(next[0]).toEqual({ id: 'a', status: 'ready', items: [1] });
    expect(next[1]).toBe(board[1]);
  });

  it('does not add a ticket the board is not showing', () => {
    expect(mergeTicketInto(board, { id: 'zzz', status: 'ready' })).toBe(board);
  });

  it('ignores an empty reply', () => {
    expect(mergeTicketInto(board, undefined)).toBe(board);
    expect(mergeTicketInto(board, null)).toBe(board);
  });

  it('does not change the list it was given', () => {
    const copy = JSON.stringify(board);
    mergeTicketInto(board, { id: 'a', status: 'ready' });
    expect(JSON.stringify(board)).toBe(copy);
  });
});
