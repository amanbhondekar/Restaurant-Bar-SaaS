import React, { useState } from 'react';
import { KitchenKdsView } from './KitchenKdsView';
import { WaitlistView } from './WaitlistView';
import { SelfServeAdminView } from './SelfServeAdminView';
import { SalesAnalyticsView } from './SalesAnalyticsView';
import { LiveClock } from '../components/LiveClock';
import { usePos } from '../context/PosContext';
import {
  ChefHat, Users, Settings, BarChart3, LayoutGrid,
  Lock, Sparkles, AlertTriangle
} from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Separator } from '../components/ui/separator';
import { Card, CardContent } from '../components/ui/card';

const TABS = [
  { id: 'kds',       icon: ChefHat,    label: 'Kitchen KDS' },
  { id: 'floor',     icon: LayoutGrid, label: 'Floor View' },
  { id: 'waitlist',  icon: Users,      label: 'Waitlist' },
  { id: 'analytics', icon: BarChart3,  label: 'Analytics' },
  { id: 'admin',     icon: Settings,   label: 'Admin Setup' },
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
    <div className="flex flex-col gap-6">
      {/* Revenue + Stats */}
      <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-surface-soft)' }}>
        <CardContent className="flex items-center justify-between flex-wrap gap-4 px-6 py-5">
          <div>
            <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>Live Floor Revenue</span>
            <div className="typography-rating-display" style={{ color: 'var(--color-primary)' }}>{currency}{stats.revenue}</div>
          </div>
          <div className="flex gap-3 flex-wrap">
            {[
              { label: 'Occupied', value: `${stats.occupied}/${stats.total}`, color: 'var(--status-rust-text)', bg: 'var(--status-rust-bg)' },
              { label: 'Available', value: stats.available, color: 'var(--status-green-text)', bg: 'var(--status-green-bg)' },
              { label: 'In Kitchen', value: stats.kot, color: 'var(--status-amber-text)', bg: 'var(--status-amber-bg)' },
              { label: 'Bill Ready', value: stats.billReady, color: 'var(--status-blue-text)', bg: 'var(--status-blue-bg)' },
            ].map(s => (
              <div key={s.label} className="rounded-[var(--radius-sm)] px-4 py-3 min-w-[100px]" style={{ background: s.bg, border: `1px solid ${s.color}33` }}>
                <div className="font-mono text-xl font-bold" style={{ color: s.color }}>{s.value}</div>
                <div className="typography-uppercase-tag mt-0.5" style={{ color: s.color }}>{s.label}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Per-Section Grids */}
      {sections.map(section => {
        const sectionTables = tables.filter(t => t.section === section);
        return (
          <div key={section}>
            <h3 className="typography-display-sm mb-3" style={{ color: 'var(--color-ink)' }}>{section}</h3>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
              {sectionTables.map(t => {
                const stColor = { available: 'var(--status-green-text)', occupied: 'var(--status-rust-text)', kot: 'var(--status-amber-text)', ready: 'var(--status-blue-text)' }[t.status] || 'var(--color-muted)';
                const stBg = { available: 'var(--status-green-bg)', occupied: 'var(--status-rust-bg)', kot: 'var(--status-amber-bg)', ready: 'var(--status-blue-bg)' }[t.status] || 'var(--color-surface-soft)';
                const stLabel = { available: 'Open', occupied: 'Dining', kot: 'In Kitchen', ready: 'Bill Ready' }[t.status] || t.status;

                return (
                  <div key={t.id} className="table-card rounded-[var(--radius-md)] border p-3.5 text-center" style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)' }}>
                    <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{t.name}</div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-muted)' }}>{t.capacity} seats</div>
                    <Badge variant="outline" className="mt-1.5 text-[8px] font-bold" style={{ color: stColor, background: stBg, borderColor: `${stColor}33` }}>
                      {stLabel}
                    </Badge>
                    {t.activeOrderTotal > 0 && (
                      <div className="font-mono text-[13px] font-bold mt-1" style={{ color: 'var(--color-primary)' }}>{currency}{t.activeOrderTotal}</div>
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
  <div className="flex flex-col items-center gap-4 text-center max-w-[540px] mx-auto py-12 px-6">
    <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: 'var(--status-amber-bg)', color: 'var(--color-primary)' }}>
      <Lock size={28} />
    </div>
    <div>
      <h3 className="typography-display-sm" style={{ color: 'var(--color-ink)' }}>{moduleTitle} Module Gated</h3>
      <p className="typography-body-sm mt-2" style={{ color: 'var(--color-muted)', lineHeight: 1.5 }}>
        Requires <strong>{requiredPlan.toUpperCase()}</strong> subscription. You're on <strong>{currentPlan.toUpperCase()}</strong>.
      </p>
    </div>
    <Button onClick={onUpgrade} className="mt-2">
      <Sparkles size={16} /> Upgrade to PRO
    </Button>
  </div>
);

export const ServerLaptopApp = () => {
  const [activeTab, setActiveTab] = useState('kds');
  const {
    tables, tickets, waitlist, hubStatus,
    currentRestaurant, hasModuleAccess, changeRestaurantPlan, isMenuUninitialized
  } = usePos();

  const badges = {
    kds: tickets.filter(t => t.status === 'in_progress').length,
    waitlist: waitlist.filter(w => w.status === 'waiting').length,
    floor: tables.filter(t => t.status === 'ready').length,
  };

  const isTabAllowed = hasModuleAccess(activeTab);

  return (
    <div className="w-full rounded-[var(--radius-md)] border overflow-hidden" style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)' }}>

      {/* Uninitialized Banner */}
      {isMenuUninitialized && (
        <div className="banner banner-warning flex items-center gap-2.5" style={{ borderBottom: '1px solid var(--color-warning-border)' }}>
          <AlertTriangle size={18} className="shrink-0" />
          <span>No menu data — connect hub to internet to complete setup.</span>
        </div>
      )}

      {/* Top Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4 px-6 py-5" style={{ background: 'var(--color-surface-soft)', borderBottom: '1px solid var(--color-hairline)' }}>
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
            <ChefHat size={22} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="typography-display-sm" style={{ color: 'var(--color-ink)' }}>{currentRestaurant?.name} Reception Hub</h1>
              <Badge variant="outline" className="text-[9px] font-bold" style={{ color: 'var(--status-amber-text)', background: 'var(--status-amber-bg)', borderColor: 'var(--status-amber-border)' }}>
                {(currentRestaurant?.plan || 'pro').toUpperCase()} PLAN
              </Badge>
            </div>
            <p className="typography-body-sm mt-0.5" style={{ color: 'var(--color-muted)' }}>
              {currentRestaurant?.city} · Pairing <strong style={{ color: 'var(--color-primary)' }}>{currentRestaurant?.pairingCode}</strong>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="w-2 h-2 rounded-full" style={{ background: hubStatus?.isHubConnected ? 'var(--status-green-text)' : 'var(--status-amber-text)' }} />
              <span style={{ color: 'var(--color-muted)' }}>Hub: </span>
              <strong style={{ color: hubStatus?.isHubConnected ? 'var(--status-green-text)' : 'var(--status-amber-text)' }}>
                {hubStatus?.isHubConnected ? 'Express & WS Active' : 'Browser Bus'}
              </strong>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <span className="w-2 h-2 rounded-full" style={{ background: hubStatus?.online ? 'var(--status-green-text)' : 'var(--status-rust-text)' }} />
              <span style={{ color: 'var(--color-muted)' }}>Sync: </span>
              <strong style={{ color: (hubStatus?.queued || 0) > 0 ? 'var(--status-amber-text)' : 'var(--status-green-text)' }}>
                {hubStatus?.online ? ((hubStatus?.queued || 0) > 0 ? `${hubStatus.queued} queued` : 'Synced') : `Offline (${hubStatus?.queued || 0} queued)`}
              </strong>
            </div>
          </div>
          <Separator orientation="vertical" className="h-10" />
          <LiveClock />
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 overflow-x-auto px-3 pt-1.5" style={{ background: 'var(--color-surface-soft)', borderBottom: '1px solid var(--color-hairline)' }}>
        {TABS.map(tab => {
          const badge = badges[tab.id] || 0;
          const isActive = activeTab === tab.id;
          const isModuleGated = !hasModuleAccess(tab.id);

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="flex items-center gap-2 px-5 py-3 text-sm font-medium whitespace-nowrap border-none cursor-pointer transition-all"
              style={{
                fontFamily: 'var(--font-body)',
                color: isActive ? 'var(--color-on-primary)' : isModuleGated ? 'var(--color-muted-soft)' : 'var(--color-ink)',
                background: isActive ? 'var(--color-primary)' : 'transparent',
                borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
              }}
            >
              <tab.icon size={16} strokeWidth={isActive ? 2.5 : 1.8} />
              {tab.label}
              {isModuleGated && <Lock size={12} style={{ color: 'var(--status-rust-text)' }} />}
              {badge > 0 && !isModuleGated && (
                <Badge variant="default" className="text-[10px] px-1.5 py-0 font-mono" style={{ background: isActive ? 'var(--color-primary-active)' : 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
                  {badge}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="p-8 min-h-[500px]" style={{ background: 'var(--color-canvas)' }}>
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
