import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { ChefHat, CheckCircle2, AlertCircle, Wifi, Cloud, Flame, Timer, RefreshCw, QrCode, StickyNote, Check, Loader, Zap, Receipt, X, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import QRCodeLib from 'qrcode';
import { installCrashReporter } from './services/crashReporter';
import './index.css';
import { ThemeToggle } from './components/ThemeToggle';
import { STATIONS, STATION_LABEL, visibleLines, heldGroups, stationStates, onStationBoard, stationCounts, initialStation } from './lib/ticketView';

installCrashReporter({ source: 'kds' });

const KitchenHubApp = () => {
  const [pairingInfo, setPairingInfo] = useState(null);
  const [qrCodeUrl, setQrCodeUrl] = useState(null);
  const [enrollmentCode, setEnrollmentCode] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [syncStatus, setSyncStatus] = useState({ queued: 0, online: true, isSyncing: false });
  const [wsConnStatus, setWsConnStatus] = useState('connecting'); // 'connecting' | 'connected' | 'disconnected'
  const wsConnected = wsConnStatus === 'connected';
  const missedWsFailuresRef = useRef(0);
  const isGracePeriodRef = useRef(true);
  const [checkedItems, setCheckedItems] = useState({});
  const [loading, setLoading] = useState(true);
  const shouldReduceMotion = useReducedMotion();

  // Which station's screen this is. A bar tablet opens the page as /?station=bar and shows only drinks;
  // the choice is remembered on the device. "all" is the reception / expo view.
  const [stationFilter, setStationFilterState] = useState(() => {
    let stored = null;
    try { stored = window.localStorage.getItem('kullina_kds_station'); } catch { /* storage blocked */ }
    return initialStation(window.location.search, stored);
  });
  const setStationFilter = station => {
    setStationFilterState(station);
    try { window.localStorage.setItem('kullina_kds_station', station); } catch { /* storage blocked */ }
    try {
      const url = new URL(window.location.href);
      if (station === 'all') url.searchParams.delete('station'); else url.searchParams.set('station', station);
      window.history.replaceState(null, '', url);
    } catch { /* not worth failing the screen over */ }
  };
  const [actionError, setActionError] = useState('');

  // Bill preview modal state (M1 billing foundation + adjustments)
  const [billTableId, setBillTableId] = useState(null);
  const [billInvoice, setBillInvoice] = useState(null);
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

  const hubHost = typeof window !== 'undefined'
    ? (window.location.port === '4000'
        ? window.location.origin
        : `${window.location.protocol}//${window.location.hostname}:4000`)
    : 'http://localhost:4000';

  // 1. Fetch Pairing & QR Info
  const fetchPairing = async () => {
    try {
      const res = await fetch(`${hubHost}/pairing-info`);
      if (res.ok) {
        const data = await res.json();
        setPairingInfo(data);
      }
    } catch (err) {
      console.warn('Could not fetch pairing info:', err);
    }
  };

  const fetchQr = async () => {
    try {
      const res = await fetch(`${hubHost}/qr`);
      if (res.ok) {
        const data = await res.json();
        setQrCodeUrl(data.qr_code);
        setEnrollmentCode(data.enrollment_code || null);
        return;
      }
    } catch (err) {
      console.warn('Could not fetch QR from hub, generating locally:', err);
    }
    try {
      const waiterUrl = `${hubHost}/waiter`;
      const dataUrl = await QRCodeLib.toDataURL(waiterUrl, { width: 256, margin: 2 });
      setQrCodeUrl(dataUrl);
    } catch (err) {
      console.warn('Could not generate QR code:', err);
    }
  };

  // 2. Fetch Active Tickets
  const fetchActiveTickets = async () => {
    try {
      const res = await fetch(`${hubHost}/orders/active`);
      if (res.ok) {
        const data = await res.json();
        setTickets(data.tickets || []);
      }
    } catch (err) {
      console.warn('Could not fetch active tickets:', err);
    } finally {
      setLoading(false);
    }
  };

  // 3. Fetch Sync Status
  const fetchSyncStatus = async () => {
    try {
      const res = await fetch(`${hubHost}/sync-status`);
      if (res.ok) {
        const data = await res.json();
        setSyncStatus(data);
      }
    } catch (err) {
      console.warn('Could not fetch sync status:', err);
    }
  };

  // 4. Setup WebSocket Connection
  useEffect(() => {
    isGracePeriodRef.current = true;
    const graceTimer = setTimeout(() => {
      isGracePeriodRef.current = false;
      if (missedWsFailuresRef.current >= 2) {
        setWsConnStatus('disconnected');
      }
    }, 3000);

    fetchPairing();
    fetchQr();
    fetchActiveTickets();
    fetchSyncStatus();

    const wsHost = hubHost.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    const wsUrl = `${wsHost}/live`;
    let ws;

    const connectWs = () => {
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          missedWsFailuresRef.current = 0;
          setWsConnStatus('connected');
          fetchPairing();
          fetchQr();
          console.log('⚡ Connected to Hub Server WebSocket');
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            const type = msg.type;
            const payload = msg.payload || {};

            if (type === 'NEW_ORDER' || type === 'order_created') {
              const newTicket = payload.ticket || payload;
              if (newTicket && (newTicket.id || newTicket.ticket_number)) {
                setTickets(prev => {
                  const exists = prev.some(t => t.id === newTicket.id || String(t.ticket_number) === String(newTicket.ticket_number));
                  if (exists) return prev;
                  return [newTicket, ...prev];
                });
              }
            } else if (type === 'TICKET_READY' || type === 'order_ready') {
              const readyTicket = payload.ticket || payload;
              const readyId = readyTicket.ticket_id || readyTicket.id || readyTicket.ticket_number;
              if (readyId) {
                setTickets(prev => prev.map(t => {
                  if (t.id === readyId || String(t.ticket_number) === String(readyId)) {
                    // Take the hub's whole ticket when it sent one, so the course and station state is current.
                    return { ...t, ...(payload.ticket || {}), status: 'ready' };
                  }
                  return t;
                }));
              }
            } else if (type === 'TICKET_UPDATED' && payload.ticket) {
              // Station ready, course fired, ticket recalled: the hub sends the ticket as it now stands.
              mergeTicket(payload.ticket);
            } else if (type === 'TICKET_CANCELLED') {
              const gone = payload.ticket_id || payload.ticket?.id;
              if (gone) setTickets(prev => prev.filter(t => t.id !== gone));
              fetchActiveTickets();
            } else if (type === 'CLEAR_TABLE' || type === 'bill_cleared' || type === 'order_cleared') {
              fetchActiveTickets();
            } else if (type === 'SYNC_STATUS_CHANGE') {
              setSyncStatus(payload);
              fetchActiveTickets();
            }
          } catch (err) {
            console.warn('Malformed WS message:', err);
          }
        };

        ws.onclose = () => {
          missedWsFailuresRef.current += 1;
          if (!isGracePeriodRef.current || missedWsFailuresRef.current >= 2) {
            setWsConnStatus('disconnected');
          } else {
            setWsConnStatus('connecting');
          }
          setTimeout(connectWs, 3000);
        };

        ws.onerror = () => {
          if (ws) ws.close();
        };
      } catch (err) {
        missedWsFailuresRef.current += 1;
        if (!isGracePeriodRef.current || missedWsFailuresRef.current >= 2) {
          setWsConnStatus('disconnected');
        }
      }
    };

    connectWs();

    // Poll pairing info, sync status & tickets periodically as fallback
    const interval = setInterval(() => {
      fetchPairing();
      fetchQr();
      fetchSyncStatus();
      fetchActiveTickets();
    }, 10000);

    return () => {
      clearTimeout(graceTimer);
      if (ws) ws.close();
      clearInterval(interval);
    };
  }, []);

  // Replace a ticket with the hub's current copy of it, matched by id.
  const mergeTicket = (next) => {
    if (!next) return;
    setTickets(prev => {
      const exists = prev.some(t => t.id === next.id);
      return exists ? prev.map(t => (t.id === next.id ? { ...t, ...next } : t)) : prev;
    });
  };

  // Mark ticket ready
  const handleMarkReady = async (ticket) => {
    try {
      const res = await fetch(`${hubHost}/orders/${ticket.id || ticket.ticket_number}/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setTickets(prev => prev.map(t => {
          if (t.id === ticket.id || t.ticket_number === ticket.ticket_number) {
            return { ...t, ...(data.ticket || {}), status: 'ready' };
          }
          return t;
        }));
      }
    } catch (err) {
      console.error('Failed to mark ticket ready:', err);
    }
  };

  // The three kitchen actions below all end the same way: take the hub's copy of the ticket, or, if the
  // hub said no (someone else got there first), say why and re-read the board so the screen is true.
  const kitchenAction = async (path, afterOk) => {
    setActionError('');
    try {
      const res = await fetch(`${hubHost}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        mergeTicket(data.ticket);
        if (afterOk) afterOk(data);
      } else {
        setActionError(data.error || 'The hub could not do that.');
        fetchActiveTickets();
      }
    } catch (err) {
      setActionError(`Hub unreachable: ${err.message}`);
    }
  };

  const ticketKey = ticket => encodeURIComponent(ticket.id || ticket.ticket_number);
  // One station reports its part done; the ticket turns ready on its own when every station has.
  const handleStationReady = (ticket, station) => kitchenAction(`/orders/${ticketKey(ticket)}/stations/${station}/ready`);
  // Send the next held course to the kitchen.
  const handleFire = (ticket) => kitchenAction(`/orders/${ticketKey(ticket)}/fire`);
  // Put a ticket that was marked ready back on the board.
  const handleRecall = (ticket) => kitchenAction(`/orders/${ticketKey(ticket)}/recall`);

  // Turn the modal's adjustment form into the body the hub understands.
  // Empty inputs mean "no adjustment on this axis" rather than 0.
  const buildAdjustmentBody = (adj) => {
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
  };

  // Fetch a preview for the current adjustments. Both the initial open and
  // any recalculation from the modal route through here.
  const fetchBillPreview = async (tableId, adj) => {
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

  // Debounce recomputation while reception is typing amounts.
  useEffect(() => {
    if (billTableId === null) return;
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
    if (!billInvoice?.grand_total) return;
    const grand = billInvoice.grand_total;
    const base = Math.floor(grand / count);
    const remainder = grand - base * count;
    setAmountSplitDraft({
      rows: Array.from({ length: count }, (_, i) => ({
        label: '',
        share_amount: String(i < remainder ? base + 1 : base)
      }))
    });
  };

  const closeAmountSplit = () => setAmountSplitDraft(null);

  const submitAmountSplit = async () => {
    if (!billInvoice?.id || !amountSplitDraft) return;
    const payload = {
      splits: amountSplitDraft.rows
        .filter(r => r.share_amount !== '')
        .map(r => ({
          label: r.label ? r.label.trim() : undefined,
          share_amount: Number(r.share_amount)
        }))
    };
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
      assignments: new Array(billInvoice.items.length).fill(0)
    });
  };

  const closeItemSplit = () => setItemSplitDraft(null);

  const submitItemSplit = async () => {
    if (!billInvoice?.id || !itemSplitDraft) return;
    // Group item indices by the split they're assigned to.
    const buckets = Array.from({ length: itemSplitDraft.count }, () => []);
    itemSplitDraft.assignments.forEach((s, i) => {
      if (s >= 0 && s < buckets.length) buckets[s].push(i);
    });
    const payload = {
      splits: buckets.map((item_indices, i) => ({
        label: `Split ${i + 1}`,
        item_indices
      }))
    };
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

  const toggleCheck = (ticketId, idx) => {
    const key = `${ticketId}_${idx}`;
    setCheckedItems(p => ({ ...p, [key]: !p[key] }));
  };

  // "Mark ready" unlocks once every line on THIS screen is ticked: a bar tablet needs only its drinks
  // ticked, and lines held for a later course are not on the board yet.
  const allCheckedFor = (ticket, lines) => lines.every(({ idx }) => checkedItems[`${ticket.id}_${idx}`]);

  const activeTickets = tickets.filter(t => t.status === 'in_progress');
  const readyTickets = tickets.filter(t => t.status === 'ready');
  const boardTickets = activeTickets.filter(t => onStationBoard(t, stationFilter));
  const counts = stationCounts(activeTickets);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-canvas)', color: 'var(--color-ink)', fontFamily: 'var(--font-body)', padding: 'var(--spacing-lg)' }}>
      {/* Top Navigation / Header */}
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)',
        padding: 'var(--spacing-base) var(--spacing-lg)', marginBottom: 'var(--spacing-lg)', flexWrap: 'wrap', gap: 'var(--spacing-base)',
        boxShadow: 'var(--shadow-flat)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)', width: '44px', height: '44px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ChefHat size={22} />
          </div>
          <div>
            <h1 className="typography-display-sm" style={{ margin: 0, color: 'var(--color-ink)' }}>
              Kitchen Hub Display
            </h1>
            <div className="typography-caption-sm" style={{ color: 'var(--color-muted)', marginTop: 'var(--spacing-xxs)' }}>
              {pairingInfo ? `${pairingInfo.name} (${pairingInfo.pairing_code})` : 'Connecting to Reception Hub...'}
            </div>
          </div>
        </div>

        {/* Live System Status Badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {/* LAN Connection Badge */}
          <motion.div
            layout={!shouldReduceMotion}
            style={{
              background: wsConnStatus === 'connected' ? 'var(--status-green-bg)' : wsConnStatus === 'connecting' ? 'var(--color-surface-soft)' : 'var(--status-rust-bg)',
              border: `1px solid ${wsConnStatus === 'connected' ? 'var(--status-green-border)' : wsConnStatus === 'connecting' ? 'var(--color-hairline)' : 'var(--status-rust-border)'}`,
              color: wsConnStatus === 'connected' ? 'var(--status-green-text)' : wsConnStatus === 'connecting' ? 'var(--color-muted)' : 'var(--status-rust-text)',
              padding: '6px 14px', borderRadius: 'var(--radius-full)', fontSize: '12px', fontWeight: 700,
              display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-mono)'
            }}
          >
            {wsConnStatus === 'connecting' ? (
              <RefreshCw size={14} className="spin" />
            ) : (
              <Wifi size={14} />
            )}
            {wsConnStatus === 'connected' ? 'LAN WiFi Active' : wsConnStatus === 'connecting' ? 'Connecting…' : 'LAN Disconnected'}
          </motion.div>

          {/* Cloud Sync Status Badge */}
          <div style={{
            background: syncStatus.online ? (syncStatus.queued > 0 ? 'var(--status-amber-bg)' : 'var(--status-green-bg)') : 'var(--status-amber-bg)',
            border: `1px solid ${syncStatus.online ? (syncStatus.queued > 0 ? 'var(--status-amber-border)' : 'var(--status-green-border)') : 'var(--status-amber-border)'}`,
            color: syncStatus.online ? (syncStatus.queued > 0 ? 'var(--status-amber-text)' : 'var(--status-green-text)') : 'var(--status-amber-text)',
            padding: '6px 14px', borderRadius: 'var(--radius-full)', fontSize: '12px', fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-mono)'
          }}>
            <Cloud size={14} />
            {syncStatus.online 
              ? (syncStatus.queued > 0 ? `Cloud Queue (${syncStatus.queued})` : 'Cloud Synced')
              : `Local Only (${syncStatus.queued} queued)`}
          </div>

          <motion.button
            whileTap={shouldReduceMotion ? {} : { scale: 0.95 }}
            onClick={() => { fetchActiveTickets(); fetchSyncStatus(); }}
            style={{ background: 'var(--color-surface-soft)', color: 'var(--color-body)', border: '1px solid var(--color-hairline)', padding: '8px 14px', borderRadius: 'var(--radius-full)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600 }}
          >
            <RefreshCw size={14} /> Refresh
          </motion.button>
          <a href="/admin" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-body)', border: '1px solid var(--color-hairline)', padding: '8px 14px', borderRadius: 'var(--radius-full)', textDecoration: 'none', display: 'flex', alignItems: 'center', fontSize: '12px', fontWeight: 600 }}>Menu &amp; Tables</a>
          <ThemeToggle />
        </div>
      </header>

      {/* Main Grid: Left side pairing card, Right side live KOT tickets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 320px) 1fr', gap: 'var(--spacing-lg)', alignItems: 'start' }}>

        {/* Left Column: Waiter Pairing QR Code & Details */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-base)' }}>
          <div style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-lg)', textAlign: 'center', boxShadow: 'var(--shadow-flat)' }}>
            <div className="typography-micro-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--spacing-sm)', color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 'var(--spacing-md)' }}>
              <QrCode size={16} /> Waiter Pairing QR Code
            </div>

            {qrCodeUrl ? (
              <div style={{ background: 'var(--color-canvas)', padding: 'var(--spacing-md)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-hairline)', display: 'inline-block', marginBottom: 'var(--spacing-md)' }}>
                <img src={qrCodeUrl} alt="Waiter App Pairing QR" style={{ width: '180px', height: '180px', display: 'block' }} />
              </div>
            ) : (
              <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-muted)' }}>Generating QR...</div>
            )}

            <div className="typography-caption" style={{ color: 'var(--color-ink)' }}>
              Scan with Waiter Phone Camera
            </div>
            <div className="typography-badge" style={{ color: 'var(--color-muted)', marginTop: 'var(--spacing-xs)', fontFamily: 'var(--font-mono)' }}>
              LAN Address: {pairingInfo?.server_url || hubHost}/waiter
            </div>
            <div style={{ marginTop: 'var(--spacing-md)', background: 'var(--color-surface-soft)', padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-sm)', color: 'var(--color-body)' }}>
              <span className="typography-micro-label">Pairing Code: </span><strong style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)' }}>{pairingInfo?.pairing_code || '---'}</strong>
            </div>
            {/* Handsets that cannot scan the QR type this code once to enrol.
                It is only ever served to this screen, never over the LAN. */}
            <div style={{ marginTop: '8px', background: 'var(--color-surface-soft)', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', color: 'var(--color-body)' }}>
              Enrollment Code: <strong style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', letterSpacing: '2px' }}>{enrollmentCode || '---'}</strong>
              <div style={{ fontSize: '10px', color: 'var(--color-muted)', marginTop: '2px' }}>
                Type this on a waiter handset if it cannot scan the QR code.
              </div>
            </div>
          </div>

          {/* Quick Metrics Card */}
          <div style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-lg)', boxShadow: 'var(--shadow-flat)' }}>
            <div className="typography-micro-label" style={{ color: 'var(--color-muted)', textTransform: 'uppercase', marginBottom: 'var(--spacing-md)' }}>
              Kitchen Summary
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)' }}>
              <div style={{ background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)', padding: 'var(--spacing-md)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--status-amber-text)', fontFamily: 'var(--font-mono)' }}>{activeTickets.length}</div>
                <div className="typography-badge" style={{ color: 'var(--status-amber-text)', marginTop: 'var(--spacing-xxs)', textTransform: 'uppercase' }}>ACTIVE KOTS</div>
              </div>
              <div style={{ background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)', padding: 'var(--spacing-md)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--status-green-text)', fontFamily: 'var(--font-mono)' }}>{readyTickets.length}</div>
                <div className="typography-badge" style={{ color: 'var(--status-green-text)', marginTop: 'var(--spacing-xxs)', textTransform: 'uppercase' }}>READY TO SERVE</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Live KOT Rail (SIGNATURE MOTION MOMENT: TICKET PRINT-IN) */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-base)' }}>
            <h2 className="typography-display-sm" style={{ margin: 0, color: 'var(--color-ink)' }}>
              {stationFilter === 'all' ? 'Live Order Tickets' : STATION_LABEL[stationFilter]} ({boardTickets.length})
            </h2>
            <span className="typography-badge" style={{ color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Zap size={12} /> Real-time KDS
            </span>
          </div>

          {/* Station screens: pick which station this display is for. A ticket shows on a station's screen
              only while that station still has something to cook on it. */}
          <div role="tablist" aria-label="Station" style={{ display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap', marginBottom: 'var(--spacing-base)' }}>
            {['all', ...STATIONS].map(s => {
              const selected = stationFilter === s;
              return (
                <button
                  key={s}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setStationFilter(s)}
                  style={{
                    background: selected ? 'var(--color-primary)' : 'var(--color-surface-soft)',
                    color: selected ? 'var(--color-on-primary)' : 'var(--color-body)',
                    border: `1px solid ${selected ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                    padding: '8px 16px', borderRadius: 'var(--radius-full)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '8px', minHeight: '40px'
                  }}
                >
                  {s === 'all' ? 'All stations' : STATION_LABEL[s]}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', opacity: 0.85 }}>{counts[s]}</span>
                </button>
              );
            })}
          </div>

          {actionError && (
            <div role="alert" style={{ background: 'var(--status-rust-bg)', color: 'var(--status-rust-text)', border: '1px solid var(--status-rust-border)', padding: '10px 12px', borderRadius: '8px', fontSize: '13px', marginBottom: 'var(--spacing-base)', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span>{actionError}</span>
              <button onClick={() => setActionError('')} aria-label="Dismiss" style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}><X size={14} /></button>
            </div>
          )}

          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--color-muted)' }}>Loading active KOTs...</div>
          ) : boardTickets.length === 0 ? (
            <div className="empty-state empty-state-lg">
              <ChefHat size={40} style={{ color: 'var(--color-muted)', marginBottom: 'var(--spacing-md)' }} />
              <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>
                {stationFilter === 'all' ? 'Kitchen Rail Clear' : `${STATION_LABEL[stationFilter]} is clear`}
              </div>
              <div className="typography-caption-sm" style={{ marginTop: 'var(--spacing-xs)', color: 'var(--color-muted)' }}>
                Orders placed on waiter phones will pop up here in real time.
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--spacing-base)' }}>
              <AnimatePresence mode="popLayout">
                {boardTickets.map(ticket => {
                  const lines = visibleLines(ticket, stationFilter);
                  const canMark = allCheckedFor(ticket, lines);
                  const states = stationStates(ticket);
                  const held = heldGroups(ticket);
                  const stationMode = stationFilter !== 'all';
                  return (
                    <motion.div
                      key={ticket.id || ticket.ticket_number}
                      layout={!shouldReduceMotion}
                      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -45, scale: 0.94, rotateX: -10 }}
                      animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, rotateX: 0 }}
                      exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: 60, scale: 0.9 }}
                      transition={shouldReduceMotion ? { duration: 0.01 } : {
                        type: 'spring',
                        stiffness: 380,
                        damping: 24,
                        mass: 0.8
                      }}
                      style={{
                        background: 'var(--color-canvas)',
                        border: '1px solid var(--color-hairline)',
                        borderRadius: 'var(--radius-md)',
                        padding: 'var(--spacing-base)',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        boxShadow: 'var(--shadow-flat)',
                        transformOrigin: 'top center'
                      }}
                    >
                      <div>
                        {/* Ticket Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--color-hairline)', paddingBottom: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
                          <div>
                            <span className="typography-badge" style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
                              TICKET #{ticket.ticket_number}
                            </span>
                            <div className="typography-display-sm" style={{ color: 'var(--color-ink)', marginTop: 'var(--spacing-xxs)' }}>
                              {ticket.table_name || 'Table'}
                            </div>
                          </div>
                          <span className="typography-badge" style={{ background: ticket.synced_to_cloud ? 'var(--status-green-bg)' : 'var(--status-amber-bg)', color: ticket.synced_to_cloud ? 'var(--status-green-text)' : 'var(--status-amber-text)', padding: '3px 8px', borderRadius: 'var(--radius-full)', fontFamily: 'var(--font-mono)', border: `1px solid ${ticket.synced_to_cloud ? 'var(--status-green-border)' : 'var(--status-amber-border)'}`, display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
                            {ticket.synced_to_cloud ? <><Check size={10} /> Synced</> : <><Loader size={10} className="spin" /> Queued</>}
                          </span>
                        </div>

                        {/* Where each station stands, and which course this is (shown only when it helps) */}
                        {(states.length > 1 || ticket.staged) && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: 'var(--spacing-md)' }}>
                            {ticket.staged && (
                              <span className="typography-badge" style={{ background: 'var(--status-blue-bg)', color: 'var(--status-blue-text)', border: '1px solid var(--status-blue-border)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 700 }}>
                                Course {Math.max(...(ticket.fired_courses || [1]))}
                              </span>
                            )}
                            {states.map(s => (
                              <span
                                key={s.station}
                                className="typography-badge"
                                style={{
                                  background: s.done ? 'var(--status-green-bg)' : 'var(--status-amber-bg)',
                                  color: s.done ? 'var(--status-green-text)' : 'var(--status-amber-text)',
                                  border: `1px solid ${s.done ? 'var(--status-green-border)' : 'var(--status-amber-border)'}`,
                                  padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px'
                                }}
                              >
                                {s.done && <Check size={10} />}{STATION_LABEL[s.station]}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Items Checklist */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
                          {lines.map(({ item, idx }) => {
                            const isChecked = !!checkedItems[`${ticket.id}_${idx}`];
                            return (
                              <div
                                key={idx}
                                onClick={() => toggleCheck(ticket.id, idx)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', cursor: 'pointer',
                                  opacity: isChecked ? 0.4 : 1, textDecoration: isChecked ? 'line-through' : 'none'
                                }}
                              >
                                <div style={{
                                  width: '18px', height: '18px', borderRadius: 'var(--radius-xs)',
                                  border: `1.5px solid ${isChecked ? 'var(--status-green-text)' : 'var(--color-hairline)'}`,
                                  background: isChecked ? 'var(--status-green-text)' : 'transparent',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  color: 'var(--color-on-primary)', fontSize: '10px', fontWeight: 800
                                }}>
                                  {isChecked && <Check size={10} />}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                  <span className="typography-caption" style={{ color: 'var(--color-ink)' }}>
                                    {item.qty > 1 && <strong style={{ color: 'var(--color-primary)' }}>{item.qty}× </strong>}
                                    {item.name}
                                    {item.variant_label && (
                                      <span style={{ fontSize: '12px', color: 'var(--color-muted)', fontWeight: 500, marginLeft: 4 }}>
                                        · {item.variant_label}
                                      </span>
                                    )}
                                    {item.day_part_label && (
                                      <span
                                        title={`Billed at ${item.day_part_label}`}
                                        style={{
                                          fontSize: 10, color: 'var(--status-green-text)', fontFamily: 'var(--font-mono)',
                                          background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)',
                                          padding: '1px 6px', borderRadius: 'var(--radius-full)', marginLeft: 6, verticalAlign: 'middle'
                                        }}
                                      >
                                        {String(item.day_part_label).toUpperCase()}
                                      </span>
                                    )}
                                    {/* Station routing tag (M2 · PR 15). Only
                                        surfaced when the item was explicitly
                                        routed off the default hot line, so
                                        curries don't get a "HOT" tag on every
                                        ticket — only bar drinks and cold-
                                        prep items call for a routing note. */}
                                    {item.station && item.station !== 'hot' && (
                                      <span
                                        title={`Fires to ${item.station} station`}
                                        style={{
                                          fontSize: 10, color: 'var(--color-primary)', fontFamily: 'var(--font-mono)',
                                          background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)',
                                          padding: '1px 6px', borderRadius: 'var(--radius-full)', marginLeft: 6, verticalAlign: 'middle',
                                          fontWeight: 700
                                        }}
                                      >
                                        {String(item.station).toUpperCase()}
                                      </span>
                                    )}
                                  </span>
                                  {/* KDS modifier lines (M2 · PR 12). The kitchen
                                      sees "· Spice level: Hot" for prep instructions
                                      and "+ Extra cheese" for paid extras (delta is
                                      priced elsewhere; on the KDS card we highlight
                                      what the cook needs to prep). */}
                                  {Array.isArray(item.modifiers) && item.modifiers.length > 0 && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 4 }}>
                                      {item.modifiers.map((m, mi) => {
                                        const delta = Number(m.price_delta) || 0;
                                        return (
                                          <span key={mi} style={{
                                            fontSize: 11,
                                            color: delta > 0 ? 'var(--color-primary)' : 'var(--color-muted)',
                                            fontWeight: delta > 0 ? 600 : 500
                                          }}>
                                            {delta === 0
                                              ? `· ${m.group_label ? m.group_label + ': ' : ''}${m.option_label}`
                                              : `+ ${m.option_label}`}
                                          </span>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Courses held back until someone fires them (hold and fire) */}
                        {held.length > 0 && (
                          <div style={{ border: '1px dashed var(--color-hairline)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', marginBottom: 'var(--spacing-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', background: 'var(--color-surface-soft)' }}>
                            <span className="typography-badge" style={{ color: 'var(--color-muted)' }}>
                              On hold: {held.map(h => `course ${h.course} (${h.count})`).join(', ')}
                            </span>
                            {/* Firing is a front-of-house decision: station screens only show what is held. */}
                            {!stationMode && (
                              <button
                                onClick={() => handleFire(ticket)}
                                style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)', border: 'none', borderRadius: 'var(--radius-full)', padding: '6px 12px', fontWeight: 700, fontSize: '12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}
                              >
                                <Flame size={13} /> Fire course {held[0].course}
                              </button>
                            )}
                          </div>
                        )}

                        {ticket.note && (
                          <div className="ticket-note" style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-xs)', marginBottom: 'var(--spacing-md)' }}>
                            <StickyNote size={13} style={{ flexShrink: 0, marginTop: '1px' }} /> {ticket.note}
                          </div>
                        )}
                      </div>

                      {/* Bottom Action */}
                      <div style={{ borderTop: '1px solid var(--color-hairline)', paddingTop: 'var(--spacing-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                        <span className="typography-badge" style={{ color: 'var(--color-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          By {ticket.created_by_waiter || 'Waiter'}
                        </span>
                        <button
                          onClick={() => openBill(ticket.table_id)}
                          disabled={!ticket.table_id && ticket.table_id !== 0}
                          title={`View bill for ${ticket.table_name || 'this table'}`}
                          style={{
                            background: 'transparent',
                            color: 'var(--color-primary)',
                            border: '1px solid var(--color-hairline)',
                            padding: '6px 10px',
                            borderRadius: 'var(--radius-full)',
                            fontWeight: 700,
                            fontSize: '12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                          }}
                        >
                          <Receipt size={13} /> Bill
                        </button>
                        <motion.button
                          whileTap={shouldReduceMotion || !canMark ? {} : { scale: 0.95 }}
                          onClick={() => (stationMode ? handleStationReady(ticket, stationFilter) : handleMarkReady(ticket))}
                          disabled={!canMark || lines.length === 0}
                          style={{
                            background: canMark ? 'var(--status-green-text)' : 'var(--color-surface-soft)',
                            color: canMark ? 'var(--color-on-primary)' : 'var(--color-muted)',
                            border: `1px solid ${canMark ? 'var(--status-green-border)' : 'var(--color-hairline)'}`, padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-full)',
                            fontWeight: 700, fontSize: '13px', cursor: canMark ? 'pointer' : 'not-allowed'
                          }}
                        >
                          {canMark ? <><Check size={14} /> {stationMode ? `${STATION_LABEL[stationFilter]} ready` : 'Mark Ready'}</> : 'Tick All'}
                        </motion.button>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

          {/* Bill Preview Modal (M1 billing foundation) */}
          <AnimatePresence>
            {billTableId !== null && (
              <motion.div
                key="bill-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={closeBill}
                style={{
                  position: 'fixed', inset: 0, background: 'rgba(15, 15, 15, 0.55)',
                  zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
                }}
              >
                <motion.div
                  key="bill-card"
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.98 }}
                  transition={{ duration: 0.18 }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: '#ffffff', borderRadius: 'var(--radius-md)', width: '100%', maxWidth: '440px',
                    boxShadow: '0 24px 64px rgba(0,0,0,0.22)', border: '1px solid var(--color-hairline)',
                    overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '90vh'
                  }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 18px', borderBottom: '1px solid var(--color-hairline)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Receipt size={18} style={{ color: 'var(--color-primary)' }} />
                      <div>
                        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '16px', color: 'var(--color-ink)' }}>
                          Bill Preview
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
                          {billInvoice?.table_name || `Table ${billTableId}`} · not yet issued
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={closeBill}
                      style={{ background: 'transparent', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 4 }}
                      aria-label="Close bill preview"
                    >
                      <X size={18} />
                    </button>
                  </div>

                  <div style={{ overflowY: 'auto', padding: '16px 18px' }}>
                    {billLoading && (
                      <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-muted)', fontSize: '13px' }}>
                        <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite', display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />
                        Fetching latest bill from hub…
                      </div>
                    )}

                    {billError && !billLoading && (
                      <div style={{
                        background: 'var(--status-rust-bg)', color: 'var(--status-rust-text)',
                        border: '1px solid var(--status-rust-border)', padding: '10px 12px', borderRadius: '8px',
                        fontSize: '13px'
                      }}>
                        {billError}
                      </div>
                    )}

                    {billInvoice && (
                      <>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px', opacity: billLoading ? 0.55 : 1, transition: 'opacity 0.15s ease' }}>
                          {billInvoice.items.map((line, idx) => (
                            <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: '13px', color: 'var(--color-ink)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  <span style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', marginRight: 6, fontWeight: 700 }}>
                                    {line.qty}×
                                  </span>
                                  {line.name}
                                  {line.variant_label && (
                                    <span style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 500, marginLeft: 6 }}>
                                      · {line.variant_label}
                                    </span>
                                  )}
                                  {line.day_part_label && (
                                    <span
                                      title={`Billed at ${line.day_part_label}`}
                                      style={{
                                        fontSize: 9, color: 'var(--status-green-text)', fontFamily: 'var(--font-mono)',
                                        background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)',
                                        padding: '1px 5px', borderRadius: 'var(--radius-full)', marginLeft: 6, verticalAlign: 'middle'
                                      }}
                                    >
                                      {String(line.day_part_label).toUpperCase()}
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                                  #{line.ticket_number} · {billInvoice.currency}{line.price} each
                                </div>
                                {/* Modifier detail on the bill preview (M2 · PR 12).
                                    Zero-delta prep lines describe how the dish was
                                    prepared; positive deltas surface the paid extra
                                    with its per-unit contribution so reception can
                                    explain the line to the guest. */}
                                {Array.isArray(line.modifiers) && line.modifiers.length > 0 && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2, paddingLeft: 4 }}>
                                    {line.modifiers.map((m, mi) => {
                                      const delta = Number(m.price_delta) || 0;
                                      return (
                                        <div key={mi} style={{
                                          fontSize: 10, color: 'var(--color-muted)',
                                          display: 'flex', justifyContent: 'space-between', gap: 6
                                        }}>
                                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {delta === 0
                                              ? `· ${m.group_label ? m.group_label + ': ' : ''}${m.option_label}`
                                              : `+ ${m.option_label}`}
                                          </span>
                                          {delta !== 0 && (
                                            <span style={{ fontFamily: 'var(--font-mono)', color: delta > 0 ? 'var(--color-primary)' : 'var(--status-green-text)' }}>
                                              {delta > 0 ? '+' : '−'}{billInvoice.currency}{Math.abs(delta)} × {line.qty}
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, color: 'var(--color-ink)' }}>
                                {billInvoice.currency}{line.line_total}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Adjustment controls */}
                        {!billInvoice.invoice_number && (
                          <div style={{
                            borderTop: '1px dashed var(--color-hairline)', paddingTop: '10px', marginBottom: '8px',
                            display: 'flex', flexDirection: 'column', gap: '8px'
                          }}>
                            <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                              Bill adjustments
                            </div>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <select
                                value={billAdjustments.discount_type}
                                onChange={e => setBillAdjustments(a => ({ ...a, discount_type: e.target.value }))}
                                style={{
                                  padding: '6px 8px', fontSize: '12px', border: '1px solid var(--color-hairline)',
                                  borderRadius: 'var(--radius-xs)', background: '#fff', color: 'var(--color-ink)'
                                }}
                              >
                                <option value="percent">Discount %</option>
                                <option value="flat">Discount ₹</option>
                              </select>
                              <input
                                type="number"
                                min="0"
                                step={billAdjustments.discount_type === 'percent' ? '1' : '10'}
                                placeholder="0"
                                value={billAdjustments.discount_value}
                                onChange={e => setBillAdjustments(a => ({ ...a, discount_value: e.target.value }))}
                                style={{
                                  width: '80px', padding: '6px 8px', fontSize: '12px', fontFamily: 'var(--font-mono)',
                                  border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                                }}
                              />
                              <input
                                type="text"
                                placeholder="Reason (optional)"
                                value={billAdjustments.discount_reason}
                                onChange={e => setBillAdjustments(a => ({ ...a, discount_reason: e.target.value }))}
                                style={{
                                  flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px',
                                  border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                                }}
                              />
                            </div>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <label style={{ fontSize: '12px', color: 'var(--color-muted)', flexShrink: 0 }}>Service charge</label>
                              <input
                                type="number"
                                min="0"
                                max="25"
                                step="0.5"
                                placeholder="0"
                                value={billAdjustments.service_charge_percent}
                                onChange={e => setBillAdjustments(a => ({ ...a, service_charge_percent: e.target.value }))}
                                style={{
                                  width: '70px', padding: '6px 8px', fontSize: '12px', fontFamily: 'var(--font-mono)',
                                  border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                                }}
                              />
                              <span style={{ fontSize: '12px', color: 'var(--color-muted)' }}>%</span>
                            </div>
                          </div>
                        )}

                        <div style={{ borderTop: '1px dashed var(--color-hairline)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'var(--color-muted)' }}>
                            <span>Subtotal</span>
                            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-ink)' }}>{billInvoice.currency}{billInvoice.subtotal}</span>
                          </div>
                          {billInvoice.discount_rows && billInvoice.discount_rows.map((row, idx) => (
                            <div key={`d${idx}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--status-green-text)' }}>
                              <span>
                                Discount{row.type === 'percent' ? ` (${row.value}%)` : ''}
                                {row.reason ? ` · ${row.reason}` : ''}
                              </span>
                              <span style={{ fontFamily: 'var(--font-mono)' }}>−{billInvoice.currency}{row.amount}</span>
                            </div>
                          ))}
                          {billInvoice.service_charge_amount > 0 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--color-muted)' }}>
                              <span>Service charge ({billInvoice.service_charge_percent}%)</span>
                              <span style={{ fontFamily: 'var(--font-mono)' }}>{billInvoice.currency}{billInvoice.service_charge_amount}</span>
                            </div>
                          )}
                          {billInvoice.tax_rows.map((row, idx) => (
                            <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--color-muted)' }}>
                              <span>{row.label} ({row.rate_percent}%)</span>
                              <span style={{ fontFamily: 'var(--font-mono)' }}>{billInvoice.currency}{row.amount}</span>
                            </div>
                          ))}
                        </div>

                        <div style={{
                          marginTop: '12px', borderTop: '1px solid var(--color-hairline)', paddingTop: '12px',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'
                        }}>
                          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--color-ink)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            Grand Total
                          </span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '22px', fontWeight: 800, color: 'var(--color-primary)' }}>
                            {billInvoice.currency}{billInvoice.grand_total}
                          </span>
                        </div>

                        {billInvoice.invoice_number ? (
                          <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <div style={{
                              background: billInvoice.payment_status === 'paid'
                                ? 'var(--status-green-bg)'
                                : billInvoice.payment_status === 'voided'
                                ? 'var(--status-rust-bg)'
                                : 'var(--status-amber-bg)',
                              border: `1px solid ${
                                billInvoice.payment_status === 'paid'
                                  ? 'var(--status-green-border)'
                                  : billInvoice.payment_status === 'voided'
                                  ? 'var(--status-rust-border)'
                                  : 'var(--status-amber-border)'
                              }`,
                              color: billInvoice.payment_status === 'paid'
                                ? 'var(--status-green-text)'
                                : billInvoice.payment_status === 'voided'
                                ? 'var(--status-rust-text)'
                                : 'var(--status-amber-text)',
                              padding: '10px 12px', borderRadius: '8px',
                              fontSize: '13px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700
                            }}>
                              {billInvoice.payment_status === 'paid' && `✓ ${billInvoice.invoice_number} · Paid · ${billInvoice.payment_method?.toUpperCase()}`}
                              {billInvoice.payment_status === 'voided' && `✕ ${billInvoice.invoice_number} · Voided`}
                              {billInvoice.payment_status === 'refunded' && `↩ ${billInvoice.invoice_number} · Refunded`}
                              {billInvoice.payment_status === 'pending' && `⏳ ${billInvoice.invoice_number} · Awaiting payment`}
                            </div>

                            {billInvoice.payment_status === 'paid' && billInvoice.payment_ref && (
                              <div style={{ fontSize: '11px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                                Ref: {billInvoice.payment_ref}
                              </div>
                            )}

                            {(billInvoice.payment_status === 'paid' || billInvoice.payment_status === 'refunded') && (
                              <button
                                onClick={printReceipt}
                                disabled={billLoading}
                                style={{
                                  padding: '8px 10px', borderRadius: 'var(--radius-full)',
                                  background: 'var(--color-primary)', color: '#fff',
                                  border: 'none', fontWeight: 700, fontSize: '12px',
                                  cursor: billLoading ? 'not-allowed' : 'pointer'
                                }}
                              >
                                Print receipt
                              </button>
                            )}

                            {billInvoice.payment_status === 'paid' && (
                              <button
                                onClick={refundInvoice}
                                disabled={billLoading}
                                style={{
                                  padding: '8px 10px', borderRadius: 'var(--radius-full)',
                                  background: 'transparent', color: 'var(--status-rust-text)',
                                  border: '1px solid var(--status-rust-border)', fontWeight: 700, fontSize: '12px',
                                  cursor: billLoading ? 'not-allowed' : 'pointer'
                                }}
                              >
                                Refund invoice
                              </button>
                            )}

                            {billInvoice.payment_status === 'refunded' && billInvoice.refund_reason && (
                              <div style={{ fontSize: '11px', color: 'var(--color-muted)', textAlign: 'center', fontStyle: 'italic' }}>
                                Reason: {billInvoice.refund_reason}
                              </div>
                            )}

                            {billInvoice.payment_status === 'pending' && !billInvoice.splits && (
                              <>
                                <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                                  Mark paid
                                </div>
                                <input
                                  type="text"
                                  value={paymentRef}
                                  onChange={e => setPaymentRef(e.target.value)}
                                  placeholder="Payment reference (optional, e.g. UPI txn id)"
                                  maxLength={80}
                                  style={{
                                    padding: '6px 8px', fontSize: '12px', fontFamily: 'var(--font-mono)',
                                    border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)',
                                    color: 'var(--color-ink)'
                                  }}
                                />
                                <div style={{ display: 'flex', gap: '6px' }}>
                                  {['cash', 'upi', 'card', 'other'].map(m => (
                                    <button
                                      key={m}
                                      onClick={() => markPaid(m)}
                                      disabled={billLoading}
                                      style={{
                                        flex: 1, padding: '8px 10px', borderRadius: 'var(--radius-full)',
                                        background: 'var(--color-primary)', color: '#fff',
                                        border: 'none', fontWeight: 700, fontSize: '12px', textTransform: 'uppercase',
                                        letterSpacing: '0.5px', cursor: billLoading ? 'not-allowed' : 'pointer', opacity: billLoading ? 0.6 : 1
                                      }}
                                    >
                                      {m}
                                    </button>
                                  ))}
                                </div>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                                    Split by seats
                                  </span>
                                  {[2, 3, 4, 5, 6].map(n => (
                                    <button
                                      key={n}
                                      onClick={() => splitBySeats(n)}
                                      disabled={billLoading}
                                      style={{
                                        padding: '6px 10px', borderRadius: 'var(--radius-full)',
                                        background: 'transparent', color: 'var(--color-primary)',
                                        border: '1px solid var(--color-primary)', fontWeight: 700, fontSize: '12px',
                                        cursor: billLoading ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-mono)'
                                      }}
                                    >
                                      {n}
                                    </button>
                                  ))}
                                  <button
                                    onClick={() => openAmountSplit(2)}
                                    disabled={billLoading || !!amountSplitDraft || !!itemSplitDraft}
                                    style={{
                                      padding: '6px 10px', borderRadius: 'var(--radius-full)',
                                      background: 'transparent', color: 'var(--color-muted)',
                                      border: '1px dashed var(--color-hairline)', fontWeight: 700, fontSize: '12px',
                                      cursor: (billLoading || amountSplitDraft || itemSplitDraft) ? 'not-allowed' : 'pointer'
                                    }}
                                  >
                                    Custom amounts…
                                  </button>
                                  <button
                                    onClick={() => openItemSplit(2)}
                                    disabled={billLoading || !!amountSplitDraft || !!itemSplitDraft || !billInvoice.items?.length}
                                    style={{
                                      padding: '6px 10px', borderRadius: 'var(--radius-full)',
                                      background: 'transparent', color: 'var(--color-muted)',
                                      border: '1px dashed var(--color-hairline)', fontWeight: 700, fontSize: '12px',
                                      cursor: (billLoading || amountSplitDraft || itemSplitDraft) ? 'not-allowed' : 'pointer'
                                    }}
                                  >
                                    By items…
                                  </button>
                                </div>

                                {itemSplitDraft && (() => {
                                  const { count, assignments } = itemSplitDraft;
                                  const perSplitSubtotal = Array.from({ length: count }, () => 0);
                                  assignments.forEach((s, i) => {
                                    if (s >= 0 && s < count) perSplitSubtotal[s] += billInvoice.items[i]?.line_total || 0;
                                  });
                                  const emptySplits = perSplitSubtotal.filter(v => v === 0).length;
                                  const canApply = emptySplits === 0;
                                  return (
                                    <div style={{
                                      border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
                                      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px',
                                      background: 'var(--color-surface-soft)'
                                    }}>
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <span style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                                          By items · {count} splits
                                        </span>
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                          <button
                                            onClick={() => setItemSplitDraft(d => d.count < 6 ? { count: d.count + 1, assignments: d.assignments } : d)}
                                            disabled={billLoading || count >= 6}
                                            style={{
                                              padding: '4px 8px', borderRadius: 'var(--radius-xs)',
                                              background: 'transparent', color: 'var(--color-primary)',
                                              border: '1px solid var(--color-primary)', fontSize: '11px', fontWeight: 700,
                                              cursor: (billLoading || count >= 6) ? 'not-allowed' : 'pointer'
                                            }}
                                          >
                                            + split
                                          </button>
                                          <button
                                            onClick={() => setItemSplitDraft(d => {
                                              if (d.count <= 2) return d;
                                              // Clamp any assignment pointing at the removed split back to split 0.
                                              const nextCount = d.count - 1;
                                              return {
                                                count: nextCount,
                                                assignments: d.assignments.map(s => s >= nextCount ? 0 : s)
                                              };
                                            })}
                                            disabled={billLoading || count <= 2}
                                            style={{
                                              padding: '4px 8px', borderRadius: 'var(--radius-xs)',
                                              background: 'transparent', color: 'var(--color-muted)',
                                              border: '1px solid var(--color-hairline)', fontSize: '11px', fontWeight: 700,
                                              cursor: (billLoading || count <= 2) ? 'not-allowed' : 'pointer'
                                            }}
                                          >
                                            − split
                                          </button>
                                        </div>
                                      </div>
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                        {billInvoice.items.map((line, itemIdx) => (
                                          <div key={itemIdx} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <div style={{ flex: 1, minWidth: 0, fontSize: '12px', color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                              <span style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', marginRight: 4, fontWeight: 700 }}>
                                                {line.qty}×
                                              </span>
                                              {line.name}
                                            </div>
                                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 700, color: 'var(--color-ink)', width: 60, textAlign: 'right' }}>
                                              {billInvoice.currency}{line.line_total}
                                            </div>
                                            <div style={{ display: 'flex', gap: '3px' }}>
                                              {Array.from({ length: count }).map((_, splitIdx) => {
                                                const active = assignments[itemIdx] === splitIdx;
                                                return (
                                                  <button
                                                    key={splitIdx}
                                                    onClick={() => setItemSplitDraft(d => ({
                                                      count: d.count,
                                                      assignments: d.assignments.map((s, i) => i === itemIdx ? splitIdx : s)
                                                    }))}
                                                    disabled={billLoading}
                                                    style={{
                                                      width: 24, height: 24, borderRadius: '50%',
                                                      background: active ? 'var(--color-primary)' : 'transparent',
                                                      color: active ? '#fff' : 'var(--color-muted)',
                                                      border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                                                      fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 700,
                                                      cursor: billLoading ? 'not-allowed' : 'pointer'
                                                    }}
                                                  >
                                                    {splitIdx + 1}
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                                        {perSplitSubtotal.map((v, i) => (
                                          <div key={i} style={{
                                            display: 'flex', justifyContent: 'space-between',
                                            color: v === 0 ? 'var(--status-rust-text)' : 'var(--color-muted)'
                                          }}>
                                            <span>Split {i + 1} subtotal</span>
                                            <span>{v === 0 ? 'empty' : `${billInvoice.currency}${v}`}</span>
                                          </div>
                                        ))}
                                      </div>
                                      {emptySplits > 0 && (
                                        <div style={{ fontSize: '11px', color: 'var(--status-rust-text)', fontWeight: 700 }}>
                                          Every split needs at least one item ({emptySplits} empty).
                                        </div>
                                      )}
                                      <div style={{ display: 'flex', gap: '6px' }}>
                                        <button
                                          onClick={closeItemSplit}
                                          disabled={billLoading}
                                          style={{
                                            flex: 1, padding: '7px 10px', borderRadius: 'var(--radius-full)',
                                            background: 'transparent', color: 'var(--color-muted)',
                                            border: '1px solid var(--color-hairline)', fontSize: '12px', fontWeight: 700,
                                            cursor: billLoading ? 'not-allowed' : 'pointer'
                                          }}
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          onClick={submitItemSplit}
                                          disabled={!canApply || billLoading}
                                          style={{
                                            flex: 2, padding: '7px 10px', borderRadius: 'var(--radius-full)',
                                            background: canApply && !billLoading ? 'var(--color-primary)' : 'var(--color-surface-soft)',
                                            color: canApply && !billLoading ? '#fff' : 'var(--color-muted)',
                                            border: 'none', fontSize: '12px', fontWeight: 700,
                                            cursor: canApply && !billLoading ? 'pointer' : 'not-allowed'
                                          }}
                                        >
                                          Apply split
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })()}

                                {amountSplitDraft && (() => {
                                  const rows = amountSplitDraft.rows;
                                  const nums = rows.map(r => Number(r.share_amount)).filter(n => Number.isFinite(n));
                                  const sum = nums.reduce((s, n) => s + n, 0);
                                  const grand = billInvoice.grand_total;
                                  const delta = grand - sum;
                                  const balanced = delta === 0;
                                  const anyDecimal = rows.some(r => r.share_amount !== '' && !Number.isInteger(Number(r.share_amount)));
                                  const canSubmit = balanced && !anyDecimal && rows.every(r => Number(r.share_amount) > 0);
                                  return (
                                    <div style={{
                                      border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
                                      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px',
                                      background: 'var(--color-surface-soft)'
                                    }}>
                                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <span style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                                          Custom split · {rows.length} shares
                                        </span>
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                          <button
                                            onClick={() => setAmountSplitDraft(d => ({ rows: [...d.rows, { label: '', share_amount: '' }] }))}
                                            disabled={billLoading || rows.length >= 40}
                                            style={{
                                              padding: '4px 8px', borderRadius: 'var(--radius-xs)',
                                              background: 'transparent', color: 'var(--color-primary)',
                                              border: '1px solid var(--color-primary)', fontSize: '11px', fontWeight: 700,
                                              cursor: (billLoading || rows.length >= 40) ? 'not-allowed' : 'pointer'
                                            }}
                                          >
                                            + row
                                          </button>
                                          <button
                                            onClick={() => setAmountSplitDraft(d => d.rows.length > 2 ? { rows: d.rows.slice(0, -1) } : d)}
                                            disabled={billLoading || rows.length <= 2}
                                            style={{
                                              padding: '4px 8px', borderRadius: 'var(--radius-xs)',
                                              background: 'transparent', color: 'var(--color-muted)',
                                              border: '1px solid var(--color-hairline)', fontSize: '11px', fontWeight: 700,
                                              cursor: (billLoading || rows.length <= 2) ? 'not-allowed' : 'pointer'
                                            }}
                                          >
                                            − row
                                          </button>
                                        </div>
                                      </div>
                                      {rows.map((row, idx) => (
                                        <div key={idx} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                          <input
                                            type="text"
                                            placeholder={`Split ${idx + 1}`}
                                            value={row.label}
                                            onChange={e => setAmountSplitDraft(d => ({ rows: d.rows.map((r, i) => i === idx ? { ...r, label: e.target.value } : r) }))}
                                            style={{
                                              flex: 1, minWidth: 0, padding: '5px 8px', fontSize: '12px',
                                              border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                                            }}
                                          />
                                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-muted)' }}>
                                            {billInvoice.currency}
                                          </span>
                                          <input
                                            type="number"
                                            min="1"
                                            step="1"
                                            placeholder="0"
                                            value={row.share_amount}
                                            onChange={e => setAmountSplitDraft(d => ({ rows: d.rows.map((r, i) => i === idx ? { ...r, share_amount: e.target.value } : r) }))}
                                            style={{
                                              width: '90px', padding: '5px 8px', fontSize: '13px', fontFamily: 'var(--font-mono)',
                                              border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                                            }}
                                          />
                                        </div>
                                      ))}
                                      <div style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                        fontSize: '11px', fontFamily: 'var(--font-mono)', fontWeight: 700,
                                        color: balanced ? 'var(--status-green-text)' : 'var(--status-rust-text)'
                                      }}>
                                        <span>Target: {billInvoice.currency}{grand}</span>
                                        <span>
                                          {balanced
                                            ? '✓ Balanced'
                                            : delta > 0
                                              ? `Short by ${billInvoice.currency}${delta}`
                                              : `Over by ${billInvoice.currency}${-delta}`}
                                        </span>
                                      </div>
                                      <div style={{ display: 'flex', gap: '6px' }}>
                                        <button
                                          onClick={closeAmountSplit}
                                          disabled={billLoading}
                                          style={{
                                            flex: 1, padding: '7px 10px', borderRadius: 'var(--radius-full)',
                                            background: 'transparent', color: 'var(--color-muted)',
                                            border: '1px solid var(--color-hairline)', fontSize: '12px', fontWeight: 700,
                                            cursor: billLoading ? 'not-allowed' : 'pointer'
                                          }}
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          onClick={submitAmountSplit}
                                          disabled={!canSubmit || billLoading}
                                          style={{
                                            flex: 2, padding: '7px 10px', borderRadius: 'var(--radius-full)',
                                            background: canSubmit && !billLoading ? 'var(--color-primary)' : 'var(--color-surface-soft)',
                                            color: canSubmit && !billLoading ? '#fff' : 'var(--color-muted)',
                                            border: 'none', fontSize: '12px', fontWeight: 700,
                                            cursor: canSubmit && !billLoading ? 'pointer' : 'not-allowed'
                                          }}
                                        >
                                          Apply split
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })()}
                                <button
                                  onClick={voidInvoice}
                                  disabled={billLoading}
                                  style={{
                                    padding: '8px 10px', borderRadius: 'var(--radius-full)',
                                    background: 'transparent', color: 'var(--status-rust-text)',
                                    border: '1px solid var(--status-rust-border)', fontWeight: 700, fontSize: '12px',
                                    cursor: billLoading ? 'not-allowed' : 'pointer'
                                  }}
                                >
                                  Void bill (reopens tickets)
                                </button>
                              </>
                            )}

                            {billInvoice.payment_status === 'pending' && Array.isArray(billInvoice.splits) && billInvoice.splits.length > 0 && (
                              <>
                                <input
                                  type="text"
                                  value={paymentRef}
                                  onChange={e => setPaymentRef(e.target.value)}
                                  placeholder="Payment reference for next split (optional)"
                                  maxLength={80}
                                  style={{
                                    padding: '6px 8px', fontSize: '12px', fontFamily: 'var(--font-mono)',
                                    border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)',
                                    color: 'var(--color-ink)'
                                  }}
                                />
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                                    Split into {billInvoice.splits.length} {billInvoice.split_mode === 'seats' ? 'seats' : 'shares'}
                                  </span>
                                  {billInvoice.splits.every(s => s.payment_status !== 'paid') && (
                                    <button
                                      onClick={unsplitInvoice}
                                      disabled={billLoading}
                                      style={{
                                        background: 'transparent', color: 'var(--color-muted)', border: 'none',
                                        fontSize: '11px', cursor: billLoading ? 'not-allowed' : 'pointer', textDecoration: 'underline'
                                      }}
                                    >
                                      Undo split
                                    </button>
                                  )}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                  {billInvoice.splits.map((s, idx) => (
                                    <div key={idx} style={{
                                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                      padding: '8px 10px', borderRadius: 'var(--radius-xs)',
                                      background: s.payment_status === 'paid' ? 'var(--status-green-bg)' : 'var(--color-surface-soft)',
                                      border: `1px solid ${s.payment_status === 'paid' ? 'var(--status-green-border)' : 'var(--color-hairline)'}`
                                    }}>
                                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-ink)' }}>
                                          {s.label}
                                        </span>
                                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: s.payment_status === 'paid' ? 'var(--status-green-text)' : 'var(--color-primary)', fontWeight: 700 }}>
                                          {billInvoice.currency}{s.share_amount}
                                        </span>
                                      </div>
                                      {s.payment_status === 'paid' ? (
                                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--status-green-text)', fontWeight: 700, textTransform: 'uppercase' }}>
                                          ✓ {s.payment_method}
                                        </span>
                                      ) : (
                                        <div style={{ display: 'flex', gap: '4px' }}>
                                          {['cash', 'upi', 'card'].map(m => (
                                            <button
                                              key={m}
                                              onClick={() => markSplitPaid(idx, m)}
                                              disabled={billLoading}
                                              style={{
                                                padding: '5px 8px', borderRadius: 'var(--radius-full)',
                                                background: 'var(--color-primary)', color: '#fff',
                                                border: 'none', fontWeight: 700, fontSize: '10px',
                                                textTransform: 'uppercase', letterSpacing: '0.5px',
                                                cursor: billLoading ? 'not-allowed' : 'pointer'
                                              }}
                                            >
                                              {m}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}

                            {billInvoice.payment_status === 'voided' && billInvoice.voided_reason && (
                              <div style={{ fontSize: '11px', color: 'var(--color-muted)', textAlign: 'center', fontStyle: 'italic' }}>
                                Reason: {billInvoice.voided_reason}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                            <button
                              onClick={closeBill}
                              style={{
                                flex: 1, padding: '10px 14px', borderRadius: 'var(--radius-full)',
                                background: 'transparent', color: 'var(--color-muted)',
                                border: '1px solid var(--color-hairline)', fontWeight: 600, fontSize: '13px', cursor: 'pointer'
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              onClick={commitBill}
                              disabled={billLoading}
                              style={{
                                flex: 1, padding: '10px 14px', borderRadius: 'var(--radius-full)',
                                background: billLoading ? 'var(--color-surface-soft)' : 'var(--color-primary)',
                                color: billLoading ? 'var(--color-muted)' : '#fff',
                                border: 'none', fontWeight: 700, fontSize: '13px',
                                cursor: billLoading ? 'not-allowed' : 'pointer'
                              }}
                            >
                              Close Bill · {billInvoice.currency}{billInvoice.grand_total}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Print preview overlay (M1 PR 8) */}
          <AnimatePresence>
            {printPreview && (
              <motion.div
                key="print-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={() => setPrintPreview(null)}
                style={{
                  position: 'fixed', inset: 0, background: 'rgba(15, 15, 15, 0.65)',
                  zIndex: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
                }}
              >
                <motion.div
                  key="print-card"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: '#ffffff', borderRadius: 'var(--radius-md)', width: '100%',
                    maxWidth: '520px', border: '1px solid var(--color-hairline)',
                    boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
                    display: 'flex', flexDirection: 'column', maxHeight: '85vh'
                  }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px', borderBottom: '1px solid var(--color-hairline)'
                  }}>
                    <div>
                      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '15px', color: 'var(--color-ink)' }}>
                        {printPreview.title}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                        {printPreview.status === 'sent' && '✓ Sent to printer'}
                        {printPreview.status === 'preview' && '👁 Preview only · no printer configured'}
                        {printPreview.status === 'error' && `✕ Printer error: ${printPreview.error}`}
                      </div>
                    </div>
                    <button
                      onClick={() => setPrintPreview(null)}
                      style={{ background: 'transparent', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 4 }}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <pre style={{
                    margin: 0, padding: '14px 16px', overflow: 'auto',
                    fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.35,
                    color: 'var(--color-ink)', background: 'var(--color-surface-soft)',
                    whiteSpace: 'pre'
                  }}>
{printPreview.text || '(nothing to preview)'}
                  </pre>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Ready Tickets Section */}
          {readyTickets.length > 0 && (
            <div style={{ marginTop: 'var(--spacing-xl)' }}>
              <h3 className="typography-title-md" style={{ color: 'var(--status-green-text)', marginBottom: 'var(--spacing-md)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
                <CheckCircle2 size={18} /> Ready to Serve ({readyTickets.length})
              </h3>
              <div style={{ display: 'flex', gap: 'var(--spacing-md)', flexWrap: 'wrap' }}>
                <AnimatePresence>
                  {readyTickets.map(t => (
                    <motion.div
                      key={t.id || t.ticket_number}
                      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                      animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                      exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                      style={{ background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)', padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}
                    >
                      <CheckCircle2 size={16} style={{ color: 'var(--status-green-text)' }} />
                      <div>
                        <strong className="typography-caption" style={{ color: 'var(--color-ink)' }}>{t.table_name || 'Table'}</strong>
                        <div className="typography-badge" style={{ color: 'var(--color-muted)' }}>Ticket #{t.ticket_number} · Ready</div>
                      </div>
                      {/* Next course goes to the kitchen when the guests are ready; recall puts a mistaken ticket back on the board. */}
                      {heldGroups(t).length > 0 && (
                        <button
                          onClick={() => handleFire(t)}
                          style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)', border: 'none', borderRadius: 'var(--radius-full)', padding: '6px 12px', fontWeight: 700, fontSize: '12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}
                        >
                          <Flame size={13} /> Fire course {heldGroups(t)[0].course}
                        </button>
                      )}
                      <button
                        onClick={() => handleRecall(t)}
                        title="Put this ticket back on the kitchen board"
                        style={{ background: 'transparent', color: 'var(--color-body)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-full)', padding: '6px 10px', fontWeight: 600, fontSize: '12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        <RotateCcw size={12} /> Recall
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <KitchenHubApp />
  </React.StrictMode>
);
