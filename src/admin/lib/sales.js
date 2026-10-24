// Wording and arithmetic for the Sales tab (§3 analytics). The hub does the sums; this turns them into the
// sentences on the screen, so none of it is buried in markup. Nothing here invents a figure: a number the hub
// could not work out stays missing and is shown as a dash.

export const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom' }
];

export const money = (n, currency = '₹') =>
  (n === null || n === undefined || Number.isNaN(Number(n)) ? '–' : `${currency}${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

const hourLabel = h => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;

/**
 * "up 12% on yesterday so far", "the same as the week before", "new: nothing to compare with", or '' when the
 * hub could not say. `previousLabel` is the hub's own wording for what it was set against.
 */
export function changeText(d, previousLabel) {
  if (!d || d.direction === 'unknown') return '';
  if (d.direction === 'new') return 'new: nothing to compare with';
  if (d.direction === 'same') return previousLabel ? `the same as ${previousLabel}` : 'the same';
  return `${d.direction} ${Math.abs(d.pct)}%${previousLabel ? ` on ${previousLabel}` : ''}`;
}

/**
 * Whether a change is good news. Takings, bills and the average bill rising is; refunds and voids are not
 * judged either way (a rise might be a fault or a busy day), so they are neither green nor red.
 */
export function changeTone(d, metric) {
  if (!d || d.direction === 'unknown' || d.direction === 'same' || d.direction === 'new') return 'neutral';
  if (metric === 'refunds' || metric === 'voided') return 'neutral';
  return d.direction === 'up' ? 'good' : 'bad';
}

/** The headline figures, in the order they are shown. Refunds and voids appear only when there were some. */
export function kpis(report, currency) {
  const c = report.current;
  const k = report.comparison;
  const prev = report.period.previous_label;
  const rows = [
    { id: 'net', label: 'Takings', value: money(c.takings.net, currency), change: changeText(k.net, prev), tone: changeTone(k.net, 'net') },
    { id: 'bills', label: 'Bills', value: String(c.bills.count), change: changeText(k.bills, prev), tone: changeTone(k.bills, 'bills') },
    { id: 'average_bill', label: 'Average bill', value: money(c.bills.average, currency), change: changeText(k.average_bill, prev), tone: changeTone(k.average_bill, 'average_bill') }
  ];
  if (c.takings.refunds > 0) rows.push({ id: 'refunds', label: 'Refunded', value: money(c.takings.refunds, currency), change: changeText(k.refunds, prev), tone: 'neutral' });
  if (c.voided.count > 0) rows.push({ id: 'voided', label: 'Voided bills', value: `${c.voided.count} (${money(c.voided.total, currency)})`, change: changeText(k.voided, prev), tone: 'neutral' });
  return rows;
}

const METHOD = { cash: 'Cash', upi: 'UPI', card: 'Card', other: 'Other' };

/** "Cash ₹5,000 · UPI ₹3,000" -- the methods that took money, largest first. Empty when none did. */
export function methodLine(byMethod, currency) {
  return Object.entries(byMethod || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([m, v]) => `${METHOD[m] || m} ${money(v, currency)}`)
    .join(' · ');
}

/** "Dal Makhani · 12 portions · ₹3,600" */
export const dishLine = (d, currency) => `${d.qty} ${d.qty === 1 ? 'portion' : 'portions'} · ${money(d.revenue, currency)}`;

/** "and 7 more dishes", or '' when the five shown are all of them. */
export function moreDishes(current) {
  const extra = (current.dish_count || 0) - (current.top_dishes?.length || 0);
  return extra > 0 ? `and ${extra} more ${extra === 1 ? 'dish' : 'dishes'}` : '';
}

/**
 * The hours worth drawing: from the first hour with a bill to the last, so a restaurant open 11-11 is not
 * shown 24 rows with half of them empty. Each row says how wide its bar is relative to the busiest hour.
 */
export function hourRows(byHour, currency) {
  const rows = Array.isArray(byHour) ? byHour : [];
  const busy = rows.filter(h => h.bills > 0);
  if (busy.length === 0) return [];
  const first = busy[0].hour;
  const last = busy[busy.length - 1].hour;
  const top = Math.max(...busy.map(h => h.billed));
  return rows
    .filter(h => h.hour >= first && h.hour <= last)
    .map(h => ({
      hour: h.hour,
      label: hourLabel(h.hour),
      bills: h.bills,
      text: h.bills === 0 ? 'no bills' : `${h.bills} ${h.bills === 1 ? 'bill' : 'bills'} · ${money(h.billed, currency)}`,
      percent: top > 0 ? Math.round((h.billed / top) * 100) : 0
    }));
}

/** "12 guests: 5 new, 7 returning" or the honest empty line. */
export function guestLine(g) {
  if (!g || g.guests === 0) return 'No seated bookings or walk-ins recorded in this period.';
  return `${g.guests} ${g.guests === 1 ? 'guest' : 'guests'}: ${g.new} new, ${g.returning} returning`;
}

/** "Of the 8 guests who were new the period before, 3 came again (38%)", or '' with nobody to measure. */
export function retentionLine(g) {
  const r = g?.retention;
  if (!r) return '';
  return `Of the ${r.of} ${r.of === 1 ? 'guest' : 'guests'} who ${r.of === 1 ? 'was' : 'were'} new in the period before, ${r.returned} came again (${r.pct}%).`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10' -> 'Oct 2026'. */
export function monthLabel(key) {
  const [y, m] = String(key).split('-');
  return MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${y}` : String(key);
}

/**
 * The two dates typed into a custom range, as the hub wants them: the start of the first day to the start of
 * the day AFTER the last, in this laptop's local time (the restaurant's). Both days are included.
 */
export function customRange(fromDay, toDay) {
  const parse = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const from = parse(fromDay);
  const last = parse(toDay);
  if (!from || !last) return { ok: false, error: 'Choose both dates.' };
  if (last < from) return { ok: false, error: 'The last day cannot be before the first.' };
  const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return { ok: true, from: from.toISOString(), to: to.toISOString() };
}

/** "+91 98765 43210" from the hub's digits, or the digits with a plus if the length is unusual. */
export function showPhone(digits) {
  if (!digits) return '';
  const d = String(digits);
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`;
}
