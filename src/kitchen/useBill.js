import { useEffect, useRef, useState } from 'react';
import { buildAdjustmentBody, equalSplitRows, amountSplitPayload, initialItemAssignments, itemSplitPayload } from '../lib/kitchenBill';

// The bill: its state, and everything reception can do to it from the Kitchen Display (preview, close, pay, split, void,
// refund, print). Moved out of kitchen_main.jsx unchanged. It needs the hub's address, and a way to re-read the board
// (a voided bill reopens its tickets).
export function useBill({ hubHost, fetchActiveTickets }) {
  // Bill preview modal state (M1 billing foundation + adjustments)
  const [billTableId, setBillTableId] = useState(null);
  const [billInvoice, setBillInvoice] = useState(null);
  // True once the bill on screen has been issued: from then on nothing recalculates it (see fetchBillPreview).
  const billIssuedRef = useRef(false);
  // What the bill on screen was last asked for (table and adjustments), so the delayed recalculation does not ask again for
  // what it was just given: opening a bill fetches it at once, and the effect below would fetch the same thing 220 ms later.
  const previewKeyRef = useRef('');
  const [billLoading, setBillLoading] = useState(false);
  const [billError, setBillError] = useState('');
  const [billAdjustments, setBillAdjustments] = useState({
    discount_type: 'percent', // 'percent' | 'flat'
    discount_value: '',
    discount_reason: '',
    service_charge_percent: ''
  });

  // Custom-amount split state (M1 PR 5). null when the sub-panel is closed.
  const [amountSplitDraft, setAmountSplitDraft] = useState(null);
  // Item-split state (M1 PR 6). Kept as an array `assignments[itemIndex] = splitIndex`
  // plus a `count` so the picker can render N pills per row.
  const [itemSplitDraft, setItemSplitDraft] = useState(null);
  // Optional payment reference (UPI txn id, card auth code…). Cleared when the
  // modal is dismissed. Applies to both parent mark-paid and per-split mark-paid.
  const [paymentRef, setPaymentRef] = useState('');
  // Rendered receipt preview shown after a print request completes. When set,
  // an overlay renders the monospace preview_text with a Close button.
  const [printPreview, setPrintPreview] = useState(null); // { title, text, previewOnly }

  // Fetch a preview for the current adjustments. Both the initial open and
  // any recalculation from the modal route through here.
  const fetchBillPreview = async (tableId, adj) => {
    // An issued bill is never recalculated. The preview is asked for a moment after the last keystroke, so a bill
    // closed straight after typing a discount would otherwise be asked about once it is gone, be told there is
    // nothing to preview, and have the issued invoice wiped from the screen. (A preview already in flight cannot be
    // overtaken by a close: the Close button is disabled while one is.)
    if (billIssuedRef.current) return;
    previewKeyRef.current = `${tableId}|${JSON.stringify(adj)}`;
    const body = buildAdjustmentBody(adj);
    const hasAdjustments = Object.keys(body).length > 0;
    setBillLoading(true);
    setBillError('');
    try {
      const res = hasAdjustments
        ? await fetch(`${hubHost}/tables/${tableId}/invoice/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          })
        : await fetch(`${hubHost}/tables/${tableId}/invoice`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        setBillInvoice(data.invoice);
      } else {
        setBillInvoice(null);
        setBillError(data.error || `Could not load bill for table ${tableId}.`);
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  // Open bill preview for a table — folds every open ticket on that table
  // into a single invoice and pulls tax breakdown from the hub.
  const openBill = async (tableId) => {
    if (!tableId && tableId !== 0) return;
    setBillTableId(tableId);
    setBillInvoice(null);
    setBillError('');
    const fresh = {
      discount_type: 'percent',
      discount_value: '',
      discount_reason: '',
      service_charge_percent: ''
    };
    setBillAdjustments(fresh);
    fetchBillPreview(tableId, fresh);
  };

  // Whatever the screen is showing, an issued bill (it has an invoice number) is not to be recalculated.
  useEffect(() => { billIssuedRef.current = Boolean(billInvoice?.invoice_number); }, [billInvoice]);

  // Debounce recomputation while reception is typing amounts.
  useEffect(() => {
    if (billTableId === null) return;
    if (previewKeyRef.current === `${billTableId}|${JSON.stringify(billAdjustments)}`) return;   // already showing this
    const t = setTimeout(() => fetchBillPreview(billTableId, billAdjustments), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billAdjustments, billTableId]);

  const closeBill = () => {
    setBillTableId(null);
    setBillInvoice(null);
    setBillError('');
    setAmountSplitDraft(null);
    setItemSplitDraft(null);
    setPaymentRef('');
    setPrintPreview(null);
  };

  // Ask the hub to print (or preview, if no printer is configured) the
  // customer receipt for the currently-open invoice.
  const printReceipt = async () => {
    if (!billInvoice?.id) return;
    setBillLoading(true);
    try {
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/print-receipt`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const target = data.results?.[0];
        setPrintPreview({
          title: `Receipt · ${billInvoice.invoice_number}`,
          text: data.preview_text || '',
          previewOnly: !!target?.preview,
          status: target ? (target.ok ? (target.preview ? 'preview' : 'sent') : 'error') : 'preview',
          error: target && !target.ok ? target.error : null
        });
        setBillError('');
      } else {
        setBillError(data.error || 'Could not print receipt.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  // Close the bill with whatever the modal is currently showing.
  const commitBill = async () => {
    if (billTableId === null) return;
    const body = buildAdjustmentBody(billAdjustments);
    setBillLoading(true);
    try {
      const res = await fetch(`${hubHost}/tables/${billTableId}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        // Show the issued invoice one last time so reception has the number.
        setBillInvoice(data.invoice);
        setBillError('');
      } else {
        setBillError(data.error || 'Could not close the bill.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  // Mark an issued invoice paid — the seam future payment-capture code
  // will hook into. Method is captured now; the actual integration lands
  // in a follow-up PR.
  const markPaid = async (method) => {
    if (!billInvoice?.id) return;
    setBillLoading(true);
    try {
      const payload = { payment_method: method };
      const ref = paymentRef.trim();
      if (ref) payload.payment_ref = ref;
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        setBillInvoice(data.invoice);
        setBillError('');
        setPaymentRef('');
      } else {
        setBillError(data.error || 'Could not mark invoice paid.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  // Refund a paid invoice — reception is prompted for a required reason.
  // For split invoices, every paid share flips to refunded server-side too.
  const refundInvoice = async () => {
    if (!billInvoice?.id) return;
    const reason = window.prompt(
      `Refund ${billInvoice.invoice_number} (${billInvoice.currency}${billInvoice.grand_total})?\n\nReason:`
    );
    if (!reason || !reason.trim()) return;
    setBillLoading(true);
    try {
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        setBillInvoice(data.invoice);
        setBillError('');
      } else {
        setBillError(data.error || 'Could not refund the invoice.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  // Split the issued invoice into N equal seat shares. Reception picks
  // the seat count from the modal, and the resulting shares surface as
  // per-row Mark Paid actions.
  const splitBySeats = async (count) => {
    if (!billInvoice?.id || !count) return;
    setBillLoading(true);
    try {
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/split-by-seats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: Number(count) })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        setBillInvoice(data.invoice);
        setBillError('');
      } else {
        setBillError(data.error || 'Could not split the bill.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  // Kick off the "custom amounts" sub-panel with N empty rows, seeded with
  // an equal-split hint so reception can edit from a sensible starting point.
  const openAmountSplit = (count = 2) => {
    const rows = equalSplitRows(billInvoice?.grand_total, count);
    if (rows.length === 0) return;
    setAmountSplitDraft({ rows });
  };

  const closeAmountSplit = () => setAmountSplitDraft(null);

  const submitAmountSplit = async () => {
    if (!billInvoice?.id || !amountSplitDraft) return;
    const payload = amountSplitPayload(amountSplitDraft.rows);
    setBillLoading(true);
    try {
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/split-by-amounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        setBillInvoice(data.invoice);
        setBillError('');
        setAmountSplitDraft(null);
      } else {
        setBillError(data.error || 'Could not split by amount.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  // "By items" sub-panel state. Every line starts on split 1; reception
  // clicks a pill (1..N) to reassign a line to that split.
  const openItemSplit = (count = 2) => {
    if (!billInvoice?.items?.length) return;
    setItemSplitDraft({
      count,
      assignments: initialItemAssignments(billInvoice.items.length)
    });
  };

  const closeItemSplit = () => setItemSplitDraft(null);

  const submitItemSplit = async () => {
    if (!billInvoice?.id || !itemSplitDraft) return;
    const payload = itemSplitPayload(itemSplitDraft.count, itemSplitDraft.assignments);
    setBillLoading(true);
    try {
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/split-by-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        setBillInvoice(data.invoice);
        setBillError('');
        setItemSplitDraft(null);
      } else {
        setBillError(data.error || 'Could not split by items.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  const unsplitInvoice = async () => {
    if (!billInvoice?.id) return;
    setBillLoading(true);
    try {
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/splits`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        setBillInvoice(data.invoice);
        setBillError('');
      } else {
        setBillError(data.error || 'Could not unsplit.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  const markSplitPaid = async (splitIndex, method) => {
    if (!billInvoice?.id) return;
    setBillLoading(true);
    try {
      const payload = { payment_method: method };
      const ref = paymentRef.trim();
      if (ref) payload.payment_ref = ref;
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/splits/${splitIndex}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        setBillInvoice(data.invoice);
        setBillError('');
        setPaymentRef('');
      } else {
        setBillError(data.error || 'Could not mark split paid.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  // Void an issued invoice. Reception is prompted for a reason (required),
  // the underlying tickets are reopened on the server, and the modal
  // closes so the reopened tickets appear on the KDS rail again.
  const voidInvoice = async () => {
    if (!billInvoice?.id) return;
    const reason = window.prompt(
      `Void ${billInvoice.invoice_number}? The tickets on ${billInvoice.table_name || 'this table'} will reopen.\n\nReason:`
    );
    if (!reason || !reason.trim()) return;
    setBillLoading(true);
    try {
      const res = await fetch(`${hubHost}/invoices/${billInvoice.id}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.invoice) {
        closeBill();
        fetchActiveTickets();
      } else {
        setBillError(data.error || 'Could not void the invoice.');
      }
    } catch (err) {
      setBillError(`Hub unreachable: ${err.message}`);
    } finally {
      setBillLoading(false);
    }
  };

  return {
    billTableId,
    billInvoice,
    billLoading,
    billError,
    billAdjustments,
    setBillAdjustments,
    amountSplitDraft,
    setAmountSplitDraft,
    itemSplitDraft,
    setItemSplitDraft,
    paymentRef,
    setPaymentRef,
    printPreview,
    setPrintPreview,
    openBill,
    closeBill,
    printReceipt,
    commitBill,
    markPaid,
    refundInvoice,
    splitBySeats,
    openAmountSplit,
    closeAmountSplit,
    submitAmountSplit,
    openItemSplit,
    closeItemSplit,
    submitItemSplit,
    unsplitInvoice,
    markSplitPaid,
    voidInvoice
  };
}
