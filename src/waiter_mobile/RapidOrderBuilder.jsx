import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Search, Plus, Minus } from 'lucide-react';

export const RapidOrderBuilder = ({ selectedTableId, draftItems, onAddItem, onRemoveItem }) => {
  const { menu, tables, currentRestaurant } = usePos();
  const [activeCategory, setActiveCategory] = useState('All');
  const [query, setQuery] = useState('');
  const [vegFilter, setVegFilter] = useState('all');

  const currency = currentRestaurant?.currency || '₹';
  const table = tables.find(t => t.id === selectedTableId);
  const categories = ['All', ...new Set(menu.map(m => m.category))];

  const filtered = menu.filter(item => {
    if (!item.available) return false;
    if (activeCategory !== 'All' && item.category !== activeCategory) return false;
    if (vegFilter === 'veg' && !item.isVeg) return false;
    if (vegFilter === 'nonveg' && item.isVeg) return false;
    if (query.trim() && !item.name.toLowerCase().includes(query.toLowerCase())) return false;
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
        {filtered.map(item => {
          const qty = draftItems[item.id] || 0;
          return (
            <div
              key={item.id}
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
                <span style={{ fontSize: '11px', flexShrink: 0 }}>{item.isVeg ? '🟢' : '🔴'}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="typography-title-md" style={{ color: 'var(--color-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.name}
                  </div>
                  <div className="typography-body-sm" style={{ fontSize: '12px', color: 'var(--color-muted)', marginTop: '1px' }}>
                    {currency}{item.price}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                {qty > 0 ? (
                  <>
                    <button
                      onClick={() => onRemoveItem(item.id)} disabled={!selectedTableId}
                      style={{
                        width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
                        background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)',
                        color: 'var(--color-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer'
                      }}
                    ><Minus size={13} /></button>

                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, color: 'var(--color-primary)', minWidth: '18px', textAlign: 'center' }}>
                      {qty}
                    </span>

                    <button
                      onClick={() => onAddItem(item.id)} disabled={!selectedTableId}
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
                    onClick={() => onAddItem(item.id)} disabled={!selectedTableId}
                    style={{
                      padding: '6px 14px', borderRadius: 'var(--radius-sm)', fontSize: '12px', fontWeight: 500,
                      background: selectedTableId ? 'var(--color-primary)' : 'var(--color-surface-soft)',
                      color: selectedTableId ? '#ffffff' : 'var(--color-muted)',
                      display: 'flex', alignItems: 'center', gap: '4px', border: 'none',
                      cursor: selectedTableId ? 'pointer' : 'not-allowed',
                      transition: 'all 0.15s ease'
                    }}
                  ><Plus size={13} />Add</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
