import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { X, Check, Plus, Minus } from 'lucide-react';

/**
 * Modifier picker for items whose menu row ships `modifier_groups` (M2 · PR 12).
 *
 * Composes on top of the variant flow: reception has already tapped a specific
 * variant row (or a flat item) and that resolved `row` — with `item_id`,
 * `variant_id?`, `variant_label?`, `name`, base `price`, `isVeg` — is what
 * arrives here as `row`. The sheet layers modifier picks on top and emits an
 * enriched row to `onConfirm` that carries `modifiers: [{ group_id,
 * group_label, option_id, option_label, price_delta }]` plus the modifier-
 * adjusted `price` (base + Σ delta) so the cart shows the right number
 * without re-reading the menu.
 *
 * The server is still the pricing authority: it re-prices the same row on
 * `POST /orders` and rejects any drift (see hub_server/lib/pricing.js). The
 * `price` we compute here is display-only — it just makes the cart total
 * feel live while the waiter is composing.
 *
 * UI rules:
 *   - Groups with `min >= 1` show a "Required" chip and block Add-to-cart
 *     until satisfied.
 *   - `max === 1` renders as radio-style single-select.
 *   - `max > 1` renders as toggleable chips; a chip goes disabled (not
 *     hidden) when `max` picks are already made and it isn't one of them.
 *   - Zero-delta options ("Mild", "No onion") don't show a price; positive
 *     deltas show `+₹40`, negative show `−₹20`.
 */
export const ModifierSheet = ({ row, currency = '₹', onConfirm, onClose }) => {
  const groups = Array.isArray(row?.modifier_groups) ? row.modifier_groups : [];

  // Picks are keyed by group_id → array of option_id. Radio groups just hold
  // a single-element array; multi-select groups hold up to `group.max`.
  const [picks, setPicks] = useState(() => {
    const seed = {};
    for (const g of groups) seed[g.id] = [];
    return seed;
  });

  const toggle = (group, optionId) => {
    setPicks(prev => {
      const current = prev[group.id] || [];
      const max = Number(group.max) || 1;
      // Radio single-select: replace.
      if (max === 1) {
        return { ...prev, [group.id]: current[0] === optionId ? [] : [optionId] };
      }
      // Multi-select checkbox: toggle in/out, honouring max.
      if (current.includes(optionId)) {
        return { ...prev, [group.id]: current.filter(id => id !== optionId) };
      }
      if (current.length >= max) return prev; // click ignored past max
      return { ...prev, [group.id]: [...current, optionId] };
    });
  };

  const missingRequired = useMemo(
    () => groups.filter(g => Number(g.min) >= 1 && (picks[g.id]?.length || 0) < Number(g.min)),
    [groups, picks]
  );
  const canConfirm = missingRequired.length === 0;

  // Modifier delta preview so the "Add" button shows the actual per-unit price.
  const modifierDelta = useMemo(() => {
    let delta = 0;
    for (const g of groups) {
      const picked = picks[g.id] || [];
      for (const optId of picked) {
        const opt = g.options.find(o => o.id === optId);
        if (opt && Number.isFinite(Number(opt.price_delta))) delta += Number(opt.price_delta);
      }
    }
    return delta;
  }, [groups, picks]);

  const basePrice = Number(row?.price) || 0;
  const finalPrice = Math.round((basePrice + modifierDelta) * 100) / 100;

  const handleConfirm = () => {
    if (!canConfirm) return;
    const resolved = [];
    for (const g of groups) {
      for (const optId of picks[g.id] || []) {
        const opt = g.options.find(o => o.id === optId);
        if (!opt) continue;
        resolved.push({
          group_id: g.id,
          group_label: g.label,
          option_id: opt.id,
          option_label: opt.label,
          price_delta: Number(opt.price_delta) || 0
        });
      }
    }
    onConfirm({
      ...row,
      price: finalPrice,      // per-unit price for the cart
      modifiers: resolved
    });
  };

  return (
    <div
      className="modal-overlay"
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)'
      }}
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.2 }}
        onClick={e => e.stopPropagation()}
        className="modal-content"
        style={{
          width: '100%', maxWidth: '520px',
          maxHeight: '85vh',
          display: 'flex', flexDirection: 'column',
          borderTopLeftRadius: 'var(--radius-md)',
          borderTopRightRadius: 'var(--radius-md)',
          borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
          background: 'var(--color-canvas)',
          borderTop: '1px solid var(--color-hairline)',
          padding: 0, overflow: 'hidden',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)'
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--color-hairline)', flexShrink: 0
        }}>
          <div style={{ minWidth: 0 }}>
            <div className="typography-title-md" style={{ color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row?.name}
              {row?.variant_label && (
                <span style={{ fontSize: '13px', color: 'var(--color-muted)', fontWeight: 500, marginLeft: 6 }}>
                  · {row.variant_label}
                </span>
              )}
            </div>
            <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: 2, fontSize: '11px' }}>
              Customize this dish
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none', color: 'var(--color-muted)',
              cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable groups */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {groups.map(group => {
            const picked = picks[group.id] || [];
            const required = Number(group.min) >= 1;
            const max = Number(group.max) || 1;
            const isSingle = max === 1;
            const atMax = picked.length >= max;
            return (
              <div key={group.id}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                  <div className="typography-uppercase-tag" style={{ color: 'var(--color-ink)', fontSize: '11px' }}>
                    {group.label}
                  </div>
                  {required ? (
                    <span style={{
                      fontSize: '10px', fontWeight: 700, color: 'var(--color-primary)',
                      background: 'var(--status-amber-bg)',
                      padding: '1px 6px', borderRadius: 'var(--radius-full)',
                      border: '1px solid var(--status-amber-border)',
                      fontFamily: 'var(--font-mono)'
                    }}>
                      REQUIRED
                    </span>
                  ) : (
                    <span style={{ fontSize: '10px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
                      {max > 1 ? `up to ${max}` : 'optional'}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {group.options.map(opt => {
                    const isPicked = picked.includes(opt.id);
                    const disabled = !isPicked && !isSingle && atMax;
                    const delta = Number(opt.price_delta) || 0;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => !disabled && toggle(group, opt.id)}
                        disabled={disabled}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '10px 14px',
                          borderRadius: 'var(--radius-sm)',
                          background: isPicked ? 'var(--status-amber-bg)' : 'var(--color-canvas)',
                          border: `1px solid ${isPicked ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                          color: 'var(--color-ink)',
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled ? 0.45 : 1,
                          textAlign: 'left'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{
                            width: 18, height: 18,
                            borderRadius: isSingle ? '50%' : '4px',
                            border: `1.5px solid ${isPicked ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                            background: isPicked ? 'var(--color-primary)' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: '#fff', flexShrink: 0
                          }}>
                            {isPicked && <Check size={12} strokeWidth={3} />}
                          </div>
                          <span style={{ fontSize: 13, fontWeight: isPicked ? 600 : 500 }}>{opt.label}</span>
                        </div>
                        {delta !== 0 && (
                          <span style={{
                            fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
                            color: delta > 0 ? 'var(--color-primary)' : 'var(--status-green-text)'
                          }}>
                            {delta > 0 ? '+' : '−'}{currency}{Math.abs(delta)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer: running per-unit total + Add */}
        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--color-hairline)',
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
          background: 'var(--color-canvas)'
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
              Per unit
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-ink)', fontFamily: 'var(--font-display)' }}>
              {currency}{finalPrice}
              {modifierDelta !== 0 && (
                <span style={{ fontSize: 11, color: 'var(--color-muted)', marginLeft: 6, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                  ({currency}{basePrice} {modifierDelta > 0 ? '+' : '−'} {currency}{Math.abs(modifierDelta)})
                </span>
              )}
            </div>
          </div>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="btn btn-primary"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 18px',
              opacity: canConfirm ? 1 : 0.5,
              cursor: canConfirm ? 'pointer' : 'not-allowed'
            }}
          >
            <Plus size={16} />
            {canConfirm ? 'Add to cart' : `Pick ${missingRequired[0]?.label || 'options'}`}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
