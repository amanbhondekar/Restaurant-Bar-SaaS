import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { windowFor, salesReport, summaryText, startOfDay, dayKey } from './analytics.js';
import { normalizePhone, whatsappLink } from './guestContact.js';

// Scheduled summaries (§3 analytics): a daily summary the morning after, and a weekly one on Monday,
// prepared by the hub on a timer and kept as a record.
//
// What "scheduled" can honestly mean here. The hub can prepare a summary on a schedule and have it waiting;
// it cannot send one, because sending a WhatsApp message is something a person's phone does (the same
// click-to-chat decision as bookings and the shopping list: no provider, no per-message fee, nothing stored
// that is not needed). So a summary is PREPARED automatically and SENT by a tap, and the screen says which
// it is. An owner's number is stored in plain because a link to message someone cannot be built from a hash.
//
// A summary is FROZEN when it is made: it says what the figures were that morning. A refund the next day does
// not rewrite last week's record -- reception reconciles against the cash screen, and a report that changes
// after it was read is a worse record than one that is slightly out of date.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'reports.json');

const CATCH_UP_DAYS = 14;   // a hub switched on after a quiet fortnight does not write a fortnight of summaries
const CATCH_UP_WEEKS = 8;
const KEEP = { day: 120, week: 52 };
const DAY_MS = 24 * 60 * 60 * 1000;

const dayLabel = d => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const rangeLabel = (a, b) => `${a.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(b - 1).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;

export class ReportStore {
  constructor() {
    this.state = this.load();
  }

  load() {
    try {
      if (fs.existsSync(FILE)) {
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { summaries: Array.isArray(parsed.summaries) ? parsed.summaries.filter(s => s && s.id && s.restaurant_id) : [], contacts: parsed.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {} };
        }
      }
    } catch (err) {
      console.warn('⚠️ Could not load reports.json:', err.message);
    }
    return { summaries: [], contacts: {} };
  }

  save() {
    fs.writeFileSync(FILE, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  /** The owner's number, as it was normalised, or null. */
  contactFor(restaurantId) {
    return this.state.contacts[restaurantId] ?? null;
  }

  /** `null` or an empty string removes it. Returns `{ ok, phone }` or a refusal. */
  setContact(restaurantId, input) {
    if (input === null || input === undefined || String(input).trim() === '') {
      delete this.state.contacts[restaurantId];
      this.save();
      return { ok: true, phone: null };
    }
    const phone = normalizePhone(input);
    if (!phone) return { ok: false, code: 'INVALID_PHONE', error: 'That does not look like a mobile number.' };
    this.state.contacts[restaurantId] = phone;
    this.save();
    return { ok: true, phone };
  }

  /** Newest first. Each carries the link that opens WhatsApp with it written, to the owner if a number is set. */
  list(restaurantId, limit = 60) {
    const phone = this.contactFor(restaurantId);
    return this.state.summaries
      .filter(s => s.restaurant_id === restaurantId)
      .sort((a, b) => b.from.localeCompare(a.from) || (a.kind === 'week' ? -1 : 1))
      .slice(0, limit)
      .map(s => ({ ...s, whatsapp: phone ? whatsappLink(phone, s.text) : `https://wa.me/?text=${encodeURIComponent(s.text)}` }));
  }

  markSent(restaurantId, id, now = new Date()) {
    const s = this.state.summaries.find(x => x.id === id && x.restaurant_id === restaurantId);
    if (!s) return { ok: false, code: 'NOT_FOUND', error: 'No such summary.' };
    if (!s.sent_at) { s.sent_at = now.toISOString(); this.save(); }
    return { ok: true, summary: s };
  }

  /**
   * Prepare any daily and weekly summary that is due and missing. Idempotent: safe to call on a timer, at
   * boot and whenever the screen is opened. Returns how many it made.
   *
   * A day or week gets a summary only if something happened in it: a restaurant closed on Mondays does not
   * get a Monday report saying nothing, and the reader is not taught to ignore them.
   */
  ensure({ invoices, visits, restaurantId, currency = '₹', now = new Date() }) {
    const have = new Set(this.state.summaries.filter(s => s.restaurant_id === restaurantId).map(s => s.id));
    // Where to stop looking back: the first bill. A refund or void comes after its sale, so only the sale's
    // own dates can be the earliest; whether a day had business is the ledger's to say (see `active`).
    const stamps = [];
    for (const i of Array.isArray(invoices) ? invoices : []) {
      if (i?.restaurant_id !== restaurantId) continue;
      for (const k of ['issued_at', 'paid_at']) { const t = Date.parse(i[k]); if (Number.isFinite(t)) stamps.push(t); }
    }
    if (stamps.length === 0) return 0;

    const today = startOfDay(now);
    const firstDay = startOfDay(new Date(Math.min(...stamps)));
    const made = [];
    const make = (kind, key, from, to, title) => {
      const id = `${kind}:${key}`;
      if (have.has(id)) return;
      const win = windowFor('custom', now, { from, to });
      const report = salesReport({ invoices, visits, restaurantId, window: win.ok ? { ...win, label: title, previous_label: kind === 'day' ? 'the day before' : 'the week before' } : win });
      const active = report.current.bills.count > 0 || report.current.takings.payments > 0 || report.current.takings.refunds > 0;
      if (!active) return;
      made.push({
        id, kind, key, restaurant_id: restaurantId, title,
        from: from.toISOString(), to: to.toISOString(), created_at: now.toISOString(), sent_at: null,
        text: summaryText(report, { title, currency }),
        report: { period: report.period, takings: report.current.takings, bills: report.current.bills, voided: report.current.voided, top_dishes: report.current.top_dishes, busiest_hour: report.current.busiest_hour, comparison: report.comparison, guests: report.guests }
      });
    };

    // Whole days that have ended, newest within the catch-up limit.
    for (let n = 1; n <= CATCH_UP_DAYS; n++) {
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
      if (from < firstDay) break;
      make('day', dayKey(from), from, new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1), `Daily summary — ${dayLabel(from)}`);
    }
    // Whole weeks (Monday to Monday) that have ended.
    const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
    for (let n = 1; n <= CATCH_UP_WEEKS; n++) {
      const from = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 * n);
      if (from < new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() - 6)) break;
      const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
      make('week', dayKey(from), from, to, `Weekly summary — ${rangeLabel(from, to)}`);
    }

    if (made.length === 0) return 0;
    const all = [...this.state.summaries, ...made];
    // Keep the newest of each kind so the file does not grow for ever.
    const keep = new Set();
    for (const kind of ['day', 'week']) {
      all.filter(s => s.kind === kind && s.restaurant_id === restaurantId).sort((a, b) => b.from.localeCompare(a.from)).slice(0, KEEP[kind]).forEach(s => keep.add(s.id));
    }
    this.state.summaries = all.filter(s => s.restaurant_id !== restaurantId || keep.has(s.id));
    this.save();
    return made.length;
  }
}

export const reportStore = new ReportStore();
export const DAY = DAY_MS;
