import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FloorGrid } from './FloorGrid';
import { RapidOrderBuilder } from './RapidOrderBuilder';
import { OrderDraftDrawer } from './OrderDraftDrawer';
import { WifiOff, LayoutGrid, Utensils, ShoppingBag, ShieldCheck, Server, RefreshCw, AlertTriangle } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePos } from '../context/PosContext';
import { authFetch, captureTokenFromUrl, enrollWithCode, hasToken } from '../services/hubAuth';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { ThemeToggle } from '../components/ThemeToggle';

export const WaiterApp = () => {
  const { currentRestaurant, isMenuUninitialized: posMenuUninitialized } = usePos() || {};
  const shouldReduceMotion = useReducedMotion();
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [activeTab, setActiveTab] = useState('floor');
  const [hubMenuUninitialized, setHubMenuUninitialized] = useState(false);

  const defaultHub = typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : 'http://localhost:4000';

  const [hubUrl, setHubUrl] = useState(() => {
    return localStorage.getItem('mejwani_hub_url') || defaultHub;
  });

  const [hubInfo, setHubInfo] = useState(null);
  const [connStatus, setConnStatus] = useState('connecting');
  const hubConnected = connStatus === 'connected';
  const [showPairModal, setShowPairModal] = useState(false);
  const [manualIpInput, setManualIpInput] = useState('');
  const [enrollCodeInput, setEnrollCodeInput] = useState('');
  // A QR scan drops the device token straight into the URL, so capture it before
  // the first render decides whether this handset still needs to enrol.
  const [isEnrolled, setIsEnrolled] = useState(() => {
    captureTokenFromUrl();
    return hasToken();
  });
  const [pairError, setPairError] = useState('');
  const [isTestingConn, setIsTestingConn] = useState(false);

  const [liveTables, setLiveTables] = useState([]);
  const [activeOrders, setActiveOrders] = useState([]);
  const wasConnectedRef = useRef(false);
  const isGracePeriodRef = useRef(true);

  const fetchLiveState = useCallback(async (targetUrl = hubUrl) => {
    const cleanUrl = targetUrl.replace(/\/+$/, '');
    try {
      const [tablesRes, ordersRes, menuRes] = await Promise.all([
        authFetch(`${cleanUrl}/tables`).catch(() => null),
        authFetch(`${cleanUrl}/orders/active`).catch(() => null),
        authFetch(`${cleanUrl}/menu`).catch(() => null)
      ]);

      if (menuRes && menuRes.ok) {
        const menuData = await menuRes.json();
        setHubMenuUninitialized(!!menuData.uninitialized);
      }

      if (tablesRes && tablesRes.ok) {
        const data = await tablesRes.json();
        if (data.uninitialized) setHubMenuUninitialized(true);
        if (data.tables && Array.isArray(data.tables)) setLiveTables(data.tables);
      }

      if (ordersRes && ordersRes.ok) {
        const data = await ordersRes.json();
        if (data.tickets && Array.isArray(data.tickets)) setActiveOrders(data.tickets);
      }
    } catch (err) {
      console.warn('Could not fetch live state from hub:', err);
    }
  }, [hubUrl]);

  const pingFailuresRef = useRef(0);

  const checkHubConnection = useCallback(async (targetUrl = hubUrl) => {
    setIsTestingConn(true);
    setPairError('');
    const cleanUrl = targetUrl.replace(/\/+$/, '');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await authFetch(`${cleanUrl}/pairing-info`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        setHubInfo(data);
        pingFailuresRef.current = 0;
        if (!wasConnectedRef.current) fetchLiveState(cleanUrl);
        wasConnectedRef.current = true;
        setConnStatus('connected');
        setHubUrl(cleanUrl);
        localStorage.setItem('mejwani_hub_url', cleanUrl);
        setIsTestingConn(false);
        return true;
      }
    } catch (err) {
      pingFailuresRef.current += 1;
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
      if (pingFailuresRef.current >= 2) setConnStatus('disconnected');
    }, 3000);

    checkHubConnection(hubUrl);
    fetchLiveState(hubUrl);
    const healthInterval = setInterval(() => checkHubConnection(hubUrl), 5000);

    return () => { clearTimeout(graceTimer); clearInterval(healthInterval); };
  }, [hubUrl, checkHubConnection, fetchLiveState]);

  const handleHubWsEvent = useCallback((msg, cleanUrl) => {
    if (!msg || !msg.type) return;
    const type = msg.type;
    const payload = msg.payload || {};

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
          if (o.id === ticketId || String(o.ticket_number) === String(ticketId)) return { ...o, status: 'ready' };
          return o;
        }));
      }
    } else if (type === 'CLEAR_TABLE' || type === 'bill_cleared' || type === 'order_cleared') {
      const tableId = payload.table_id;
      if (tableId) {
        setLiveTables(prev => prev.map(t => String(t.id) === String(tableId) ? { ...t, status: 'available', activeOrderTotal: 0, occupiedSince: null } : t));
        setActiveOrders(prev => prev.filter(o => String(o.table_id) !== String(tableId)));
        setDrafts(prev => { const copy = { ...prev }; delete copy[tableId]; return copy; });
      }
    } else if (type === 'NEW_ORDER' || type === 'order_created') {
      const ticket = payload.ticket || payload;
      if (ticket && ticket.table_id) {
        setLiveTables(prev => prev.map(t => {
          if (String(t.id) === String(ticket.table_id)) {
            return { ...t, status: t.status === 'ready' ? 'ready' : 'kot', activeOrderTotal: (t.activeOrderTotal || 0) + (Number(ticket.total_amount) || 0) };
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
    fetchLiveState(cleanUrl);
  }, [fetchLiveState]);

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
        ws.onopen = () => { console.log(`📱 Waiter WS connected to ${wsUrl}`); fetchLiveState(cleanUrl); };
        ws.onmessage = (event) => {
          if (!isSubscribed) return;
          try { handleHubWsEvent(JSON.parse(event.data), cleanUrl); } catch (e) {}
        };
        ws.onclose = () => { if (isSubscribed) setTimeout(connectWs, 4000); };
        ws.onerror = () => { if (ws) ws.close(); };
      } catch (err) {}
    };
    connectWs();
    return () => { isSubscribed = false; if (ws) ws.close(); };
  }, [hubUrl, fetchLiveState, handleHubWsEvent]);

  const handleClearTableBill = async (tableId) => {
    setDrafts(p => { const c = { ...p }; delete c[tableId]; return c; });
    if (!hubUrl) return;
    const cleanUrl = hubUrl.replace(/\/+$/, '');
    try {
      const res = await authFetch(`${cleanUrl}/tables/${tableId}/clear`, {
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
    setPairError('');

    let raw = manualIpInput.trim();
    if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      raw = `http://${raw}`;
    }
    if (!raw.includes(':', 6)) {
      raw = `${raw}:4000`;
    }

    // The hub only accepts enrolled devices. If this handset has no token yet,
    // trade the code shown on the Kitchen Display for one before connecting.
    if (!hasToken()) {
      const code = enrollCodeInput.trim();
      if (!code) {
        setConnStatus('disconnected');
        setPairError('Enter the enrollment code shown on the Kitchen Display, or scan its QR code instead.');
        return;
      }

      const enrolled = await enrollWithCode(raw, code).catch(() => ({
        ok: false,
        error: `Could not reach Kitchen Hub at ${raw}. Check WiFi connection.`
      }));

      if (!enrolled.ok) {
        setConnStatus('disconnected');
        setPairError(enrolled.error);
        return;
      }
      setIsEnrolled(true);
    }

    const success = await checkHubConnection(raw);
    if (success) {
      setShowPairModal(false);
      setManualIpInput('');
      setEnrollCodeInput('');
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
      width: '100%', maxWidth: '480px', height: '100vh', display: 'flex', flexDirection: 'column',
      background: 'var(--color-canvas)', margin: '0 auto',
      paddingTop: 'env(safe-area-inset-top, 0px)',
      paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)'
    }}>
      <div className="flex flex-col" style={{ height: '100%', overflow: 'hidden' }}>
        {/* Header */}
        <div className="flex items-center justify-between flex-none px-4 py-3"
          style={{ background: 'var(--color-canvas)', borderBottom: '1px solid var(--color-hairline)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-extrabold shrink-0"
              style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
              W1
            </div>
            <div>
              <div className="typography-caption" style={{ color: 'var(--color-ink)' }}>
                {hubInfo?.name || currentRestaurant?.name || 'Hotel Mejwani'}
              </div>
              <div className="font-mono text-[10px]" style={{ color: 'var(--color-muted)' }}>
                Hub: {hubUrl.replace('http://', '').replace('https://', '')}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] font-semibold cursor-pointer gap-1 px-2.5 py-1"
              onClick={() => setShowPairModal(true)}
              style={{
                color: connStatus === 'connected' ? 'var(--status-green-text)' : connStatus === 'connecting' ? 'var(--status-amber-text)' : 'var(--status-rust-text)',
                background: connStatus === 'connected' ? 'var(--status-green-bg)' : connStatus === 'connecting' ? 'var(--status-amber-bg)' : 'var(--status-rust-bg)',
                borderColor: connStatus === 'connected' ? 'var(--status-green-border)' : connStatus === 'connecting' ? 'var(--status-amber-border)' : 'var(--status-rust-border)',
              }}>
              {connStatus === 'connected' ? <ShieldCheck size={11} /> : connStatus === 'connecting' ? <RefreshCw size={11} className="spin" /> : <WifiOff size={11} />}
              {connStatus === 'connected' ? 'LAN' : connStatus === 'connecting' ? '…' : 'Off'}
            </Badge>
            <ThemeToggle size="icon-sm" />
          </div>
        </div>

        {/* Banners */}
        {connStatus === 'disconnected' && (
          <div className="banner banner-error flex items-center justify-between" style={{ borderBottom: '1px solid var(--color-error-border)' }}>
            <div className="flex items-center gap-2">
              <WifiOff size={14} className="shrink-0" />
              <span className="text-xs">Not connected to kitchen hub.</span>
            </div>
            <Button size="sm" variant="destructive" className="h-7 px-3 text-[11px]" onClick={() => setShowPairModal(true)}>Connect</Button>
          </div>
        )}

        {(hubMenuUninitialized || posMenuUninitialized) && (
          <div className="banner banner-warning flex items-center gap-2" style={{ borderBottom: '1px solid var(--color-warning-border)' }}>
            <AlertTriangle size={14} className="shrink-0" />
            <span className="text-xs">No menu data — connect hub to internet to complete setup.</span>
          </div>
        )}

        {/* Pairing Modal */}
        {showPairModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="w-full max-w-[340px] rounded-[var(--radius-md)] border p-6"
              style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)' }}>
              <div className="flex items-center gap-2.5 mb-4">
                <Server size={20} style={{ color: 'var(--color-primary)' }} />
                <h3 className="typography-title-md" style={{ color: 'var(--color-ink)' }}>Connect to Kitchen Hub</h3>
              </div>
              <p className="typography-body-sm mb-4" style={{ color: 'var(--color-muted)' }}>
                Enter the hub's LAN IP address to pair this device.
              </p>
              <form onSubmit={handlePairSubmit} className="flex flex-col gap-4">
                <div>
                  <Label className="text-xs font-semibold" style={{ color: 'var(--color-muted)' }}>Hub LAN IP or URL</Label>
                  <Input type="text" value={manualIpInput} onChange={e => setManualIpInput(e.target.value)}
                    placeholder="e.g. 192.168.1.50:4000" className="mt-1 font-mono" />
                </div>
                {!isEnrolled && (
                  <div>
                    <Label className="text-xs font-semibold" style={{ color: 'var(--color-muted)' }}>Enrollment code</Label>
                    <Input
                      type="text"
                      value={enrollCodeInput}
                      onChange={e => setEnrollCodeInput(e.target.value.toUpperCase())}
                      placeholder="Shown on the Kitchen Display"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      className="mt-1 font-mono"
                      style={{ letterSpacing: '2px' }}
                    />
                    <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '4px', fontSize: '11px' }}>
                      Only needed once per handset. Scanning the QR code skips this step.
                    </div>
                  </div>
                )}

                {pairError && (
                  <div className="text-xs flex items-center gap-1" style={{ color: 'var(--color-error-text)' }}>
                    <AlertTriangle size={12} /> {pairError}
                  </div>
                )}
                <div className="flex gap-2.5 mt-1">
                  <Button type="button" variant="outline" className="flex-1" onClick={() => setShowPairModal(false)}>Cancel</Button>
                  <Button type="submit" disabled={isTestingConn} className="flex-1">
                    {isTestingConn ? <RefreshCw size={14} className="spin" /> : 'Connect'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4" style={{ background: 'var(--color-canvas)' }}>
          {activeTab === 'floor' && (
            <>
              <p className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>
                Select Table → Add Items → Send to Kitchen
              </p>
              <FloorGrid
                selectedTable={selectedTableId} onSelectTable={setSelectedTableId}
                tables={liveTables} onClearTableBill={handleClearTableBill}
                isLoading={connStatus === 'connecting' && liveTables.length === 0}
                drafts={drafts} onOpenPairing={() => setShowPairModal(true)} hubConnected={hubConnected}
              />
              <OrderDraftDrawer
                selectedTableId={selectedTableId} draftItems={currentDraftItems}
                onRemoveItem={removeItem} onClearDraft={clearDraft}
                hubUrl={hubUrl} hubConnected={hubConnected}
              />
            </>
          )}

          {activeTab === 'menu' && (
            <>
              {!selectedTableId && (
                <div className="banner banner-warning flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2" style={{ borderBottom: 'none' }}>
                  <AlertTriangle size={14} className="shrink-0" /> <span className="text-xs">Tap a table on <strong>Tables</strong> tab first.</span>
                </div>
              )}
              <RapidOrderBuilder
                selectedTableId={selectedTableId} draftItems={currentDraftItems}
                onAddItem={addItem} onRemoveItem={removeItem}
              />
            </>
          )}

          {activeTab === 'cart' && (
            <OrderDraftDrawer
              selectedTableId={selectedTableId} draftItems={currentDraftItems}
              onRemoveItem={removeItem} onClearDraft={clearDraft}
              hubUrl={hubUrl} hubConnected={hubConnected}
            />
          )}
        </div>

        {/* Bottom Nav */}
        <div className="bottom-nav flex-none">
          {navItems.map(nav => (
            <button
              key={nav.id}
              onClick={() => setActiveTab(nav.id)}
              className={`bottom-nav-item${activeTab === nav.id ? ' active' : ''}`}
            >
              <nav.icon size={22} strokeWidth={activeTab === nav.id ? 2.4 : 1.8} />
              {nav.label}
              {nav.badge > 0 && <span className="nav-badge">{nav.badge}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
