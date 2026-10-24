import { ChefHat, RefreshCw, Wifi, Cloud } from 'lucide-react';
import { motion } from 'framer-motion';
import { ThemeToggle } from '../components/ThemeToggle';

export function KdsHeader({ pairingInfo, shouldReduceMotion, wsConnStatus, syncStatus, fetchActiveTickets, fetchSyncStatus }) {
  return (
    <header style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)',
      padding: 'var(--spacing-base) var(--spacing-lg)', marginBottom: 'var(--spacing-lg)', flexWrap: 'wrap', gap: 'var(--spacing-base)',
      boxShadow: 'var(--shadow-flat)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)', width: '44px', height: '44px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ChefHat size={22} />
        </div>
        <div>
          <h1 className="typography-display-sm" style={{ margin: 0, color: 'var(--color-ink)' }}>
            Kitchen Hub Display
          </h1>
          <div className="typography-caption-sm" style={{ color: 'var(--color-muted)', marginTop: 'var(--spacing-xxs)' }}>
            {pairingInfo ? `${pairingInfo.name} (${pairingInfo.pairing_code})` : 'Connecting to Reception Hub...'}
          </div>
        </div>
      </div>

      {/* Live System Status Badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        {/* LAN Connection Badge */}
        <motion.div
          layout={!shouldReduceMotion}
          style={{
            background: wsConnStatus === 'connected' ? 'var(--status-green-bg)' : wsConnStatus === 'connecting' ? 'var(--color-surface-soft)' : 'var(--status-rust-bg)',
            border: `1px solid ${wsConnStatus === 'connected' ? 'var(--status-green-border)' : wsConnStatus === 'connecting' ? 'var(--color-hairline)' : 'var(--status-rust-border)'}`,
            color: wsConnStatus === 'connected' ? 'var(--status-green-text)' : wsConnStatus === 'connecting' ? 'var(--color-muted)' : 'var(--status-rust-text)',
            padding: '6px 14px', borderRadius: 'var(--radius-full)', fontSize: '12px', fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-mono)'
          }}
        >
          {wsConnStatus === 'connecting' ? (
            <RefreshCw size={14} className="spin" />
          ) : (
            <Wifi size={14} />
          )}
          {wsConnStatus === 'connected' ? 'LAN WiFi Active' : wsConnStatus === 'connecting' ? 'Connecting…' : 'LAN Disconnected'}
        </motion.div>

        {/* Cloud Sync Status Badge */}
        <div style={{
          background: syncStatus.online ? (syncStatus.queued > 0 ? 'var(--status-amber-bg)' : 'var(--status-green-bg)') : 'var(--status-amber-bg)',
          border: `1px solid ${syncStatus.online ? (syncStatus.queued > 0 ? 'var(--status-amber-border)' : 'var(--status-green-border)') : 'var(--status-amber-border)'}`,
          color: syncStatus.online ? (syncStatus.queued > 0 ? 'var(--status-amber-text)' : 'var(--status-green-text)') : 'var(--status-amber-text)',
          padding: '6px 14px', borderRadius: 'var(--radius-full)', fontSize: '12px', fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-mono)'
        }}>
          <Cloud size={14} />
          {syncStatus.online 
            ? (syncStatus.queued > 0 ? `Cloud Queue (${syncStatus.queued})` : 'Cloud Synced')
            : `Local Only (${syncStatus.queued} queued)`}
        </div>

        <motion.button
          whileTap={shouldReduceMotion ? {} : { scale: 0.95 }}
          onClick={() => { fetchActiveTickets(); fetchSyncStatus(); }}
          style={{ background: 'var(--color-surface-soft)', color: 'var(--color-body)', border: '1px solid var(--color-hairline)', padding: '8px 14px', borderRadius: 'var(--radius-full)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600 }}
        >
          <RefreshCw size={14} /> Refresh
        </motion.button>
        <a href="/admin" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-body)', border: '1px solid var(--color-hairline)', padding: '8px 14px', borderRadius: 'var(--radius-full)', textDecoration: 'none', display: 'flex', alignItems: 'center', fontSize: '12px', fontWeight: 600 }}>Menu &amp; Tables</a>
        <ThemeToggle />
      </div>
    </header>
  );
}
