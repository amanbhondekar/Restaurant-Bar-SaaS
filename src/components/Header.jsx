import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { SelfServeOnboardingModal } from './SelfServeOnboardingModal';
import { DevicePairingModal } from './DevicePairingModal';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import {
  Wifi, WifiOff, Smartphone, Laptop, Sparkles,
  QrCode, PlusCircle
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
    deviceMode,
    setDeviceMode,
    changeRestaurantPlan
  } = usePos();

  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [isPairingOpen, setIsPairingOpen] = useState(false);

  const planColors = {
    starter: { bg: 'var(--status-blue-bg)', text: 'var(--status-blue-text)', border: 'var(--status-blue-border)' },
    pro:     { bg: 'var(--status-amber-bg)', text: 'var(--status-amber-text)', border: 'var(--status-amber-border)' },
    enterprise: { bg: 'var(--status-rust-bg)', text: 'var(--status-rust-text)', border: 'var(--status-rust-border)' }
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
                    {r.name} {r.isPilot ? ' (Pilot)' : ''} ({r.city})
                  </option>
                ))}
              </select>

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
          <Button size="sm" onClick={() => setIsOnboardingOpen(true)}>
            <PlusCircle /> Onboard Restaurant
          </Button>

          <Button variant="outline" size="sm" onClick={() => setIsPairingOpen(true)}>
            <QrCode className="text-primary" /> Pair KDS
          </Button>

          {currentRole !== 'waiter' && (
            <div style={{
              display: 'flex', alignItems: 'center',
              background: 'var(--color-surface-soft)',
              border: '1px solid var(--color-hairline)',
              borderRadius: 'var(--radius-full)', padding: '3px'
            }}>
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

          {currentRole !== 'waiter' && (
            <Button
              variant={cloudOnline ? 'outline' : 'destructive'}
              size="sm"
              onClick={toggleCloudOutage}
            >
              {cloudOnline ? <Wifi /> : <WifiOff />}
              {cloudOnline ? 'Simulate Outage' : 'Restore Internet'}
              {!cloudOnline && cloudQueue.length > 0 && (
                <Badge variant="destructive" className="ml-1">{cloudQueue.length}</Badge>
              )}
            </Button>
          )}
        </div>
      </header>

      <SelfServeOnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
      />

      <DevicePairingModal
        isOpen={isPairingOpen}
        onClose={() => setIsPairingOpen(false)}
      />
    </>
  );
};
