import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Search, Plus, Minus, SlidersHorizontal, Clock } from 'lucide-react';
import { ModifierSheet } from './ModifierSheet';

export const RapidOrderBuilder = ({ selectedTableId, draftItems, onAddItem, onRemoveItem }) => {
  const { menu, tables, currentRestaurant } = usePos();
  const [activeCategory, setActiveCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [vegFilter, setVegFilter] = useState('all');
  // The row currently being customized in the modifier sheet, or null if
  // the sheet is closed. Holds a resolved row (variant already picked) so
  // the sheet only handles modifier picks on top.
  const [sheetRow, setSheetRow] = useState(null);

  const currency = currentRestaurant?.currency || '₹';
  const table = tables.find(t => t.id === selectedTableId);
  const categories = ['All', ...new Set(menu.map(m => m.category))];

  // Expand items with variants into one visible row per variant. Each row
  // carries a stable `lineKey` and the resolved shape addItem() expects.
  // No-variant items render as a single row with `lineKey === item.id`.
  // Modifier groups (M2 · PR 12) hang off the parent item, not the variant,
  // so both flat-item rows and variant-expanded rows inherit the same
  // modifier_groups reference; the sheet handles the picks.
  // The hub already resolves the active day-part per request and stamps
  // `effective_price` + `active_day_part` on each item + variant (M2 · PR 13).
  // The handset just reads those fields — no client-side clock, no drift
  // window between what the waiter taps and what the KDS bills. Server is
  // the pricing authority; POST /orders re-prices from scratch anyway.
  const priceOf = (obj) => Number.isFinite(Number(obj?.effective_price))
    ? Number(obj.effective_price)
    : Number(obj?.price) || 0;

  const expandedRows = menu.flatMap(item => {
    if (!item.available) return [];
    const hasModifiers = Array.isArray(item.modifier_groups) && item.modifier_groups.length > 0;
    const itemDayPart = item.active_day_part || null;
    if (Array.isArray(item.variants) && item.variants.length > 0) {
      return item.variants.map(v => ({
        lineKey: `${item.id}|${v.id}`,
        item_id: item.id,
        variant_id: v.id,
        variant_label: v.label,
        name: item.name,
        display_name: `${item.name} — ${v.label}`,
        price: priceOf(v),
        base_price: Number(v.price) || 0,
        active_day_part: v.active_day_part || itemDayPart,
        isVeg: item.isVeg,
        category: item.category,
        hasModifiers,
        modifier_groups: hasModifiers ? item.modifier_groups : null
      }));
    }
    return [{
      lineKey: String(item.id),
      item_id: item.id,
      variant_id: null,
      variant_label: null,
      name: item.name,
      display_name: item.name,
      price: priceOf(item),
      base_price: Number(item.price) || 0,
      active_day_part: itemDayPart,
      isVeg: item.isVeg,
      category: item.category,
      hasModifiers,
      modifier_groups: hasModifiers ? item.modifier_groups : null
    }];
  });

  const filtered = expandedRows.filter(row => {
    if (activeCategory !== 'All' && row.category !== activeCategory) return false;
    if (vegFilter === 'veg' && !row.isVeg) return false;
    if (vegFilter === 'nonveg' && row.isVeg) return false;
    if (query.trim() && !row.display_name.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Label row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>
          {currentRestaurant?.name} Menu
        </span>
        {table && (
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-primary)', fontFamily: 'var(--font-display)' }}>
            → {table.name}
          </span>
        )}
      </div>

      {/* Search + Veg Toggle */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: '8px',
          background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)',
          borderRadius: 'var(--radius-sm)', padding: '0 12px', height: '48px'
        }}>
          <Search size={16} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
          <input
            type="text" placeholder="Search dishes…" value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ background: 'transparent', border: 'none', color: 'var(--color-ink)', fontSize: '13px', outline: 'none', width: '100%' }}
          />
        </div>

        <div className="pill-group" style={{ flexShrink: 0, height: '48px', alignItems: 'center' }}>
          {[['all','All'],['veg','🟢'],['nonveg','🔴']].map(([val, label]) => (
            <button key={val} className={`pill-btn ${vegFilter === val ? 'active' : ''}`}
              onClick={() => setVegFilter(val)}
              style={{ padding: '6px 10px', fontSize: '12px' }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Category Slider */}
      <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '2px' }}>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius-full)', fontSize: '12px',
              fontWeight: 500, whiteSpace: 'nowrap',
              background: activeCategory === cat ? 'var(--color-primary)' : 'var(--color-surface-soft)',
              color: activeCategory === cat ? '#ffffff' : 'var(--color-muted)',
              border: `1px solid ${activeCategory === cat ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
              transition: 'all 0.15s ease', cursor: 'pointer'
            }}
          >{cat}</button>
        ))}
      </div>

      {/* Dish List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto' }}>
        {menu.length === 0 ? (
          <div className="banner banner-warning" style={{ textAlign: 'center' }}>
            ⚠️ No menu data available — connect this hub to the internet once to complete setup.
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-muted)', fontSize: '13px' }}>
            No items match your search.
          </div>
        ) : null}
        {filtered.map(row => {
          // Aggregate qty across every draft line whose lineKey starts with
          // this row's key — a modifier'd item may have multiple cart lines
          // (Hot vs Mild vs +Cheese) all sharing this menu row. The bare "-"
          // stepper only decrements the plain, no-modifier variant; modifier
          // combos are edited from the cart tab (each has its own line there).
          const rowKey = row.lineKey;
          const draftEntries = Object.entries(draftItems).filter(([k]) => k === rowKey || k.startsWith(`${rowKey}|`));
          const qty = draftEntries.reduce((s, [, v]) => s + (v?.qty || 0), 0);
          const plainQty = draftItems[rowKey]?.qty || 0;
          const openSheet = () => setSheetRow(row);
          const handleAdd = row.hasModifiers ? openSheet : () => onAddItem(row);
          return (
            <div
              key={row.lineKey}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: qty > 0 ? 'var(--status-amber-bg)' : 'var(--color-canvas)',
                border: `1px solid ${qty > 0 ? 'var(--status-amber-border)' : 'var(--color-hairline)'}`,
                borderRadius: 'var(--radius-md)', padding: '10px 14px',
                boxShadow: 'var(--shadow-flat)',
                transition: 'all 0.15s ease'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '11px', flexShrink: 0 }}>{row.isVeg ? '🟢' : '🔴'}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="typography-title-md" style={{ color: 'var(--color-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.name}
                    {row.variant_label && (
                      <span style={{ fontSize: '11px', color: 'var(--color-muted)', fontWeight: 500, marginLeft: 6 }}>
                        · {row.variant_label}
                      </span>
                    )}
                    {row.hasModifiers && (
                      <span title="Customizable — spice, extras, prep" style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 6,
                        fontSize: '9px', color: 'var(--color-primary)', fontFamily: 'var(--font-mono)',
                        background: 'var(--status-amber-bg)',
                        padding: '1px 5px', borderRadius: 'var(--radius-full)',
                        border: '1px solid var(--status-amber-border)', verticalAlign: 'middle'
                      }}>
                        <SlidersHorizontal size={9} /> CUSTOMIZE
                      </span>
                    )}
                    {row.active_day_part && (
                      <span
                        title={`Active promotion: ${row.active_day_part.label}`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 6,
                          fontSize: '9px', color: 'var(--status-green-text)', fontFamily: 'var(--font-mono)',
                          background: 'var(--status-green-bg)',
                          padding: '1px 5px', borderRadius: 'var(--radius-full)',
                          border: '1px solid var(--status-green-border)', verticalAlign: 'middle'
                        }}
                      >
                        <Clock size={9} /> {String(row.active_day_part.label).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="typography-body-sm" style={{ fontSize: '12px', color: 'var(--color-muted)', marginTop: '1px', display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ color: row.active_day_part ? 'var(--status-green-text)' : 'var(--color-muted)', fontWeight: row.active_day_part ? 700 : 500 }}>
                      {currency}{row.price}{row.hasModifiers ? ' +' : ''}
                    </span>
                    {row.active_day_part && row.base_price !== row.price && (
                      <span style={{ textDecoration: 'line-through', fontSize: 11, opacity: 0.6 }}>
                        {currency}{row.base_price}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                {qty > 0 ? (
                  <>
                    <button
                      // Only touch the plain (no-modifier) draft line here;
                      // modifier lines are edited from the cart tab where
                      // each combination is listed individually.
                      onClick={() => onRemoveItem(rowKey)}
                      disabled={!selectedTableId || plainQty === 0}
                      title={plainQty === 0 ? 'Edit customized items from the Cart tab' : 'Remove one'}
                      style={{
                        width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
                        background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)',
                        color: 'var(--color-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: plainQty === 0 ? 'not-allowed' : 'pointer',
                        opacity: plainQty === 0 ? 0.4 : 1
                      }}
                    ><Minus size={13} /></button>

                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, color: 'var(--color-primary)', minWidth: '18px', textAlign: 'center' }}>
                      {qty}
                    </span>

                    <button
                      onClick={handleAdd} disabled={!selectedTableId}
                      style={{
                        width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
                        background: 'var(--color-primary)', color: '#ffffff', border: 'none',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    ><Plus size={13} /></button>
                  </>
                ) : (
                  <button
                    onClick={handleAdd} disabled={!selectedTableId}
                    style={{
                      padding: '6px 14px', borderRadius: 'var(--radius-sm)', fontSize: '12px', fontWeight: 500,
                      background: selectedTableId ? 'var(--color-primary)' : 'var(--color-surface-soft)',
                      color: selectedTableId ? '#ffffff' : 'var(--color-muted)',
                      display: 'flex', alignItems: 'center', gap: '4px', border: 'none',
                      cursor: selectedTableId ? 'pointer' : 'not-allowed',
                      transition: 'all 0.15s ease'
                    }}
                  ><Plus size={13} />{row.hasModifiers ? 'Customize' : 'Add'}</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {sheetRow && (
        <ModifierSheet
          row={sheetRow}
          currency={currency}
          onClose={() => setSheetRow(null)}
          onConfirm={(configuredRow) => {
            onAddItem(configuredRow);
            setSheetRow(null);
          }}
        />
      )}
    </div>
  );
};
