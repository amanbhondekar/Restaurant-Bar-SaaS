import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { ChefHat, CheckCircle2, AlertCircle, Wifi, Cloud, Flame, Timer, RefreshCw, QrCode, StickyNote, Check, Loader, Zap } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import QRCodeLib from 'qrcode';
import './index.css';

const KitchenHubApp = () => {
  const [pairingInfo, setPairingInfo] = useState(null);
  const [qrCodeUrl, setQrCodeUrl] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [syncStatus, setSyncStatus] = useState({ queued: 0, online: true, isSyncing: false });
  const [wsConnStatus, setWsConnStatus] = useState('connecting'); // 'connecting' | 'connected' | 'disconnected'
  const wsConnected = wsConnStatus === 'connected';
  const missedWsFailuresRef = useRef(0);
  const isGracePeriodRef = useRef(true);
  const [checkedItems, setCheckedItems] = useState({});
  const [loading, setLoading] = useState(true);
  const shouldReduceMotion = useReducedMotion();

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
              Live Order Tickets ({activeTickets.length})
            </h2>
            <span className="typography-badge" style={{ color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <Zap size={12} /> Real-time KDS
            </span>
          </div>

          {loading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--color-muted)' }}>Loading active KOTs...</div>
          ) : activeTickets.length === 0 ? (
            <div className="empty-state empty-state-lg">
              <ChefHat size={40} style={{ color: 'var(--color-muted)', marginBottom: 'var(--spacing-md)' }} />
              <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>Kitchen Rail Clear</div>
              <div className="typography-caption-sm" style={{ marginTop: 'var(--spacing-xs)', color: 'var(--color-muted)' }}>
                Orders placed on waiter phones will pop up here in real time.
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--spacing-base)' }}>
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

                        {/* Items Checklist */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
                          {ticket.items && ticket.items.map((item, idx) => {
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
                                <span className="typography-caption" style={{ color: 'var(--color-ink)' }}>
                                  {item.qty > 1 && <strong style={{ color: 'var(--color-primary)' }}>{item.qty}× </strong>}
                                  {item.name}
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {ticket.note && (
                          <div className="ticket-note" style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-xs)', marginBottom: 'var(--spacing-md)' }}>
                            <StickyNote size={13} style={{ flexShrink: 0, marginTop: '1px' }} /> {ticket.note}
                          </div>
                        )}
                      </div>

                      {/* Bottom Action */}
                      <div style={{ borderTop: '1px solid var(--color-hairline)', paddingTop: 'var(--spacing-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="typography-badge" style={{ color: 'var(--color-muted)' }}>
                          By {ticket.created_by_waiter || 'Waiter'}
                        </span>
                        <motion.button
                          whileTap={shouldReduceMotion || !canMark ? {} : { scale: 0.95 }}
                          onClick={() => handleMarkReady(ticket)}
                          disabled={!canMark}
                          style={{
                            background: canMark ? 'var(--status-green-text)' : 'var(--color-surface-soft)',
                            color: canMark ? 'var(--color-on-primary)' : 'var(--color-muted)',
                            border: `1px solid ${canMark ? 'var(--status-green-border)' : 'var(--color-hairline)'}`, padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-full)',
                            fontWeight: 700, fontSize: '13px', cursor: canMark ? 'pointer' : 'not-allowed'
                          }}
                        >
                          {canMark ? <><Check size={14} /> Mark Ready</> : 'Tick All'}
                        </motion.button>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

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
