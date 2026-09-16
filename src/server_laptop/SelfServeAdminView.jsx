import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Plus, Edit2, Trash2, Check, LayoutGrid, Utensils, Save, X, Users, QrCode, ShieldCheck, Crown } from 'lucide-react';
import { VegBadge } from '../components/VegBadge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';

export const SelfServeAdminView = () => {
  const {
    menu, tables, staff, currentRestaurant,
    addMenuItem, updateMenuItem, deleteMenuItem,
    addTable, updateTable, deleteTable
  } = usePos();

  const [activeTab, setActiveTab] = useState('menu');

  const [editingItem, setEditingItem] = useState(null);
  const [itemName, setItemName] = useState('');
  const [itemPrice, setItemPrice] = useState('');
  const [itemCategory, setItemCategory] = useState('Starters');
  const [itemIsVeg, setItemIsVeg] = useState(true);
  const [menuError, setMenuError] = useState('');

  const [editingTable, setEditingTable] = useState(null);
  const [tableName, setTableName] = useState('');
  const [tableSection, setTableSection] = useState('Main Hall');
  const [tableCapacity, setTableCapacity] = useState(4);
  const [tableError, setTableError] = useState('');

  const currency = currentRestaurant?.currency || '₹';

  const handleSaveMenuItem = (e) => {
    e.preventDefault();
    if (!itemName.trim()) { setMenuError('Dish name is required'); return; }
    if (!itemPrice || Number(itemPrice) <= 0) { setMenuError('Please enter a valid price'); return; }
    setMenuError('');

    if (editingItem) {
      updateMenuItem({ ...editingItem, name: itemName, price: Number(itemPrice), category: itemCategory, isVeg: itemIsVeg });
      setEditingItem(null);
    } else {
      addMenuItem({ name: itemName, price: Number(itemPrice), category: itemCategory, isVeg: itemIsVeg });
    }
    setItemName(''); setItemPrice('');
  };

  const startEditMenu = (item) => {
    setEditingItem(item); setItemName(item.name); setItemPrice(item.price);
    setItemCategory(item.category); setItemIsVeg(item.isVeg); setMenuError('');
  };

  const handleSaveTable = (e) => {
    e.preventDefault();
    if (!tableName.trim()) { setTableError('Table name / code is required'); return; }
    setTableError('');

    if (editingTable) {
      updateTable({ ...editingTable, name: tableName, section: tableSection, capacity: Number(tableCapacity) });
      setEditingTable(null);
    } else {
      addTable({ name: tableName, section: tableSection, capacity: Number(tableCapacity) });
    }
    setTableName(''); setTableCapacity(4);
  };

  const startEditTable = (table) => {
    setEditingTable(table); setTableName(table.name);
    setTableSection(table.section); setTableCapacity(table.capacity); setTableError('');
  };

  const tabItems = [
    { id: 'menu', icon: Utensils, label: 'Menu Editor' },
    { id: 'layout', icon: LayoutGrid, label: 'Floor Layout' },
    { id: 'staff', icon: Users, label: 'Staff & Pairing' },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <Card className="border-[var(--color-hairline)]" style={{ background: 'var(--color-canvas)' }}>
        <CardContent className="flex items-center justify-between flex-wrap gap-4 px-6 py-5">
          <div>
            <h1 className="typography-display-xl flex items-center gap-2.5" style={{ color: 'var(--color-ink)' }}>
              {currentRestaurant?.name} Admin Controls
              <Badge variant="outline" className="text-[9px] font-bold" style={{ color: 'var(--status-amber-text)', background: 'var(--status-amber-bg)', borderColor: 'var(--status-amber-border)' }}>
                Self-Serve Tier
              </Badge>
            </h1>
            <p className="typography-body-sm mt-0.5" style={{ color: 'var(--color-muted)' }}>
              Zero Developer Vendor Lock-In · Live Menu, Floor Layout & Staff Credentials
            </p>
          </div>

          <div className="flex gap-1 rounded-[var(--radius-sm)] p-1" style={{ background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)' }}>
            {tabItems.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-[var(--radius-sm)] border-none cursor-pointer transition-all"
                style={{
                  fontFamily: 'var(--font-body)',
                  color: activeTab === tab.id ? 'var(--color-on-primary)' : 'var(--color-ink)',
                  background: activeTab === tab.id ? 'var(--color-primary)' : 'transparent',
                }}
              >
                <tab.icon size={15} />
                {tab.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Menu Editor */}
      {activeTab === 'menu' && (
        <div className="grid gap-5" style={{ gridTemplateColumns: '340px 1fr' }}>
          <Card className="border-[var(--color-hairline)]">
            <CardHeader className="px-6 pt-6 pb-4">
              <CardTitle className="typography-display-md" style={{ color: 'var(--color-ink)' }}>
                {editingItem ? 'Edit Dish' : 'Add New Dish'}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <form onSubmit={handleSaveMenuItem} className="flex flex-col gap-3.5">
                <div>
                  <Label className="typography-caption-sm font-semibold" style={{ color: menuError ? 'var(--color-primary-error-text)' : 'var(--color-muted)' }}>
                    Dish Name *
                  </Label>
                  <Input
                    type="text" placeholder="e.g. Butter Chicken" value={itemName}
                    onChange={(e) => { setItemName(e.target.value); setMenuError(''); }}
                    className="mt-1 h-12"
                  />
                  {menuError && <div className="text-xs mt-1" style={{ color: 'var(--color-primary-error-text)' }}>{menuError}</div>}
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <Label className="typography-caption-sm font-semibold" style={{ color: 'var(--color-muted)' }}>Price ({currency}) *</Label>
                    <Input type="number" placeholder="280" value={itemPrice} onChange={(e) => setItemPrice(e.target.value)} className="mt-1 h-12 font-mono" />
                  </div>
                  <div>
                    <Label className="typography-caption-sm font-semibold" style={{ color: 'var(--color-muted)' }}>Category</Label>
                    <select value={itemCategory} onChange={(e) => setItemCategory(e.target.value)}
                      className="mt-1 h-12 w-full rounded-[var(--radius-sm)] border px-3 text-[13px]"
                      style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)', color: 'var(--color-ink)', fontFamily: 'var(--font-body)' }}>
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

                <label className="typography-body-sm flex items-center gap-2 cursor-pointer mt-1" style={{ color: 'var(--color-ink)' }}>
                  <input type="checkbox" checked={itemIsVeg} onChange={(e) => setItemIsVeg(e.target.checked)} />
                  Vegetarian Dish
                </label>

                <div className="flex gap-2.5 mt-2">
                  <Button type="submit" className="flex-1 h-12">
                    <Save size={16} /> {editingItem ? 'Update Dish' : 'Save Dish'}
                  </Button>
                  {editingItem && (
                    <Button type="button" variant="outline" className="h-12 px-4"
                      onClick={() => { setEditingItem(null); setItemName(''); setItemPrice(''); setMenuError(''); }}>
                      <X size={16} />
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

          <Card className="border-[var(--color-hairline)]">
            <CardContent className="px-6 py-6">
              <div className="flex flex-col gap-2.5">
                {menu.map(item => (
                  <div key={item.id} className="flex items-center justify-between rounded-[var(--radius-md)] border p-3 px-4"
                    style={{ background: 'var(--color-surface-soft)', borderColor: 'var(--color-hairline)' }}>
                    <div className="flex items-center gap-3">
                      <VegBadge isVeg={item.isVeg} />
                      <div>
                        <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{item.name}</div>
                        <div className="typography-body-sm text-xs" style={{ color: 'var(--color-muted)' }}>
                          {item.category} · <strong className="font-mono" style={{ color: 'var(--color-primary)' }}>{currency}{item.price}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5">
                      <Badge variant="outline" className="text-[8px] font-bold cursor-pointer"
                        onClick={() => updateMenuItem({ ...item, available: !item.available })}
                        style={{
                          color: item.available ? 'var(--status-green-text)' : 'var(--status-rust-text)',
                          background: item.available ? 'var(--status-green-bg)' : 'var(--status-rust-bg)',
                          borderColor: item.available ? 'var(--status-green-border)' : 'var(--status-rust-border)',
                        }}>
                        {item.available ? 'In Stock' : 'Sold Out'}
                      </Badge>
                      <button onClick={() => startEditMenu(item)} className="p-1.5 border-none bg-transparent cursor-pointer" style={{ color: 'var(--color-muted)' }}>
                        <Edit2 size={15} />
                      </button>
                      <button onClick={() => deleteMenuItem(item.id)} className="p-1.5 border-none bg-transparent cursor-pointer" style={{ color: 'var(--status-rust-text)' }}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Floor Layout */}
      {activeTab === 'layout' && (
        <div className="grid gap-5" style={{ gridTemplateColumns: '340px 1fr' }}>
          <Card className="border-[var(--color-hairline)]">
            <CardHeader className="px-6 pt-6 pb-4">
              <CardTitle className="typography-display-md" style={{ color: 'var(--color-ink)' }}>
                {editingTable ? 'Edit Table' : 'Add New Table'}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <form onSubmit={handleSaveTable} className="flex flex-col gap-3.5">
                <div>
                  <Label className="typography-caption-sm font-semibold" style={{ color: tableError ? 'var(--color-primary-error-text)' : 'var(--color-muted)' }}>
                    Table Name / Code *
                  </Label>
                  <Input type="text" placeholder="e.g. T13" value={tableName}
                    onChange={(e) => { setTableName(e.target.value); setTableError(''); }}
                    className="mt-1 h-12 font-mono" />
                  {tableError && <div className="text-xs mt-1" style={{ color: 'var(--color-primary-error-text)' }}>{tableError}</div>}
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <Label className="typography-caption-sm font-semibold" style={{ color: 'var(--color-muted)' }}>Capacity</Label>
                    <Input type="number" min="1" value={tableCapacity} onChange={(e) => setTableCapacity(e.target.value)} className="mt-1 h-12 font-mono" />
                  </div>
                  <div>
                    <Label className="typography-caption-sm font-semibold" style={{ color: 'var(--color-muted)' }}>Section</Label>
                    <select value={tableSection} onChange={(e) => setTableSection(e.target.value)}
                      className="mt-1 h-12 w-full rounded-[var(--radius-sm)] border px-3 text-[13px]"
                      style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)', color: 'var(--color-ink)', fontFamily: 'var(--font-body)' }}>
                      <option value="Main Hall">Main Hall</option>
                      <option value="AC Room">AC Room</option>
                      <option value="Family Room">Family Room</option>
                      <option value="Garden Lawn">Garden Lawn</option>
                      <option value="Bistro Area">Bistro Area</option>
                    </select>
                  </div>
                </div>

                <Button type="submit" className="mt-2 h-12">
                  <Save size={16} /> {editingTable ? 'Update Table' : 'Add Table'}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="border-[var(--color-hairline)]">
            <CardContent className="px-6 py-6">
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
                {tables.map(t => (
                  <div key={t.id} className="rounded-[var(--radius-md)] border p-3.5 text-center"
                    style={{ background: 'var(--color-surface-soft)', borderColor: 'var(--color-hairline)' }}>
                    <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{t.name}</div>
                    <div className="typography-body-sm text-[11px] mt-0.5" style={{ color: 'var(--color-muted)' }}>
                      {t.section} · {t.capacity}p
                    </div>
                    <div className="flex justify-center gap-2.5 mt-2.5">
                      <button onClick={() => startEditTable(t)} className="border-none bg-transparent cursor-pointer" style={{ color: 'var(--color-muted)' }}>
                        <Edit2 size={14} />
                      </button>
                      <button onClick={() => deleteTable(t.id)} className="border-none bg-transparent cursor-pointer" style={{ color: 'var(--status-rust-text)' }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Staff & Pairing */}
      {activeTab === 'staff' && (
        <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 360px' }}>
          <Card className="border-[var(--color-hairline)]">
            <CardHeader className="px-6 pt-6 pb-4">
              <CardTitle className="typography-display-md flex items-center gap-2.5" style={{ color: 'var(--color-ink)' }}>
                <Users size={20} style={{ color: 'var(--color-primary)' }} /> Scoped Staff Accounts ({staff.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <div className="flex flex-col gap-2.5">
                {staff.map(s => (
                  <div key={s.id} className="flex items-center justify-between rounded-[var(--radius-md)] border p-3.5 px-4"
                    style={{ background: 'var(--color-surface-soft)', borderColor: 'var(--color-hairline)' }}>
                    <div>
                      <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>{s.name}</div>
                      <div className="typography-body-sm text-xs mt-0.5" style={{ color: 'var(--color-muted)' }}>
                        Role: <strong style={{ color: 'var(--color-primary)' }}>{s.role}</strong> | Auth PIN: <code className="font-mono font-bold" style={{ color: 'var(--status-green-text)' }}>{s.pin}</code>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[8px] font-bold"
                      style={{ color: 'var(--status-green-text)', background: 'var(--status-green-bg)', borderColor: 'var(--status-green-border)' }}>
                      Active
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-dashed border-[var(--color-primary)] text-center">
            <CardContent className="flex flex-col items-center gap-3.5 px-6 py-6">
              <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: 'var(--status-amber-bg)', color: 'var(--color-primary)' }}>
                <QrCode size={24} />
              </div>
              <div className="typography-display-sm" style={{ color: 'var(--color-ink)' }}>Restaurant KDS Pairing Code</div>
              <div className="font-mono text-[28px] font-bold rounded-[var(--radius-sm)] px-4 py-2.5"
                style={{ color: 'var(--color-primary)', background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)' }}>
                {currentRestaurant?.pairingCode}
              </div>
              <p className="typography-body-sm" style={{ color: 'var(--color-muted)', lineHeight: 1.5 }}>
                Waiters enter this code once on their handsets to pair directly to <strong>{currentRestaurant?.name}</strong>'s LAN kitchen display.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};
