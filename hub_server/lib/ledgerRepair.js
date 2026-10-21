// Repairing a PARTIAL ledger (§4.1): some bills on the hub, others only in the cloud.
//
// `restoreLedgerFromCloud` deliberately only ever fills an EMPTY store, and refuses to touch a hub
// that holds anything. That is the right rule for a restore, because a hub that holds bills is the
// authority on them and a blind pull could resurrect a bill someone voided or undo a settlement
// that has not been pushed yet.
//
// But it leaves a real gap: a hub restored from a backup older than the cloud, or one that lost part
// of its data directory, has SOME bills -- so restore refuses -- and is quietly missing the rest,
// for good. Repair closes that gap with the narrowest rule that is safe:
//
//   * a record on the hub is never changed, whatever the cloud says about it;
//   * a record only the cloud has is added;
//   * a record only the hub has is kept and left to the ordinary backfill to push.
//
// In other words it is a union keyed on the hub's own id, where the hub wins every conflict. Nothing
// is overwritten and nothing is deleted, so the worst a repair can do is add a bill that was already
// settled -- which is what being short of it was.
//
// This is deliberately NOT automatic. It reads the whole cloud ledger, and a hub that is merely
// behind on pushing is indistinguishable at a glance from one that has lost records. Reception asks
// for it, and gets told exactly what it did. What IS automatic is noticing: see `ledgerGap`.

/** Every record keyed by the hub's own id. A record with no id cannot be matched, so it is dropped. */
const byId = records => new Map((records || []).filter(r => r && r.id).map(r => [String(r.id), r]));

/**
 * Merge a cloud ledger into a local one. Returns the merged list and exactly what was added, so the
 * caller can report it rather than claiming a number nobody can check.
 *
 * `order` sorts the result the way the store keeps it, because the merged records are inserted among
 * existing ones rather than appended.
 */
export function mergeById(local, cloud, order) {
  const mine = byId(local);
  const added = [];
  for (const [id, record] of byId(cloud)) {
    if (mine.has(id)) continue;             // the hub's copy stands, always
    mine.set(id, record);
    added.push(record);
  }
  const merged = [...mine.values()];
  return { merged: order ? [...merged].sort(order) : merged, added };
}

/** Newest first, which is how the invoice store keeps its bills. */
export const byIssuedDesc = (a, b) => String(b.issued_at ?? '').localeCompare(String(a.issued_at ?? ''));

/** Oldest first by shift number, which is how the cash-up store keeps its records. */
export const bySeqAsc = (a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0);

/**
 * What a repair would do, in words, without doing it. `invoices` and `cashups` are the records it
 * would add.
 *
 * Reception is about to change the restaurant's financial history, so this says what it is and what
 * it is not: which bills, over what period, and that nothing already here will be touched.
 */
export function describeRepair({ invoices = [], cashups = [] } = {}) {
  if (invoices.length === 0 && cashups.length === 0) {
    return { changed: false, summary: 'Nothing is missing. The hub already holds every bill and cash-up the cloud has.' };
  }
  const parts = [];
  if (invoices.length) {
    const numbers = invoices.map(i => i.invoice_number).filter(Boolean).sort();
    const range = numbers.length > 1 ? `${numbers[0]} to ${numbers.at(-1)}` : numbers[0];
    parts.push(`${invoices.length} bill${invoices.length === 1 ? '' : 's'}${range ? ` (${range})` : ''}`);
  }
  if (cashups.length) parts.push(`${cashups.length} cash-up${cashups.length === 1 ? '' : 's'}`);
  return {
    changed: true,
    summary: `${parts.join(' and ')} are in the cloud but not on this hub. Adding them changes nothing that is already here.`
  };
}

/**
 * Whether the cloud holds more than the hub, from counts alone.
 *
 * Cheap enough to run at boot: two counting queries, not a ledger download. A hub that is merely
 * behind on PUSHING has MORE than the cloud, not fewer, so it never reports a gap -- which is what
 * makes a reported gap worth acting on.
 *
 * It is a tripwire, not a reconciliation. Equal counts do NOT mean equal ledgers: a hub holding
 * bills 1 and 2 while the cloud holds 2 and 3 counts the same on both sides and is still missing
 * one. Only comparing ids finds that, which is what the repair itself does -- so the repair is
 * always offered, not just when this says to look.
 */
export function ledgerGap({ localInvoices, cloudInvoices, localCashups, cloudCashups }) {
  const invoices = Math.max(0, (Number(cloudInvoices) || 0) - (Number(localInvoices) || 0));
  const cashups = Math.max(0, (Number(cloudCashups) || 0) - (Number(localCashups) || 0));
  return { invoices, cashups, short: invoices > 0 || cashups > 0 };
}
