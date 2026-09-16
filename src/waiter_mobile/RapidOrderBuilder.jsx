import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Search, Plus, Minus, AlertTriangle } from 'lucide-react';
import { VegBadge } from '../components/VegBadge';
import { Badge } from '../components/ui/badge';

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
    <div className="flex flex-col gap-2">
      {/* Label */}
      <div className="flex items-center justify-between">
        <span className="typography-uppercase-tag" style={{ color: 'var(--color-muted)' }}>
          {currentRestaurant?.name} Menu
        </span>
        {table && (
          <Badge variant="outline" className="text-xs font-semibold" style={{ color: 'var(--color-primary)', borderColor: 'var(--color-primary)' }}>
            → {table.name}
          </Badge>
        )}
      </div>

      {/* Search + Veg Toggle */}
      <div className="flex gap-2">
        <div className="search-box flex-1">
          <Search size={16} className="shrink-0" style={{ color: 'var(--color-muted)' }} />
          <input type="text" placeholder="Search dishes…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>

        <div className="flex gap-0.5 shrink-0 items-center rounded-[var(--radius-sm)] p-0.5 h-12"
          style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)' }}>
          {[['all','All'],['veg','Veg'],['nonveg','Non-V']].map(([val, label]) => (
            <button key={val}
              className="px-2.5 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] border-none cursor-pointer transition-all"
              onClick={() => setVegFilter(val)}
              style={{
                fontFamily: 'var(--font-body)',
                color: vegFilter === val ? 'var(--color-on-primary)' : 'var(--color-ink)',
                background: vegFilter === val ? 'var(--color-primary)' : 'transparent',
              }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Category Chips */}
      <div className="chip-group">
        {categories.map(cat => (
          <button key={cat} onClick={() => setActiveCategory(cat)} className={`chip${activeCategory === cat ? ' active' : ''}`}>{cat}</button>
        ))}
      </div>

      {/* Dish List */}
      <div className="flex flex-col gap-2 overflow-y-auto">
        {menu.length === 0 ? (
          <div className="banner banner-warning text-center">
            <AlertTriangle size={14} className="shrink-0" /> No menu data — connect hub to internet to setup.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-6 text-[13px]" style={{ color: 'var(--color-muted)' }}>
            No items match your search.
          </div>
        ) : null}

        {filtered.map(item => {
          const qty = draftItems[item.id] || 0;
          return (
            <div key={item.id}
              className="flex items-center justify-between rounded-[var(--radius-md)] border px-3.5 py-2.5 transition-all"
              style={{
                background: qty > 0 ? 'var(--status-amber-bg)' : 'var(--color-canvas)',
                borderColor: qty > 0 ? 'var(--status-amber-border)' : 'var(--color-hairline)',
              }}>
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <VegBadge isVeg={item.isVeg} size={8} />
                <div className="min-w-0">
                  <div className="typography-title-md truncate" style={{ color: 'var(--color-ink)' }}>{item.name}</div>
                  <div className="typography-body-sm text-xs mt-[1px]" style={{ color: 'var(--color-muted)' }}>
                    {currency}{item.price}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {qty > 0 ? (
                  <>
                    <button onClick={() => onRemoveItem(item.id)} disabled={!selectedTableId}
                      className="w-7 h-7 rounded-[var(--radius-sm)] border flex items-center justify-center cursor-pointer"
                      style={{ background: 'var(--color-surface-soft)', borderColor: 'var(--color-hairline)', color: 'var(--color-ink)' }}>
                      <Minus size={13} />
                    </button>
                    <span className="font-mono text-[13px] font-bold min-w-[18px] text-center" style={{ color: 'var(--color-primary)' }}>{qty}</span>
                    <button onClick={() => onAddItem(item.id)} disabled={!selectedTableId}
                      className="w-7 h-7 rounded-[var(--radius-sm)] border-none flex items-center justify-center cursor-pointer font-bold"
                      style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
                      <Plus size={13} />
                    </button>
                  </>
                ) : (
                  <button onClick={() => onAddItem(item.id)} disabled={!selectedTableId}
                    className="px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium border-none flex items-center gap-1 cursor-pointer transition-all"
                    style={{
                      background: selectedTableId ? 'var(--color-primary)' : 'var(--color-surface-soft)',
                      color: selectedTableId ? 'var(--color-on-primary)' : 'var(--color-muted)',
                      cursor: selectedTableId ? 'pointer' : 'not-allowed',
                    }}>
                    <Plus size={13} />Add
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
