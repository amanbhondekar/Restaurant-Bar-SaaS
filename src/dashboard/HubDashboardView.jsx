import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity, Server, Wifi, WifiOff, Smartphone, Utensils, Clock,
  CheckCircle2, AlertTriangle, ShieldCheck, RefreshCw, LayoutGrid, DollarSign
} from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { LiveClock } from '../components/LiveClock';

export const HubDashboardView = () => {
  const defaultHub = typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : 'http://localhost:4000';

  const [hubData, setHubData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastFetchErr, setLastFetchErr] = useState('');
  const shouldReduceMotion = useReducedMotion();

  const fetchDashboardData = useCallback(async () => {
    try {
      const res = await fetch(`${defaultHub}/dashboard-data`);
      if (res.ok) {
        const data = await res.json();
        setHubData(data);
        setLastFetchErr('');
      } else {
        setLastFetchErr('Could not fetch dashboard metrics');
      }
    } catch (err) {
      setLastFetchErr('Hub server unreachable');
    } finally {
      setIsLoading(false);
    }
  }, [defaultHub]);

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 10000);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  // Real-Time WebSocket Subscription
  useEffect(() => {
    const wsHost = defaultHub.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    const wsUrl = `${wsHost}/live`;

    let ws = null;
    let isSubscribed = true;

    const connectWs = () => {
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log(`📊 Dashboard WS /live connected to ${wsUrl}`);
          fetchDashboardData();
        };

        ws.onmessage = (event) => {
          if (!isSubscribed) return;
          try {
            const msg = JSON.parse(event.data);
            if (['NEW_ORDER', 'order_created', 'TICKET_READY', 'order_ready', 'CLEAR_TABLE', 'bill_cleared', 'order_cleared', 'SYNC_STATUS_CHANGE', 'TABLE_STATUS_CHANGE'].includes(msg.type)) {
              fetchDashboardData();
            }
          } catch (err) {}
        };

        ws.onclose = () => {
          if (isSubscribed) setTimeout(connectWs, 4000);
        };
      } catch (err) {}
    };

    connectWs();

    return () => {
      isSubscribed = false;
      if (ws) ws.close();
    };
  }, [defaultHub, fetchDashboardData]);

  const restaurant = hubData?.restaurant || {};
  const tables = hubData?.tables || [];
  const activeTickets = hubData?.active_tickets || [];
  const completedTickets = hubData?.completed_tickets || [];
  const syncStatus = hubData?.sync_status || {};
  const runningTotal = hubData?.running_total || 0;
  const connectedDevices = hubData?.connected_devices || 0;

  const currency = restaurant.currency || '₹';

  const tableStats = {
    total: tables.length,
    occupied: tables.filter(t => t.status === 'kot' || t.status === 'ready' || t.status === 'occupied').length,
    inKitchen: tables.filter(t => t.status === 'kot').length,
    billReady: tables.filter(t => t.status === 'ready').length,
    open: tables.filter(t => t.status === 'available').length,
  };

  return (
    <div style={{
      width: '100%', minHeight: '100vh', background: 'var(--color-canvas)',
      display: 'flex', flexDirection: 'column', color: 'var(--color-ink)'
    }}>
      {/* Top Bar Header */}
      <div style={{
        background: 'var(--color-surface-soft)', borderBottom: '1px solid var(--color-hairline)',
        padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '16px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            width: '42px', height: '42px', borderRadius: 'var(--radius-full)',
            background: 'var(--color-primary)', color: '#ffffff',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Activity size={22} />
          </div>
          <div>
            <div className="typography-display-sm" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {restaurant.name || 'Hotel Mejwani'} Live Operational Dashboard
              <span className={`conn-pill ${lastFetchErr ? 'conn-pill-off' : 'conn-pill-ok'}`}>
                {lastFetchErr ? 'HUB OFFLINE' : 'HUB ONLINE'}
              </span>
            </div>
            <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '2px' }}>
              Pairing Code: <strong style={{ color: 'var(--color-primary)' }}>{restaurant.pairing_code || 'MJW-7492'}</strong> · LAN IP: <span style={{ fontFamily: 'var(--font-mono)' }}>{defaultHub}</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
            <Smartphone size={16} style={{ color: 'var(--status-blue-text)' }} />
            <span style={{ color: 'var(--color-muted)' }}>Connected Staff Handsets:</span>
            <strong style={{ color: 'var(--status-blue-text)', fontFamily: 'var(--font-mono)' }}>{connectedDevices} Active</strong>
          </div>
          <div style={{ width: '1px', height: '36px', background: 'var(--color-hairline)' }} />
          <LiveClock />
        </div>
      </div>

      {/* Connection Failure Banner */}
      {lastFetchErr && (
        <div className="banner banner-error" style={{
          borderBottom: '1px solid var(--color-error-border)',
          display: 'flex', alignItems: 'center', gap: '8px'
        }}>
          <AlertTriangle size={16} /> {lastFetchErr}. Re-connecting to hub server...
        </div>
      )}

      {/* Uninitialized Cache Failure Banner */}
      {(hubData?.uninitialized || hubData?.tables?.uninitialized) && (
        <div className="banner banner-warning" style={{
          borderBottom: '1px solid var(--color-warning-border)',
          display: 'flex', alignItems: 'center', gap: '10px'
        }}>
          <AlertTriangle size={18} /> No menu data available — connect this hub to the internet once to complete setup.
        </div>
      )}

      {/* Main Content Dashboard Layout */}
      <div style={{ flex: 1, padding: '24px', maxWidth: '1400px', width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* KPI Metrics Row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
          <div style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px' }}>
            <div className="typography-uppercase-tag" style={{ color: 'var(--color-muted)', marginBottom: '4px' }}>
              Today's Billed Sales
            </div>
            <motion.div
              key={runningTotal}
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
              animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="typography-rating-display"
              style={{ color: 'var(--color-primary)' }}
            >
              {currency}{runningTotal}
            </motion.div>
            <div className="typography-caption-sm" style={{ color: 'var(--color-muted)', marginTop: '4px' }}>
              From {completedTickets.length} completed table bills
            </div>
          </div>

          <div style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px' }}>
            <div className="typography-uppercase-tag" style={{ color: 'var(--color-muted)', marginBottom: '4px' }}>
              Active Kitchen KOTs
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '32px', fontWeight: 800, color: 'var(--status-amber-text)' }}>
              {activeTickets.length}
            </div>
            <div className="typography-caption-sm" style={{ color: 'var(--color-muted)', marginTop: '4px' }}>
              {activeTickets.filter(t => t.status === 'in_progress').length} In Kitchen · {activeTickets.filter(t => t.status === 'ready').length} Ready
            </div>
          </div>

          <div style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px' }}>
            <div className="typography-uppercase-tag" style={{ color: 'var(--color-muted)', marginBottom: '4px' }}>
              Floor Occupancy
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '32px', fontWeight: 800, color: 'var(--color-ink)' }}>
              {tableStats.occupied} / {tableStats.total}
            </div>
            <div className="typography-caption-sm" style={{ color: 'var(--color-muted)', marginTop: '4px' }}>
              {tableStats.open} Open Tables Available
            </div>
          </div>

          <div style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px' }}>
            <div className="typography-uppercase-tag" style={{ color: 'var(--color-muted)', marginBottom: '4px' }}>
              Cloud Sync Queue
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '32px', fontWeight: 800, color: syncStatus.queued > 0 ? 'var(--status-amber-text)' : 'var(--status-green-text)' }}>
              {syncStatus.queued || 0}
            </div>
            <div className="typography-caption-sm" style={{ color: 'var(--color-muted)', marginTop: '4px' }}>
              {syncStatus.online ? 'Supabase Online ✓' : 'Cloud Unreachable (Queued)'}
            </div>
          </div>
        </div>

        {/* Live Floor Grid Section */}
        <div style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div className="typography-title-md" style={{ color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <LayoutGrid size={18} style={{ color: 'var(--color-primary)' }} /> Live Floor Table Grid
            </div>
            <div style={{ display: 'flex', gap: '12px', fontSize: '11px', fontWeight: 600 }}>
              <span style={{ color: 'var(--status-green-text)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                🟢 {tableStats.open} Open
              </span>
              <span style={{ color: 'var(--status-amber-text)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                🟡 {tableStats.inKitchen} In Kitchen
              </span>
              <span style={{ color: 'var(--status-blue-text)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                🔵 {tableStats.billReady} Bill Ready
              </span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px' }}>
            {tables.map(t => {
              const statusColors = {
                available: { bg: 'var(--status-green-bg)', text: 'var(--status-green-text)', border: 'var(--status-green-border)', label: 'Open' },
                kot: { bg: 'var(--status-amber-bg)', text: 'var(--status-amber-text)', border: 'var(--status-amber-border)', label: 'In Kitchen' },
                ready: { bg: 'var(--status-blue-bg)', text: 'var(--status-blue-text)', border: 'var(--status-blue-border)', label: 'Bill Ready' },
              }[t.status] || { bg: 'var(--color-canvas)', text: 'var(--color-muted)', border: 'var(--color-hairline)', label: t.status };

              return (
                <div key={t.id} style={{
                  background: 'var(--color-canvas)', border: `1px solid ${statusColors.border}`,
                  borderRadius: 'var(--radius-md)', padding: '12px', textAlign: 'center'
                }}>
                  <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{t.name}</div>
                  <div style={{ fontSize: '10px', color: 'var(--color-muted)', marginTop: '2px' }}>{t.capacity} Seats · {t.section}</div>
                  <div style={{
                    fontSize: '10px', fontWeight: 700, color: statusColors.text, background: statusColors.bg,
                    padding: '2px 6px', borderRadius: 'var(--radius-full)', marginTop: '6px', display: 'inline-block'
                  }}>
                    {statusColors.label}
                  </div>
                  {t.activeOrderTotal > 0 && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-primary)', fontWeight: 700, marginTop: '4px' }}>
                      {currency}{t.activeOrderTotal}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Tickets Feed Split View */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '20px' }}>
          
          {/* Active KOT Tickets */}
          <div style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px' }}>
            <div className="typography-title-md" style={{ color: 'var(--color-ink)', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Utensils size={18} style={{ color: 'var(--status-amber-text)' }} /> Active KOT Tickets ({activeTickets.length})
            </div>

            {activeTickets.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-muted)', fontSize: '13px', border: '1px dashed var(--color-hairline)', borderRadius: 'var(--radius-sm)' }}>
                No active kitchen tickets. Waiter orders will appear here in real-time.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '420px', overflowY: 'auto' }}>
                {activeTickets.map(t => (
                  <div key={t.id} style={{
                    background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)',
                    borderRadius: 'var(--radius-sm)', padding: '12px 14px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <span style={{ fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--color-primary)' }}>
                        Ticket #{t.ticket_number}
                      </span>
                      <span style={{
                        fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-full)',
                        background: t.status === 'ready' ? 'var(--status-blue-bg)' : 'var(--status-amber-bg)',
                        color: t.status === 'ready' ? 'var(--status-blue-text)' : 'var(--status-amber-text)'
                      }}>
                        {t.table_name} · {t.status === 'ready' ? 'BILL READY' : 'IN KITCHEN'}
                      </span>
                    </div>

                    <div style={{ fontSize: '12px', color: 'var(--color-ink)', margin: '6px 0', lineHeight: 1.5 }}>
                      {t.items?.map((item, idx) => (
                        <div key={idx} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{item.qty}× {item.name}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>{currency}{item.price * item.qty}</span>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '6px', borderTop: '1px dashed var(--color-hairline)', fontSize: '11px', color: 'var(--color-muted)' }}>
                      <span>Waiter: {t.created_by_waiter || 'Handset'}</span>
                      <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-ink)' }}>{currency}{t.total_amount}</strong>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Completed / Billed Orders */}
          <div style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '20px' }}>
            <div className="typography-title-md" style={{ color: 'var(--color-ink)', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <CheckCircle2 size={18} style={{ color: 'var(--status-green-text)' }} /> Billed Orders History ({completedTickets.length})
            </div>

            {completedTickets.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-muted)', fontSize: '13px', border: '1px dashed var(--color-hairline)', borderRadius: 'var(--radius-sm)' }}>
                No completed orders yet today.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '420px', overflowY: 'auto' }}>
                {completedTickets.map(t => (
                  <div key={t.id} style={{
                    background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)',
                    borderRadius: 'var(--radius-sm)', padding: '12px 14px'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <strong style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-ink)' }}>
                          Ticket #{t.ticket_number} ({t.table_name})
                        </strong>
                        <div style={{ fontSize: '10px', color: 'var(--color-muted)', marginTop: '2px' }}>
                          Cleared at: {t.updated_at ? new Date(t.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Today'}
                        </div>
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 800, color: 'var(--status-green-text)' }}>
                        {currency}{t.total_amount}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
};
