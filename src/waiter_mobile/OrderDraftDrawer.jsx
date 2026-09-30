import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Send, Trash2, Edit3, Wifi } from 'lucide-react';
import { motion } from 'framer-motion';
import { authFetch } from '../services/hubAuth';

export const OrderDraftDrawer = ({ selectedTableId, draftItems, onRemoveItem, onClearDraft, hubUrl, hubConnected, waiter = null }) => {
  const { menu, tables, currentRestaurant } = usePos();
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [sentTicket, setSentTicket] = useState(null);
  const [sendError, setSendError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const handleSend = async () => {
    if (!hasItems || !selectedTableId || isSubmitting || !hubConnected) return;
    setSendError('');
    setIsSubmitting(true);

    const targetHub = (hubUrl || 'http://localhost:4000').replace(/\/+$/, '');
    const orderRequestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

    const orderPayload = {
      order_request_id: orderRequestId,
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
      // Server ignores this string and stamps waiter.name from waiter_id, so
      // the value here is only a display fallback.
      created_by_waiter: waiter?.name ? `${waiter.name} (PWA)` : 'Waiter Handset (PWA)',
      waiter_id: waiter?.id || undefined
    };

    try {
      const res = await authFetch(`${targetHub}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload)
      });

      if (res.ok) {
        const data = await res.json();
        setSentTicket(data.ticket);
        setSent(true);
        onClearDraft();
        setNote('');
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
        <div style={{ fontSize: '28px', marginBottom: '6px' }}>🪑</div>
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
        <div style={{ fontSize: '28px', marginBottom: '6px' }}>⚡</div>
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
            <span style={{
              background: 'var(--color-primary)', color: '#ffffff',
              fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: '10px',
              padding: '2px 8px', borderRadius: 'var(--radius-full)'
            }}>
              {draftMenu.reduce((s,i) => s+i.qty, 0)} pcs
            </span>
          )}
        </div>
        {hasItems && (
          <button onClick={() => { if (window.confirm('Clear all items from this draft?')) onClearDraft(); }} style={{ color: 'var(--status-rust-text)', background: 'none', border: 'none', cursor: 'pointer' }}>
            <Trash2 size={15} />
          </button>
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
            const canRemove = mods.length === 0 || true; // ± always available from the cart, per-line
            return (
              <div key={item.lineKey} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: '10px', flexShrink: 0 }}>{item.isVeg ? '🟢' : '🔴'}</span>
                    <span className="typography-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.qty > 1 && <span style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', marginRight: '4px', fontWeight: 700 }}>{item.qty}×</span>}
                      {item.name}
                      {item.variant_label && (
                        <span style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 500, marginLeft: 4 }}>
                          · {item.variant_label}
                        </span>
                      )}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {mods.length > 0 && canRemove && (
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
                {/* Modifier sub-lines (M2 · PR 12). Zero-delta prep modifiers
                    ("Spice: Hot") render without a numeric column; paid
                    modifiers ("+ Extra cheese +₹40") show the delta so the
                    customer + reception can reconcile per-unit price. */}
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

          {/* Kitchen Note */}
          <div style={{ marginTop: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', color: 'var(--color-muted)', fontSize: '11px', fontWeight: 500 }}>
              <Edit3 size={12} /> Kitchen Note
            </div>
            <input
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. Extra spicy, Less oil, Jain prep…"
              className="input"
              style={{ height: '44px', fontSize: '12px' }}
            />
          </div>

          {sendError && (
            <div style={{ color: 'var(--color-error-text)', fontSize: '11px', fontWeight: 600, marginTop: '4px' }}>
              ⚠️ {sendError}
            </div>
          )}

          {/* Send Button */}
          <motion.button
            whileTap={!hasItems || !hubConnected || isSubmitting ? {} : { scale: 0.96 }}
            onClick={handleSend}
            disabled={!hasItems || !hubConnected || isSubmitting}
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '6px', opacity: (!hasItems || !hubConnected || isSubmitting) ? 0.5 : 1, cursor: (!hasItems || !hubConnected || isSubmitting) ? 'not-allowed' : 'pointer' }}
          >
            <Send size={16} />
            {isSubmitting ? '⏳ Sending to Kitchen...' : (hubConnected ? 'Send to Kitchen KDS (LAN)' : 'Not Connected to Hub')}
          </motion.button>
        </div>
      )}
    </div>
  );
};

