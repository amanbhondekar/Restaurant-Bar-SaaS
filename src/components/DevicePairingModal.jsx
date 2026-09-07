import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { QrCode, Smartphone, Wifi, CheckCircle2, ShieldCheck, X } from 'lucide-react';

export const DevicePairingModal = ({ isOpen, onClose }) => {
  const { currentRestaurant, pairingState, pairDevice } = usePos();
  const [inputCode, setInputCode] = useState('');
  const [feedback, setFeedback] = useState(null);

  if (!isOpen) return null;

  const handlePair = (e) => {
    e.preventDefault();
    const result = pairDevice(null, inputCode);
    if (result.success) {
      setFeedback({ type: 'success', text: `Successfully paired to ${result.restaurantName}!` });
      setTimeout(() => {
        setFeedback(null);
        onClose();
      }, 1200);
    } else {
      setFeedback({ type: 'error', text: result.error || 'Invalid code' });
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--color-scrim)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
    }}>
      <div className="card" style={{
        background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)',
        borderRadius: 'var(--radius-md)', width: '100%', maxWidth: '460px',
        overflow: 'hidden', boxShadow: 'var(--shadow-modal)'
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px', background: 'var(--color-surface-soft)',
          borderBottom: '1px solid var(--color-hairline)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '40px', height: '40px', borderRadius: 'var(--radius-full)',
              background: 'var(--color-primary)',
              color: 'var(--color-on-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <QrCode size={20} />
            </div>
            <div>
              <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>Per-Tenant Device Pairing</div>
              <div className="typography-body-sm" style={{ color: 'var(--color-muted)' }}>Scoped WiFi KDS Connection</div>
            </div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--color-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Active pairing card */}
          <div style={{
            background: 'var(--color-surface-soft)', border: '1px dashed var(--color-primary)',
            borderRadius: 'var(--radius-md)', padding: '20px', textAlign: 'center',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px'
          }}>
            <div className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>
              Active Restaurant Pairing Token
            </div>

            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 700,
              color: 'var(--color-primary)', letterSpacing: '4px', background: 'var(--status-amber-bg)',
              padding: '10px 24px', borderRadius: 'var(--radius-full)', border: '1px solid var(--status-amber-border)'
            }}>
              {currentRestaurant?.pairingCode}
            </div>

            <div className="typography-body-sm" style={{ color: 'var(--color-ink)' }}>
              Target KDS: <strong>{currentRestaurant?.name}</strong> ({currentRestaurant?.city})
            </div>

            <div className="typography-uppercase-tag" style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              color: 'var(--status-green-text)', background: 'var(--status-green-bg)', padding: '4px 12px',
              borderRadius: 'var(--radius-full)', border: '1px solid var(--status-green-border)'
            }}>
              <ShieldCheck size={14} /> WiFi Scope Verified · LAN Decoupled
            </div>
          </div>

          {/* Enter Code to Pair Handset */}
          <form onSubmit={handlePair} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <label className="typography-caption-sm" style={{ fontWeight: 600, color: 'var(--color-muted)' }}>
              Pair Waiter Handset with Code
            </label>

            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                type="text"
                placeholder="e.g. SPG-3108"
                value={inputCode}
                onChange={e => setInputCode(e.target.value.toUpperCase())}
                className="input"
                style={{ flex: 1, height: '48px', fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 700 }}
              />
              <button
                type="submit"
                className="btn btn-primary"
                style={{ height: '48px', padding: '0 20px' }}
              >
                Pair Device
              </button>
            </div>
          </form>

          {feedback && (
            <div style={{
              padding: '12px 16px', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 500,
              background: feedback.type === 'success' ? 'var(--status-green-bg)' : 'var(--status-rust-bg)',
              color: feedback.type === 'success' ? 'var(--status-green-text)' : 'var(--status-rust-text)',
              border: `1px solid ${feedback.type === 'success' ? 'var(--status-green-border)' : 'var(--status-rust-border)'}`
            }}>
              {feedback.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
