import React, { useRef, useState } from 'react';
import { usePos } from '../context/PosContext';
import { Send, Trash2, Edit3, Wifi, Armchair, Zap, AlertTriangle, Loader } from 'lucide-react';
import { VegBadge } from '../components/VegBadge';
import { motion } from 'framer-motion';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { authFetch } from '../services/hubAuth';

export const OrderDraftDrawer = ({ selectedTableId, draftItems, onRemoveItem, onClearDraft, hubUrl, hubConnected, waiter = null }) => {
  const { menu, tables, currentRestaurant } = usePos();
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [sentTicket, setSentTicket] = useState(null);
  const [sendError, setSendError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lastAttempt = useRef(null); // { key, id } of the order last sent and not yet answered

  const currency = currentRestaurant?.currency || '₹';
  const table = tables.find(t => t.id === selectedTableId);
  // M2 · PR 11 variants: draftItems is now `{ [lineKey]: { item_id, variant_id?,
  // variant_label?, name, price, isVeg, qty } }`. Just iterate values — each
  // row already carries the resolved variant display + price at add-time.
  const draftMenu = Object.entries(draftItems)
    .map(([lineKey, row]) => (row ? { lineKey, ...row } : null))
    .filter(Boolean);

  const subtotal = draftMenu.reduce((s, i) => s + i.price * i.qty, 0);
  const hasItems = draftMenu.length > 0;

  // Serve in courses: starters first, mains and desserts held until the waiter fires them. Offered only
  // when the order really spans more than one course (each menu item carries its course).
  const [courseService, setCourseService] = useState(false);
  const courseOfRow = row => Math.max(1, Math.floor(Number(menu.find(m => String(m.id) === String(row.item_id))?.course)) || 1);
  const distinctCourses = [...new Set(draftMenu.map(courseOfRow))].sort((a, b) => a - b);
  const canStageCourses = distinctCourses.length > 1;

  const handleSend = async () => {
    if (!hasItems || !selectedTableId || isSubmitting || !hubConnected) return;
    setSendError('');
    setIsSubmitting(true);

    const targetHub = (hubUrl || 'http://localhost:4000').replace(/\/+$/, '');

    const orderBody = {
      table_id: selectedTableId,
      table_name: table ? table.name : `Table ${selectedTableId}`,
      items: draftMenu.map(i => ({
        id: i.item_id,
        name: i.name,
        qty: i.qty,
        price: i.price,
        // Server ignores handset-supplied prices and re-prices from its own menu
        // cache; variant_id + modifiers[].{group_id, option_id} are the only
        // routing bits reception can't fake. Modifier labels and price_delta
        // arrive back on the response and are ignored on the way out.
        ...(i.variant_id ? { variant_id: i.variant_id } : {}),
        ...(Array.isArray(i.modifiers) && i.modifiers.length > 0
          ? { modifiers: i.modifiers.map(m => ({ group_id: m.group_id, option_id: m.option_id })) }
          : {})
      })),
      note: note.trim(),
      ...(courseService && canStageCourses ? { course_service: true } : {}),
      // Server ignores this string and stamps waiter.name from waiter_id, so
      // the value here is only a display fallback.
      created_by_waiter: waiter?.name ? `${waiter.name} (PWA)` : 'Waiter Handset (PWA)',
      waiter_id: waiter?.id || undefined
    };

    // The hub remembers a request id for a minute and answers a repeat with the ticket it already made, so a
    // waiter whose reply was lost on the WiFi cannot double-order by tapping again -- but only if the retry
    // carries the SAME id. So an order keeps its id until it is answered; a draft that has changed since is a
    // different order and gets a new one.
    const key = JSON.stringify(orderBody);
    const orderRequestId = lastAttempt.current?.key === key
      ? lastAttempt.current.id
      : 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    lastAttempt.current = { key, id: orderRequestId };
    const orderPayload = { order_request_id: orderRequestId, ...orderBody };

    try {
      const res = await authFetch(`${targetHub}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload)
      });

      if (res.ok) {
        const data = await res.json();
        lastAttempt.current = null;   // answered: the next order is a new one
        setSentTicket(data.ticket);
        setSent(true);
        onClearDraft();
        setNote('');
        setCourseService(false);
        if (navigator.vibrate) navigator.vibrate(200);
        setTimeout(() => {
          setSent(false);
          setSentTicket(null);
        }, 3000);
        return;
      } else {
        const errData = await res.json().catch(() => ({}));
        setSendError(errData.error || 'Failed to post order to hub.');
      }
    } catch (err) {
      setSendError(`Hub unreachable at ${targetHub}. Check WiFi network.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!selectedTableId) {
    return (
      <div style={{
        textAlign: 'center', padding: '24px 16px', color: 'var(--color-muted)', fontSize: '13px',
        border: '1px dashed var(--color-hairline)', borderRadius: 'var(--radius-md)',
        background: 'var(--color-canvas)', animation: 'fadeIn 0.3s ease'
      }}>
        <Armchair size={28} style={{ color: 'var(--color-muted)', marginBottom: '6px' }} />
        <div style={{ fontWeight: 600, color: 'var(--color-ink)', marginBottom: '4px' }}>No table selected</div>
        <div className="typography-body-sm">Tap any table above to start an order for {currentRestaurant?.name}</div>
      </div>
    );
  }

  if (sent) {
    return (
      <div style={{
        textAlign: 'center', padding: '24px 16px',
        background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)',
        borderRadius: 'var(--radius-md)', animation: 'slideInUp 0.3s ease'
      }}>
        <Zap size={28} style={{ color: 'var(--status-green-text)', marginBottom: '6px' }} />
        <div style={{ fontWeight: 700, color: 'var(--status-green-text)', fontSize: '16px', fontFamily: 'var(--font-display)', marginBottom: '4px' }}>
          Ticket #{sentTicket?.ticket_number || ''} Pushed to Kitchen!
        </div>
        <div className="typography-body-sm" style={{ color: 'var(--color-muted)' }}>
          Delivered over LAN WiFi to Kitchen Display in &lt; 1s.
        </div>
      </div>
    );
  }


  return (
    <div style={{
      background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)',
      borderRadius: 'var(--radius-md)', overflow: 'hidden', animation: 'slideInUp 0.25s ease'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: '1px solid var(--color-hairline)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="typography-title-md" style={{ color: 'var(--color-ink)' }}>
            {table ? `${table.name} Draft Order` : 'Draft Order'}
          </span>
          {hasItems && (
            <Badge>{draftMenu.reduce((s,i) => s+i.qty, 0)} pcs</Badge>
          )}
        </div>
        {hasItems && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => { if (window.confirm('Clear all items from this draft?')) onClearDraft(); }}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 />
          </Button>
        )}
      </div>

      {/* Items */}
      {!hasItems ? (
        <div className="typography-body-sm" style={{ padding: '18px', textAlign: 'center', color: 'var(--color-muted)' }}>
          Go to <strong style={{ color: 'var(--color-ink)' }}>Menu</strong> tab and add items
        </div>
      ) : (
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {draftMenu.map(item => {
            const mods = Array.isArray(item.modifiers) ? item.modifiers : [];
            return (
              <div key={item.lineKey || item.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                    <VegBadge isVeg={item.isVeg} size={8} />
                    <span className="typography-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.qty > 1 && <span style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', marginRight: '4px', fontWeight: 700 }}>{item.qty}×</span>}
                      {item.name}
                      {item.variant_label && (
                        <span style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 500, marginLeft: 4 }}>
                          · {item.variant_label}
                        </span>
                      )}
                      {item.active_day_part && (
                        <Badge variant="outline" className="ml-1.5 text-[9px] font-mono" style={{
                          color: 'var(--status-green-text)', background: 'var(--status-green-bg)',
                          borderColor: 'var(--status-green-border)'
                        }}>
                          {String(item.active_day_part.label).toUpperCase()}
                        </Badge>
                      )}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {mods.length > 0 && (
                      <button
                        onClick={() => onRemoveItem(item.lineKey)}
                        title="Remove one"
                        style={{
                          background: 'transparent', border: 'none', color: 'var(--status-rust-text)',
                          cursor: 'pointer', padding: 0, fontSize: 11, lineHeight: 1
                        }}
                      >
                        −
                      </button>
                    )}
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-ink)', fontWeight: 700 }}>
                      {currency}{item.price * item.qty}
                    </span>
                  </div>
                </div>
                {mods.length > 0 && (
                  <div style={{ paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {mods.map((m, idx) => {
                      const delta = Number(m.price_delta) || 0;
                      return (
                        <div key={idx} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          fontSize: 11, color: 'var(--color-muted)', fontFamily: 'var(--font-body)'
                        }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {delta === 0
                              ? `· ${m.group_label ? m.group_label + ': ' : ''}${m.option_label}`
                              : `+ ${m.option_label}`}
                          </span>
                          {delta !== 0 && (
                            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: delta > 0 ? 'var(--color-primary)' : 'var(--status-green-text)' }}>
                              {delta > 0 ? '+' : '−'}{currency}{Math.abs(delta) * item.qty}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Subtotal Display (Single loud rating-display moment for mobile drawer total) */}
          <div style={{ borderTop: '1px solid var(--color-hairline)', marginTop: '8px', paddingTop: '12px', textAlign: 'center' }}>
            <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginBottom: '2px' }}>Order Total</div>
            <div className="typography-rating-display" style={{ color: 'var(--color-primary)' }}>
              {currency}{subtotal}
            </div>
          </div>

          {canStageCourses && (
            <label
              style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginTop: '4px', padding: '10px 12px', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)', background: courseService ? 'var(--status-blue-bg)' : 'var(--color-surface-soft)', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={courseService}
                onChange={e => setCourseService(e.target.checked)}
                style={{ marginTop: '2px', width: '18px', height: '18px', flexShrink: 0 }}
              />
              <span>
                <span className="typography-caption" style={{ color: 'var(--color-ink)', fontWeight: 700 }}>Serve in courses</span>
                <span className="typography-badge" style={{ display: 'block', color: 'var(--color-muted)', marginTop: '2px' }}>
                  Course {distinctCourses[0]} goes to the kitchen now. {distinctCourses.length > 2 ? 'The rest wait' : 'Course ' + distinctCourses[1] + ' waits'} until you fire {distinctCourses.length > 2 ? 'them' : 'it'}.
                </span>
              </span>
            </label>
          )}

          {/* Kitchen Note */}
          <div style={{ marginTop: '4px' }}>
            <div className="typography-badge" style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)', marginBottom: 'var(--spacing-xs)', color: 'var(--color-muted)' }}>
              <Edit3 size={12} /> Kitchen Note
            </div>
            <Input
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Extra spicy, Less oil, Jain prep…"
              className="h-11 text-xs"
            />
          </div>

          {sendError && (
            <div className="typography-badge" style={{ color: 'var(--color-error-text)', marginTop: 'var(--spacing-xs)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <AlertTriangle size={12} style={{ flexShrink: 0 }} /> {sendError}
            </div>
          )}

          {/* Send Button */}
          <Button
            onClick={handleSend}
            disabled={!hasItems || !hubConnected || isSubmitting}
            size="lg"
            className="w-full mt-1.5 h-11"
          >
            {isSubmitting ? <Loader className="animate-spin" /> : <Send />}
            {isSubmitting ? 'Sending to Kitchen...' : (hubConnected ? 'Send to Kitchen KDS (LAN)' : 'Not Connected to Hub')}
          </Button>
        </div>
      )}
    </div>
  );
};

