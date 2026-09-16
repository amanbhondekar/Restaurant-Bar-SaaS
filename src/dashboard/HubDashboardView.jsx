import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity, Wifi, WifiOff, Smartphone, Utensils, Clock,
  CheckCircle2, AlertTriangle, LayoutGrid, ArrowUpRight,
  CloudOff, Cloud, Hash, IndianRupee, Timer, Users
} from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { LiveClock } from '../components/LiveClock';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Separator } from '../components/ui/separator';
import { ThemeToggle } from '../components/ThemeToggle';

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

  const statusColors = {
    available: { bg: 'bg-[var(--status-green-bg)]', text: 'text-[var(--status-green-text)]', border: 'border-[var(--status-green-border)]', label: 'Open' },
    kot: { bg: 'bg-[var(--status-amber-bg)]', text: 'text-[var(--status-amber-text)]', border: 'border-[var(--status-amber-border)]', label: 'In Kitchen' },
    ready: { bg: 'bg-[var(--status-blue-bg)]', text: 'text-[var(--status-blue-text)]', border: 'border-[var(--status-blue-border)]', label: 'Bill Ready' },
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-canvas)', color: 'var(--color-ink)' }}>

      {/* Top Bar */}
      <header className="flex items-center justify-between flex-wrap gap-4 px-8 py-4 border-b" style={{ background: 'var(--color-surface-soft)', borderColor: 'var(--color-hairline)' }}>
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
            <Activity size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="typography-display-sm" style={{ color: 'var(--color-ink)' }}>
                {restaurant.name || 'Hotel Mejwani'}
              </h1>
              <Badge variant={lastFetchErr ? 'destructive' : 'default'} className={lastFetchErr ? '' : 'bg-[var(--status-green-bg)] text-[var(--status-green-text)] border border-[var(--status-green-border)] hover:bg-[var(--status-green-bg)]'}>
                {lastFetchErr ? 'HUB OFFLINE' : 'LIVE'}
              </Badge>
            </div>
            <p className="typography-body-sm mt-0.5" style={{ color: 'var(--color-muted)' }}>
              Pairing <strong style={{ color: 'var(--color-primary)' }}>{restaurant.pairing_code || 'MJW-7492'}</strong>
              <span className="mx-1.5" style={{ color: 'var(--color-hairline)' }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{defaultHub}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs">
            <Smartphone size={15} style={{ color: 'var(--status-blue-text)' }} />
            <span style={{ color: 'var(--color-muted)' }}>Staff Devices</span>
            <Badge variant="outline" className="font-mono">{connectedDevices}</Badge>
          </div>
          <Separator orientation="vertical" className="h-8" />
          <LiveClock />
          <ThemeToggle />
        </div>
      </header>

      {/* Error Banner */}
      {lastFetchErr && (
        <div className="banner banner-error flex items-center gap-2" style={{ borderBottom: '1px solid var(--color-error-border)' }}>
          <AlertTriangle size={15} /> {lastFetchErr}. Re-connecting...
        </div>
      )}

      {/* Uninitialized Banner */}
      {(hubData?.uninitialized || hubData?.tables?.uninitialized) && (
        <div className="banner banner-warning flex items-center gap-2.5" style={{ borderBottom: '1px solid var(--color-warning-border)' }}>
          <AlertTriangle size={16} /> No menu data — connect hub to internet to complete setup.
        </div>
      )}

      {/* Main Grid */}
      <main className="flex-1 w-full max-w-[1400px] mx-auto px-8 py-6 flex flex-col gap-6">

        {/* KPI Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Revenue */}
          <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-surface-soft)' }}>
            <CardContent className="pt-5 pb-5 px-5">
              <div className="flex items-center justify-between mb-1">
                <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Today's Sales</span>
                <IndianRupee size={16} style={{ color: 'var(--color-primary)' }} />
              </div>
              <motion.div
                key={runningTotal}
                initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="font-mono text-3xl font-extrabold tracking-tight"
                style={{ color: 'var(--color-primary)' }}
              >
                {currency}{runningTotal.toLocaleString()}
              </motion.div>
              <p className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>
                {completedTickets.length} bills cleared
              </p>
            </CardContent>
          </Card>

          {/* Active KOTs */}
          <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-surface-soft)' }}>
            <CardContent className="pt-5 pb-5 px-5">
              <div className="flex items-center justify-between mb-1">
                <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Kitchen KOTs</span>
                <Utensils size={16} style={{ color: 'var(--status-amber-text)' }} />
              </div>
              <div className="font-mono text-3xl font-extrabold tracking-tight" style={{ color: 'var(--status-amber-text)' }}>
                {activeTickets.length}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs" style={{ color: 'var(--status-amber-text)' }}>
                  {activeTickets.filter(t => t.status === 'in_progress').length} cooking
                </span>
                <span className="text-xs" style={{ color: 'var(--status-blue-text)' }}>
                  {activeTickets.filter(t => t.status === 'ready').length} ready
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Floor Occupancy */}
          <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-surface-soft)' }}>
            <CardContent className="pt-5 pb-5 px-5">
              <div className="flex items-center justify-between mb-1">
                <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Floor Occupancy</span>
                <Users size={16} style={{ color: 'var(--color-ink)' }} />
              </div>
              <div className="font-mono text-3xl font-extrabold tracking-tight" style={{ color: 'var(--color-ink)' }}>
                {tableStats.occupied}<span className="text-lg font-semibold" style={{ color: 'var(--color-muted)' }}>/{tableStats.total}</span>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>
                {tableStats.open} tables open
              </p>
            </CardContent>
          </Card>

          {/* Cloud Sync */}
          <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-surface-soft)' }}>
            <CardContent className="pt-5 pb-5 px-5">
              <div className="flex items-center justify-between mb-1">
                <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Cloud Sync</span>
                {syncStatus.online
                  ? <Cloud size={16} style={{ color: 'var(--status-green-text)' }} />
                  : <CloudOff size={16} style={{ color: 'var(--status-rust-text)' }} />
                }
              </div>
              <div className="font-mono text-3xl font-extrabold tracking-tight" style={{ color: syncStatus.queued > 0 ? 'var(--status-amber-text)' : 'var(--status-green-text)' }}>
                {syncStatus.queued || 0}
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>
                {syncStatus.online ? 'Supabase synced' : 'Queued offline'}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Floor Grid */}
        <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-surface-soft)' }}>
          <CardHeader className="pb-3 px-5 pt-5">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--color-ink)' }}>
                <LayoutGrid size={17} style={{ color: 'var(--color-primary)' }} /> Live Floor Grid
              </CardTitle>
              <div className="flex items-center gap-4">
                {[
                  { label: 'Open', count: tableStats.open, color: 'var(--status-green-text)' },
                  { label: 'Kitchen', count: tableStats.inKitchen, color: 'var(--status-amber-text)' },
                  { label: 'Bill Ready', count: tableStats.billReady, color: 'var(--status-blue-text)' },
                ].map(s => (
                  <div key={s.label} className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: s.color }}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
                    {s.count} {s.label}
                  </div>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
              {tables.map(t => {
                const st = statusColors[t.status] || { bg: '', text: 'text-[var(--color-muted)]', border: 'border-[var(--color-hairline)]', label: t.status };
                return (
                  <div key={t.id} className={`rounded-[var(--radius-md)] border p-3 text-center transition-colors`} style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)' }}>
                    <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{t.name}</div>
                    <div className="text-[10px] mt-0.5" style={{ color: 'var(--color-muted)' }}>{t.capacity} seats · {t.section}</div>
                    <Badge variant="outline" className={`mt-1.5 text-[9px] font-bold px-1.5 py-0 ${st.bg} ${st.text} ${st.border}`}>
                      {st.label}
                    </Badge>
                    {t.activeOrderTotal > 0 && (
                      <div className="font-mono text-xs font-bold mt-1" style={{ color: 'var(--color-primary)' }}>
                        {currency}{t.activeOrderTotal}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Tickets Split */}
        <div className="grid lg:grid-cols-2 gap-5">

          {/* Active KOT Tickets */}
          <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-surface-soft)' }}>
            <CardHeader className="pb-3 px-5 pt-5">
              <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--color-ink)' }}>
                <Utensils size={17} style={{ color: 'var(--status-amber-text)' }} />
                Active KOTs
                <Badge variant="outline" className="ml-1 font-mono">{activeTickets.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {activeTickets.length === 0 ? (
                <div className="text-center py-8 text-sm rounded-[var(--radius-sm)] border border-dashed" style={{ color: 'var(--color-muted)', borderColor: 'var(--color-hairline)' }}>
                  No active kitchen tickets
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 max-h-[420px] overflow-y-auto">
                  {activeTickets.map(t => (
                    <div key={t.id} className="rounded-[var(--radius-sm)] border p-3.5" style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-mono font-extrabold text-sm" style={{ color: 'var(--color-primary)' }}>
                          #{t.ticket_number}
                        </span>
                        <Badge variant="outline" className={`text-[9px] font-bold ${t.status === 'ready' ? 'bg-[var(--status-blue-bg)] text-[var(--status-blue-text)] border-[var(--status-blue-border)]' : 'bg-[var(--status-amber-bg)] text-[var(--status-amber-text)] border-[var(--status-amber-border)]'}`}>
                          {t.table_name} · {t.status === 'ready' ? 'READY' : 'COOKING'}
                        </Badge>
                      </div>

                      <div className="flex flex-col gap-0.5 text-xs" style={{ color: 'var(--color-ink)' }}>
                        {t.items?.map((item, idx) => (
                          <div key={idx} className="flex justify-between">
                            <span>{item.qty}× {item.name}</span>
                            <span className="font-mono" style={{ color: 'var(--color-muted)' }}>{currency}{item.price * item.qty}</span>
                          </div>
                        ))}
                      </div>

                      <Separator className="my-2" />
                      <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--color-muted)' }}>
                        <span>{t.created_by_waiter || 'Handset'}</span>
                        <strong className="font-mono" style={{ color: 'var(--color-ink)' }}>{currency}{t.total_amount}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Completed Orders */}
          <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-surface-soft)' }}>
            <CardHeader className="pb-3 px-5 pt-5">
              <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--color-ink)' }}>
                <CheckCircle2 size={17} style={{ color: 'var(--status-green-text)' }} />
                Billed Orders
                <Badge variant="outline" className="ml-1 font-mono">{completedTickets.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {completedTickets.length === 0 ? (
                <div className="text-center py-8 text-sm rounded-[var(--radius-sm)] border border-dashed" style={{ color: 'var(--color-muted)', borderColor: 'var(--color-hairline)' }}>
                  No completed orders today
                </div>
              ) : (
                <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto">
                  {completedTickets.map(t => (
                    <div key={t.id} className="flex items-center justify-between rounded-[var(--radius-sm)] border p-3" style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)' }}>
                      <div>
                        <div className="font-mono text-sm font-bold" style={{ color: 'var(--color-ink)' }}>
                          #{t.ticket_number} <span className="font-normal" style={{ color: 'var(--color-muted)' }}>({t.table_name})</span>
                        </div>
                        <div className="text-[10px] mt-0.5" style={{ color: 'var(--color-muted)' }}>
                          {t.updated_at ? new Date(t.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Today'}
                        </div>
                      </div>
                      <span className="font-mono text-sm font-extrabold" style={{ color: 'var(--status-green-text)' }}>
                        {currency}{t.total_amount}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};
