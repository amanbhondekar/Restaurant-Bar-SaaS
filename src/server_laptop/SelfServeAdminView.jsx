import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Plus, Edit2, Trash2, Check, LayoutGrid, Utensils, Save, X, Users, QrCode, ShieldCheck, Crown } from 'lucide-react';
import { VegBadge } from '../components/VegBadge';

export const SelfServeAdminView = () => {
  const {
    menu,
    tables,
    staff,
    currentRestaurant,
    addMenuItem,
    updateMenuItem,
    deleteMenuItem,
    addTable,
    updateTable,
    deleteTable
  } = usePos();

  const [activeTab, setActiveTab] = useState('menu'); // 'menu' | 'layout' | 'staff'

  // Menu Form state
  const [editingItem, setEditingItem] = useState(null);
  const [itemName, setItemName] = useState('');
  const [itemPrice, setItemPrice] = useState('');
  const [itemCategory, setItemCategory] = useState('Starters');
  const [itemIsVeg, setItemIsVeg] = useState(true);
  const [menuError, setMenuError] = useState('');

  // Table Form state
  const [editingTable, setEditingTable] = useState(null);
  const [tableName, setTableName] = useState('');
  const [tableSection, setTableSection] = useState('Main Hall');
  const [tableCapacity, setTableCapacity] = useState(4);
  const [tableError, setTableError] = useState('');

  const currency = currentRestaurant?.currency || '₹';

  // Handle Save Menu Item
  const handleSaveMenuItem = (e) => {
    e.preventDefault();
    if (!itemName.trim()) {
      setMenuError('Dish name is required');
      return;
    }
    if (!itemPrice || Number(itemPrice) <= 0) {
      setMenuError('Please enter a valid price');
      return;
    }
    setMenuError('');

    if (editingItem) {
      updateMenuItem({
        ...editingItem,
        name: itemName,
        price: Number(itemPrice),
        category: itemCategory,
        isVeg: itemIsVeg
      });
      setEditingItem(null);
    } else {
      addMenuItem({
        name: itemName,
        price: Number(itemPrice),
        category: itemCategory,
        isVeg: itemIsVeg
      });
    }

    setItemName('');
    setItemPrice('');
  };

  const startEditMenu = (item) => {
    setEditingItem(item);
    setItemName(item.name);
    setItemPrice(item.price);
    setItemCategory(item.category);
    setItemIsVeg(item.isVeg);
    setMenuError('');
  };

  // Handle Save Table
  const handleSaveTable = (e) => {
    e.preventDefault();
    if (!tableName.trim()) {
      setTableError('Table name / code is required');
      return;
    }
    setTableError('');

    if (editingTable) {
      updateTable({
        ...editingTable,
        name: tableName,
        section: tableSection,
        capacity: Number(tableCapacity)
      });
      setEditingTable(null);
    } else {
      addTable({
        name: tableName,
        section: tableSection,
        capacity: Number(tableCapacity)
      });
    }

    setTableName('');
    setTableCapacity(4);
  };

  const startEditTable = (table) => {
    setEditingTable(table);
    setTableName(table.name);
    setTableSection(table.section);
    setTableCapacity(table.capacity);
    setTableError('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Top Admin Sub-Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '16px',
        background: 'var(--color-canvas)',
        border: '1px solid var(--color-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: '20px 24px',
        boxShadow: 'var(--shadow-flat)'
      }}>
        <div>
          <h1 className="typography-display-xl" style={{ margin: 0, color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            {currentRestaurant?.name} Admin Controls
            <span className="typography-uppercase-tag" style={{ color: 'var(--status-amber-text)', background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)', padding: '3px 10px', borderRadius: 'var(--radius-full)' }}>
              Self-Serve Tier
            </span>
          </h1>
          <div className="typography-body-sm" style={{ color: 'var(--color-muted)', marginTop: '2px' }}>
            Zero Developer Vendor Lock-In · Live Menu, Floor Layout & Staff Credentials
          </div>
        </div>

        <div className="pill-group">
          <button
            className={`pill-btn ${activeTab === 'menu' ? 'active' : ''}`}
            onClick={() => setActiveTab('menu')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Utensils size={15} /> Menu Editor
          </button>

          <button
            className={`pill-btn ${activeTab === 'layout' ? 'active' : ''}`}
            onClick={() => setActiveTab('layout')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <LayoutGrid size={15} /> Floor Layout
          </button>

          <button
            className={`pill-btn ${activeTab === 'staff' ? 'active' : ''}`}
            onClick={() => setActiveTab('staff')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Users size={15} /> Staff & Pairing
          </button>
        </div>
      </div>

      {/* 1. Menu Editor Tab */}
      {activeTab === 'menu' && (
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '20px' }}>
          {/* Add / Edit Form */}
          <div className="card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h2 className="typography-display-md" style={{ margin: 0, color: 'var(--color-ink)' }}>
              {editingItem ? 'Edit Dish' : 'Add New Dish'}
            </h2>

            <form onSubmit={handleSaveMenuItem} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label className="typography-caption-sm" style={{ fontWeight: 600, color: menuError ? 'var(--color-primary-error-text)' : 'var(--color-muted)' }}>
                  Dish Name *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Butter Chicken"
                  value={itemName}
                  onChange={(e) => { setItemName(e.target.value); setMenuError(''); }}
                  className={`input ${menuError ? 'input-error' : ''}`}
                  style={{ marginTop: '4px', height: '48px' }}
                />
                {menuError && (
                  <div className="form-error-helper">{menuError}</div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label className="typography-caption-sm" style={{ fontWeight: 600, color: 'var(--color-muted)' }}>Price ({currency}) *</label>
                  <input
                    type="number"
                    placeholder="280"
                    value={itemPrice}
                    onChange={(e) => setItemPrice(e.target.value)}
                    className="input"
                    style={{ marginTop: '4px', height: '48px', fontFamily: 'var(--font-mono)' }}
                  />
                </div>

                <div>
                  <label className="typography-caption-sm" style={{ fontWeight: 600, color: 'var(--color-muted)' }}>Category</label>
                  <select
                    value={itemCategory}
                    onChange={(e) => setItemCategory(e.target.value)}
                    className="input"
                    style={{ marginTop: '4px', height: '48px', fontSize: '13px' }}
                  >
                    <option value="Starters">Starters</option>
                    <option value="Main Course">Main Course</option>
                    <option value="Biryani & Rice">Biryani & Rice</option>
                    <option value="Saoji Specials">Saoji Specials</option>
                    <option value="Breads">Breads</option>
                    <option value="Beverages">Beverages</option>
                    <option value="Desserts">Desserts</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
                <label className="typography-body-sm" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-ink)' }}>
                  <input
                    type="checkbox"
                    checked={itemIsVeg}
                    onChange={(e) => setItemIsVeg(e.target.checked)}
                  />
                  Vegetarian Dish
                </label>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ flex: 1, height: '48px' }}
                >
                  <Save size={16} /> {editingItem ? 'Update Dish' : 'Save Dish'}
                </button>
                {editingItem && (
                  <button
                    type="button"
                    onClick={() => { setEditingItem(null); setItemName(''); setItemPrice(''); setMenuError(''); }}
                    className="btn btn-ghost"
                    style={{ height: '48px', padding: '0 16px' }}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Menu Items Table */}
          <div className="card" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {menu.map(item => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'var(--color-surface-soft)',
                    border: '1px solid var(--color-hairline)',
                    borderRadius: 'var(--radius-md)',
                    padding: '12px 16px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <VegBadge isVeg={item.isVeg} />
                    <div>
                      <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>
                        {item.name}
                      </div>
                      <div className="typography-body-sm" style={{ fontSize: '12px', color: 'var(--color-muted)' }}>
                        {item.category} • <strong style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)' }}>{currency}{item.price}</strong>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                      onClick={() => updateMenuItem({ ...item, available: !item.available })}
                      className="typography-uppercase-tag"
                      style={{
                        padding: '4px 10px',
                        borderRadius: 'var(--radius-full)',
                        background: item.available ? 'var(--status-green-bg)' : 'var(--status-rust-bg)',
                        color: item.available ? 'var(--status-green-text)' : 'var(--status-rust-text)',
                        border: `1px solid ${item.available ? 'var(--status-green-border)' : 'var(--status-rust-border)'}`,
                        cursor: 'pointer'
                      }}
                    >
                      {item.available ? 'In Stock' : 'Sold Out'}
                    </button>

                    <button
                      onClick={() => startEditMenu(item)}
                      style={{ padding: '6px', color: 'var(--color-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      <Edit2 size={15} />
                    </button>

                    <button
                      onClick={() => deleteMenuItem(item.id)}
                      style={{ padding: '6px', color: 'var(--status-rust-text)', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 2. Floor Layout Builder Tab */}
      {activeTab === 'layout' && (
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '20px' }}>
          {/* Add / Edit Table Form */}
          <div className="card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h2 className="typography-display-md" style={{ margin: 0, color: 'var(--color-ink)' }}>
              {editingTable ? 'Edit Table' : 'Add New Table'}
            </h2>

            <form onSubmit={handleSaveTable} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label className="typography-caption-sm" style={{ fontWeight: 600, color: tableError ? 'var(--color-primary-error-text)' : 'var(--color-muted)' }}>
                  Table Name / Code *
                </label>
                <input
                  type="text"
                  placeholder="e.g. T13"
                  value={tableName}
                  onChange={(e) => { setTableName(e.target.value); setTableError(''); }}
                  className={`input ${tableError ? 'input-error' : ''}`}
                  style={{ marginTop: '4px', height: '48px', fontFamily: 'var(--font-mono)' }}
                />
                {tableError && (
                  <div className="form-error-helper">{tableError}</div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label className="typography-caption-sm" style={{ fontWeight: 600, color: 'var(--color-muted)' }}>Capacity</label>
                  <input
                    type="number"
                    min="1"
                    value={tableCapacity}
                    onChange={(e) => setTableCapacity(e.target.value)}
                    className="input"
                    style={{ marginTop: '4px', height: '48px', fontFamily: 'var(--font-mono)' }}
                  />
                </div>

                <div>
                  <label className="typography-caption-sm" style={{ fontWeight: 600, color: 'var(--color-muted)' }}>Section</label>
                  <select
                    value={tableSection}
                    onChange={(e) => setTableSection(e.target.value)}
                    className="input"
                    style={{ marginTop: '4px', height: '48px', fontSize: '13px' }}
                  >
                    <option value="Main Hall">Main Hall</option>
                    <option value="AC Room">AC Room</option>
                    <option value="Family Room">Family Room</option>
                    <option value="Garden Lawn">Garden Lawn</option>
                    <option value="Bistro Area">Bistro Area</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                style={{ marginTop: '8px', height: '48px' }}
              >
                <Save size={16} /> {editingTable ? 'Update Table' : 'Add Table'}
              </button>
            </form>
          </div>

          {/* Tables Layout Grid */}
          <div className="card" style={{ padding: '24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '12px' }}>
              {tables.map(t => (
                <div
                  key={t.id}
                  className="table-card"
                  style={{
                    background: 'var(--color-surface-soft)',
                    border: '1px solid var(--color-hairline)',
                    borderRadius: 'var(--radius-md)',
                    padding: '14px 12px',
                    textAlign: 'center',
                  }}
                >
                  <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>
                    {t.name}
                  </div>

                  <div className="typography-body-sm" style={{ fontSize: '11px', color: 'var(--color-muted)', marginTop: '2px' }}>
                    {t.section} • {t.capacity}p
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', marginTop: '10px' }}>
                    <button onClick={() => startEditTable(t)} style={{ color: 'var(--color-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      <Edit2 size={14} />
                    </button>
                    <button onClick={() => deleteTable(t.id)} style={{ color: 'var(--status-rust-text)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 3. Staff & Device Pairing Credentials Tab */}
      {activeTab === 'staff' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '20px' }}>
          <div className="card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h2 className="typography-display-md" style={{ margin: 0, color: 'var(--color-ink)', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Users size={20} style={{ color: 'var(--color-primary)' }} /> Scoped Staff Accounts ({staff.length})
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {staff.map(s => (
                <div key={s.id} style={{
                  padding: '14px 16px', background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)',
                  borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                }}>
                  <div>
                    <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{s.name}</div>
                    <div className="typography-body-sm" style={{ fontSize: '12px', color: 'var(--color-muted)', marginTop: '2px' }}>
                      Role: <strong style={{ color: 'var(--color-primary)' }}>{s.role}</strong> | Auth PIN: <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--status-green-text)', fontWeight: 700 }}>{s.pin}</code>
                    </div>
                  </div>

                  <span className="typography-uppercase-tag" style={{ background: 'var(--status-green-bg)', color: 'var(--status-green-text)', border: '1px solid var(--status-green-border)', padding: '2px 8px', borderRadius: 'var(--radius-full)' }}>
                    Active
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={{
            background: 'var(--color-canvas)', border: '1px dashed var(--color-primary)', borderRadius: 'var(--radius-md)',
            padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px', textAlign: 'center',
            boxShadow: 'var(--shadow-flat)'
          }}>
            <div style={{ width: '48px', height: '48px', borderRadius: 'var(--radius-full)', background: 'var(--status-amber-bg)', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>
              <QrCode size={24} />
            </div>

            <div className="typography-display-sm" style={{ color: 'var(--color-ink)' }}>Restaurant KDS Pairing Code</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 700, color: 'var(--color-primary)', background: 'var(--status-amber-bg)', padding: '10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--status-amber-border)' }}>
              {currentRestaurant?.pairingCode}
            </div>

            <div className="typography-body-sm" style={{ color: 'var(--color-muted)', lineHeight: 1.5 }}>
              Waiters enter this code once on their handsets to pair directly to <strong>{currentRestaurant?.name}</strong>'s LAN kitchen display.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
