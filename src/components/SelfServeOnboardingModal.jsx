import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Sparkles, Building2, LayoutGrid, Utensils, Users, CheckCircle2, ArrowRight, ArrowLeft, QrCode } from 'lucide-react';
import { VegBadge } from './VegBadge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export const SelfServeOnboardingModal = ({ isOpen, onClose }) => {
  const { onboardNewRestaurant } = usePos();
  const [step, setStep] = useState(1);
  const [validationError, setValidationError] = useState('');

  const [profile, setProfile] = useState({
    name: '',
    cuisine: 'Multi-Cuisine',
    city: '',
    address: '',
    phone: '',
    plan: 'pro'
  });

  const [tables, setTables] = useState([
    { name: 'T1', section: 'Main Hall', capacity: 4 },
    { name: 'T2', section: 'Main Hall', capacity: 2 },
    { name: 'T3', section: 'Main Hall', capacity: 4 },
    { name: 'T4', section: 'AC Room', capacity: 4 },
  ]);
  const [newTable, setNewTable] = useState({ name: '', section: 'Main Hall', capacity: 4 });

  const [menuItems, setMenuItems] = useState([
    { name: 'Paneer Butter Masala', price: 240, category: 'Main Course', isVeg: true },
    { name: 'Chicken Biryani', price: 280, category: 'Biryani', isVeg: false },
    { name: 'Butter Naan', price: 60, category: 'Breads', isVeg: true },
  ]);
  const [newItem, setNewItem] = useState({ name: '', price: '', category: 'Main Course', isVeg: true });

  const [staffMembers] = useState([
    { name: 'Manager Account', role: 'manager', pin: '1234' },
    { name: 'Waiter (W1)', role: 'waiter', pin: '1111' },
  ]);

  const handleAddTable = () => {
    if (!newTable.name) return;
    setTables([...tables, newTable]);
    setNewTable({ name: '', section: 'Main Hall', capacity: 4 });
  };

  const handleAddMenuItem = () => {
    if (!newItem.name || !newItem.price) return;
    setMenuItems([...menuItems, { ...newItem, price: Number(newItem.price) }]);
    setNewItem({ name: '', price: '', category: 'Main Course', isVeg: true });
  };

  const handleFinishOnboarding = () => {
    if (!profile.name || !profile.city) {
      setValidationError('Please complete the restaurant name and city');
      return;
    }

    onboardNewRestaurant({
      profile,
      layout: tables,
      menuItems,
      staffMembers
    });

    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-[640px] p-0 gap-0 max-h-[90vh] flex flex-col"
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <DialogHeader className="flex flex-row items-center gap-3 p-5 bg-muted border-b">
          <div style={{
            width: '40px', height: '40px', borderRadius: 'var(--radius-full)',
            background: 'var(--color-primary)', color: 'var(--color-on-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <Sparkles size={20} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <DialogTitle>Self-Serve Restaurant Onboarding</DialogTitle>
            <DialogDescription>Zero-Developer Setup · Ready in 60 Seconds</DialogDescription>
          </div>
        </DialogHeader>

        {/* Step Indicator */}
        <div style={{
          display: 'flex', borderBottom: '1px solid var(--color-hairline)', background: 'var(--color-surface-soft)'
        }}>
          {[
            { num: 1, label: 'Profile & Plan', icon: Building2 },
            { num: 2, label: 'Floor Layout', icon: LayoutGrid },
            { num: 3, label: 'Menu Setup', icon: Utensils },
            { num: 4, label: 'Staff & Launch', icon: Users },
          ].map(s => (
            <div key={s.num} style={{
              flex: 1, padding: '14px 8px', textAlign: 'center',
              borderBottom: step === s.num ? '2px solid var(--color-primary)' : '2px solid transparent',
              color: step === s.num ? 'var(--color-primary)' : step > s.num ? 'var(--status-green-text)' : 'var(--color-muted)',
              fontSize: '12px', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px'
            }}>
              {step > s.num ? <CheckCircle2 size={14} /> : <s.icon size={14} />}
              {s.label}
            </div>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {step === 1 && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rest-name">Restaurant Name *</Label>
                <Input
                  id="rest-name"
                  placeholder="e.g. Royal Curry House"
                  value={profile.name}
                  onChange={e => { setProfile({ ...profile, name: e.target.value }); setValidationError(''); }}
                  aria-invalid={!!(validationError && !profile.name)}
                  className="h-10"
                />
                {validationError && !profile.name && (
                  <div className="text-xs text-destructive">Restaurant name is required</div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rest-city">City *</Label>
                  <Input
                    id="rest-city"
                    placeholder="e.g. Nagpur / Pune"
                    value={profile.city}
                    onChange={e => { setProfile({ ...profile, city: e.target.value }); setValidationError(''); }}
                    aria-invalid={!!(validationError && !profile.city)}
                    className="h-10"
                  />
                  {validationError && !profile.city && (
                    <div className="text-xs text-destructive">City is required</div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rest-cuisine">Cuisine Type</Label>
                  <Input
                    id="rest-cuisine"
                    placeholder="e.g. North Indian & Saoji"
                    value={profile.cuisine}
                    onChange={e => setProfile({ ...profile, cuisine: e.target.value })}
                    className="h-10"
                  />
                </div>
              </div>

              <div>
                <Label>Subscription Plan Tier</Label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginTop: '6px' }}>
                  {[
                    { id: 'starter', name: 'Starter Tier', desc: 'Core POS & KDS' },
                    { id: 'pro', name: 'Pro Tier', desc: 'Core + Queue + Analytics' },
                    { id: 'enterprise', name: 'Enterprise', desc: 'Multi-Branch & Custom' }
                  ].map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setProfile({ ...profile, plan: p.id })}
                      style={{
                        padding: '14px', borderRadius: 'var(--radius-sm)', textAlign: 'left',
                        background: profile.plan === p.id ? 'var(--status-amber-bg)' : 'var(--color-surface-soft)',
                        border: `1px solid ${profile.plan === p.id ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
                        color: profile.plan === p.id ? 'var(--color-primary)' : 'var(--color-ink)',
                        cursor: 'pointer'
                      }}
                    >
                      <div className="typography-title-md">{p.name}</div>
                      <div className="typography-body-sm" style={{ fontSize: '11px', color: 'var(--color-muted)', marginTop: '2px' }}>{p.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="typography-title-md">Configured Dining Tables ({tables.length})</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px' }}>
                {tables.map((t, i) => (
                  <div key={i} style={{
                    padding: '10px 12px', background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)',
                    borderRadius: 'var(--radius-sm)'
                  }}>
                    <strong style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-display)' }}>{t.name}</strong> ({t.capacity} seats)
                    <div className="typography-body-sm" style={{ fontSize: '11px', color: 'var(--color-muted)' }}>{t.section}</div>
                  </div>
                ))}
              </div>

              <div style={{
                background: 'var(--color-surface-soft)', padding: '16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-hairline)',
                display: 'grid', gridTemplateColumns: '1fr 1fr 80px auto', gap: '10px', alignItems: 'center'
              }}>
                <Input
                  placeholder="Table (T5)"
                  value={newTable.name}
                  onChange={e => setNewTable({ ...newTable, name: e.target.value })}
                  className="h-11"
                />
                <Input
                  placeholder="Section (AC)"
                  value={newTable.section}
                  onChange={e => setNewTable({ ...newTable, section: e.target.value })}
                  className="h-11"
                />
                <Input
                  type="number"
                  placeholder="Seats"
                  value={newTable.capacity}
                  onChange={e => setNewTable({ ...newTable, capacity: Number(e.target.value) })}
                  className="h-11 font-mono"
                />
                <Button type="button" size="lg" className="h-11" onClick={handleAddTable}>+ Add</Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="typography-title-md">Initial Menu Items ({menuItems.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto' }}>
                {menuItems.map((m, i) => (
                  <div key={i} style={{
                    padding: '10px 14px', background: 'var(--color-surface-soft)', border: '1px solid var(--color-hairline)',
                    borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                  }}>
                    <div>
                      <span className="typography-body-sm">
                        <VegBadge isVeg={m.isVeg} size={8} /> <strong style={{ color: 'var(--color-ink)' }}>{m.name}</strong>
                      </span>
                      <span className="typography-body-sm" style={{ fontSize: '11px', color: 'var(--color-muted)', marginLeft: '8px' }}>({m.category})</span>
                    </div>
                    <strong style={{ color: 'var(--color-primary)', fontFamily: 'var(--font-mono)' }}>₹{m.price}</strong>
                  </div>
                ))}
              </div>

              <div style={{
                background: 'var(--color-surface-soft)', padding: '16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-hairline)',
                display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr auto', gap: '10px', alignItems: 'center'
              }}>
                <Input
                  placeholder="Dish Name"
                  value={newItem.name}
                  onChange={e => setNewItem({ ...newItem, name: e.target.value })}
                  className="h-11"
                />
                <Input
                  type="number"
                  placeholder="Price"
                  value={newItem.price}
                  onChange={e => setNewItem({ ...newItem, price: e.target.value })}
                  className="h-11 font-mono"
                />
                <select
                  value={newItem.category}
                  onChange={e => setNewItem({ ...newItem, category: e.target.value })}
                  className="h-11 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <option value="Starters">Starters</option>
                  <option value="Main Course">Main Course</option>
                  <option value="Biryani">Biryani</option>
                  <option value="Breads">Breads</option>
                  <option value="Beverages">Beverages</option>
                </select>
                <Button type="button" size="lg" className="h-11" onClick={handleAddMenuItem}>+ Add</Button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div style={{
                background: 'var(--status-amber-bg)', border: '1px solid var(--status-amber-border)',
                padding: '16px', borderRadius: 'var(--radius-md)', color: 'var(--status-amber-text)'
              }}>
                <div className="typography-title-md" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <QrCode size={18} /> Restaurant Setup Summary
                </div>
                <div className="typography-body-sm" style={{ marginTop: '6px', color: 'var(--color-ink)' }}>
                  <strong>{profile.name}</strong> · {profile.city} ({profile.plan.toUpperCase()} Plan)
                  <br />
                  {tables.length} Tables configured | {menuItems.length} Menu items ready
                </div>
              </div>

              <div className="typography-title-md">Invited Staff Accounts</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                {staffMembers.map((s, i) => (
                  <div key={i} style={{ padding: '12px', background: 'var(--color-surface-soft)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-hairline)' }}>
                    <div className="typography-title-md">{s.name}</div>
                    <div className="typography-body-sm" style={{ fontSize: '11px', color: 'var(--color-muted)', marginTop: '2px' }}>Role: {s.role} | PIN: {s.pin}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px', background: 'var(--color-surface-soft)',
          borderTop: '1px solid var(--color-hairline)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        }}>
          {step > 1 ? (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              <ArrowLeft /> Back
            </Button>
          ) : <div />}

          {step < 4 ? (
            <Button
              onClick={() => {
                if (step === 1 && (!profile.name || !profile.city)) {
                  setValidationError('Please enter restaurant name and city');
                  return;
                }
                setValidationError('');
                setStep(step + 1);
              }}
            >
              Continue <ArrowRight />
            </Button>
          ) : (
            <Button onClick={handleFinishOnboarding} className="bg-[var(--status-green-text)] hover:bg-[var(--status-green-text)]/90">
              <CheckCircle2 /> Launch Tenant POS Now!
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
