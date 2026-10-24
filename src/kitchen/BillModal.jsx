import { AnimatePresence, motion } from 'framer-motion';
import { Receipt, X, RefreshCw } from 'lucide-react';

export function BillModal({ bill }) {
  const {
    billTableId,
    closeBill,
    billInvoice,
    billLoading,
    billError,
    billAdjustments,
    setBillAdjustments,
    printReceipt,
    refundInvoice,
    paymentRef,
    setPaymentRef,
    markPaid,
    splitBySeats,
    openAmountSplit,
    amountSplitDraft,
    itemSplitDraft,
    openItemSplit,
    setItemSplitDraft,
    closeItemSplit,
    submitItemSplit,
    setAmountSplitDraft,
    closeAmountSplit,
    submitAmountSplit,
    voidInvoice,
    unsplitInvoice,
    markSplitPaid,
    commitBill
  } = bill;

  return (
    <AnimatePresence>
      {billTableId !== null && (
        <motion.div
          key="bill-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={closeBill}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15, 15, 15, 0.55)',
            zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
          }}
        >
          <motion.div
            key="bill-card"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#ffffff', borderRadius: 'var(--radius-md)', width: '100%', maxWidth: '440px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.22)', border: '1px solid var(--color-hairline)',
              overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '90vh'
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 18px', borderBottom: '1px solid var(--color-hairline)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Receipt size={18} style={{ color: 'var(--color-primary)' }} />
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '16px', color: 'var(--color-ink)' }}>
                    Bill Preview
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
                    {billInvoice?.table_name || `Table ${billTableId}`} · not yet issued
                  </div>
                </div>
              </div>
              <button
                onClick={closeBill}
                style={{ background: 'transparent', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 4 }}
                aria-label="Close bill preview"
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ overflowY: 'auto', padding: '16px 18px' }}>
              {billLoading && (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-muted)', fontSize: '13px' }}>
                  <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite', display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />
                  Fetching latest bill from hub…
                </div>
              )}

              {billError && !billLoading && (
                <div style={{
                  background: 'var(--status-rust-bg)', color: 'var(--status-rust-text)',
                  border: '1px solid var(--status-rust-border)', padding: '10px 12px', borderRadius: '8px',
                  fontSize: '13px'
                }}>
                  {billError}
                </div>
              )}

              {billInvoice && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px', opacity: billLoading ? 0.55 : 1, transition: 'opacity 0.15s ease' }}>
                    {billInvoice.items.map((line, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: '13px', color: 'var(--color-ink)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <span style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', marginRight: 6, fontWeight: 700 }}>
                              {line.qty}×
                            </span>
                            {line.name}
                            {line.variant_label && (
                              <span style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 500, marginLeft: 6 }}>
                                · {line.variant_label}
                              </span>
                            )}
                            {line.day_part_label && (
                              <span
                                title={`Billed at ${line.day_part_label}`}
                                style={{
                                  fontSize: 9, color: 'var(--status-green-text)', fontFamily: 'var(--font-mono)',
                                  background: 'var(--status-green-bg)', border: '1px solid var(--status-green-border)',
                                  padding: '1px 5px', borderRadius: 'var(--radius-full)', marginLeft: 6, verticalAlign: 'middle'
                                }}
                              >
                                {String(line.day_part_label).toUpperCase()}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                            #{line.ticket_number} · {billInvoice.currency}{line.price} each
                          </div>
                          {/* Modifier detail on the bill preview (M2 · PR 12).
                              Zero-delta prep lines describe how the dish was
                              prepared; positive deltas surface the paid extra
                              with its per-unit contribution so reception can
                              explain the line to the guest. */}
                          {Array.isArray(line.modifiers) && line.modifiers.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2, paddingLeft: 4 }}>
                              {line.modifiers.map((m, mi) => {
                                const delta = Number(m.price_delta) || 0;
                                return (
                                  <div key={mi} style={{
                                    fontSize: 10, color: 'var(--color-muted)',
                                    display: 'flex', justifyContent: 'space-between', gap: 6
                                  }}>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {delta === 0
                                        ? `· ${m.group_label ? m.group_label + ': ' : ''}${m.option_label}`
                                        : `+ ${m.option_label}`}
                                    </span>
                                    {delta !== 0 && (
                                      <span style={{ fontFamily: 'var(--font-mono)', color: delta > 0 ? 'var(--color-primary)' : 'var(--status-green-text)' }}>
                                        {delta > 0 ? '+' : '−'}{billInvoice.currency}{Math.abs(delta)} × {line.qty}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, color: 'var(--color-ink)' }}>
                          {billInvoice.currency}{line.line_total}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Adjustment controls */}
                  {!billInvoice.invoice_number && (
                    <div style={{
                      borderTop: '1px dashed var(--color-hairline)', paddingTop: '10px', marginBottom: '8px',
                      display: 'flex', flexDirection: 'column', gap: '8px'
                    }}>
                      <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                        Bill adjustments
                      </div>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <select
                          value={billAdjustments.discount_type}
                          onChange={e => setBillAdjustments(a => ({ ...a, discount_type: e.target.value }))}
                          style={{
                            padding: '6px 8px', fontSize: '12px', border: '1px solid var(--color-hairline)',
                            borderRadius: 'var(--radius-xs)', background: '#fff', color: 'var(--color-ink)'
                          }}
                        >
                          <option value="percent">Discount %</option>
                          <option value="flat">Discount ₹</option>
                        </select>
                        <input
                          type="number"
                          min="0"
                          step={billAdjustments.discount_type === 'percent' ? '1' : '10'}
                          placeholder="0"
                          value={billAdjustments.discount_value}
                          onChange={e => setBillAdjustments(a => ({ ...a, discount_value: e.target.value }))}
                          style={{
                            width: '80px', padding: '6px 8px', fontSize: '12px', fontFamily: 'var(--font-mono)',
                            border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                          }}
                        />
                        <input
                          type="text"
                          placeholder="Reason (optional)"
                          value={billAdjustments.discount_reason}
                          onChange={e => setBillAdjustments(a => ({ ...a, discount_reason: e.target.value }))}
                          style={{
                            flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px',
                            border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                          }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <label style={{ fontSize: '12px', color: 'var(--color-muted)', flexShrink: 0 }}>Service charge</label>
                        <input
                          type="number"
                          min="0"
                          max="25"
                          step="0.5"
                          placeholder="0"
                          value={billAdjustments.service_charge_percent}
                          onChange={e => setBillAdjustments(a => ({ ...a, service_charge_percent: e.target.value }))}
                          style={{
                            width: '70px', padding: '6px 8px', fontSize: '12px', fontFamily: 'var(--font-mono)',
                            border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                          }}
                        />
                        <span style={{ fontSize: '12px', color: 'var(--color-muted)' }}>%</span>
                      </div>
                    </div>
                  )}

                  <div style={{ borderTop: '1px dashed var(--color-hairline)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'var(--color-muted)' }}>
                      <span>Subtotal</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-ink)' }}>{billInvoice.currency}{billInvoice.subtotal}</span>
                    </div>
                    {billInvoice.discount_rows && billInvoice.discount_rows.map((row, idx) => (
                      <div key={`d${idx}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--status-green-text)' }}>
                        <span>
                          Discount{row.type === 'percent' ? ` (${row.value}%)` : ''}
                          {row.reason ? ` · ${row.reason}` : ''}
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>−{billInvoice.currency}{row.amount}</span>
                      </div>
                    ))}
                    {billInvoice.service_charge_amount > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--color-muted)' }}>
                        <span>Service charge ({billInvoice.service_charge_percent}%)</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{billInvoice.currency}{billInvoice.service_charge_amount}</span>
                      </div>
                    )}
                    {billInvoice.tax_rows.map((row, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--color-muted)' }}>
                        <span>{row.label} ({row.rate_percent}%)</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{billInvoice.currency}{row.amount}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{
                    marginTop: '12px', borderTop: '1px solid var(--color-hairline)', paddingTop: '12px',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'
                  }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--color-ink)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Grand Total
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '22px', fontWeight: 800, color: 'var(--color-primary)' }}>
                      {billInvoice.currency}{billInvoice.grand_total}
                    </span>
                  </div>

                  {billInvoice.invoice_number ? (
                    <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div style={{
                        background: billInvoice.payment_status === 'paid'
                          ? 'var(--status-green-bg)'
                          : billInvoice.payment_status === 'voided'
                          ? 'var(--status-rust-bg)'
                          : 'var(--status-amber-bg)',
                        border: `1px solid ${
                          billInvoice.payment_status === 'paid'
                            ? 'var(--status-green-border)'
                            : billInvoice.payment_status === 'voided'
                            ? 'var(--status-rust-border)'
                            : 'var(--status-amber-border)'
                        }`,
                        color: billInvoice.payment_status === 'paid'
                          ? 'var(--status-green-text)'
                          : billInvoice.payment_status === 'voided'
                          ? 'var(--status-rust-text)'
                          : 'var(--status-amber-text)',
                        padding: '10px 12px', borderRadius: '8px',
                        fontSize: '13px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700
                      }}>
                        {billInvoice.payment_status === 'paid' && `✓ ${billInvoice.invoice_number} · Paid · ${billInvoice.payment_method?.toUpperCase()}`}
                        {billInvoice.payment_status === 'voided' && `✕ ${billInvoice.invoice_number} · Voided`}
                        {billInvoice.payment_status === 'refunded' && `↩ ${billInvoice.invoice_number} · Refunded`}
                        {billInvoice.payment_status === 'pending' && `⏳ ${billInvoice.invoice_number} · Awaiting payment`}
                      </div>

                      {billInvoice.payment_status === 'paid' && billInvoice.payment_ref && (
                        <div style={{ fontSize: '11px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                          Ref: {billInvoice.payment_ref}
                        </div>
                      )}

                      {(billInvoice.payment_status === 'paid' || billInvoice.payment_status === 'refunded') && (
                        <button
                          onClick={printReceipt}
                          disabled={billLoading}
                          style={{
                            padding: '8px 10px', borderRadius: 'var(--radius-full)',
                            background: 'var(--color-primary)', color: '#fff',
                            border: 'none', fontWeight: 700, fontSize: '12px',
                            cursor: billLoading ? 'not-allowed' : 'pointer'
                          }}
                        >
                          Print receipt
                        </button>
                      )}

                      {billInvoice.payment_status === 'paid' && (
                        <button
                          onClick={refundInvoice}
                          disabled={billLoading}
                          style={{
                            padding: '8px 10px', borderRadius: 'var(--radius-full)',
                            background: 'transparent', color: 'var(--status-rust-text)',
                            border: '1px solid var(--status-rust-border)', fontWeight: 700, fontSize: '12px',
                            cursor: billLoading ? 'not-allowed' : 'pointer'
                          }}
                        >
                          Refund invoice
                        </button>
                      )}

                      {billInvoice.payment_status === 'refunded' && billInvoice.refund_reason && (
                        <div style={{ fontSize: '11px', color: 'var(--color-muted)', textAlign: 'center', fontStyle: 'italic' }}>
                          Reason: {billInvoice.refund_reason}
                        </div>
                      )}

                      {billInvoice.payment_status === 'pending' && !billInvoice.splits && (
                        <>
                          <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                            Mark paid
                          </div>
                          <input
                            type="text"
                            value={paymentRef}
                            onChange={e => setPaymentRef(e.target.value)}
                            placeholder="Payment reference (optional, e.g. UPI txn id)"
                            maxLength={80}
                            style={{
                              padding: '6px 8px', fontSize: '12px', fontFamily: 'var(--font-mono)',
                              border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)',
                              color: 'var(--color-ink)'
                            }}
                          />
                          <div style={{ display: 'flex', gap: '6px' }}>
                            {['cash', 'upi', 'card', 'other'].map(m => (
                              <button
                                key={m}
                                onClick={() => markPaid(m)}
                                disabled={billLoading}
                                style={{
                                  flex: 1, padding: '8px 10px', borderRadius: 'var(--radius-full)',
                                  background: 'var(--color-primary)', color: '#fff',
                                  border: 'none', fontWeight: 700, fontSize: '12px', textTransform: 'uppercase',
                                  letterSpacing: '0.5px', cursor: billLoading ? 'not-allowed' : 'pointer', opacity: billLoading ? 0.6 : 1
                                }}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                              Split by seats
                            </span>
                            {[2, 3, 4, 5, 6].map(n => (
                              <button
                                key={n}
                                onClick={() => splitBySeats(n)}
                                disabled={billLoading}
                                style={{
                                  padding: '6px 10px', borderRadius: 'var(--radius-full)',
                                  background: 'transparent', color: 'var(--color-primary)',
                                  border: '1px solid var(--color-primary)', fontWeight: 700, fontSize: '12px',
                                  cursor: billLoading ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-mono)'
                                }}
                              >
                                {n}
                              </button>
                            ))}
                            <button
                              onClick={() => openAmountSplit(2)}
                              disabled={billLoading || !!amountSplitDraft || !!itemSplitDraft}
                              style={{
                                padding: '6px 10px', borderRadius: 'var(--radius-full)',
                                background: 'transparent', color: 'var(--color-muted)',
                                border: '1px dashed var(--color-hairline)', fontWeight: 700, fontSize: '12px',
                                cursor: (billLoading || amountSplitDraft || itemSplitDraft) ? 'not-allowed' : 'pointer'
                              }}
                            >
                              Custom amounts…
                            </button>
                            <button
                              onClick={() => openItemSplit(2)}
                              disabled={billLoading || !!amountSplitDraft || !!itemSplitDraft || !billInvoice.items?.length}
                              style={{
                                padding: '6px 10px', borderRadius: 'var(--radius-full)',
                                background: 'transparent', color: 'var(--color-muted)',
                                border: '1px dashed var(--color-hairline)', fontWeight: 700, fontSize: '12px',
                                cursor: (billLoading || amountSplitDraft || itemSplitDraft) ? 'not-allowed' : 'pointer'
                              }}
                            >
                              By items…
                            </button>
                          </div>

                          {itemSplitDraft && (() => {
                            const { count, assignments } = itemSplitDraft;
                            const perSplitSubtotal = Array.from({ length: count }, () => 0);
                            assignments.forEach((s, i) => {
                              if (s >= 0 && s < count) perSplitSubtotal[s] += billInvoice.items[i]?.line_total || 0;
                            });
                            const emptySplits = perSplitSubtotal.filter(v => v === 0).length;
                            const canApply = emptySplits === 0;
                            return (
                              <div style={{
                                border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
                                padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px',
                                background: 'var(--color-surface-soft)'
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                                    By items · {count} splits
                                  </span>
                                  <div style={{ display: 'flex', gap: '6px' }}>
                                    <button
                                      onClick={() => setItemSplitDraft(d => d.count < 6 ? { count: d.count + 1, assignments: d.assignments } : d)}
                                      disabled={billLoading || count >= 6}
                                      style={{
                                        padding: '4px 8px', borderRadius: 'var(--radius-xs)',
                                        background: 'transparent', color: 'var(--color-primary)',
                                        border: '1px solid var(--color-primary)', fontSize: '11px', fontWeight: 700,
                                        cursor: (billLoading || count >= 6) ? 'not-allowed' : 'pointer'
                                      }}
                                    >
                                      + split
                                    </button>
                                    <button
                                      onClick={() => setItemSplitDraft(d => {
                                        if (d.count <= 2) return d;
                                        // Clamp any assignment pointing at the removed split back to split 0.
                                        const nextCount = d.count - 1;
                                        return {
                                          count: nextCount,
                                          assignments: d.assignments.map(s => s >= nextCount ? 0 : s)
                                        };
                                      })}
                                      disabled={billLoading || count <= 2}
                                      style={{
                                        padding: '4px 8px', borderRadius: 'var(--radius-xs)',
                                        background: 'transparent', color: 'var(--color-muted)',
                                        border: '1px solid var(--color-hairline)', fontSize: '11px', fontWeight: 700,
                                        cursor: (billLoading || count <= 2) ? 'not-allowed' : 'pointer'
                                      }}
                                    >
                                      − split
                                    </button>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                  {billInvoice.items.map((line, itemIdx) => (
                                    <div key={itemIdx} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <div style={{ flex: 1, minWidth: 0, fontSize: '12px', color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        <span style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)', marginRight: 4, fontWeight: 700 }}>
                                          {line.qty}×
                                        </span>
                                        {line.name}
                                      </div>
                                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 700, color: 'var(--color-ink)', width: 60, textAlign: 'right' }}>
                                        {billInvoice.currency}{line.line_total}
                                      </div>
                                      <div style={{ display: 'flex', gap: '3px' }}>
                                        {Array.from({ length: count }).map((_, splitIdx) => {
                                          const active = assignments[itemIdx] === splitIdx;
                                          return (
                                            <button
                                              key={splitIdx}
                                              onClick={() => setItemSplitDraft(d => ({
                                                count: d.count,
                                                assignments: d.assignments.map((s, i) => i === itemIdx ? splitIdx : s)
                                              }))}
                                              disabled={billLoading}
                                              style={{
                                                width: 24, height: 24, borderRadius: '50%',
                                                background: active ? 'var(--color-primary)' : 'transparent',
                                                color: active ? '#fff' : 'var(--color-muted)',
                                                border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                                                fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 700,
                                                cursor: billLoading ? 'not-allowed' : 'pointer'
                                              }}
                                            >
                                              {splitIdx + 1}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                                  {perSplitSubtotal.map((v, i) => (
                                    <div key={i} style={{
                                      display: 'flex', justifyContent: 'space-between',
                                      color: v === 0 ? 'var(--status-rust-text)' : 'var(--color-muted)'
                                    }}>
                                      <span>Split {i + 1} subtotal</span>
                                      <span>{v === 0 ? 'empty' : `${billInvoice.currency}${v}`}</span>
                                    </div>
                                  ))}
                                </div>
                                {emptySplits > 0 && (
                                  <div style={{ fontSize: '11px', color: 'var(--status-rust-text)', fontWeight: 700 }}>
                                    Every split needs at least one item ({emptySplits} empty).
                                  </div>
                                )}
                                <div style={{ display: 'flex', gap: '6px' }}>
                                  <button
                                    onClick={closeItemSplit}
                                    disabled={billLoading}
                                    style={{
                                      flex: 1, padding: '7px 10px', borderRadius: 'var(--radius-full)',
                                      background: 'transparent', color: 'var(--color-muted)',
                                      border: '1px solid var(--color-hairline)', fontSize: '12px', fontWeight: 700,
                                      cursor: billLoading ? 'not-allowed' : 'pointer'
                                    }}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={submitItemSplit}
                                    disabled={!canApply || billLoading}
                                    style={{
                                      flex: 2, padding: '7px 10px', borderRadius: 'var(--radius-full)',
                                      background: canApply && !billLoading ? 'var(--color-primary)' : 'var(--color-surface-soft)',
                                      color: canApply && !billLoading ? '#fff' : 'var(--color-muted)',
                                      border: 'none', fontSize: '12px', fontWeight: 700,
                                      cursor: canApply && !billLoading ? 'pointer' : 'not-allowed'
                                    }}
                                  >
                                    Apply split
                                  </button>
                                </div>
                              </div>
                            );
                          })()}

                          {amountSplitDraft && (() => {
                            const rows = amountSplitDraft.rows;
                            const nums = rows.map(r => Number(r.share_amount)).filter(n => Number.isFinite(n));
                            const sum = nums.reduce((s, n) => s + n, 0);
                            const grand = billInvoice.grand_total;
                            const delta = grand - sum;
                            const balanced = delta === 0;
                            const anyDecimal = rows.some(r => r.share_amount !== '' && !Number.isInteger(Number(r.share_amount)));
                            const canSubmit = balanced && !anyDecimal && rows.every(r => Number(r.share_amount) > 0);
                            return (
                              <div style={{
                                border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
                                padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px',
                                background: 'var(--color-surface-soft)'
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                                    Custom split · {rows.length} shares
                                  </span>
                                  <div style={{ display: 'flex', gap: '6px' }}>
                                    <button
                                      onClick={() => setAmountSplitDraft(d => ({ rows: [...d.rows, { label: '', share_amount: '' }] }))}
                                      disabled={billLoading || rows.length >= 40}
                                      style={{
                                        padding: '4px 8px', borderRadius: 'var(--radius-xs)',
                                        background: 'transparent', color: 'var(--color-primary)',
                                        border: '1px solid var(--color-primary)', fontSize: '11px', fontWeight: 700,
                                        cursor: (billLoading || rows.length >= 40) ? 'not-allowed' : 'pointer'
                                      }}
                                    >
                                      + row
                                    </button>
                                    <button
                                      onClick={() => setAmountSplitDraft(d => d.rows.length > 2 ? { rows: d.rows.slice(0, -1) } : d)}
                                      disabled={billLoading || rows.length <= 2}
                                      style={{
                                        padding: '4px 8px', borderRadius: 'var(--radius-xs)',
                                        background: 'transparent', color: 'var(--color-muted)',
                                        border: '1px solid var(--color-hairline)', fontSize: '11px', fontWeight: 700,
                                        cursor: (billLoading || rows.length <= 2) ? 'not-allowed' : 'pointer'
                                      }}
                                    >
                                      − row
                                    </button>
                                  </div>
                                </div>
                                {rows.map((row, idx) => (
                                  <div key={idx} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                    <input
                                      type="text"
                                      placeholder={`Split ${idx + 1}`}
                                      value={row.label}
                                      onChange={e => setAmountSplitDraft(d => ({ rows: d.rows.map((r, i) => i === idx ? { ...r, label: e.target.value } : r) }))}
                                      style={{
                                        flex: 1, minWidth: 0, padding: '5px 8px', fontSize: '12px',
                                        border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                                      }}
                                    />
                                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--color-muted)' }}>
                                      {billInvoice.currency}
                                    </span>
                                    <input
                                      type="number"
                                      min="1"
                                      step="1"
                                      placeholder="0"
                                      value={row.share_amount}
                                      onChange={e => setAmountSplitDraft(d => ({ rows: d.rows.map((r, i) => i === idx ? { ...r, share_amount: e.target.value } : r) }))}
                                      style={{
                                        width: '90px', padding: '5px 8px', fontSize: '13px', fontFamily: 'var(--font-mono)',
                                        border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--color-ink)'
                                      }}
                                    />
                                  </div>
                                ))}
                                <div style={{
                                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                  fontSize: '11px', fontFamily: 'var(--font-mono)', fontWeight: 700,
                                  color: balanced ? 'var(--status-green-text)' : 'var(--status-rust-text)'
                                }}>
                                  <span>Target: {billInvoice.currency}{grand}</span>
                                  <span>
                                    {balanced
                                      ? '✓ Balanced'
                                      : delta > 0
                                        ? `Short by ${billInvoice.currency}${delta}`
                                        : `Over by ${billInvoice.currency}${-delta}`}
                                  </span>
                                </div>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                  <button
                                    onClick={closeAmountSplit}
                                    disabled={billLoading}
                                    style={{
                                      flex: 1, padding: '7px 10px', borderRadius: 'var(--radius-full)',
                                      background: 'transparent', color: 'var(--color-muted)',
                                      border: '1px solid var(--color-hairline)', fontSize: '12px', fontWeight: 700,
                                      cursor: billLoading ? 'not-allowed' : 'pointer'
                                    }}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={submitAmountSplit}
                                    disabled={!canSubmit || billLoading}
                                    style={{
                                      flex: 2, padding: '7px 10px', borderRadius: 'var(--radius-full)',
                                      background: canSubmit && !billLoading ? 'var(--color-primary)' : 'var(--color-surface-soft)',
                                      color: canSubmit && !billLoading ? '#fff' : 'var(--color-muted)',
                                      border: 'none', fontSize: '12px', fontWeight: 700,
                                      cursor: canSubmit && !billLoading ? 'pointer' : 'not-allowed'
                                    }}
                                  >
                                    Apply split
                                  </button>
                                </div>
                              </div>
                            );
                          })()}
                          <button
                            onClick={voidInvoice}
                            disabled={billLoading}
                            style={{
                              padding: '8px 10px', borderRadius: 'var(--radius-full)',
                              background: 'transparent', color: 'var(--status-rust-text)',
                              border: '1px solid var(--status-rust-border)', fontWeight: 700, fontSize: '12px',
                              cursor: billLoading ? 'not-allowed' : 'pointer'
                            }}
                          >
                            Void bill (reopens tickets)
                          </button>
                        </>
                      )}

                      {billInvoice.payment_status === 'pending' && Array.isArray(billInvoice.splits) && billInvoice.splits.length > 0 && (
                        <>
                          <input
                            type="text"
                            value={paymentRef}
                            onChange={e => setPaymentRef(e.target.value)}
                            placeholder="Payment reference for next split (optional)"
                            maxLength={80}
                            style={{
                              padding: '6px 8px', fontSize: '12px', fontFamily: 'var(--font-mono)',
                              border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-xs)',
                              color: 'var(--color-ink)'
                            }}
                          />
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                              Split into {billInvoice.splits.length} {billInvoice.split_mode === 'seats' ? 'seats' : 'shares'}
                            </span>
                            {billInvoice.splits.every(s => s.payment_status !== 'paid') && (
                              <button
                                onClick={unsplitInvoice}
                                disabled={billLoading}
                                style={{
                                  background: 'transparent', color: 'var(--color-muted)', border: 'none',
                                  fontSize: '11px', cursor: billLoading ? 'not-allowed' : 'pointer', textDecoration: 'underline'
                                }}
                              >
                                Undo split
                              </button>
                            )}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {billInvoice.splits.map((s, idx) => (
                              <div key={idx} style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                padding: '8px 10px', borderRadius: 'var(--radius-xs)',
                                background: s.payment_status === 'paid' ? 'var(--status-green-bg)' : 'var(--color-surface-soft)',
                                border: `1px solid ${s.payment_status === 'paid' ? 'var(--status-green-border)' : 'var(--color-hairline)'}`
                              }}>
                                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-ink)' }}>
                                    {s.label}
                                  </span>
                                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: s.payment_status === 'paid' ? 'var(--status-green-text)' : 'var(--color-primary)', fontWeight: 700 }}>
                                    {billInvoice.currency}{s.share_amount}
                                  </span>
                                </div>
                                {s.payment_status === 'paid' ? (
                                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--status-green-text)', fontWeight: 700, textTransform: 'uppercase' }}>
                                    ✓ {s.payment_method}
                                  </span>
                                ) : (
                                  <div style={{ display: 'flex', gap: '4px' }}>
                                    {['cash', 'upi', 'card'].map(m => (
                                      <button
                                        key={m}
                                        onClick={() => markSplitPaid(idx, m)}
                                        disabled={billLoading}
                                        style={{
                                          padding: '5px 8px', borderRadius: 'var(--radius-full)',
                                          background: 'var(--color-primary)', color: '#fff',
                                          border: 'none', fontWeight: 700, fontSize: '10px',
                                          textTransform: 'uppercase', letterSpacing: '0.5px',
                                          cursor: billLoading ? 'not-allowed' : 'pointer'
                                        }}
                                      >
                                        {m}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </>
                      )}

                      {billInvoice.payment_status === 'voided' && billInvoice.voided_reason && (
                        <div style={{ fontSize: '11px', color: 'var(--color-muted)', textAlign: 'center', fontStyle: 'italic' }}>
                          Reason: {billInvoice.voided_reason}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                      <button
                        onClick={closeBill}
                        style={{
                          flex: 1, padding: '10px 14px', borderRadius: 'var(--radius-full)',
                          background: 'transparent', color: 'var(--color-muted)',
                          border: '1px solid var(--color-hairline)', fontWeight: 600, fontSize: '13px', cursor: 'pointer'
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={commitBill}
                        disabled={billLoading}
                        style={{
                          flex: 1, padding: '10px 14px', borderRadius: 'var(--radius-full)',
                          background: billLoading ? 'var(--color-surface-soft)' : 'var(--color-primary)',
                          color: billLoading ? 'var(--color-muted)' : '#fff',
                          border: 'none', fontWeight: 700, fontSize: '13px',
                          cursor: billLoading ? 'not-allowed' : 'pointer'
                        }}
                      >
                        Close Bill · {billInvoice.currency}{billInvoice.grand_total}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
