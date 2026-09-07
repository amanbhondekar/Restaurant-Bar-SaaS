import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { QrCode, ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export const DevicePairingModal = ({ isOpen, onClose }) => {
  const { currentRestaurant, pairDevice } = usePos();
  const [inputCode, setInputCode] = useState('');
  const [feedback, setFeedback] = useState(null);

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
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[460px] gap-0 p-0">
        <DialogHeader className="flex flex-row items-center gap-3 p-5 bg-muted border-b">
          <div style={{
            width: '40px', height: '40px', borderRadius: 'var(--radius-full)',
            background: 'var(--color-primary)', color: 'var(--color-on-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <QrCode size={20} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <DialogTitle>Per-Tenant Device Pairing</DialogTitle>
            <DialogDescription>Scoped WiFi KDS Connection</DialogDescription>
          </div>
        </DialogHeader>

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
          <form onSubmit={handlePair} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Label htmlFor="pair-code">Pair Waiter Handset with Code</Label>
            <div style={{ display: 'flex', gap: '10px' }}>
              <Input
                id="pair-code"
                type="text"
                placeholder="e.g. SPG-3108"
                value={inputCode}
                onChange={e => setInputCode(e.target.value.toUpperCase())}
                className="h-10 flex-1 font-mono font-bold text-base"
              />
              <Button type="submit" size="lg" className="h-10">
                Pair Device
              </Button>
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
      </DialogContent>
    </Dialog>
  );
};
