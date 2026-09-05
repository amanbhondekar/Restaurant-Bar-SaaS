import React, { useState, useEffect } from 'react';
import { usePos } from '../context/PosContext';
import { ChefHat, Clock, CheckCircle2, AlertCircle, Flame, Timer } from 'lucide-react';

const DEFAULT_URGENT_MINS = 12;

const Ticker = ({ isoTime, urgentMins = DEFAULT_URGENT_MINS }) => {
  const [elapsed, setElapsed] = useState('0s');
  const [mins, setMins] = useState(0);

  useEffect(() => {
    const update = () => {
      const s = Math.max(0, Math.floor((Date.now() - new Date(isoTime)) / 1000));
      const m = Math.floor(s / 60);
      setMins(m);
      if (s < 60) setElapsed(`${s}s`);
      else setElapsed(`${m}m ${s % 60}s`);
    };
    update();
    const i = setInterval(update, 1000);
    return () => clearInterval(i);
  }, [isoTime]);

  const warnMins = Math.floor(urgentMins * 0.67);
  const urgent = mins >= urgentMins;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '5px',
      fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700,
      color: urgent ? 'var(--status-rust-text)' : mins >= warnMins ? 'var(--status-amber-text)' : 'var(--status-green-text)',
    }}>
      {urgent ? <Flame size={14} /> : <Timer size={14} />}
      {elapsed}
    </div>
  );
};

// Section 6.2 Skeleton Screen Loader for KDS Ticket Rail
export const KdsTicketSkeleton = () => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '20px' }}>
    {[1, 2, 3].map(i => (
      <div key={i} className="skeleton skeleton-card" style={{ height: '240px', borderRadius: 'var(--radius-md)' }} />
    ))}
  </div>
);

export const KitchenKdsView = ({ isLoading = false }) => {
  const { tickets, markTicketReady, cloudQueue, currentRestaurant } = usePos();
  const currency = currentRestaurant?.currency || '₹';
  const [checkedItems, setCheckedItems] = useState({});

  const activeTickets = tickets.filter(t => t.status === 'in_progress');
  const readyTickets  = tickets.filter(t => t.status === 'ready');

  const toggleCheck = (ticketId, itemIdx) => {
    const key = `${ticketId}_${itemIdx}`;
    setCheckedItems(p => ({ ...p, [key]: !p[key] }));
  };

  const allItemsChecked = (ticket) =>
    ticket.items.every((_, idx) => checkedItems[`${ticket.id}_${idx}`]);

  if (isLoading) {
    return <KdsTicketSkeleton />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 className="typography-display-xl" style={{ color: 'var(--color-ink)' }}>Kitchen Display System</h1>
          <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '2px' }}>
            Live KOT Queue · Instant Scoped LAN Sync
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{
            background: 'var(--status-rust-bg)', border: '1px solid var(--status-rust-border)',
            borderRadius: 'var(--radius-sm)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px'
          }}>
            <Flame size={20} style={{ color: 'var(--status-rust-text)' }} />
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '22px', fontWeight: 700, color: 'var(--status-rust-text)', lineHeight: 1 }}>{activeTickets.length}</div>
              <div className="typography-uppercase-tag" style={{ color: 'var(--status-rust-text)', marginTop: '2px' }}>Active KOTs</div>
            </div>
          </div>

          <div style={{
            background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)',
            borderRadius: 'var(--radius-sm)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px'
          }}>
            <CheckCircle2 size={20} style={{ color: 'var(--status-green-text)' }} />
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '22px', fontWeight: 700, color: 'var(--status-green-text)', lineHeight: 1 }}>{readyTickets.length}</div>
              <div className="typography-uppercase-tag" style={{ color: 'var(--status-green-text)', marginTop: '2px' }}>Ready to Serve</div>
            </div>
          </div>

          {cloudQueue.length > 0 && (
            <div style={{
              background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)',
              borderRadius: 'var(--radius-sm)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px'
            }}>
              <AlertCircle size={20} style={{ color: 'var(--status-amber-text)' }} />
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '22px', fontWeight: 700, color: 'var(--status-amber-text)', lineHeight: 1 }}>{cloudQueue.length}</div>
                <div className="typography-uppercase-tag" style={{ color: 'var(--status-amber-text)', marginTop: '2px' }}>Offline Queue</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Active KOT Ticket Rail */}
      {activeTickets.length === 0 ? (
        <div style={{
          border: '1px dashed var(--color-hairline)', borderRadius: 'var(--radius-md)', padding: '64px 24px',
          textAlign: 'center', color: 'var(--color-muted)', background: 'var(--color-canvas)'
        }}>
          <ChefHat size={36} style={{ marginBottom: '12px', color: 'var(--color-muted-soft)' }} />
          <div className="typography-display-sm" style={{ color: 'var(--color-ink)' }}>Kitchen is Clear</div>
          <div className="typography-body-sm" style={{ marginTop: '4px' }}>New orders from waiters will appear here instantly via LAN</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '20px', alignItems: 'start' }}>
          {activeTickets.map(ticket => {
            const canMark = allItemsChecked(ticket);
            return (
              <div key={ticket.id} className="kds-ticket">
                <div className="ticket-inner">
                  {/* Ticket Header */}
                  <div style={{ borderBottom: '1px solid var(--color-hairline)', paddingBottom: '12px', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>
                          KOT Ticket #{ticket.id}
                        </span>
                        <div className="typography-display-sm" style={{ color: 'var(--color-ink)', marginTop: '2px' }}>
                          {ticket.tableName}
                        </div>
                      </div>
                      <Ticker isoTime={ticket.time} />
                    </div>
                  </div>

                  {/* Items */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
                    {ticket.items.map((item, idx) => {
                      const isChecked = !!checkedItems[`${ticket.id}_${idx}`];
                      return (
                        <div
                          key={idx}
                          onClick={() => toggleCheck(ticket.id, idx)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '10px',
                            cursor: 'pointer', userSelect: 'none',
                            opacity: isChecked ? 0.4 : 1,
                            textDecoration: isChecked ? 'line-through' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <div style={{
                            width: '18px', height: '18px', borderRadius: 'var(--radius-xs)', flexShrink: 0,
                            border: `1.5px solid ${isChecked ? 'var(--status-green-text)' : 'var(--color-hairline)'}`,
                            background: isChecked ? 'var(--status-green-text)' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all 0.15s ease'
                          }}>
                            {isChecked && <span style={{ fontSize: '11px', color: '#ffffff', fontWeight: 700 }}>✓</span>}
                          </div>
                          <span className="typography-body-sm" style={{ fontWeight: 500, color: 'var(--color-ink)' }}>
                            {item.qty > 1 && <span style={{ color: 'var(--color-primary)', fontWeight: 700 }}>{item.qty}× </span>}
                            {item.name}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Note */}
                  {ticket.note && (
                    <div style={{
                      background: 'var(--color-surface-soft)', borderRadius: 'var(--radius-xs)', padding: '8px 10px',
                      fontSize: '12px', color: 'var(--color-body)', fontStyle: 'italic',
                      borderLeft: '3px solid var(--color-primary)', marginBottom: '14px'
                    }}>
                      📝 {ticket.note}
                    </div>
                  )}

                  {/* Total + Mark Ready */}
                  <div style={{ borderTop: '1px solid var(--color-hairline)', paddingTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 700, color: 'var(--color-ink)' }}>
                      {currency}{ticket.items.reduce((s,i) => s + i.price * i.qty, 0)}
                    </span>
                    <button
                      onClick={() => markTicketReady(ticket.id, ticket.tableId)}
                      disabled={!canMark}
                      className="typography-button-sm"
                      style={{
                        padding: '8px 14px', borderRadius: 'var(--radius-sm)',
                        background: canMark ? 'var(--status-green-text)' : 'var(--color-surface-soft)',
                        color: canMark ? '#ffffff' : 'var(--color-muted)',
                        cursor: canMark ? 'pointer' : 'not-allowed',
                        border: 'none', transition: 'all 0.15s ease',
                      }}
                    >
                      {canMark ? '✓ Mark Ready' : 'Tick All Items'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Ready Tickets Strip */}
      {readyTickets.length > 0 && (
        <div>
          <div className="typography-display-sm" style={{ color: 'var(--status-green-text)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={18} /> Ready to Serve ({readyTickets.length})
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {readyTickets.map(t => (
              <div key={t.id} style={{
                background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)',
                borderRadius: 'var(--radius-md)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px'
              }}>
                <CheckCircle2 size={18} style={{ color: 'var(--status-green-text)' }} />
                <div>
                  <div className="typography-title-md" style={{ color: 'var(--status-green-text)' }}>{t.tableName}</div>
                  <div className="typography-body-sm" style={{ fontSize: '12px', color: 'var(--color-muted)', marginTop: '2px' }}>
                    {t.items.reduce((s,i) => s+i.qty, 0)} items · {currency}{t.items.reduce((s,i) => s+i.price*i.qty, 0)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
