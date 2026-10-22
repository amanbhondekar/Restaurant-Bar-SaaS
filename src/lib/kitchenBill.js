// The pure parts of the Kitchen Display's billing screen, lifted out of the component so they can be tested without
// rendering it (`src/kitchen_main.jsx` is one 2,000-line component, which is why nothing about it was).
//
// Everything here turns what reception typed or tapped into what the hub understands. The hub re-validates all of it
// (discounts, splits that must add up to the bill), so a mistake here is not a wrong bill; it is a request the hub
// refuses, or one that means something other than what the person intended.

/**
 * The adjustment form as the body the hub understands. An empty input means "no adjustment on this axis", not 0:
 * a blank discount adds none, while a service charge of 0 is an explicit "waive it".
 */
export function buildAdjustmentBody(adj) {
  const body = {};
  const value = Number(adj.discount_value);
  if (adj.discount_value !== '' && Number.isFinite(value) && value > 0) {
    body.discounts = [{
      type: adj.discount_type,
      value,
      reason: adj.discount_reason?.trim() || undefined
    }];
  }
  if (adj.service_charge_percent !== '') {
    const sc = Number(adj.service_charge_percent);
    if (Number.isFinite(sc) && sc >= 0) body.service_charge_percent = sc;
  }
  return body;
}

/**
 * Rows for "split by custom amounts", seeded with an equal split that adds up to the bill exactly: the odd units go to
 * the first rows rather than being lost. A bill in whole rupees is split in whole rupees (nobody hands over 248.50 in
 * cash because of a 497 bill); a total with a fraction is split in paise, so it cannot drift.
 */
export function equalSplitRows(grandTotal, count = 2) {
  const total = Number(grandTotal);
  if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count < 1) return [];
  const unit = Number.isInteger(total) ? 1 : 100;   // what a "share" is counted in: a rupee, or a paisa
  const units = Math.round(total * unit);
  const base = Math.floor(units / count);
  const extra = units - base * count;
  return Array.from({ length: count }, (_, i) => ({ label: '', share_amount: String((i < extra ? base + 1 : base) / unit) }));
}

/** The request for "split by amounts": rows with nothing in the amount are left out, labels are trimmed. */
export function amountSplitPayload(rows) {
  return {
    splits: rows
      .filter(r => r.share_amount !== '')
      .map(r => ({ label: r.label ? r.label.trim() : undefined, share_amount: Number(r.share_amount) }))
  };
}

/**
 * The request for "split by items": each line goes to the split it is assigned to. A line assigned to a split that does
 * not exist is left out of every split (the hub then refuses a split that does not cover the bill), never quietly
 * filed under another.
 */
export function itemSplitPayload(count, assignments) {
  const buckets = Array.from({ length: count }, () => []);
  assignments.forEach((s, i) => {
    if (s >= 0 && s < buckets.length) buckets[s].push(i);
  });
  return { splits: buckets.map((item_indices, i) => ({ label: `Split ${i + 1}`, item_indices })) };
}

/** Every line starts on split 1; reception taps a pill to move a line. */
export const initialItemAssignments = lineCount => new Array(lineCount).fill(0);

/** What the hub is called by for a ticket: its id, else its number, safe to put in a path. */
export const ticketKey = ticket => encodeURIComponent(ticket.id || ticket.ticket_number);

/**
 * Replace a ticket with the hub's current copy of it, matched by id. A ticket that is not on the board is left out
 * rather than added: a reply about a ticket this screen is not showing must not make it appear.
 */
export function mergeTicketInto(tickets, next) {
  if (!next) return tickets;
  if (!tickets.some(t => t.id === next.id)) return tickets;
  return tickets.map(t => (t.id === next.id ? { ...t, ...next } : t));
}
