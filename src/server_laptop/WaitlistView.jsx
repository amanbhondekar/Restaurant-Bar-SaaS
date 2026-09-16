import React, { useState } from 'react';
import { usePos } from '../context/PosContext';
import { Users, Clock, Plus, CheckCircle2, UserX, Armchair } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';

export const WaitlistView = () => {
  const { waitlist, addWaitlistEntry, updateWaitlistStatus, tables } = usePos();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [partySize, setPartySize] = useState(4);
  const [section, setSection] = useState('Main Hall');
  const [selectedAssignedTable, setSelectedAssignedTable] = useState({});

  const availableTables = tables.filter(t => t.status === 'available');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;

    const activeWaitingCount = waitlist.filter(w => w.status === 'waiting').length;
    const estimatedWaitMins = Math.max(5, 10 + activeWaitingCount * 5);

    addWaitlistEntry({ name, phone, partySize: Number(partySize), section, estimatedWaitMins });
    setName(''); setPhone(''); setPartySize(4);
  };

  const handleSeatParty = (waitlistId) => {
    const tableId = selectedAssignedTable[waitlistId];
    if (!tableId) return;
    updateWaitlistStatus(waitlistId, 'seated', Number(tableId));
  };

  return (
    <div className="grid gap-5" style={{ gridTemplateColumns: '340px 1fr' }}>
      {/* Walk-in Form */}
      <Card className="border-[var(--color-hairline)]">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="typography-display-md flex items-center gap-2.5" style={{ color: 'var(--color-ink)' }}>
            <Users size={20} style={{ color: 'var(--color-primary)' }} />
            Log Walk-In Party
          </CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="px-6 pt-5 pb-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
            <div>
              <Label className="typography-caption-sm font-semibold" style={{ color: 'var(--color-muted)' }}>Guest / Family Name *</Label>
              <Input type="text" required placeholder="e.g. Patil Family" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-12" />
            </div>

            <div>
              <Label className="typography-caption-sm font-semibold" style={{ color: 'var(--color-muted)' }}>Phone Number</Label>
              <Input type="text" placeholder="e.g. 98220XXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1 h-12" />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <Label className="typography-caption-sm font-semibold" style={{ color: 'var(--color-muted)' }}>Party Size</Label>
                <Input type="number" min="1" max="20" value={partySize} onChange={(e) => setPartySize(e.target.value)} className="mt-1 h-12 font-mono" />
              </div>
              <div>
                <Label className="typography-caption-sm font-semibold" style={{ color: 'var(--color-muted)' }}>Seating Area</Label>
                <select value={section} onChange={(e) => setSection(e.target.value)}
                  className="mt-1 h-12 w-full rounded-[var(--radius-sm)] border px-3 text-[13px]"
                  style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)', color: 'var(--color-ink)', fontFamily: 'var(--font-body)' }}>
                  <option value="Main Hall">Main Hall</option>
                  <option value="AC Room">AC Room</option>
                  <option value="Family Room">Family Room</option>
                </select>
              </div>
            </div>

            <Button type="submit" className="mt-2 h-12">
              <Plus size={16} /> Add to Queue
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Waitlist Log */}
      <Card className="border-[var(--color-hairline)]">
        <CardHeader className="flex flex-row items-center justify-between px-6 pt-6 pb-4">
          <CardTitle className="typography-display-md" style={{ color: 'var(--color-ink)' }}>
            Digital Queue & Turnaround Estimator
          </CardTitle>
          <span className="typography-body-sm" style={{ color: 'var(--color-muted)' }}>
            Waiting: <strong className="font-mono" style={{ color: 'var(--color-primary)' }}>{waitlist.filter(w => w.status === 'waiting').length}</strong>
          </span>
        </CardHeader>
        <Separator />
        <CardContent className="px-6 pt-5 pb-6">
          <div className="flex flex-col gap-3">
            {waitlist.length === 0 ? (
              <div className="typography-body-sm text-center rounded-[var(--radius-md)] border border-dashed p-9"
                style={{ color: 'var(--color-muted)', borderColor: 'var(--color-hairline)' }}>
                No parties currently waiting. Log walk-ins on the left panel.
              </div>
            ) : (
              waitlist.map(entry => {
                const isWaiting = entry.status === 'waiting';
                return (
                  <div key={entry.id} className="flex items-center justify-between flex-wrap gap-3 rounded-[var(--radius-md)] border p-3.5 px-4"
                    style={{ background: 'var(--color-surface-soft)', borderColor: 'var(--color-hairline)', opacity: isWaiting ? 1 : 0.65 }}>
                    <div className="flex items-center gap-3.5">
                      <div className="w-[42px] h-[42px] rounded-full flex items-center justify-center font-mono font-bold text-sm"
                        style={{
                          background: isWaiting ? 'var(--status-amber-bg)' : 'var(--color-surface-strong)',
                          color: isWaiting ? 'var(--color-primary)' : 'var(--color-muted)',
                        }}>
                        {entry.partySize}p
                      </div>
                      <div>
                        <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>
                          {entry.name} <span className="typography-body-sm" style={{ color: 'var(--color-muted)' }}>({entry.phone || 'No phone'})</span>
                        </div>
                        <div className="typography-body-sm text-xs mt-0.5 flex items-center gap-2" style={{ color: 'var(--color-muted)' }}>
                          <span>Area: <strong style={{ color: 'var(--color-ink)' }}>{entry.section}</strong></span>
                          <span>·</span>
                          <span className="flex items-center gap-1">
                            <Clock size={12} /> Est: <strong style={{ color: 'var(--color-primary)' }}>~{entry.estimatedWaitMins}m</strong>
                          </span>
                        </div>
                      </div>
                    </div>

                    {isWaiting ? (
                      <div className="flex items-center gap-2">
                        <select
                          onChange={(e) => setSelectedAssignedTable(prev => ({ ...prev, [entry.id]: e.target.value }))}
                          defaultValue=""
                          className="h-10 rounded-[var(--radius-sm)] border px-2.5 text-xs w-[180px]"
                          style={{ background: 'var(--color-canvas)', borderColor: 'var(--color-hairline)', color: 'var(--color-ink)', fontFamily: 'var(--font-body)' }}>
                          <option value="" disabled>Assign Open Table</option>
                          {availableTables.map(t => (
                            <option key={t.id} value={t.id}>Table {t.name} ({t.section} - {t.capacity} seats)</option>
                          ))}
                        </select>
                        <Button size="sm" className="h-10 px-3.5 text-[13px]" disabled={!selectedAssignedTable[entry.id]}
                          onClick={() => handleSeatParty(entry.id)}>
                          <Armchair size={14} /> Seat
                        </Button>
                        <Button variant="outline" size="sm" className="h-10 px-2.5"
                          onClick={() => updateWaitlistStatus(entry.id, 'cancelled')}
                          style={{ color: 'var(--status-rust-text)', borderColor: 'var(--status-rust-border)' }}>
                          <UserX size={14} />
                        </Button>
                      </div>
                    ) : (
                      <Badge variant="outline" className="text-[8px] font-bold"
                        style={{ color: entry.status === 'seated' ? 'var(--status-green-text)' : 'var(--color-muted)' }}>
                        {entry.status === 'seated' ? `Seated at Table T${entry.assignedTableId}` : 'Cancelled'}
                      </Badge>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
