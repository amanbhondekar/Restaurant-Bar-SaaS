import React from 'react';
import { usePos } from '../context/PosContext';
import { BarChart3, TrendingUp, ShoppingBag, Clock, Database, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

export const SalesAnalyticsView = () => {
  const { tickets, menu, tables, cloudQueue, cloudOnline, currentRestaurant } = usePos();
  const currency = currentRestaurant?.currency || '₹';

  const totalRevenue = tickets.reduce((sum, ticket) => {
    return sum + ticket.items.reduce((tSum, i) => tSum + i.price * i.qty, 0);
  }, 0);

  const totalOrders = tickets.length;
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  const itemCounts = {};
  tickets.forEach(ticket => {
    ticket.items.forEach(item => {
      itemCounts[item.name] = (itemCounts[item.name] || 0) + item.qty;
    });
  });

  const popularDishes = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-canvas)' }}>
        <CardContent className="flex items-center gap-3 px-6 py-5">
          <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--status-amber-bg)', color: 'var(--color-primary)' }}>
            <BarChart3 size={22} />
          </div>
          <div>
            <h1 className="typography-display-xl" style={{ color: 'var(--color-ink)' }}>
              {currentRestaurant?.name} Analytics
            </h1>
            <p className="typography-body-sm mt-0.5" style={{ color: 'var(--color-muted)' }}>
              Isolated Tenant Metrics · {currentRestaurant?.city}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* KPI Grid */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {/* Revenue */}
        <Card className="border-[var(--color-hairline)]">
          <CardContent className="px-5 py-5">
            <div className="flex items-center justify-between mb-1">
              <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Today's Live Sales</span>
              <TrendingUp size={18} style={{ color: 'var(--status-green-text)' }} />
            </div>
            <div className="typography-rating-display mt-2" style={{ color: 'var(--color-primary)' }}>
              {currency}{totalRevenue}
            </div>
            <p className="typography-body-sm mt-1" style={{ color: 'var(--color-muted)' }}>
              From {totalOrders} placed orders
            </p>
          </CardContent>
        </Card>

        {/* Order Volume */}
        <Card className="border-[var(--color-hairline)]">
          <CardContent className="px-5 py-5">
            <div className="flex items-center justify-between mb-1">
              <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Order Volume</span>
              <ShoppingBag size={18} style={{ color: 'var(--status-blue-text)' }} />
            </div>
            <div className="font-mono text-[32px] font-extrabold mt-3" style={{ color: 'var(--color-ink)' }}>
              {totalOrders}
            </div>
            <p className="typography-body-sm mt-1" style={{ color: 'var(--color-muted)' }}>
              Avg ticket: {currency}{avgOrderValue}
            </p>
          </CardContent>
        </Card>

        {/* KOT Delivery */}
        <Card className="border-[var(--color-hairline)]">
          <CardContent className="px-5 py-5">
            <div className="flex items-center justify-between mb-1">
              <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Avg KOT Delivery</span>
              <Clock size={18} style={{ color: 'var(--color-primary)' }} />
            </div>
            <div className="typography-display-xl text-[28px] mt-3" style={{ color: 'var(--color-ink)' }}>
              Instant (LAN)
            </div>
            <p className="typography-body-sm mt-1 flex items-center gap-1" style={{ color: 'var(--status-green-text)' }}>
              <Zap size={13} /> 0ms latency to kitchen
            </p>
          </CardContent>
        </Card>

        {/* Cloud Sync */}
        <Card className="border-[var(--color-hairline)]">
          <CardContent className="px-5 py-5">
            <div className="flex items-center justify-between mb-1">
              <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Cloud Sync Status</span>
              <Database size={18} style={{ color: cloudOnline ? 'var(--status-green-text)' : 'var(--status-rust-text)' }} />
            </div>
            <div className="typography-display-xl text-2xl mt-3" style={{ color: cloudOnline ? 'var(--status-green-text)' : 'var(--status-rust-text)' }}>
              {cloudOnline ? 'Reconciled' : `${cloudQueue.length} Queued`}
            </div>
            <p className="typography-body-sm mt-1" style={{ color: 'var(--color-muted)' }}>
              {cloudOnline ? 'Supabase Postgres synced' : 'Waiting for internet'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Top Dishes */}
      <Card className="border-[var(--color-hairline)]">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="typography-display-md" style={{ color: 'var(--color-ink)' }}>
            Top Selling Dishes Today
          </CardTitle>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <div className="flex flex-col gap-2.5">
            {popularDishes.length === 0 ? (
              <p className="typography-body-sm" style={{ color: 'var(--color-muted)' }}>
                No sales data recorded yet today.
              </p>
            ) : (
              popularDishes.map(([dishName, count], idx) => (
                <div
                  key={dishName}
                  className="flex items-center justify-between rounded-[var(--radius-sm)] border p-3.5 px-4"
                  style={{ background: 'var(--color-surface-soft)', borderColor: 'var(--color-hairline)' }}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold text-sm" style={{ color: 'var(--color-primary)' }}>#{idx + 1}</span>
                    <span className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{dishName}</span>
                  </div>
                  <Badge variant="outline" className="font-mono font-bold">{count} orders</Badge>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
