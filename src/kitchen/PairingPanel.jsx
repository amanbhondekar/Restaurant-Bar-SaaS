import { QrCode } from 'lucide-react';

export function PairingPanel({ qrCodeUrl, pairingInfo, hubHost, enrollmentCode, activeTickets, readyTickets }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-base)' }}>
      <div style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-lg)', textAlign: 'center', boxShadow: 'var(--shadow-flat)' }}>
        <div className="typography-micro-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--spacing-sm)', color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 'var(--spacing-md)' }}>
          <QrCode size={16} /> Waiter Pairing QR Code
        </div>

        {qrCodeUrl ? (
          <div style={{ background: 'var(--color-canvas)', padding: 'var(--spacing-md)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-hairline)', display: 'inline-block', marginBottom: 'var(--spacing-md)' }}>
            <img src={qrCodeUrl} alt="Waiter App Pairing QR" style={{ width: '180px', height: '180px', display: 'block' }} />
          </div>
        ) : (
          <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-muted)' }}>Generating QR...</div>
        )}

        <div className="typography-caption" style={{ color: 'var(--color-ink)' }}>
          Scan with Waiter Phone Camera
        </div>
        <div className="typography-badge" style={{ color: 'var(--color-muted)', marginTop: 'var(--spacing-xs)', fontFamily: 'var(--font-mono)' }}>
          LAN Address: {pairingInfo?.server_url || hubHost}/waiter
        </div>
        <div style={{ marginTop: 'var(--spacing-md)', background: 'var(--color-surface-soft)', padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-sm)', color: 'var(--color-body)' }}>
          <span className="typography-micro-label">Pairing Code: </span><strong style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)' }}>{pairingInfo?.pairing_code || '---'}</strong>
        </div>
        {/* Handsets that cannot scan the QR type this code once to enrol.
            It is only ever served to this screen, never over the LAN. */}
        <div style={{ marginTop: '8px', background: 'var(--color-surface-soft)', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', color: 'var(--color-body)' }}>
          Enrollment Code: <strong style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', letterSpacing: '2px' }}>{enrollmentCode || '---'}</strong>
          <div style={{ fontSize: '10px', color: 'var(--color-muted)', marginTop: '2px' }}>
            Type this on a waiter handset if it cannot scan the QR code.
          </div>
        </div>
      </div>

      {/* Quick Metrics Card */}
      <div style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-lg)', boxShadow: 'var(--shadow-flat)' }}>
        <div className="typography-micro-label" style={{ color: 'var(--color-muted)', textTransform: 'uppercase', marginBottom: 'var(--spacing-md)' }}>
          Kitchen Summary
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)' }}>
          <div style={{ background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)', padding: 'var(--spacing-md)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
            <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--status-amber-text)', fontFamily: 'var(--font-mono)' }}>{activeTickets.length}</div>
            <div className="typography-badge" style={{ color: 'var(--status-amber-text)', marginTop: 'var(--spacing-xxs)', textTransform: 'uppercase' }}>ACTIVE KOTS</div>
          </div>
          <div style={{ background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)', padding: 'var(--spacing-md)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
            <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--status-green-text)', fontFamily: 'var(--font-mono)' }}>{readyTickets.length}</div>
            <div className="typography-badge" style={{ color: 'var(--status-green-text)', marginTop: 'var(--spacing-xxs)', textTransform: 'uppercase' }}>READY TO SERVE</div>
          </div>
        </div>
      </div>
    </div>
  );
}
