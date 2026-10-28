// Open orders, and cancelling one (§3 inventory limits). Pure wording and rules; no DOM, no React.

// Mirrors the hub's anyCooked (hub_server/lib/courses.js): has any of this order been made? It only decides
// what the confirmation SAYS -- the hub decides what actually happens -- so if the two ever disagree the
// screen is the one that is wrong, and the hub's answer after the cancel is what is reported.
export function anyCooked(ticket) {
  if (!ticket) return false;
  if (ticket.status === 'ready') return true;
  return Object.values(ticket.course_log || {}).some(e => e?.ready_at || e?.recall_count > 0 || Object.keys(e?.stations_ready || {}).length > 0);
}

/** What the confirmation tells reception will happen to the ingredients. */
export function cancelConsequence(ticket) {
  if (anyCooked(ticket)) {
    return 'Some of this has already been made, so its ingredients stay counted as used. The order is taken off the board and the bill.';
  }
  return 'Nothing has been cooked yet, so its ingredients go back into stock. The order is taken off the board and the bill.';
}

/** The sentence reception sees afterwards, from what the hub reports it actually did. */
export function cancelledMessage(ticket, result) {
  const n = `Order #${result?.ticket?.ticket_number ?? ticket?.ticket_number}`;
  if (result?.stock_returned) return `${n} cancelled. Its ingredients are back in stock.`;
  if (result?.cooked) return `${n} cancelled. It had been cooked, so its ingredients stay used.`;
  return `${n} cancelled.`;
}

/** "3 items: Biryani ×2, Chai". Long orders are cut, and the cut says how many it hid. */
export function itemsLine(ticket, max = 3) {
  const lines = Array.isArray(ticket?.items) ? ticket.items : [];
  if (lines.length === 0) return 'No items';
  const shown = lines.slice(0, max).map(l => `${l.name}${Number(l.qty) > 1 ? ` ×${l.qty}` : ''}`).join(', ');
  return lines.length > max ? `${shown} and ${lines.length - max} more` : shown;
}

/** Whole minutes since `iso`, never negative; null for a time that cannot be read. */
export function minutesSince(iso, now = Date.now()) {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60000)) : null;
}

export const ageLabel = minutes => (minutes === null ? '' : minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`);

/** Orders the way a host thinks of them: oldest first, because that is the one most likely to be stuck. */
export const oldestFirst = tickets => [...(tickets || [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

export const CANCEL_REASONS = ['Guest left', 'Guest changed their mind', 'Wrong table', 'Entered by mistake', 'Kitchen cannot make it'];
