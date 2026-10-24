import { CheckCircle2, Flame, RotateCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { heldGroups } from '../lib/ticketView';

export function ReadyTickets({ readyTickets, shouldReduceMotion, handleFire, handleRecall }) {
  return (
    readyTickets.length > 0 ? (
      <div style={{ marginTop: 'var(--spacing-xl)' }}>
        <h3 className="typography-title-md" style={{ color: 'var(--status-green-text)', marginBottom: 'var(--spacing-md)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
          <CheckCircle2 size={18} /> Ready to Serve ({readyTickets.length})
        </h3>
        <div style={{ display: 'flex', gap: 'var(--spacing-md)', flexWrap: 'wrap' }}>
          <AnimatePresence>
            {readyTickets.map(t => (
              <motion.div
                key={t.id || t.ticket_number}
                initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                style={{ background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)', padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}
              >
                <CheckCircle2 size={16} style={{ color: 'var(--status-green-text)' }} />
                <div>
                  <strong className="typography-caption" style={{ color: 'var(--color-ink)' }}>{t.table_name || 'Table'}</strong>
                  <div className="typography-badge" style={{ color: 'var(--color-muted)' }}>Ticket #{t.ticket_number} · Ready</div>
                </div>
                {/* Next course goes to the kitchen when the guests are ready; recall puts a mistaken ticket back on the board. */}
                {heldGroups(t).length > 0 && (
                  <button
                    onClick={() => handleFire(t)}
                    style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)', border: 'none', borderRadius: 'var(--radius-full)', padding: '6px 12px', fontWeight: 700, fontSize: '12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}
                  >
                    <Flame size={13} /> Fire course {heldGroups(t)[0].course}
                  </button>
                )}
                <button
                  onClick={() => handleRecall(t)}
                  title="Put this ticket back on the kitchen board"
                  style={{ background: 'transparent', color: 'var(--color-body)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-full)', padding: '6px 10px', fontWeight: 600, fontSize: '12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <RotateCcw size={12} /> Recall
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    ) : null
  );
}
