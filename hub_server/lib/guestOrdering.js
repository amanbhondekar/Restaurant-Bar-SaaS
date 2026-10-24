// Letting a guest send an order to the kitchen from the code on their table (§4.5).
//
// This is the hub's SECOND unauthenticated write, and far more consequential than the first: guest
// feedback adds a row nobody acts on, while this puts food on a pass and money on a bill. Everything
// here exists to bound what an unauthenticated caller on the restaurant's wifi can cause.
//
//   OFF BY DEFAULT. A restaurant must turn guest ordering on. A kitchen that starts receiving tickets
//   because a hub was updated would be a genuinely bad thing to do to someone, and "it was in the
//   release notes" is not consent.
//   A REAL TABLE. The order carries the table code from the scanned QR, and that table must exist in
//   the layout. Without it an order has nowhere to go and nobody to bill.
//   THE HUB PRICES IT. As with a waiter's handset: names and prices in the body are ignored entirely.
//   A COOLDOWN AND A CAP. One order per table per minute, and a bounded number of lines and
//   quantities -- so the worst a bored guest can do is a nuisance, not a hundred mains.
//
// What is deliberately NOT here: ordering does not let a guest see the bill, other tables, or anything
// the menu does not already show. The answer to a placed order is the ticket number and nothing else.

export const GUEST_ORDER_COOLDOWN_MS = 60 * 1000;
export const LIMITS = { lines: 20, qtyPerLine: 20, note: 140 };

/** Was an order taken from this table too recently to take another? */
export function isCoolingDown(lastOrderAt, now = Date.now()) {
  if (!lastOrderAt) return false;
  const at = new Date(lastOrderAt).getTime();
  return Number.isFinite(at) && now - at < GUEST_ORDER_COOLDOWN_MS;
}

/**
 * Check what a guest's phone sent, before anything is priced or created.
 *
 * Only `id`, `qty`, `variant_id` and `modifiers` are read: everything else a body might carry is
 * dropped rather than passed along, so a field the pricer gains later cannot be set from outside.
 */
export function validateGuestOrder(body, { tables = [] } = {}) {
  const errors = [];

  const rawTable = typeof body?.table === 'string' ? body.table.trim() : '';
  const table = (tables || []).find(t => String(t.name) === rawTable || String(t.id) === rawTable);
  if (!rawTable) errors.push({ field: 'table', message: 'Scan the code on your table to order.' });
  else if (!table) errors.push({ field: 'table', message: 'That table is not one of ours. Please ask a member of staff.' });

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0) errors.push({ field: 'items', message: 'Nothing has been chosen yet.' });
  else if (rawItems.length > LIMITS.lines) errors.push({ field: 'items', message: `That is more than ${LIMITS.lines} different dishes. Please ask a member of staff.` });

  const items = [];
  for (const raw of rawItems.slice(0, LIMITS.lines)) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    const qty = Math.floor(Number(raw?.qty));
    if (!id || !Number.isFinite(qty) || qty < 1 || qty > LIMITS.qtyPerLine) {
      errors.push({ field: 'items', message: 'One of those lines does not look right. Please try again.' });
      break;
    }
    items.push({
      id,
      qty,
      ...(typeof raw.variant_id === 'string' ? { variant_id: raw.variant_id } : {}),
      ...(Array.isArray(raw.modifiers)
        ? { modifiers: raw.modifiers.slice(0, LIMITS.lines).map(m => ({ group_id: String(m?.group_id ?? ''), option_id: String(m?.option_id ?? '') })) }
        : {})
    });
  }

  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, LIMITS.note) : '';

  return errors.length
    ? { ok: false, errors }
    : { ok: true, order: { table_id: table.id, table_name: table.name, items, ...(note ? { note } : {}) } };
}

/**
 * What a guest is told back. Deliberately thin: the ticket number, so they can refer to it, and
 * nothing about the bill, the table's other orders, or what anything cost.
 *
 * A guest who can read a total can read someone else's by guessing a table, and the menu they already
 * have tells them the prices anyway.
 */
export const guestOrderReceipt = ticket => ({
  success: true,
  ticket_number: ticket.ticket_number,
  message: 'Sent to the kitchen.'
});
