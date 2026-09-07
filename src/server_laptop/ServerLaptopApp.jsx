import React, { useState, useEffect } from 'react';
import { KitchenKdsView } from './KitchenKdsView';
import { WaitlistView } from './WaitlistView';
import { SelfServeAdminView } from './SelfServeAdminView';
import { SalesAnalyticsView } from './SalesAnalyticsView';
import { LiveClock } from '../components/LiveClock';
import { usePos } from '../context/PosContext';
import {
  ChefHat, Users, Settings, BarChart3, LayoutGrid, Clock,
  Wifi, WifiOff, CheckCircle2, Lock, Sparkles, Shield, AlertTriangle
} from 'lucide-react';

const TABS = [
  { id: 'kds',       icon: ChefHat,    label: 'Kitchen KDS',  color: 'var(--color-primary)', module: 'kds' },
  { id: 'floor',     icon: LayoutGrid, label: 'Floor View',   color: 'var(--status-blue-text)', module: 'floor' },
  { id: 'waitlist',  icon: Users,      label: 'Waitlist',     color: 'var(--color-ink)', module: 'waitlist' },
  { id: 'analytics', icon: BarChart3,  label: 'Analytics',    color: 'var(--status-green-text)', module: 'analytics' },
  { id: 'admin',     icon: Settings,   label: 'Admin Setup',  color: 'var(--color-primary)', module: 'admin' },
];

const FloorOverview = () => {
  const { tables, currentRestaurant } = usePos();
  const currency = currentRestaurant?.currency || '₹';

  const stats = {
    occupied: tables.filter(t => ['occupied', 'kot', 'ready'].includes(t.status)).length,
    available: tables.filter(t => t.status === 'available').length,
    kot: tables.filter(t => t.status === 'kot').length,
    billReady: tables.filter(t => t.status === 'ready').length,
    total: tables.length,
    revenue: tables.reduce((s, t) => s + (t.activeOrderTotal || 0), 0),
  };

  const sections = Array.from(new Set(tables.map(t => t.section)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Live Revenue Loud Type Moment (Section 1 System Restraint Principle) */}
      <div style={{
        background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)',
        borderRadius: 'var(--radius-md)', padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '16px'
      }}>
        <div>
          <div className="typography-uppercase-tag" style={{ color: 'var(--color-muted)', marginBottom: '4px' }}>
            Live Floor Revenue Overview
          </div>
          <div className="typography-rating-display" style={{ color: 'var(--color-primary)' }}>
            {currency}{stats.revenue}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {[
            { label: 'Occupied', value: `${stats.occupied}/${stats.total}`, color: 'var(--status-rust-text)', bg: 'var(--status-rust-bg)' },
            { label: 'Available', value: stats.available, color: 'var(--status-green-text)', bg: 'var(--status-green-bg)' },
            { label: 'In Kitchen', value: stats.kot, color: 'var(--status-amber-text)', bg: 'var(--status-amber-bg)' },
            { label: 'Bill Ready', value: stats.billReady, color: 'var(--status-blue-text)', bg: 'var(--status-blue-bg)' },
          ].map(s => (
            <div key={s.label} style={{
              background: s.bg, border: `1px solid ${s.color}33`,
              borderRadius: 'var(--radius-sm)', padding: '12px 16px', minWidth: '100px'
            }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 700, color: s.color }}>{s.value}</div>
              <div className="typography-uppercase-tag" style={{ color: s.color, marginTop: '2px' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-Section Grids */}
      {sections.map(section => {
        const sectionTables = tables.filter(t => t.section === section);
        return (
          <div key={section}>
            <div className="typography-display-sm" style={{ color: 'var(--color-ink)', marginBottom: '12px' }}>
              {section}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '12px' }}>
              {sectionTables.map(t => {
                const stColor = {
                  available: 'var(--status-green-text)', occupied: 'var(--status-rust-text)',
                  kot: 'var(--status-amber-text)', ready: 'var(--status-blue-text)'
                }[t.status] || 'var(--color-muted)';
                const stBg = {
                  available: 'var(--status-green-bg)', occupied: 'var(--status-rust-bg)',
                  kot: 'var(--status-amber-bg)', ready: 'var(--status-blue-bg)'
                }[t.status] || 'var(--color-surface-soft)';
                const stLabel = {
                  available: 'Open', occupied: 'Dining',
                  kot: 'In Kitchen', ready: 'Bill Ready'
                }[t.status] || t.status;

                return (
                  <div key={t.id} className="table-card" style={{
                    background: 'var(--color-canvas)', border: `1px solid var(--color-hairline)`,
                    borderRadius: 'var(--radius-md)', padding: '14px 12px', textAlign: 'center',
                  }}>
                    <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{t.name}</div>
                    <div className="typography-body-sm" style={{ fontSize: '11px', color: 'var(--color-muted)', marginTop: '2px' }}>{t.capacity} seats</div>
                    <div className="typography-uppercase-tag" style={{ color: stColor, background: stBg, padding: '2px 6px', borderRadius: 'var(--radius-full)', marginTop: '6px', display: 'inline-block' }}>{stLabel}</div>
                    {t.activeOrderTotal > 0 && (
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-primary)', fontWeight: 700, marginTop: '4px' }}>{currency}{t.activeOrderTotal}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const PlanUpgradeGate = ({ moduleTitle, requiredPlan, currentPlan, onUpgrade }) => (
  <div style={{
    background: 'var(--color-canvas)', border: '1px dashed var(--color-primary)',
    borderRadius: 'var(--radius-md)', padding: '48px 24px', textAlign: 'center',
    maxWidth: '540px', margin: '40px auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px',
    boxShadow: 'var(--shadow-flat)'
  }}>
    <div style={{
      width: '56px', height: '56px', borderRadius: 'var(--radius-full)',
      background: 'var(--status-amber-bg)', color: 'var(--color-primary)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <Lock size={28} />
    </div>

    <div>
      <div className="typography-display-sm" style={{ color: 'var(--color-ink)' }}>{moduleTitle} Module Gated</div>
      <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '8px', lineHeight: 1.5 }}>
        This feature requires the <strong>{requiredPlan.toUpperCase()} TIER</strong> subscription. Your restaurant is currently on the <strong>{currentPlan.toUpperCase()} TIER</strong>.
      </div>
    </div>

    <button
      onClick={onUpgrade}
      className="btn btn-primary"
      style={{ marginTop: '8px' }}
    >
      <Sparkles size={16} /> Upgrade to PRO Plan
    </button>
  </div>
);

export const ServerLaptopApp = () => {
  const [activeTab, setActiveTab] = useState('kds');
  const {
    tables, tickets, cloudOnline, cloudQueue, waitlist, hubStatus,
    currentRestaurant, hasModuleAccess, changeRestaurantPlan, isMenuUninitialized
  } = usePos();

  const badges = {
    kds: tickets.filter(t => t.status === 'in_progress').length,
    waitlist: waitlist.filter(w => w.status === 'waiting').length,
    floor: tables.filter(t => t.status === 'ready').length,
  };

  const isTabAllowed = hasModuleAccess(activeTab);

  return (
    <div style={{
      width: '100%',
      background: 'var(--color-canvas)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--color-hairline)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-flat)',
    }}>
      {/* Uninitialized Cache Warning Banner */}
      {isMenuUninitialized && (
        <div className="banner banner-warning" style={{
          borderBottom: '1px solid var(--color-warning-border)',
          display: 'flex', alignItems: 'center', gap: '10px'
        }}>
          <AlertTriangle size={18} style={{ flexShrink: 0 }} />
          <span>No menu data available — connect this hub to the internet once to complete setup.</span>
        </div>
      )}
      {/* Laptop Top Bar */}
      <div style={{
        background: 'var(--color-surface-soft)',
        borderBottom: '1px solid var(--color-hairline)',
        padding: '20px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        {/* Identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: 'var(--radius-full)', flexShrink: 0,
            background: 'var(--color-primary)',
            color: 'var(--color-on-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <ChefHat size={22} />
          </div>
          <div>
            <div className="typography-display-sm" style={{ color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              {currentRestaurant?.name} Reception Hub
              <span className="typography-uppercase-tag" style={{
                background: 'var(--status-amber-bg)', color: 'var(--status-amber-text)',
                padding: '3px 10px', borderRadius: 'var(--radius-full)', border: '1px solid var(--status-amber-border)'
              }}>
                {(currentRestaurant?.plan || 'pro').toUpperCase()} PLAN
              </span>
            </div>
            <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '2px' }}>
              {currentRestaurant?.city} · Pairing Code: <strong style={{ color: 'var(--color-primary)' }}>{currentRestaurant?.pairingCode}</strong>
            </div>
          </div>
        </div>

        {/* Live indicators + Clock */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: hubStatus?.isHubConnected ? 'var(--status-green-text)' : 'var(--status-amber-text)' }} />
              <span style={{ color: 'var(--color-muted)' }}>Local Hub (0.0.0.0:4000): </span>
              <strong style={{ color: hubStatus?.isHubConnected ? 'var(--status-green-text)' : 'var(--status-amber-text)' }}>
                {hubStatus?.isHubConnected ? 'Node.js Express & WS Active' : 'Browser Bus Fallback'}
              </strong>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: hubStatus?.online ? 'var(--status-green-text)' : 'var(--status-rust-text)' }} />
              <span style={{ color: 'var(--color-muted)' }}>Cloud Sync Queue: </span>
              <strong style={{ color: (hubStatus?.queued || 0) > 0 ? 'var(--status-amber-text)' : 'var(--status-green-text)' }}>
                {hubStatus?.online ? ((hubStatus?.queued || 0) > 0 ? `${hubStatus.queued} queued` : 'Supabase Synced ✓') : `Offline (${hubStatus?.queued || 0} queued)`}
              </strong>
            </div>
          </div>
          <div style={{ width: '1px', height: '40px', background: 'var(--color-hairline)' }} />
          <LiveClock />
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{
        display: 'flex', gap: '4px',
        background: 'var(--color-surface-soft)',
        borderBottom: '1px solid var(--color-hairline)',
        padding: '6px 12px 0',
        overflowX: 'auto',
      }}>
        {TABS.map(tab => {
          const badge = badges[tab.id] || 0;
          const isActive = activeTab === tab.id;
          const isModuleGated = !hasModuleAccess(tab.id);

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '12px 20px', fontSize: '14px', fontWeight: 500,
                fontFamily: 'var(--font-body)',
                color: isActive ? 'var(--color-on-primary)' : isModuleGated ? 'var(--color-muted-soft)' : 'var(--color-ink)',
                background: isActive ? 'var(--color-primary)' : 'transparent',
                borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
                whiteSpace: 'nowrap', position: 'relative',
                transition: 'all 0.15s ease', cursor: 'pointer', border: 'none'
              }}
            >
              <tab.icon size={16} strokeWidth={isActive ? 2.5 : 1.8} />
              {tab.label}

              {isModuleGated && (
                <Lock size={12} style={{ color: 'var(--status-rust-text)' }} />
              )}

              {badge > 0 && !isModuleGated && (
                <span style={{
                  background: isActive ? 'var(--color-primary-active)' : 'var(--color-primary)',
                  color: 'var(--color-on-primary)',
                  fontSize: '10px', fontWeight: 700, borderRadius: 'var(--radius-full)',
                  padding: '1px 6px', fontFamily: 'var(--font-mono)',
                  minWidth: '18px', textAlign: 'center',
                }}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div style={{ padding: '32px', minHeight: '500px', background: 'var(--color-canvas)' }}>
        {!isTabAllowed ? (
          <PlanUpgradeGate
            moduleTitle={TABS.find(t => t.id === activeTab)?.label}
            requiredPlan="PRO"
            currentPlan={currentRestaurant?.plan || 'starter'}
            onUpgrade={() => changeRestaurantPlan(currentRestaurant.id, 'pro')}
          />
        ) : (
          <>
            {activeTab === 'kds'       && <KitchenKdsView />}
            {activeTab === 'floor'     && <FloorOverview />}
            {activeTab === 'waitlist'  && <WaitlistView />}
            {activeTab === 'analytics' && <SalesAnalyticsView />}
            {activeTab === 'admin'     && <SelfServeAdminView />}
          </>
        )}
      </div>
    </div>
  );
};
