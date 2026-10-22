import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FloorGrid } from './FloorGrid';
import { RapidOrderBuilder } from './RapidOrderBuilder';
import { OrderDraftDrawer } from './OrderDraftDrawer';
import { WifiOff, LayoutGrid, Utensils, ShoppingBag, ShieldCheck, Server, RefreshCw, AlertTriangle, LogOut, UserCircle2, Key, QrCode, Download } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePos } from '../context/PosContext';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { ThemeToggle } from '../components/ThemeToggle';
import { authFetch, authWsUrl, captureTokenFromUrl, consumePendingEnrollmentCode, enrollWithCode, hasToken } from '../services/hubAuth';
import { heldGroups } from '../lib/ticketView';
import { QrScannerModal } from './QrScannerModal';
import { WaiterLogin } from './WaiterLogin';

const WAITER_SESSION_KEY = 'kullina_waiter_session';

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
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('mejwani_hub_url');
      if (saved) {
        // If saved URL is pointing to localhost but current page was opened on mobile via IP address, adapt to LAN IP
        if (saved.includes('localhost') && window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
          return `${window.location.protocol}//${window.location.hostname}:4000`;
        }
        return saved;
      }
      return defaultHub;
    }
    return 'http://localhost:4000';
  });

  const [hubInfo, setHubInfo] = useState(null);
  const [connStatus, setConnStatus] = useState('connecting'); // 'connecting' | 'connected' | 'unauthorized' | 'disconnected'
  const hubConnected = connStatus === 'connected';
  const [showPairModal, setShowPairModal] = useState(false);
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [manualIpInput, setManualIpInput] = useState('');
  const [enrollCodeInput, setEnrollCodeInput] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);

  // A QR scan drops the device token straight into the URL, so capture it before
  // the first render decides whether this handset still needs to enrol.
  const [isEnrolled, setIsEnrolled] = useState(() => {
    captureTokenFromUrl();
    return hasToken();
  });
  const [pairError, setPairError] = useState('');
  const [isTestingConn, setIsTestingConn] = useState(false);
  // Which waiter is signed in on this handset. Persisted across reloads so
  // reception doesn't have to re-enter the PIN mid-shift, cleared on Sign out.
  const [waiterSession, setWaiterSession] = useState(() => {
    try {
      const raw = localStorage.getItem(WAITER_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  const handleWaiterLogin = (waiter) => {
    setWaiterSession(waiter);
    try { localStorage.setItem(WAITER_SESSION_KEY, JSON.stringify(waiter)); } catch {}
  };
  const signOutWaiter = () => {
    setWaiterSession(null);
    try { localStorage.removeItem(WAITER_SESSION_KEY); } catch {}
  };

  const [liveTables, setLiveTables] = useState([]);
  const [liveSections, setLiveSections] = useState([]);
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

      // 403 as well as 401: a tablet that was set up as a kitchen screen shares this browser's storage, so
      // it arrives here holding a token the hub refuses for the till. /tables and /menu answer 403 only for
      // that, and the cure is the same as for no token -- enrol as a handset, which replaces it.
      const turnedAway = r => r?.status === 401 || r?.status === 403;
      if (turnedAway(tablesRes) || turnedAway(menuRes) || ordersRes?.status === 401) {
        console.warn('Hub refused this device: handset requires enrollment');
        setIsEnrolled(false);
        setConnStatus('unauthorized');
        return;
      }

      if (menuRes && menuRes.ok) {
        const menuData = await menuRes.json();
        setHubMenuUninitialized(!!menuData.uninitialized);
      }

      if (tablesRes && tablesRes.ok) {
        const data = await tablesRes.json();
        if (data.uninitialized) setHubMenuUninitialized(true);
        if (data.tables && Array.isArray(data.tables)) setLiveTables(data.tables);
        if (Array.isArray(data.sections)) setLiveSections(data.sections);
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
      const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s timeout
      const res = await authFetch(`${cleanUrl}/pairing-info`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        setHubInfo(data);
        pingFailuresRef.current = 0; // Reset fail counter on success
        
        // A tablet that was set up as a kitchen screen holds a token the hub honours for tickets and
        // nothing else, and shares this browser's storage. It is not an enrolled handset: say so, and let
        // the code entry below replace the token, rather than carrying on to a sign-in the hub refuses.
        if (data.device_scope === 'kitchen') {
          setIsEnrolled(false);
          setConnStatus('unauthorized');
          wasConnectedRef.current = false;
          setIsTestingConn(false);
          return false;
        }

        // If data.authorised is false (hub requires enrollment from this handset)
        if (data.authorised === false && !hasToken()) {
          setIsEnrolled(false);
          setConnStatus('unauthorized');
          wasConnectedRef.current = false;
          setIsTestingConn(false);
          return false;
        }

        setIsEnrolled(true);
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
      if (pingFailuresRef.current >= 2 || !isGracePeriodRef.current) {
        wasConnectedRef.current = false;
        setConnStatus('disconnected');
      }
    }
    setIsTestingConn(false);
    return false;
  }, [hubUrl, fetchLiveState]);

  // A scanned QR now hands over an enrollment code rather than a token, so trade
  // it for one as soon as the app mounts. The page is served by the hub itself,
  // so its own origin is the right address to enrol against.
  useEffect(() => {
    const pendingCode = consumePendingEnrollmentCode();
    if (!pendingCode || hasToken()) return;

    let cancelled = false;
    (async () => {
      const target = hubUrl || window.location.origin;
      const res = await enrollWithCode(target, pendingCode).catch(() => ({ ok: false }));
      if (!cancelled && res.ok) {
        setIsEnrolled(true);
        checkHubConnection(target);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        const finalWsUrl = authWsUrl(wsUrl);
        ws = new WebSocket(finalWsUrl);

        ws.onopen = () => {
          console.log(`📱 Waiter App WS /live connected to ${finalWsUrl}`);
          fetchLiveState(cleanUrl);
        };

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

  // Courses held for the selected table (served in courses): which tickets, and what is still on hold.
  const [firingId, setFiringId] = useState(null);
  const [fireError, setFireError] = useState('');
  const heldForTable = selectedTableId
    ? activeOrders
        .filter(t => String(t.table_id) === String(selectedTableId))
        .map(t => ({ ticket: t, held: heldGroups(t) }))
        .filter(x => x.held.length > 0)
    : [];

  const fireNextCourse = async (ticket) => {
    if (!hubUrl) return;
    const cleanUrl = hubUrl.replace(/\/+$/, '');
    setFireError('');
    setFiringId(ticket.id);
    try {
      const res = await authFetch(`${cleanUrl}/orders/${encodeURIComponent(ticket.id)}/fire`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFireError(data.error || 'Could not fire the next course.');
      }
      fetchLiveState(cleanUrl);
    } catch {
      setFireError(`Hub unreachable at ${cleanUrl}. Check WiFi network.`);
    } finally {
      setFiringId(null);
    }
  };

  const handleClearTableBill = async (tableId) => {
    // 1. Clear draft for table
    setDrafts(p => {
      const c = { ...p };
      delete c[tableId];
      return c;
    });

    // 2. Optimistic UI update immediately
    const prevTables = [...liveTables];
    setLiveTables(prev => prev.map(t => String(t.id) === String(tableId) ? {
      ...t,
      status: 'available',
      activeOrderTotal: 0,
      occupiedSince: null
    } : t));
    setActiveOrders(prev => prev.filter(o => String(o.table_id) !== String(tableId)));

    if (!hubUrl) return;
    const cleanUrl = hubUrl.replace(/\/+$/, '');
    try {
      const res = await authFetch(`${cleanUrl}/tables/${tableId}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        console.log(`🧹 Clear bill request for table ${tableId} succeeded on Hub`);
        const data = await res.json().catch(() => ({}));
        if (data.tables && Array.isArray(data.tables)) {
          setLiveTables(data.tables);
        }
        fetchLiveState(cleanUrl);
      } else {
        // Revert optimistic update
        setLiveTables(prevTables);
        const errData = await res.json().catch(() => ({}));
        if (res.status === 401) {
          setShowPairModal(true);
          setPairError('Handset is not enrolled or token expired. Enter the enrollment code from Kitchen Display.');
        } else {
          alert(errData.error || `Could not clear bill for table ${tableId}`);
        }
      }
    } catch (err) {
      setLiveTables(prevTables);
      console.error(`Failed to clear bill for table ${tableId}:`, err);
      alert(`Could not reach Hub at ${cleanUrl}. Check WiFi connection.`);
    }
  };

  const handlePairSubmit = async (e) => {
    e.preventDefault();
    setConnStatus('connecting');
    setPairError('');

    let raw = manualIpInput.trim() || hubUrl.replace(/^https?:\/\//, '');
    if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      raw = `http://${raw}`;
    }
    if (!raw.includes(':', 6)) {
      raw = `${raw}:4000`;
    }

    // The hub only accepts enrolled devices. If this handset has no token yet,
    // trade the code shown on the Kitchen Display for one before connecting.
    if (!hasToken() || !isEnrolled) {
      const code = enrollCodeInput.trim().toUpperCase();
      if (!code) {
        setConnStatus('unauthorized');
        setPairError('Enter the 6-character enrollment code shown on the Kitchen Display (e.g. 9KZXEC).');
        return;
      }

      const enrolled = await enrollWithCode(raw, code).catch(() => ({
        ok: false,
        error: `Could not reach Kitchen Hub at ${raw}. Check WiFi connection.`
      }));

      if (!enrolled.ok) {
        setConnStatus('unauthorized');
        setPairError(enrolled.error || 'Invalid enrollment code. Check the Kitchen Display.');
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
      setConnStatus(prev => (prev === 'unauthorized' ? 'unauthorized' : 'disconnected'));
      if (!pairError) {
        setPairError(`Could not reach Kitchen Hub at ${raw}. Check WiFi connection.`);
      }
    }
  };

  // Auto-prompt enrollment modal when handset is detected as unauthorized
  useEffect(() => {
    if (connStatus === 'unauthorized' && !hasToken()) {
      if (!manualIpInput) {
        setManualIpInput(hubUrl.replace(/^https?:\/\//, ''));
      }
      setShowPairModal(true);
    }
  }, [connStatus, hubUrl]);

  // Handle successful QR scan from QrScannerModal
  const handleScanSuccess = useCallback(({ token, hubUrl: detectedHubUrl }) => {
    if (detectedHubUrl) {
      const cleanUrl = detectedHubUrl.replace(/\/+$/, '');
      setHubUrl(cleanUrl);
      localStorage.setItem('mejwani_hub_url', cleanUrl);
    }
    setIsEnrolled(true);
    setConnStatus('connected');
    setShowPairModal(false);
    setShowScannerModal(false);
    fetchLiveState(detectedHubUrl || hubUrl);
  }, [fetchLiveState, hubUrl]);

  // PWA Install Prompt Listener
  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
      console.log('🎉 Waiter PWA installed to home screen');
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      setIsInstalled(true);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const openPairing = () => {
    if (!manualIpInput) setManualIpInput(hubUrl.replace(/^https?:\/\//, ''));
    setShowPairModal(true);
  };

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') {
      setInstallPrompt(null);
      setIsInstalled(true);
    }
  };

  // Draft shape (M2 · PR 11 variants + PR 12 modifiers): a map keyed by
  // `lineKey` — item id, optionally suffixed with `|variantId` and, when the
  // item has modifier groups, `|<modifier signature>`. Lines with identical
  // variant + modifier picks stack (qty++). Different picks split into
  // separate cart lines so "Chicken Tikka (Full, Hot, +Cheese)" and
  // "Chicken Tikka (Full, Mild)" bill correctly.
  //
  //   drafts[tableId] = {
  //     [lineKey]: {
  //       item_id, variant_id?, variant_label?, name, price, isVeg, qty,
  //       modifiers?: [{ group_id, group_label, option_id, option_label, price_delta }]
  //     }
  //   }
  const currentDraftItems = selectedTableId ? (drafts[selectedTableId] || {}) : {};
  const totalCartCount = Object.values(currentDraftItems).reduce((s, row) => s + (row?.qty || 0), 0);

  // Signature is a sorted "gid:oid;gid:oid" string so `{spice:hot, extras:cheese}`
  // and `{extras:cheese, spice:hot}` collapse to the same lineKey. Two picks in
  // one multi-select group stay ordered within that group by option_id.
  const modifierSignature = (modifiers) => {
    if (!Array.isArray(modifiers) || modifiers.length === 0) return '';
    return [...modifiers]
      .map(m => `${m.group_id}:${m.option_id}`)
      .sort()
      .join(';');
  };
  const lineKey = (row) => {
    const base = row.variant_id ? `${row.item_id}|${row.variant_id}` : String(row.item_id);
    const sig = modifierSignature(row.modifiers);
    // A day-part boundary crossed mid-order means the same item picked at
    // 15:59 (base price) and 16:01 (happy hour) should be TWO separate
    // cart lines (M2 · PR 13). Signature dedupes on `dp_<id>|` so identical
    // day-part attributions still stack, but base vs promo split cleanly.
    const dp = row.active_day_part?.id ? `dp_${row.active_day_part.id}` : 'dp_none';
    const modPart = sig ? `|${sig}` : '';
    return `${base}${modPart}|${dp}`;
  };

  const addItem = (row) => {
    if (!selectedTableId || !row?.item_id) return;
    const key = lineKey(row);
    setDrafts(p => {
      const tableDraft = { ...(p[selectedTableId] || {}) };
      const existing = tableDraft[key];
      tableDraft[key] = existing
        ? { ...existing, qty: (existing.qty || 0) + 1 }
        : {
            item_id: row.item_id,
            variant_id: row.variant_id || null,
            variant_label: row.variant_label || null,
            name: row.name,
            // `row.price` on a modifier'd row already includes the delta (the
            // sheet applies it before onConfirm) AND the active day-part
            // override (hub-resolved on GET /menu), so a straight assign is
            // correct — the cart total shown to the waiter matches the
            // hub's server-authoritative re-price at POST /orders modulo up
            // to one 5s poll of clock drift across a day-part boundary.
            price: row.price,
            isVeg: row.isVeg,
            qty: 1,
            modifiers: Array.isArray(row.modifiers) ? row.modifiers : [],
            active_day_part: row.active_day_part || null
          };
      return { ...p, [selectedTableId]: tableDraft };
    });
  };

  const removeItem = (key) => {
    if (!selectedTableId) return;
    setDrafts(p => {
      const d = { ...(p[selectedTableId] || {}) };
      const row = d[key];
      if (!row) return p;
      const nextQty = (row.qty || 0) - 1;
      if (nextQty <= 0) delete d[key];
      else d[key] = { ...row, qty: nextQty };
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

  // Gate the whole app on a signed-in waiter. Runs the moment the hub is
  // reachable — device enrolment is orthogonal (the reception laptop is
  // trusted-local and never enrols, but its waiter still needs to identify
  // themselves). Sits before the header so a stale session can't leak a
  // table into the wrong shift.
  if (hubConnected && !waiterSession) {
    return (
      <WaiterLogin
        hubUrl={hubUrl}
        onLogin={handleWaiterLogin}
        currentRestaurant={hubInfo || currentRestaurant}
      />
    );
  }

  return (
    <div style={{
      width: '100%', maxWidth: '480px', height: '100dvh', display: 'flex', flexDirection: 'column',
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
              {waiterSession?.name ? waiterSession.name.slice(0, 1).toUpperCase() : 'W'}
            </div>
            <div>
              <div className="typography-caption" style={{ color: 'var(--color-ink)' }}>
                {hubInfo?.name || currentRestaurant?.name || 'Kullina POS'}
              </div>
              <div className="font-mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--color-muted)' }}>
                {waiterSession?.name && (
                  <>
                    <UserCircle2 size={10} />
                    <span>{waiterSession.name}</span>
                    <button
                      onClick={signOutWaiter}
                      title="Sign out"
                      className="inline-flex items-center"
                      style={{ background: 'transparent', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 0 }}
                    >
                      <LogOut size={10} />
                    </button>
                    <span style={{ opacity: 0.4 }}>·</span>
                  </>
                )}
                <span>Hub: {hubUrl.replace('http://', '').replace('https://', '')}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {installPrompt && !isInstalled && (
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px] gap-1"
                onClick={handleInstallClick} title="Install Waiter App on this device"
                style={{ color: 'var(--color-primary)', borderColor: 'var(--color-primary)' }}>
                <Download size={12} />
                <span>Install</span>
              </Button>
            )}
            <Badge variant="outline" className="text-[10px] font-semibold cursor-pointer gap-1 px-2.5 py-1"
              onClick={openPairing}
              style={{
                color: connStatus === 'connected' ? 'var(--status-green-text)' : connStatus === 'connecting' || connStatus === 'unauthorized' ? 'var(--status-amber-text)' : 'var(--status-rust-text)',
                background: connStatus === 'connected' ? 'var(--status-green-bg)' : connStatus === 'connecting' || connStatus === 'unauthorized' ? 'var(--status-amber-bg)' : 'var(--status-rust-bg)',
                borderColor: connStatus === 'connected' ? 'var(--status-green-border)' : connStatus === 'connecting' || connStatus === 'unauthorized' ? 'var(--status-amber-border)' : 'var(--status-rust-border)',
              }}>
              {connStatus === 'connected' ? <ShieldCheck size={11} /> : connStatus === 'unauthorized' ? <Key size={11} /> : connStatus === 'connecting' ? <RefreshCw size={11} className="spin" /> : <WifiOff size={11} />}
              {connStatus === 'connected' ? 'LAN' : connStatus === 'unauthorized' ? 'Code' : connStatus === 'connecting' ? '…' : 'Off'}
            </Badge>
            <ThemeToggle size="icon-sm" />
          </div>
        </div>

        {/* Banners */}
        {connStatus === 'unauthorized' && (
          <div className="banner banner-warning flex items-center justify-between gap-2"
            style={{ borderBottom: '1px solid var(--color-warning-border)', padding: '10px 14px', background: 'var(--status-amber-bg)', color: 'var(--status-amber-text)' }}>
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Key size={14} className="shrink-0" />
              <span>Handset not enrolled. Scan KDS QR or enter code.</span>
            </div>
            <div className="flex gap-1.5 shrink-0">
              <Button size="sm" className="h-7 px-2.5 text-[11px] gap-1" onClick={() => setShowScannerModal(true)}>
                <QrCode size={13} />
                <span>Scan QR</span>
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={openPairing}>
                Enter Code
              </Button>
            </div>
          </div>
        )}
        {connStatus === 'disconnected' && (
          <div className="banner banner-error flex items-center justify-between" style={{ borderBottom: '1px solid var(--color-error-border)' }}>
            <div className="flex items-center gap-2">
              <WifiOff size={14} className="shrink-0" />
              <span className="text-xs">Not connected to kitchen hub.</span>
            </div>
            <Button size="sm" variant="destructive" className="h-7 px-3 text-[11px]" onClick={openPairing}>Connect</Button>
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
                Scan the QR code displayed on the Kitchen Display screen, or enter the hub's LAN IP and the enrollment code below.
              </p>

              {/* Instant Camera QR Scanner Trigger */}
              <Button type="button" className="w-full gap-2 mb-3"
                onClick={() => { setShowPairModal(false); setShowScannerModal(true); }}>
                <QrCode size={17} />
                <span>Scan Kitchen Display QR Code</span>
              </Button>

              <div className="flex items-center gap-2 mb-3 text-[10px] font-semibold tracking-wider" style={{ color: 'var(--color-muted)' }}>
                <div className="flex-1 h-px" style={{ background: 'var(--color-hairline)' }} />
                <span>OR ENTER MANUALLY</span>
                <div className="flex-1 h-px" style={{ background: 'var(--color-hairline)' }} />
              </div>

              <form onSubmit={handlePairSubmit} className="flex flex-col gap-4">
                <div>
                  <Label className="text-xs font-semibold" style={{ color: 'var(--color-muted)' }}>Hub LAN IP or URL</Label>
                  <Input type="text" value={manualIpInput} onChange={e => setManualIpInput(e.target.value)}
                    placeholder={hubUrl.replace(/^https?:\/\//, '') || 'e.g. 192.168.1.50:4000'} className="mt-1 font-mono" />
                </div>
                {!isEnrolled && (
                  <div>
                    <Label className="text-xs font-semibold" style={{ color: 'var(--color-muted)' }}>Enrollment code</Label>
                    <Input
                      type="text"
                      value={enrollCodeInput}
                      onChange={e => setEnrollCodeInput(e.target.value.toUpperCase())}
                      placeholder="e.g. 9KZXEC"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      autoFocus
                      className="mt-1 font-mono"
                      style={{ letterSpacing: '3px', fontSize: '16px', fontWeight: 700, textAlign: 'center', textTransform: 'uppercase' }}
                    />
                    <p className="typography-body-sm mt-1 text-[11px]" style={{ color: 'var(--color-muted)' }}>
                      Check the Kitchen Display (KDS) for the code (e.g. <strong>9KZXEC</strong>). Only needed once per handset; scanning the QR code skips this step.
                    </p>
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
                    {isTestingConn ? <RefreshCw size={14} className="spin" /> : 'Connect & Unlock'}
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
                tables={liveTables} sections={liveSections} onClearTableBill={handleClearTableBill}
                isLoading={connStatus === 'connecting' && liveTables.length === 0}
                drafts={drafts} onOpenPairing={openPairing} hubConnected={hubConnected}
                connStatus={connStatus}
                isEnrolled={isEnrolled}
              />
              {/* Courses held for the selected table: the waiter sends the next one when the guests are ready. */}
              {heldForTable.length > 0 && (
                <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border px-3 py-2.5" style={{ borderColor: 'var(--status-blue-border)', background: 'var(--status-blue-bg)' }}>
                  {heldForTable.map(({ ticket, held }) => (
                    <div key={ticket.id} className="flex items-center justify-between gap-2">
                      <span className="text-xs" style={{ color: 'var(--status-blue-text)' }}>
                        <strong>{ticket.table_name || 'Table'} · #{ticket.ticket_number}</strong>
                        {' '}on hold: {held.map(h => `course ${h.course} (${h.count})`).join(', ')}
                      </span>
                      <Button size="sm" className="h-9 shrink-0" disabled={firingId === ticket.id} onClick={() => fireNextCourse(ticket)}>
                        Fire course {held[0].course}
                      </Button>
                    </div>
                  ))}
                  {fireError && <span className="text-xs" style={{ color: 'var(--color-error-text)' }}>{fireError}</span>}
                </div>
              )}
              <OrderDraftDrawer
                selectedTableId={selectedTableId} draftItems={currentDraftItems}
                onRemoveItem={removeItem} onClearDraft={clearDraft}
                hubUrl={hubUrl} hubConnected={hubConnected} waiter={waiterSession}
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
              hubUrl={hubUrl} hubConnected={hubConnected} waiter={waiterSession}
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

        {/* In-App Camera QR Code Scanner Modal */}
        <QrScannerModal
          isOpen={showScannerModal}
          onClose={() => setShowScannerModal(false)}
          onScanSuccess={handleScanSuccess}
          hubUrl={hubUrl}
        />
      </div>
    </div>
  );
};
