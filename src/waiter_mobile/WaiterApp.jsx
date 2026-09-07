import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FloorGrid } from './FloorGrid';
import { RapidOrderBuilder } from './RapidOrderBuilder';
import { OrderDraftDrawer } from './OrderDraftDrawer';
import { WifiOff, LayoutGrid, Utensils, ShoppingBag, ShieldCheck, Server, RefreshCw, AlertTriangle } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePos } from '../context/PosContext';

export const WaiterApp = () => {
  const { currentRestaurant, isMenuUninitialized: posMenuUninitialized } = usePos() || {};
  const shouldReduceMotion = useReducedMotion();
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [activeTab, setActiveTab] = useState('floor');
  const [hubMenuUninitialized, setHubMenuUninitialized] = useState(false);

  // Hub Connection & Pairing State
  const defaultHub = typeof window !== 'undefined' 
    ? `${window.location.protocol}//${window.location.hostname}:4000` 
    : 'http://localhost:4000';

  const [hubUrl, setHubUrl] = useState(() => {
    return localStorage.getItem('mejwani_hub_url') || defaultHub;
  });

  const [hubInfo, setHubInfo] = useState(null);
  const [connStatus, setConnStatus] = useState('connecting'); // 'connecting' | 'connected' | 'disconnected'
  const hubConnected = connStatus === 'connected';
  const [showPairModal, setShowPairModal] = useState(false);
  const [manualIpInput, setManualIpInput] = useState('');
  const [pairError, setPairError] = useState('');
  const [isTestingConn, setIsTestingConn] = useState(false);

  // Live Dynamic State from Hub Server
  const [liveTables, setLiveTables] = useState([]);
  const [activeOrders, setActiveOrders] = useState([]);
  const wasConnectedRef = useRef(false);
  const isGracePeriodRef = useRef(true);

  // 1. Fetch Live Tables, Open Orders, and Menu state from Hub Server
  const fetchLiveState = useCallback(async (targetUrl = hubUrl) => {
    const cleanUrl = targetUrl.replace(/\/+$/, '');
    try {
      const [tablesRes, ordersRes, menuRes] = await Promise.all([
        fetch(`${cleanUrl}/tables`).catch(() => null),
        fetch(`${cleanUrl}/orders/active`).catch(() => null),
        fetch(`${cleanUrl}/menu`).catch(() => null)
      ]);

      if (menuRes && menuRes.ok) {
        const menuData = await menuRes.json();
        if (menuData.uninitialized) {
          setHubMenuUninitialized(true);
        } else {
          setHubMenuUninitialized(false);
        }
      }

      if (tablesRes && tablesRes.ok) {
        const data = await tablesRes.json();
        if (data.uninitialized) {
          setHubMenuUninitialized(true);
        }
        if (data.tables && Array.isArray(data.tables)) {
          setLiveTables(data.tables);
        }
      }

      if (ordersRes && ordersRes.ok) {
        const data = await ordersRes.json();
        if (data.tickets && Array.isArray(data.tickets)) {
          setActiveOrders(data.tickets);
        }
      }
    } catch (err) {
      console.warn('Could not fetch live state from hub:', err);
    }
  }, [hubUrl]);

  const pingFailuresRef = useRef(0);

  // 2. Periodic 5s Health Check & Auto Re-Sync on Reconnect
  const checkHubConnection = useCallback(async (targetUrl = hubUrl) => {
    setIsTestingConn(true);
    setPairError('');
    const cleanUrl = targetUrl.replace(/\/+$/, '');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s timeout

      const res = await fetch(`${cleanUrl}/pairing-info`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        setHubInfo(data);
        pingFailuresRef.current = 0; // Reset fail counter on success
        
        // Auto Re-Sync check: if previously disconnected and now connected again
        if (!wasConnectedRef.current) {
          fetchLiveState(cleanUrl);
        }
        wasConnectedRef.current = true;
        setConnStatus('connected');
        setHubUrl(cleanUrl);
        localStorage.setItem('mejwani_hub_url', cleanUrl);
        setIsTestingConn(false);
        return true;
      }
    } catch (err) {
      pingFailuresRef.current += 1;
      // Require 2 consecutive missed pings (or post grace window) before declaring offline state
      if (pingFailuresRef.current >= 2 || !isGracePeriodRef.current) {
        wasConnectedRef.current = false;
        setConnStatus('disconnected');
      }
    }
    setIsTestingConn(false);
    return false;
  }, [hubUrl, fetchLiveState]);

  useEffect(() => {
    isGracePeriodRef.current = true;
    const graceTimer = setTimeout(() => {
      isGracePeriodRef.current = false;
      if (pingFailuresRef.current >= 2) {
        setConnStatus('disconnected');
      }
    }, 3000);

    checkHubConnection(hubUrl);
    fetchLiveState(hubUrl);

    // Periodic 5s health check loop
    const healthInterval = setInterval(() => {
      checkHubConnection(hubUrl);
    }, 5000);

    return () => {
      clearTimeout(graceTimer);
      clearInterval(healthInterval);
    };
  }, [hubUrl, checkHubConnection, fetchLiveState]);

  // Shared WebSocket Message Funnel for all state-changing events
  const handleHubWsEvent = useCallback((msg, cleanUrl) => {
    if (!msg || !msg.type) return;
    const type = msg.type;
    const payload = msg.payload || {};

    console.log(`⚡ WaiterApp processing WS event: ${type}`, payload);

    // 1. Instant optimistic local state updates
    if (type === 'TICKET_READY' || type === 'order_ready') {
      const tableId = payload.table_id;
      const ticketId = payload.ticket_id || payload.ticket_number || payload.order_id;

      if (tableId) {
        setLiveTables(prev => prev.map(t => {
          if (String(t.id) === String(tableId) || (t.name && String(t.name).toLowerCase() === String(payload.table_name).toLowerCase())) {
            return { ...t, status: 'ready' };
          }
          return t;
        }));
      }
      if (ticketId) {
        setActiveOrders(prev => prev.map(o => {
          if (o.id === ticketId || String(o.ticket_number) === String(ticketId)) {
            return { ...o, status: 'ready' };
          }
          return o;
        }));
      }
    } else if (type === 'CLEAR_TABLE' || type === 'bill_cleared' || type === 'order_cleared') {
      const tableId = payload.table_id;

      if (tableId) {
        setLiveTables(prev => prev.map(t => {
          if (String(t.id) === String(tableId)) {
            return { ...t, status: 'available', activeOrderTotal: 0, occupiedSince: null };
          }
          return t;
        }));

        setActiveOrders(prev => prev.filter(o => String(o.table_id) !== String(tableId)));

        setDrafts(prev => {
          const copy = { ...prev };
          delete copy[tableId];
          return copy;
        });
      }
    } else if (type === 'NEW_ORDER' || type === 'order_created') {
      const ticket = payload.ticket || payload;
      if (ticket && ticket.table_id) {
        setLiveTables(prev => prev.map(t => {
          if (String(t.id) === String(ticket.table_id)) {
            return {
              ...t,
              status: t.status === 'ready' ? 'ready' : 'kot',
              activeOrderTotal: (t.activeOrderTotal || 0) + (Number(ticket.total_amount) || 0)
            };
          }
          return t;
        }));

        setActiveOrders(prev => {
          const exists = prev.some(o => o.id === ticket.id || String(o.ticket_number) === String(ticket.ticket_number));
          if (exists) return prev;
          return [ticket, ...prev];
        });
      }
    }

    // 2. Authoritative live state fetch to stay 100% synchronized
    fetchLiveState(cleanUrl);
  }, [fetchLiveState]);

  // 3. WebSocket Real-Time Subscription to WS /live
  useEffect(() => {
    if (!hubUrl) return;
    const cleanUrl = hubUrl.replace(/\/+$/, '');
    const wsHost = cleanUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    const wsUrl = `${wsHost}/live`;

    let ws = null;
    let isSubscribed = true;

    const connectWs = () => {
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log(`📱 Waiter App WS /live connected to ${wsUrl}`);
          fetchLiveState(cleanUrl);
        };

        ws.onmessage = (event) => {
          if (!isSubscribed) return;
          try {
            const msg = JSON.parse(event.data);
            handleHubWsEvent(msg, cleanUrl);
          } catch (e) {
            console.warn('WS message parse error:', e);
          }
        };

        ws.onclose = () => {
          if (isSubscribed) {
            setTimeout(connectWs, 4000);
          }
        };

        ws.onerror = () => {
          if (ws) ws.close();
        };
      } catch (err) {
        console.warn('WS connection failed:', err);
      }
    };

    connectWs();

    return () => {
      isSubscribed = false;
      if (ws) ws.close();
    };
  }, [hubUrl, fetchLiveState, handleHubWsEvent]);

  // Handle Clearing Table Bill
  const handleClearTableBill = async (tableId) => {
    setDrafts(p => {
      const c = { ...p };
      delete c[tableId];
      return c;
    });

    if (!hubUrl) return;
    const cleanUrl = hubUrl.replace(/\/+$/, '');
    try {
      const res = await fetch(`${cleanUrl}/tables/${tableId}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        console.log(`🧹 Clear bill request for table ${tableId} succeeded on Hub`);
        fetchLiveState(cleanUrl);
      }
    } catch (err) {
      console.error(`Failed to clear bill for table ${tableId}:`, err);
    }
  };

  const handlePairSubmit = async (e) => {
    e.preventDefault();
    if (!manualIpInput.trim()) return;
    setConnStatus('connecting');

    let raw = manualIpInput.trim();
    if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      raw = `http://${raw}`;
    }
    if (!raw.includes(':', 6)) {
      raw = `${raw}:4000`;
    }

    const success = await checkHubConnection(raw);
    if (success) {
      setShowPairModal(false);
      setManualIpInput('');
      fetchLiveState(raw);
    } else {
      setConnStatus('disconnected');
      setPairError(`Could not reach Kitchen Hub at ${raw}. Check WiFi connection.`);
    }
  };

  const currentDraftItems = selectedTableId ? (drafts[selectedTableId] || {}) : {};
  const totalCartCount = Object.values(currentDraftItems).reduce((s, q) => s + q, 0);

  const addItem = (itemId) => {
    if (!selectedTableId) return;
    setDrafts(p => ({ ...p, [selectedTableId]: { ...(p[selectedTableId] || {}), [itemId]: ((p[selectedTableId] || {})[itemId] || 0) + 1 } }));
  };

  const removeItem = (itemId) => {
    if (!selectedTableId) return;
    setDrafts(p => {
      const d = { ...(p[selectedTableId] || {}) };
      d[itemId] = (d[itemId] || 0) - 1;
      if (d[itemId] <= 0) delete d[itemId];
      return { ...p, [selectedTableId]: d };
    });
  };

  const clearDraft = () => {
    if (!selectedTableId) return;
    setDrafts(p => { const c = { ...p }; delete c[selectedTableId]; return c; });
  };

  const navItems = [
    { id: 'floor', icon: LayoutGrid, label: 'Tables' },
    { id: 'menu',  icon: Utensils,   label: 'Menu' },
    { id: 'cart',  icon: ShoppingBag, label: 'Cart', badge: totalCartCount },
  ];

  return (
    <div style={{
      width: '100%', maxWidth: '480px', minHeight: '100vh', display: 'flex', flexDirection: 'column',
      background: 'var(--color-canvas)', margin: '0 auto',
      paddingTop: 'env(safe-area-inset-top, 0px)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      paddingLeft: 'env(safe-area-inset-left, 0px)',
      paddingRight: 'env(safe-area-inset-right, 0px)'
    }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* App Header & Pairing Status */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--spacing-sm) var(--spacing-base)', background: 'var(--color-canvas)',
          borderBottom: '1px solid var(--color-hairline)', flex: 'none'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
            <div className="avatar avatar-sm avatar-primary" style={{ fontWeight: 800, fontSize: '12px' }}>
              W1
            </div>
            <div>
              <div className="typography-caption" style={{ color: 'var(--color-ink)' }}>
                {hubInfo?.name || currentRestaurant?.name || 'Hotel Mejwani'}
              </div>
              <div className="typography-badge" style={{ color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
                Hub: {hubUrl.replace('http://', '').replace('https://', '')}
              </div>
            </div>
          </div>

          <button
            onClick={() => setShowPairModal(true)}
            className={`conn-pill conn-pill-${connStatus === 'connected' ? 'ok' : connStatus === 'connecting' ? 'connecting' : 'off'}`}
            style={{ cursor: 'pointer' }}
          >
            {connStatus === 'connected' ? (
              <ShieldCheck size={12} />
            ) : connStatus === 'connecting' ? (
              <RefreshCw size={12} className="spin" />
            ) : (
              <WifiOff size={12} />
            )}
            {connStatus === 'connected' ? 'LAN Connected' : connStatus === 'connecting' ? 'Connecting…' : 'Not Connected'}
          </button>
        </div>

        {/* Unreachable Hub Offline Banner */}
        {connStatus === 'disconnected' && (
          <div className="banner banner-error" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            borderBottom: '1px solid var(--color-error-border)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <WifiOff size={16} style={{ flexShrink: 0 }} />
              <span>Not connected to kitchen hub. Tap to pair.</span>
            </div>
            <button
              onClick={() => setShowPairModal(true)}
              className="btn btn-danger btn-sm banner-connect-btn"
            >
              Connect
            </button>
          </div>
        )}

        {/* Uninitialized Cache & Offline Failure Banner */}
        {(hubMenuUninitialized || posMenuUninitialized) && (
          <div className="banner banner-warning" style={{
            borderBottom: '1px solid var(--color-warning-border)',
            display: 'flex', alignItems: 'center', gap: '10px'
          }}>
            <AlertTriangle size={16} style={{ flexShrink: 0 }} />
            <span>No menu data available — connect this hub to the internet once to complete setup.</span>
          </div>
        )}

        {/* Pairing Modal Flow */}
        {showPairModal && (
          <div className="modal-overlay" style={{
            position: 'absolute', inset: 0, zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-lg)'
          }}>
            <div className="modal-content" style={{
              width: '100%', maxWidth: '340px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
                <Server size={22} style={{ color: 'var(--color-primary)' }} />
                <h3 className="typography-title-md" style={{ margin: 0, color: 'var(--color-ink)' }}>
                  Connect to Kitchen Hub
                </h3>
              </div>

              <p className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: 0, marginBottom: 'var(--spacing-base)' }}>
                Scan the QR code displayed on the Kitchen Display screen, or enter the hub's LAN IP address below.
              </p>

              <form onSubmit={handlePairSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
                <div>
                  <label className="form-label">
                    Hub LAN IP or URL
                  </label>
                  <input
                    type="text"
                    value={manualIpInput}
                    onChange={e => setManualIpInput(e.target.value)}
                    placeholder="e.g. 192.168.1.50:4000"
                    className="input"
                    style={{ fontFamily: 'var(--font-mono)' }}
                  />
                </div>

                {pairError && (
                  <div className="typography-badge" style={{ color: 'var(--color-error-text)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
                    <AlertTriangle size={12} /> {pairError}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-sm)' }}>
                  <button
                    type="button"
                    onClick={() => setShowPairModal(false)}
                    className="btn btn-ghost"
                    style={{ flex: 1 }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isTestingConn}
                    className="btn btn-primary"
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--spacing-xs)' }}
                  >
                    {isTestingConn ? <RefreshCw size={14} className="spin" /> : 'Connect'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Screen Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--spacing-md)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', background: 'var(--color-canvas)' }}>
          {activeTab === 'floor' && (
            <>
              <p className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>
                Select Table → Add Items → Send to Kitchen
              </p>
              <FloorGrid
                selectedTable={selectedTableId}
                onSelectTable={setSelectedTableId}
                tables={liveTables}
                onClearTableBill={handleClearTableBill}
                isLoading={connStatus === 'connecting' && liveTables.length === 0}
                drafts={drafts}
                onOpenPairing={() => setShowPairModal(true)}
                hubConnected={hubConnected}
              />
              <OrderDraftDrawer
                selectedTableId={selectedTableId}
                draftItems={currentDraftItems}
                onRemoveItem={removeItem}
                onClearDraft={clearDraft}
                hubUrl={hubUrl}
                hubConnected={hubConnected}
              />
            </>
          )}

          {activeTab === 'menu' && (
            <>
              {!selectedTableId && (
                <div className="banner banner-warning" style={{
                  borderRadius: 'var(--radius-sm)', padding: 'var(--spacing-sm) var(--spacing-md)',
                  display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', borderBottom: 'none'
                }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0 }} /> Tap a table on the <strong>Tables</strong> tab first, then add items here.
                </div>
              )}
              <RapidOrderBuilder
                selectedTableId={selectedTableId}
                draftItems={currentDraftItems}
                onAddItem={addItem}
                onRemoveItem={removeItem}
              />
            </>
          )}

          {activeTab === 'cart' && (
            <OrderDraftDrawer
              selectedTableId={selectedTableId}
              draftItems={currentDraftItems}
              onRemoveItem={removeItem}
              onClearDraft={clearDraft}
              hubUrl={hubUrl}
              hubConnected={hubConnected}
            />
          )}
        </div>

        {/* Bottom Nav Bar */}
        <div className="bottom-nav" style={{ flex: 'none' }}>
          {navItems.map(nav => (
            <button
              key={nav.id}
              onClick={() => setActiveTab(nav.id)}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px',
                padding: '8px 4px', borderRadius: 'var(--radius-sm)',
                color: activeTab === nav.id ? 'var(--color-primary)' : 'var(--color-muted)',
                background: 'transparent',
                fontSize: '11px', fontWeight: activeTab === nav.id ? 700 : 500, position: 'relative',
                transition: 'all 0.15s ease', border: 'none', cursor: 'pointer'
              }}
            >
              <nav.icon size={20} strokeWidth={activeTab === nav.id ? 2.5 : 1.8} />
              {nav.label}
              {activeTab === nav.id && (
                <span style={{
                  position: 'absolute', bottom: '0', left: '50%', transform: 'translateX(-50%)',
                  width: '20px', height: '3px', borderRadius: '2px',
                  background: 'var(--color-primary)'
                }} />
              )}
              {nav.badge > 0 && (
                <span style={{
                  position: 'absolute', top: '2px', right: '14px',
                  background: 'var(--color-primary)',
                  color: 'var(--color-on-primary)', fontSize: '9px', fontWeight: 700, borderRadius: 'var(--radius-full)',
                  padding: '1px 6px', fontFamily: 'var(--font-mono)'
                }}>
                  {nav.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
