import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { SelfServeOnboardingModal } from './SelfServeOnboardingModal';
import { DevicePairingModal } from './DevicePairingModal';
import {
  Wifi, WifiOff, Smartphone, Laptop, Sparkles, RefreshCw,
  Building2, QrCode, Shield, Zap, PlusCircle, Crown
} from 'lucide-react';

export const Header = () => {
  const {
    restaurants,
    currentRestaurantId,
    setCurrentRestaurantId,
    currentRestaurant,
    currentRole,
    setCurrentRole,
    cloudOnline,
    toggleCloudOutage,
    cloudQueue,
    isSyncing,
    deviceMode,
    setDeviceMode,
    changeRestaurantPlan
  } = usePos();

  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [isPairingOpen, setIsPairingOpen] = useState(false);

  const planColors = {
    starter: { bg: 'var(--status-blue-bg)', text: 'var(--status-blue-text)', border: 'var(--status-blue-border)', label: 'STARTER TIER' },
    pro: { bg: 'var(--status-amber-bg)', text: 'var(--status-amber-text)', border: 'var(--status-amber-border)', label: 'PRO TIER' },
    enterprise: { bg: 'var(--status-rust-bg)', text: 'var(--status-rust-text)', border: 'var(--status-rust-border)', label: 'ENTERPRISE' }
  };
  const currentPlan = planColors[currentRestaurant?.plan] || planColors.starter;

  return (
    <>
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '16px',
        padding: '0 24px',
        minHeight: '80px',
        background: 'var(--color-canvas)',
        borderBottom: '1px solid var(--color-hairline)',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        {/* Brand & Tenant Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Logo Asset */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <img
              src="/logos/Logo-Default.svg"
              alt="Kullina"
              style={{ height: '28px', objectFit: 'contain' }}
            />
          </div>

          <div style={{ width: '1px', height: '32px', background: 'var(--color-hairline)' }} />

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <select
                value={currentRestaurantId}
                onChange={e => setCurrentRestaurantId(e.target.value)}
                style={{
                  background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)',
                  color: 'var(--color-ink)', fontWeight: 700, fontSize: '15px',
                  fontFamily: 'var(--font-display)',
                  borderRadius: 'var(--radius-sm)', padding: '4px 10px', cursor: 'pointer'
                }}
              >
                {restaurants.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name} {r.isPilot ? '👑 (Pilot)' : ''} ({r.city})
                  </option>
                ))}
              </select>

              {/* Plan Tier Badge */}
              <select
                value={currentRestaurant?.plan || 'pro'}
                onChange={e => changeRestaurantPlan(currentRestaurantId, e.target.value)}
                className="typography-uppercase-tag"
                style={{
                  background: currentPlan.bg, color: currentPlan.text,
                  border: `1px solid ${currentPlan.border}`,
                  borderRadius: 'var(--radius-full)',
                  padding: '3px 10px', cursor: 'pointer'
                }}
              >
                <option value="starter">STARTER TIER</option>
                <option value="pro">PRO TIER</option>
                <option value="enterprise">ENTERPRISE</option>
              </select>
            </div>

            <div style={{ fontSize: '11px', color: 'var(--color-muted)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>{currentRestaurant?.cuisine} · {currentRestaurant?.city}</span>
              <span>•</span>
              <span style={{ color: 'var(--color-primary)', fontWeight: 700 }}>Code: {currentRestaurant?.pairingCode}</span>
            </div>
          </div>
        </div>

        {/* Action Controls & Role Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Onboard New Restaurant Button */}
          <button
            onClick={() => setIsOnboardingOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '8px 14px', borderRadius: 'var(--radius-sm)',
              fontSize: '13px', fontWeight: 500,
              background: 'var(--color-primary)',
              color: 'var(--color-on-primary)', border: 'none', cursor: 'pointer',
              transition: 'background-color 0.15s ease'
            }}
            onMouseDown={e => e.currentTarget.style.backgroundColor = 'var(--color-primary-active)'}
            onMouseUp={e => e.currentTarget.style.backgroundColor = 'var(--color-primary)'}
          >
            <PlusCircle size={15} /> + Onboard Restaurant
          </button>

          {/* Device Pairing Button */}
          <button
            onClick={() => setIsPairingOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '8px 14px', borderRadius: 'var(--radius-sm)',
              fontSize: '13px', fontWeight: 500,
              background: 'var(--color-surface-soft)', color: 'var(--color-ink)',
              border: '1px solid var(--color-hairline)', cursor: 'pointer'
            }}
          >
            <QrCode size={15} style={{ color: 'var(--color-primary)' }} /> Pair KDS
          </button>

          {/* Role Switcher (owner/manager only) */}
          {currentRole !== 'waiter' && (
            <div style={{ display: 'flex', alignItems: 'center', background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-full)', padding: '3px' }}>
              <span style={{ fontSize: '10px', color: 'var(--color-muted)', padding: '0 8px', fontWeight: 700, textTransform: 'uppercase' }}>ROLE:</span>
              {['owner', 'manager', 'waiter'].map(role => (
                <button
                  key={role}
                  onClick={() => setCurrentRole(role)}
                  style={{
                    padding: '4px 12px', borderRadius: 'var(--radius-full)', fontSize: '12px', fontWeight: 500,
                    textTransform: 'capitalize', border: 'none', cursor: 'pointer',
                    background: currentRole === role ? 'var(--color-primary)' : 'transparent',
                    color: currentRole === role ? 'var(--color-on-primary)' : 'var(--color-muted)',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {role}
                </button>
              ))}
            </div>
          )}

          {/* Device View Mode Switcher */}
          <div className="pill-group">
            <button
              className={`pill-btn ${deviceMode === 'waiter_mobile' ? 'active' : ''}`}
              onClick={() => setDeviceMode('waiter_mobile')}
              style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <Smartphone size={13} /> Mobile
            </button>
            <button
              className={`pill-btn ${deviceMode === 'laptop_server' ? 'active' : ''}`}
              onClick={() => setDeviceMode('laptop_server')}
              style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <Laptop size={13} /> KDS Hub
            </button>
            <button
              className={`pill-btn ${deviceMode === 'dual_demo' ? 'active' : ''}`}
              onClick={() => setDeviceMode('dual_demo')}
              style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <Sparkles size={13} /> Dual Demo
            </button>
          </div>

          {/* Outage Simulator (owner/manager only) */}
          {currentRole !== 'waiter' && (
            <button
              onClick={toggleCloudOutage}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '8px 14px', borderRadius: 'var(--radius-sm)',
                fontSize: '12px', fontWeight: 500,
                background: !cloudOnline ? 'var(--status-rust-bg)' : 'var(--color-surface-soft)',
                color: !cloudOnline ? 'var(--status-rust-text)' : 'var(--color-ink)',
                border: `1px solid ${!cloudOnline ? 'var(--status-rust-border)' : 'var(--color-hairline)'}`,
                transition: 'all 0.15s ease', cursor: 'pointer'
              }}
            >
              {!cloudOnline ? <WifiOff size={14} /> : <Wifi size={14} />}
              {!cloudOnline ? 'Restore Internet' : 'Simulate Outage'}
              {!cloudOnline && cloudQueue.length > 0 && (
                <span style={{
                  background: 'var(--status-rust-text)', color: 'var(--color-on-primary)', fontSize: '10px',
                  fontWeight: 700, padding: '1px 6px', borderRadius: 'var(--radius-full)'
                }}>{cloudQueue.length}</span>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Onboarding Wizard Modal */}
      <SelfServeOnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
      />

      {/* Device Pairing Modal */}
      <DevicePairingModal
        isOpen={isPairingOpen}
        onClose={() => setIsPairingOpen(false)}
      />
    </>
  );
};
