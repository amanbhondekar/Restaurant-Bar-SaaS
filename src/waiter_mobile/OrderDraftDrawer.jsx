import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Send, Trash2, Edit3, Wifi, Armchair, Zap, AlertTriangle, Loader } from 'lucide-react';
import { VegBadge } from '../components/VegBadge';
import { motion } from 'framer-motion';

export const OrderDraftDrawer = ({ selectedTableId, draftItems, onRemoveItem, onClearDraft, hubUrl, hubConnected }) => {
  const { menu, tables, currentRestaurant } = usePos();
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [sentTicket, setSentTicket] = useState(null);
  const [sendError, setSendError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const currency = currentRestaurant?.currency || '₹';
  const table = tables.find(t => t.id === selectedTableId);
  const draftMenu = Object.entries(draftItems)
    .map(([id, qty]) => {
      const item = menu.find(m => m.id === id);
      return item ? { ...item, qty } : null;
    })
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
      items: draftMenu.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.price })),
      note: note.trim(),
      created_by_waiter: 'Waiter Handset (PWA)'
    };

    try {
      const res = await fetch(`${targetHub}/orders`, {
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
            <span style={{
              background: 'var(--color-primary)', color: 'var(--color-on-primary)',
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
          {draftMenu.map(item => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                <VegBadge isVeg={item.isVeg} size={8} />
                <span className="typography-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.qty > 1 && <span style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', marginRight: '4px', fontWeight: 700 }}>{item.qty}×</span>}
                  {item.name}
                </span>
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-ink)', fontWeight: 700, flexShrink: 0 }}>
                {currency}{item.price * item.qty}
              </span>
            </div>
          ))}

          {/* Subtotal Display (Single loud rating-display moment for mobile drawer total) */}
          <div style={{ borderTop: '1px solid var(--color-hairline)', marginTop: '8px', paddingTop: '12px', textAlign: 'center' }}>
            <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginBottom: '2px' }}>Order Total</div>
            <div className="typography-rating-display" style={{ color: 'var(--color-primary)' }}>
              {currency}{subtotal}
            </div>
          </div>

          {/* Kitchen Note */}
          <div style={{ marginTop: '4px' }}>
            <div className="typography-badge" style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)', marginBottom: 'var(--spacing-xs)', color: 'var(--color-muted)' }}>
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
            <div className="typography-badge" style={{ color: 'var(--color-error-text)', marginTop: 'var(--spacing-xs)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-xs)' }}>
              <AlertTriangle size={12} style={{ flexShrink: 0 }} /> {sendError}
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
            {isSubmitting ? <><Loader size={14} className="spin" /> Sending to Kitchen...</> : (hubConnected ? 'Send to Kitchen KDS (LAN)' : 'Not Connected to Hub')}
          </motion.button>
        </div>
      )}
    </div>
  );
};

