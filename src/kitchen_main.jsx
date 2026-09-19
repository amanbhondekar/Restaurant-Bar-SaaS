import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { ChefHat, CheckCircle2, AlertCircle, Wifi, Cloud, Flame, Timer, RefreshCw, QrCode, Receipt, X } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import './index.css';

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
      }
    } catch (err) {
      console.warn('Could not fetch QR code:', err);
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
                    return { ...t, status: 'ready' };
                  }
                  return t;
                }));
              }
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

  // Mark ticket ready
  const handleMarkReady = async (ticket) => {
    try {
      const res = await fetch(`${hubHost}/orders/${ticket.id || ticket.ticket_number}/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        setTickets(prev => prev.map(t => {
          if (t.id === ticket.id || t.ticket_number === ticket.ticket_number) {
            return { ...t, status: 'ready' };
          }
          return t;
        }));
      }
    } catch (err) {
      console.error('Failed to mark ticket ready:', err);
    }
  };

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

  const toggleCheck = (ticketId, idx) => {
    const key = `${ticketId}_${idx}`;
    setCheckedItems(p => ({ ...p, [key]: !p[key] }));
  };

  const allChecked = (ticket) => {
    if (!ticket.items || !ticket.items.length) return true;
    return ticket.items.every((_, idx) => checkedItems[`${ticket.id}_${idx}`]);
  };

  const activeTickets = tickets.filter(t => t.status === 'in_progress');
  const readyTickets = tickets.filter(t => t.status === 'ready');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-canvas)', color: 'var(--color-ink)', fontFamily: 'var(--font-body)', padding: '24px' }}>
      {/* Top Navigation / Header */}
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: '#ffffff', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)',
        padding: '16px 24px', marginBottom: '24px', flexWrap: 'wrap', gap: '16px',
        boxShadow: 'var(--shadow-card-float)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ background: 'var(--color-primary)', color: '#ffffff', width: '44px', height: '44px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px' }}>
            👨‍🍳
          </div>
          <div>
            <h1 className="typography-display-sm" style={{ margin: 0, color: 'var(--color-ink)' }}>
              Kitchen Hub Display
            </h1>
            <div style={{ fontSize: '13px', color: 'var(--color-muted)', marginTop: '2px' }}>
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
        </div>
      </header>

      {/* Main Grid: Left side pairing card, Right side live KOT tickets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 320px) 1fr', gap: '24px', alignItems: 'start' }}>
        
        {/* Left Column: Waiter Pairing QR Code & Details */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ background: '#ffffff', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px', textAlign: 'center', boxShadow: 'var(--shadow-card-float)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '12px', fontFamily: 'var(--font-display)' }}>
              <QrCode size={16} /> Waiter Pairing QR Code
            </div>
            
            {qrCodeUrl ? (
              <div style={{ background: '#ffffff', padding: '12px', borderRadius: '12px', border: '1px solid var(--color-hairline)', display: 'inline-block', marginBottom: '12px' }}>
                <img src={qrCodeUrl} alt="Waiter App Pairing QR" style={{ width: '180px', height: '180px', display: 'block' }} />
              </div>
            ) : (
              <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-muted)' }}>Generating QR...</div>
            )}

            <div style={{ fontSize: '13px', color: 'var(--color-ink)', fontWeight: 600 }}>
              Scan with Waiter Phone Camera
            </div>
            <div style={{ fontSize: '11px', color: 'var(--color-muted)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
              LAN Address: {pairingInfo?.server_url || hubHost}/waiter
            </div>
            <div style={{ marginTop: '12px', background: 'var(--color-surface-soft)', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', color: 'var(--color-body)' }}>
              Pairing Code: <strong style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)' }}>{pairingInfo?.pairing_code || '---'}</strong>
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
          <div style={{ background: '#ffffff', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px', boxShadow: 'var(--shadow-card-float)' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-muted)', textTransform: 'uppercase', marginBottom: '12px', fontFamily: 'var(--font-display)' }}>
              Kitchen Summary
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)', padding: '12px', borderRadius: '10px', textAlign: 'center' }}>
                <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--status-amber-text)', fontFamily: 'var(--font-mono)' }}>{activeTickets.length}</div>
                <div style={{ fontSize: '11px', color: 'var(--status-amber-text)', marginTop: '2px', fontWeight: 600 }}>ACTIVE KOTS</div>
              </div>
              <div style={{ background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)', padding: '12px', borderRadius: '10px', textAlign: 'center' }}>
                <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--status-green-text)', fontFamily: 'var(--font-mono)' }}>{readyTickets.length}</div>
                <div style={{ fontSize: '11px', color: 'var(--status-green-text)', marginTop: '2px', fontWeight: 600 }}>READY TO SERVE</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Live KOT Rail (SIGNATURE MOTION MOMENT: TICKET PRINT-IN) */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h2 className="typography-title-md" style={{ margin: 0, color: 'var(--color-ink)', fontSize: '18px' }}>
              Live Order Tickets ({activeTickets.length})
            </h2>
            <span style={{ fontSize: '12px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
              ⚡ Instant Physical Ticket Printer Motion
            </span>
          </div>

          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--color-muted)' }}>Loading active KOTs...</div>
          ) : activeTickets.length === 0 ? (
            <div style={{
              background: '#ffffff', border: '1px dashed var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '60px 20px',
              textAlign: 'center', color: 'var(--color-muted)'
            }}>
              <ChefHat size={40} style={{ color: 'var(--color-muted)', marginBottom: '12px' }} />
              <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--color-ink)', fontFamily: 'var(--font-display)' }}>Kitchen Rail Clear</div>
              <div style={{ fontSize: '13px', marginTop: '4px', color: 'var(--color-muted)' }}>
                Orders placed on waiter phones will pop up here in real time.
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
              <AnimatePresence mode="popLayout">
                {activeTickets.map(ticket => {
                  const canMark = allChecked(ticket);
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
                        background: '#ffffff',
                        border: '1px solid var(--color-hairline)',
                        borderRadius: 'var(--radius-md)',
                        padding: '16px',
                        display: 'flex',
                        flexDirection: 'column',
                        justify: 'space-between',
                        boxShadow: 'var(--shadow-card-float)',
                        transformOrigin: 'top center'
                      }}
                    >
                      <div>
                        {/* Ticket Header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--color-hairline)', paddingBottom: '10px', marginBottom: '12px' }}>
                          <div>
                            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-primary)', fontFamily: 'var(--font-mono)' }}>
                              TICKET #{ticket.ticket_number}
                            </span>
                            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--color-ink)', marginTop: '2px', fontFamily: 'var(--font-display)' }}>
                              {ticket.table_name || 'Table'}
                            </div>
                          </div>
                          <span style={{ fontSize: '11px', background: ticket.synced_to_cloud ? 'var(--status-green-bg)' : 'var(--status-amber-bg)', color: ticket.synced_to_cloud ? 'var(--status-green-text)' : 'var(--status-amber-text)', padding: '3px 8px', borderRadius: '999px', fontWeight: 600, fontFamily: 'var(--font-mono)', border: `1px solid ${ticket.synced_to_cloud ? 'var(--status-green-border)' : 'var(--status-amber-border)'}` }}>
                            {ticket.synced_to_cloud ? '✓ Synced' : '⏳ Queued'}
                          </span>
                        </div>

                        {/* Items Checklist */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                          {ticket.items && ticket.items.map((item, idx) => {
                            const isChecked = !!checkedItems[`${ticket.id}_${idx}`];
                            return (
                              <div
                                key={idx}
                                onClick={() => toggleCheck(ticket.id, idx)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer',
                                  opacity: isChecked ? 0.4 : 1, textDecoration: isChecked ? 'line-through' : 'none'
                                }}
                              >
                                <div style={{
                                  width: '18px', height: '18px', borderRadius: '4px',
                                  border: `1.5px solid ${isChecked ? 'var(--status-green-text)' : 'var(--color-hairline)'}`,
                                  background: isChecked ? 'var(--status-green-text)' : 'transparent',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  color: '#fff', fontSize: '10px', fontWeight: 800
                                }}>
                                  {isChecked && '✓'}
                                </div>
                                <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-ink)' }}>
                                  {item.qty > 1 && <strong style={{ color: 'var(--color-primary)' }}>{item.qty}× </strong>}
                                  {item.name}
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {ticket.note && (
                          <div style={{ background: 'var(--status-amber-bg)', padding: '8px 10px', borderRadius: '6px', fontSize: '12px', color: 'var(--status-amber-text)', fontStyle: 'italic', marginBottom: '12px', borderLeft: '3px solid var(--color-primary)' }}>
                            📝 {ticket.note}
                          </div>
                        )}
                      </div>

                      {/* Bottom Action */}
                      <div style={{ borderTop: '1px solid var(--color-hairline)', paddingTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--color-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                          onClick={() => handleMarkReady(ticket)}
                          disabled={!canMark}
                          style={{
                            background: canMark ? 'var(--status-green-text)' : 'var(--color-surface-soft)',
                            color: canMark ? '#ffffff' : 'var(--color-muted)',
                            border: `1px solid ${canMark ? 'var(--status-green-border)' : 'var(--color-hairline)'}`, padding: '8px 14px', borderRadius: 'var(--radius-full)',
                            fontWeight: 700, fontSize: '13px', cursor: canMark ? 'pointer' : 'not-allowed'
                          }}
                        >
                          {canMark ? '✓ Mark Ready' : 'Tick All'}
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
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                                  #{line.ticket_number} · {billInvoice.currency}{line.price} each
                                </div>
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
                          <div style={{
                            marginTop: '12px', background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)',
                            color: 'var(--status-green-text)', padding: '10px 12px', borderRadius: '8px',
                            fontSize: '13px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700
                          }}>
                            ✓ {billInvoice.invoice_number} issued
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

          {/* Ready Tickets Section */}
          {readyTickets.length > 0 && (
            <div style={{ marginTop: '32px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--status-green-text)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-display)' }}>
                <CheckCircle2 size={18} /> Ready to Serve ({readyTickets.length})
              </h3>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <AnimatePresence>
                  {readyTickets.map(t => (
                    <motion.div
                      key={t.id || t.ticket_number}
                      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                      animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                      exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                      style={{ background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)', padding: '10px 14px', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '10px' }}
                    >
                      <CheckCircle2 size={16} style={{ color: 'var(--status-green-text)' }} />
                      <div>
                        <strong style={{ color: 'var(--color-ink)', fontSize: '13px' }}>{t.table_name || 'Table'}</strong>
                        <div style={{ fontSize: '11px', color: 'var(--color-muted)' }}>Ticket #{t.ticket_number} · Ready</div>
                      </div>
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
