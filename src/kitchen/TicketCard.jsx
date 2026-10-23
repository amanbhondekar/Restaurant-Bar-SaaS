import { visibleLines, stationStates, heldGroups, STATION_LABEL } from '../lib/ticketView';
import { motion } from 'framer-motion';
import { Check, Loader, Flame, StickyNote, Receipt } from 'lucide-react';

// One ticket on the rail. The ref is passed to the card because the rail animates tickets in and out with AnimatePresence
// in "popLayout" mode, which needs to measure the element it is animating.
export function TicketCard({ ticket, stationFilter, allCheckedFor, shouldReduceMotion, checkedItems, toggleCheck, handleFire, handleStationReady, handleMarkReady, openBill, ref }) {
    const lines = visibleLines(ticket, stationFilter);
    const canMark = allCheckedFor(ticket, lines);
    const states = stationStates(ticket);
    const held = heldGroups(ticket);
    const stationMode = stationFilter !== 'all';
    return (
      <motion.div
        ref={ref}
        layout={!shouldReduceMotion}
        initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -45, scale: 0.94, rotateX: -10 }}
        animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, rotateX: 0 }}
        exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, x: 60, scale: 0.9 }}
        transition={shouldReduceMotion ? { duration: 0.01 } : {
          type: 'spring',
          stiffness: 380,
          damping: 24,
          mass: 0.8
        }}
        style={{
          background: 'var(--color-canvas)',
          border: '1px solid var(--color-hairline)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--spacing-base)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          boxShadow: 'var(--shadow-flat)',
          transformOrigin: 'top center'
        }}
      >
        <div>
          {/* Ticket Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--color-hairline)', paddingBottom: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
            <div>
              <span className="typography-badge" style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
                TICKET #{ticket.ticket_number}
              </span>
              <div className="typography-display-sm" style={{ color: 'var(--color-ink)', marginTop: 'var(--spacing-xxs)' }}>
                {ticket.table_name || 'Table'}
              </div>
            </div>
            <span className="typography-badge" style={{ background: ticket.synced_to_cloud ? 'var(--status-green-bg)' : 'var(--status-amber-bg)', color: ticket.synced_to_cloud ? 'var(--status-green-text)' : 'var(--status-amber-text)', padding: '3px 8px', borderRadius: 'var(--radius-full)', fontFamily: 'var(--font-mono)', border: `1px solid ${ticket.synced_to_cloud ? 'var(--status-green-border)' : 'var(--status-amber-border)'}`, display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              {ticket.synced_to_cloud ? <><Check size={10} /> Synced</> : <><Loader size={10} className="spin" /> Queued</>}
            </span>
          </div>
  
          {/* Where each station stands, and which course this is (shown only when it helps) */}
          {(states.length > 1 || ticket.staged) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: 'var(--spacing-md)' }}>
              {ticket.staged && (
                <span className="typography-badge" style={{ background: 'var(--status-blue-bg)', color: 'var(--status-blue-text)', border: '1px solid var(--status-blue-border)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 700 }}>
                  Course {Math.max(...(ticket.fired_courses || [1]))}
                </span>
              )}
              {states.map(s => (
                <span
                  key={s.station}
                  className="typography-badge"
                  style={{
                    background: s.done ? 'var(--status-green-bg)' : 'var(--status-amber-bg)',
                    color: s.done ? 'var(--status-green-text)' : 'var(--status-amber-text)',
                    border: `1px solid ${s.done ? 'var(--status-green-border)' : 'var(--status-amber-border)'}`,
                    padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px'
                  }}
                >
                  {s.done && <Check size={10} />}{STATION_LABEL[s.station]}
                </span>
              ))}
            </div>
          )}
  
          {/* Items Checklist */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
            {lines.map(({ item, idx }) => {
              const isChecked = !!checkedItems[`${ticket.id}_${idx}`];
              return (
                <div
                  key={idx}
                  onClick={() => toggleCheck(ticket.id, idx)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', cursor: 'pointer',
                    opacity: isChecked ? 0.4 : 1, textDecoration: isChecked ? 'line-through' : 'none'
                  }}
                >
                  <div style={{
                    width: '18px', height: '18px', borderRadius: 'var(--radius-xs)',
                    border: `1.5px solid ${isChecked ? 'var(--status-green-text)' : 'var(--color-hairline)'}`,
                    background: isChecked ? 'var(--status-green-text)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--color-on-primary)', fontSize: '10px', fontWeight: 800
                  }}>
                    {isChecked && <Check size={10} />}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span className="typography-caption" style={{ color: 'var(--color-ink)' }}>
                      {item.qty > 1 && <strong style={{ color: 'var(--color-primary)' }}>{item.qty}× </strong>}
                      {item.name}
                      {item.variant_label && (
                        <span style={{ fontSize: '12px', color: 'var(--color-muted)', fontWeight: 500, marginLeft: 4 }}>
                          · {item.variant_label}
                        </span>
                      )}
                      {item.day_part_label && (
                        <span
                          title={`Billed at ${item.day_part_label}`}
                          style={{
                            fontSize: 10, color: 'var(--status-green-text)', fontFamily: 'var(--font-mono)',
                            background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)',
                            padding: '1px 6px', borderRadius: 'var(--radius-full)', marginLeft: 6, verticalAlign: 'middle'
                          }}
                        >
                          {String(item.day_part_label).toUpperCase()}
                        </span>
                      )}
                      {/* Station routing tag (M2 · PR 15). Only
                          surfaced when the item was explicitly
                          routed off the default hot line, so
                          curries don't get a "HOT" tag on every
                          ticket — only bar drinks and cold-
                          prep items call for a routing note. */}
                      {item.station && item.station !== 'hot' && (
                        <span
                          title={`Fires to ${item.station} station`}
                          style={{
                            fontSize: 10, color: 'var(--color-primary)', fontFamily: 'var(--font-mono)',
                            background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)',
                            padding: '1px 6px', borderRadius: 'var(--radius-full)', marginLeft: 6, verticalAlign: 'middle',
                            fontWeight: 700
                          }}
                        >
                          {String(item.station).toUpperCase()}
                        </span>
                      )}
                    </span>
                    {/* KDS modifier lines (M2 · PR 12). The kitchen
                        sees "· Spice level: Hot" for prep instructions
                        and "+ Extra cheese" for paid extras (delta is
                        priced elsewhere; on the KDS card we highlight
                        what the cook needs to prep). */}
                    {Array.isArray(item.modifiers) && item.modifiers.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 4 }}>
                        {item.modifiers.map((m, mi) => {
                          const delta = Number(m.price_delta) || 0;
                          return (
                            <span key={mi} style={{
                              fontSize: 11,
                              color: delta > 0 ? 'var(--color-primary)' : 'var(--color-muted)',
                              fontWeight: delta > 0 ? 600 : 500
                            }}>
                              {delta === 0
                                ? `· ${m.group_label ? m.group_label + ': ' : ''}${m.option_label}`
                                : `+ ${m.option_label}`}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
  
          {/* Courses held back until someone fires them (hold and fire) */}
          {held.length > 0 && (
            <div style={{ border: '1px dashed var(--color-hairline)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', marginBottom: 'var(--spacing-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', background: 'var(--color-surface-soft)' }}>
              <span className="typography-badge" style={{ color: 'var(--color-muted)' }}>
                On hold: {held.map(h => `course ${h.course} (${h.count})`).join(', ')}
              </span>
              {/* Firing is a front-of-house decision: station screens only show what is held. */}
              {!stationMode && (
                <button
                  onClick={() => handleFire(ticket)}
                  style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)', border: 'none', borderRadius: 'var(--radius-full)', padding: '6px 12px', fontWeight: 700, fontSize: '12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}
                >
                  <Flame size={13} /> Fire course {held[0].course}
                </button>
              )}
            </div>
          )}
  
          {ticket.note && (
            <div className="ticket-note" style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-xs)', marginBottom: 'var(--spacing-md)' }}>
              <StickyNote size={13} style={{ flexShrink: 0, marginTop: '1px' }} /> {ticket.note}
            </div>
          )}
        </div>
  
        {/* Bottom Action */}
        <div style={{ borderTop: '1px solid var(--color-hairline)', paddingTop: 'var(--spacing-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <span className="typography-badge" style={{ color: 'var(--color-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            By {ticket.created_by_waiter || 'Waiter'}
          </span>
          <button
            onClick={() => openBill(ticket.table_id)}
            disabled={!ticket.table_id && ticket.table_id !== 0}
            title={`View bill for ${ticket.table_name || 'this table'}`}
            style={{
              background: 'transparent',
              color: 'var(--color-primary)',
              border: '1px solid var(--color-hairline)',
              padding: '6px 10px',
              borderRadius: 'var(--radius-full)',
              fontWeight: 700,
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <Receipt size={13} /> Bill
          </button>
          <motion.button
            whileTap={shouldReduceMotion || !canMark ? {} : { scale: 0.95 }}
            onClick={() => (stationMode ? handleStationReady(ticket, stationFilter) : handleMarkReady(ticket))}
            disabled={!canMark || lines.length === 0}
            style={{
              background: canMark ? 'var(--status-green-text)' : 'var(--color-surface-soft)',
              color: canMark ? 'var(--color-on-primary)' : 'var(--color-muted)',
              border: `1px solid ${canMark ? 'var(--status-green-border)' : 'var(--color-hairline)'}`, padding: 'var(--spacing-sm) var(--spacing-md)', borderRadius: 'var(--radius-full)',
              fontWeight: 700, fontSize: '13px', cursor: canMark ? 'pointer' : 'not-allowed'
            }}
          >
            {canMark ? <><Check size={14} /> {stationMode ? `${STATION_LABEL[stationFilter]} ready` : 'Mark Ready'}</> : 'Tick All'}
          </motion.button>
        </div>
      </motion.div>
    );
  }
