import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';

export function PrintPreview({ bill }) {
  const {
    printPreview,
    setPrintPreview
  } = bill;

  return (
    <AnimatePresence>
                {printPreview && (
                  <motion.div
                    key="print-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    onClick={() => setPrintPreview(null)}
                    style={{
                      position: 'fixed', inset: 0, background: 'rgba(15, 15, 15, 0.65)',
                      zIndex: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
                    }}
                  >
                    <motion.div
                      key="print-card"
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        background: '#ffffff', borderRadius: 'var(--radius-md)', width: '100%',
                        maxWidth: '520px', border: '1px solid var(--color-hairline)',
                        boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
                        display: 'flex', flexDirection: 'column', maxHeight: '85vh'
                      }}
                    >
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '12px 16px', borderBottom: '1px solid var(--color-hairline)'
                      }}>
                        <div>
                          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '15px', color: 'var(--color-ink)' }}>
                            {printPreview.title}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                            {printPreview.status === 'sent' && '✓ Sent to printer'}
                            {printPreview.status === 'preview' && '👁 Preview only · no printer configured'}
                            {printPreview.status === 'error' && `✕ Printer error: ${printPreview.error}`}
                          </div>
                        </div>
                        <button
                          onClick={() => setPrintPreview(null)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 4 }}
                        >
                          <X size={18} />
                        </button>
                      </div>
                      <pre style={{
                        margin: 0, padding: '14px 16px', overflow: 'auto',
                        fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.35,
                        color: 'var(--color-ink)', background: 'var(--color-surface-soft)',
                        whiteSpace: 'pre'
                      }}>
    {printPreview.text || '(nothing to preview)'}
                      </pre>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
  );
}
