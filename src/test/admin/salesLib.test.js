import { describe, expect, it } from 'vitest';
import {
  changeText, changeTone, customRange, dishLine, guestLine, hourRows, kpis, methodLine, money, monthLabel, moreDishes, retentionLine, showPhone
} from '@/admin/lib/sales';

const d = (direction, pct = null, change = 0) => ({ direction, pct, change, current: 0, previous: 0 });

describe('money', () => {
  it('uses Indian grouping and the restaurant\'s currency, and shows a dash for what is not known', () => {
    expect(money(123456.5)).toBe('₹1,23,456.5');
    expect(money(0)).toBe('₹0');
    expect(money(40, '$')).toBe('$40');
    expect(money(null)).toBe('–');
    expect(money(undefined)).toBe('–');
  });
});

describe('changeText', () => {
  it('says how much, which way, and against what', () => {
    expect(changeText(d('up', 12.5), 'yesterday so far')).toBe('up 12.5% on yesterday so far');
    expect(changeText(d('down', -8), 'the week before')).toBe('down 8% on the week before');
  });
  it('says "the same" and "new" without a percentage, and nothing when the hub could not say', () => {
    expect(changeText(d('same'), 'the week before')).toBe('the same as the week before');
    expect(changeText(d('new'), 'the week before')).toBe('new: nothing to compare with');
    expect(changeText(d('unknown'), 'x')).toBe('');
    expect(changeText(null, 'x')).toBe('');
  });
});

describe('changeTone', () => {
  it('is good news when takings, bills or the average rise, bad when they fall', () => {
    expect(changeTone(d('up', 5), 'net')).toBe('good');
    expect(changeTone(d('down', -5), 'bills')).toBe('bad');
  });
  it('does not judge refunds or voids either way, nor a change with no size', () => {
    expect(changeTone(d('up', 50), 'refunds')).toBe('neutral');
    expect(changeTone(d('down', -50), 'voided')).toBe('neutral');
    expect(changeTone(d('same'), 'net')).toBe('neutral');
    expect(changeTone(d('new'), 'net')).toBe('neutral');
  });
});

const REPORT = {
  period: { previous_label: 'yesterday so far' },
  current: { takings: { net: 1000, refunds: 0, by_method: {} }, bills: { count: 4, average: 250 }, voided: { count: 0, total: 0 } },
  comparison: { net: d('up', 10), bills: d('same'), average_bill: d('down', -3), refunds: d('same'), voided: d('same') }
};

describe('kpis', () => {
  it('lists takings, bills and the average bill, each with its change', () => {
    const rows = kpis(REPORT, '₹');
    expect(rows.map(r => [r.label, r.value, r.change])).toEqual([
      ['Takings', '₹1,000', 'up 10% on yesterday so far'],
      ['Bills', '4', 'the same as yesterday so far'],
      ['Average bill', '₹250', 'down 3% on yesterday so far']
    ]);
  });
  it('adds refunds and voided bills only when there were some', () => {
    const rows = kpis({ ...REPORT, current: { ...REPORT.current, takings: { net: 800, refunds: 200, by_method: {} }, voided: { count: 2, total: 350 } } }, '₹');
    expect(rows.map(r => r.label)).toEqual(['Takings', 'Bills', 'Average bill', 'Refunded', 'Voided bills']);
    expect(rows.find(r => r.id === 'voided').value).toBe('2 (₹350)');
  });
  it('shows a dash for an average when no bill was raised', () => {
    const rows = kpis({ ...REPORT, current: { ...REPORT.current, bills: { count: 0, average: null } } }, '₹');
    expect(rows.find(r => r.id === 'average_bill').value).toBe('–');
  });
});

describe('methodLine', () => {
  it('names the methods that took money, largest first, and skips the rest', () => {
    expect(methodLine({ cash: 500, upi: 1200, card: 0, other: 0 }, '₹')).toBe('UPI ₹1,200 · Cash ₹500');
    expect(methodLine({ cash: 0 }, '₹')).toBe('');
    expect(methodLine(undefined, '₹')).toBe('');
  });
});

describe('dishes', () => {
  it('counts portions in the singular and the plural', () => {
    expect(dishLine({ qty: 1, revenue: 300 }, '₹')).toBe('1 portion · ₹300');
    expect(dishLine({ qty: 12, revenue: 3600 }, '₹')).toBe('12 portions · ₹3,600');
  });
  it('says how many dishes are not shown, or nothing when all are', () => {
    expect(moreDishes({ dish_count: 12, top_dishes: [1, 2, 3, 4, 5] })).toBe('and 7 more dishes');
    expect(moreDishes({ dish_count: 6, top_dishes: [1, 2, 3, 4, 5] })).toBe('and 1 more dish');
    expect(moreDishes({ dish_count: 5, top_dishes: [1, 2, 3, 4, 5] })).toBe('');
  });
});

describe('hourRows', () => {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, bills: 0, billed: 0 }));
  const set = (hour, bills, billed) => { hours[hour] = { hour, bills, billed }; };

  it('draws from the first busy hour to the last, quiet hours between included, nothing outside', () => {
    set(12, 2, 400); set(13, 0, 0); set(14, 1, 1000);
    const rows = hourRows(hours, '₹');
    expect(rows.map(r => r.label)).toEqual(['12pm', '1pm', '2pm']);
    expect(rows.map(r => r.percent)).toEqual([40, 0, 100]);
    expect(rows.map(r => r.text)).toEqual(['2 bills · ₹400', 'no bills', '1 bill · ₹1,000']);
  });
  it('labels midnight and noon the way people say them', () => {
    const h = Array.from({ length: 24 }, (_, hour) => ({ hour, bills: hour === 0 || hour === 12 ? 1 : 0, billed: hour === 0 || hour === 12 ? 10 : 0 }));
    const rows = hourRows(h, '₹');
    expect(rows[0].label).toBe('12am');
    expect(rows[rows.length - 1].label).toBe('12pm');
  });
  it('draws nothing when there were no bills', () => {
    expect(hourRows(Array.from({ length: 24 }, (_, hour) => ({ hour, bills: 0, billed: 0 })), '₹')).toEqual([]);
    expect(hourRows(undefined, '₹')).toEqual([]);
  });
});

describe('guests', () => {
  it('says how many were new and how many returned, in the right number', () => {
    expect(guestLine({ guests: 12, new: 5, returning: 7 })).toBe('12 guests: 5 new, 7 returning');
    expect(guestLine({ guests: 1, new: 1, returning: 0 })).toBe('1 guest: 1 new, 0 returning');
  });
  it('says plainly when nobody was recorded, rather than "0 guests: 0 new"', () => {
    expect(guestLine({ guests: 0, new: 0, returning: 0 })).toMatch(/No seated bookings/);
    expect(guestLine(null)).toMatch(/No seated bookings/);
  });
  it('says how many of the period before\'s new guests came again, or nothing with nobody to measure', () => {
    expect(retentionLine({ retention: { of: 8, returned: 3, pct: 38 } })).toBe('Of the 8 guests who were new in the period before, 3 came again (38%).');
    expect(retentionLine({ retention: { of: 1, returned: 1, pct: 100 } })).toBe('Of the 1 guest who was new in the period before, 1 came again (100%).');
    expect(retentionLine({ retention: null })).toBe('');
  });
  it('names a cohort month', () => {
    expect(monthLabel('2026-10')).toBe('Oct 2026');
    expect(monthLabel('2026-01')).toBe('Jan 2026');
    expect(monthLabel('garbage')).toBe('garbage');
  });
});

describe('customRange', () => {
  it('runs from the start of the first day to the start of the day after the last, so both days count', () => {
    const r = customRange('2026-10-10', '2026-10-12');
    expect(r.ok).toBe(true);
    expect(new Date(r.from).getTime()).toBe(new Date(2026, 9, 10).getTime());
    expect(new Date(r.to).getTime()).toBe(new Date(2026, 9, 13).getTime());
  });
  it('a single day is a range of one day', () => {
    const r = customRange('2026-10-10', '2026-10-10');
    expect(new Date(r.to).getTime() - new Date(r.from).getTime()).toBeGreaterThanOrEqual(23 * 3600 * 1000);
    expect(new Date(r.to).getTime()).toBe(new Date(2026, 9, 11).getTime());
  });
  it('rolls over a month end', () => {
    expect(new Date(customRange('2026-10-30', '2026-10-31').to).getTime()).toBe(new Date(2026, 10, 1).getTime());
  });
  it('refuses a missing date and a last day before the first, saying why', () => {
    expect(customRange('', '2026-10-10')).toEqual({ ok: false, error: 'Choose both dates.' });
    expect(customRange('2026-10-10', '')).toEqual({ ok: false, error: 'Choose both dates.' });
    expect(customRange('not a date', '2026-10-10').ok).toBe(false);
    expect(customRange('2026-10-12', '2026-10-10')).toEqual({ ok: false, error: 'The last day cannot be before the first.' });
  });
});

describe('showPhone', () => {
  it('shows an Indian number the way it is written, and any other with a plus', () => {
    expect(showPhone('919876543210')).toBe('+91 98765 43210');
    expect(showPhone('14155550123')).toBe('+14155550123');
    expect(showPhone(null)).toBe('');
  });
});
