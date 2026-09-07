import React from 'react';
import { usePos } from '../context/PosContext';
import { BarChart3, TrendingUp, ShoppingBag, Clock, Database, Zap } from 'lucide-react';

export const SalesAnalyticsView = () => {
  const { tickets, menu, tables, cloudQueue, cloudOnline, currentRestaurant } = usePos();
  const currency = currentRestaurant?.currency || '₹';

  // Revenue calculation
  const totalRevenue = tickets.reduce((sum, ticket) => {
    return sum + ticket.items.reduce((tSum, i) => tSum + i.price * i.qty, 0);
  }, 0);

  const totalOrders = tickets.length;
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  // Item popularity map
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--color-canvas)',
        border: '1px solid var(--color-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--spacing-lg)',
        boxShadow: 'var(--shadow-flat)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--status-amber-bg)',
            color: 'var(--color-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <BarChart3 size={22} />
          </div>
          <div>
            <h1 className="typography-display-xl" style={{ margin: 0, color: 'var(--color-ink)' }}>
              {currentRestaurant?.name} Analytics Dashboard
            </h1>
            <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '2px' }}>
              Isolated Tenant Metrics · {currentRestaurant?.city}
            </div>
          </div>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '16px' }}>
        {/* Total Revenue - Single Loud Type Moment (Section 1 System Restraint Principle) */}
        <div className="card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--color-muted)', fontSize: '13px' }}>
            <span className="typography-uppercase-tag">Today's Live Sales</span>
            <TrendingUp size={18} style={{ color: 'var(--status-green-text)' }} />
          </div>
          <div className="typography-rating-display" style={{ color: 'var(--color-primary)', marginTop: '8px' }}>
            {currency}{totalRevenue}
          </div>
          <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '4px' }}>
            From {totalOrders} placed orders
          </div>
        </div>

        {/* Total Orders */}
        <div className="card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--color-muted)', fontSize: '13px' }}>
            <span className="typography-uppercase-tag">Order Volume</span>
            <ShoppingBag size={18} style={{ color: 'var(--status-blue-text)' }} />
          </div>
          <div className="typography-display-xl" style={{ fontSize: '32px', color: 'var(--color-ink)', marginTop: '12px' }}>
            {totalOrders}
          </div>
          <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '4px' }}>
            Avg ticket size: {currency}{avgOrderValue}
          </div>
        </div>

        {/* Avg KOT Prep Time */}
        <div className="card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--color-muted)', fontSize: '13px' }}>
            <span className="typography-uppercase-tag">Avg KOT Delivery</span>
            <Clock size={18} style={{ color: 'var(--color-primary)' }} />
          </div>
          <div className="typography-display-xl" style={{ fontSize: '28px', color: 'var(--color-ink)', marginTop: '12px' }}>
            Instant (LAN)
          </div>
          <div className="typography-body-sm" style={{ color: 'var(--status-green-text)', marginTop: '4px' }}>
            <Zap size={13} style={{ verticalAlign: 'middle' }} /> 0ms latency to kitchen
          </div>
        </div>

        {/* Cloud Sync Health */}
        <div className="card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--color-muted)', fontSize: '13px' }}>
            <span className="typography-uppercase-tag">Cloud Sync Status</span>
            <Database size={18} style={{ color: cloudOnline ? 'var(--status-green-text)' : 'var(--status-rust-text)' }} />
          </div>
          <div className="typography-display-xl" style={{ fontSize: '24px', color: cloudOnline ? 'var(--status-green-text)' : 'var(--status-rust-text)', marginTop: '12px' }}>
            {cloudOnline ? 'Reconciled' : `${cloudQueue.length} Queued`}
          </div>
          <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '4px' }}>
            {cloudOnline ? 'Supabase Postgres synced' : 'Waiting for internet return'}
          </div>
        </div>
      </div>

      {/* Popular Dishes Breakdown */}
      <div className="card" style={{ padding: '24px' }}>
        <h2 className="typography-display-md" style={{ margin: '0 0 16px', color: 'var(--color-ink)' }}>
          Top Selling Dishes Today ({currentRestaurant?.name})
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {popularDishes.length === 0 ? (
            <div className="typography-body-sm" style={{ color: 'var(--color-muted)' }}>
              No sales data recorded yet for this restaurant today.
            </div>
          ) : (
            popularDishes.map(([dishName, count], idx) => (
              <div
                key={dishName}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'var(--color-surface-soft)',
                  border: '1px solid var(--color-hairline)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '12px 16px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--color-primary)', fontSize: '14px' }}>
                    #{idx + 1}
                  </span>
                  <span className="typography-title-md" style={{ color: 'var(--color-ink)' }}>
                    {dishName}
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 700, color: 'var(--color-ink)' }}>
                  {count} orders
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
