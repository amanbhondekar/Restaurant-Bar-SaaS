import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { ChefHat, Zap, X } from 'lucide-react';
import { AnimatePresence, useReducedMotion } from 'framer-motion';
import QRCodeLib from 'qrcode';
import { installCrashReporter } from './services/crashReporter';
import './index.css';
import { STATION_LABEL, onStationBoard, stationCounts, initialStation } from './lib/ticketView';
import { mergeTicketInto, ticketKey } from './lib/kitchenBill';
import { applyLiveMessage, markedReady, statusAfterClose, statusAfterGrace } from './lib/kitchenBoard';
import { useBill } from './kitchen/useBill';
import { KdsHeader } from './kitchen/KdsHeader';
import { PairingPanel } from './kitchen/PairingPanel';
import { StationTabs } from './kitchen/StationTabs';
import { TicketCard } from './kitchen/TicketCard';
import { BillModal } from './kitchen/BillModal';
import { PrintPreview } from './kitchen/PrintPreview';
import { ReadyTickets } from './kitchen/ReadyTickets';

installCrashReporter({ source: 'kds' });

const KitchenHubApp = () => {
  const [pairingInfo, setPairingInfo] = useState(null);
  const [qrCodeUrl, setQrCodeUrl] = useState(null);
  const [enrollmentCode, setEnrollmentCode] = useState(null);
  const [tickets, setTicketsState] = useState([]);
  // The socket handler outlives any one render, so it reads the board from here rather than from a closure.
  const ticketsRef = useRef([]);
  const setTickets = next => {
    ticketsRef.current = typeof next === 'function' ? next(ticketsRef.current) : next;
    setTicketsState(ticketsRef.current);
  };
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
      setWsConnStatus(current => statusAfterGrace({ failures: missedWsFailuresRef.current, current }));
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
            const result = applyLiveMessage(ticketsRef.current, JSON.parse(event.data));
            if (result.tickets !== ticketsRef.current) setTickets(result.tickets);
            if (result.sync) setSyncStatus(result.sync);
            if (result.refetch) fetchActiveTickets();
          } catch (err) {
            console.warn('Malformed WS message:', err);
          }
        };

        ws.onclose = () => {
          missedWsFailuresRef.current += 1;
          setWsConnStatus(statusAfterClose({ failures: missedWsFailuresRef.current, inGracePeriod: isGracePeriodRef.current }));
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

  // Replace a ticket with the hub's current copy of it, matched by id (src/lib/kitchenBill.js).
  const mergeTicket = (next) => {
    if (!next) return;
    setTickets(prev => mergeTicketInto(prev, next));
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
        setTickets(prev => markedReady(prev, ticket, data));
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

  // One station reports its part done; the ticket turns ready on its own when every station has.
  const handleStationReady = (ticket, station) => kitchenAction(`/orders/${ticketKey(ticket)}/stations/${station}/ready`);
  // Send the next held course to the kitchen.
  const handleFire = (ticket) => kitchenAction(`/orders/${ticketKey(ticket)}/fire`);
  // Put a ticket that was marked ready back on the board.
  const handleRecall = (ticket) => kitchenAction(`/orders/${ticketKey(ticket)}/recall`);

  // The bill and everything done to it (see src/kitchen/useBill.js).
  const bill = useBill({ hubHost, fetchActiveTickets });
  const { openBill } = bill;

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
      <KdsHeader pairingInfo={pairingInfo} shouldReduceMotion={shouldReduceMotion} wsConnStatus={wsConnStatus} syncStatus={syncStatus} fetchActiveTickets={fetchActiveTickets} fetchSyncStatus={fetchSyncStatus} />

      {/* Main Grid: Left side pairing card, Right side live KOT tickets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 320px) 1fr', gap: 'var(--spacing-lg)', alignItems: 'start' }}>

        {/* Left Column: Waiter Pairing QR Code & Details */}
        <PairingPanel qrCodeUrl={qrCodeUrl} pairingInfo={pairingInfo} hubHost={hubHost} enrollmentCode={enrollmentCode} activeTickets={activeTickets} readyTickets={readyTickets} />

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
          <StationTabs stationFilter={stationFilter} setStationFilter={setStationFilter} counts={counts} />

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
                {boardTickets.map(ticket => (
                  <TicketCard
                    key={ticket.id || ticket.ticket_number}
                    ticket={ticket}
                    stationFilter={stationFilter}
                    allCheckedFor={allCheckedFor}
                    shouldReduceMotion={shouldReduceMotion}
                    checkedItems={checkedItems}
                    toggleCheck={toggleCheck}
                    handleFire={handleFire}
                    handleStationReady={handleStationReady}
                    handleMarkReady={handleMarkReady}
                    openBill={openBill}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}

          {/* Bill Preview Modal (M1 billing foundation) */}
          <BillModal bill={bill} />

          {/* Print preview overlay (M1 PR 8) */}
          <PrintPreview bill={bill} />

          {/* Ready Tickets Section */}
          <ReadyTickets readyTickets={readyTickets} shouldReduceMotion={shouldReduceMotion} handleFire={handleFire} handleRecall={handleRecall} />
        </div>
      </div>
    </div>
  );
};

export { KitchenHubApp };

// The page mounts itself. Under test there is no #root: the tests render the component directly.
const mountPoint = document.getElementById('root');
if (mountPoint) {
  ReactDOM.createRoot(mountPoint).render(
    <React.StrictMode>
      <KitchenHubApp />
    </React.StrictMode>
  );
}
