import React from 'react';
import { usePos } from '../context/PosContext';
import { Users, Clock, Armchair, Lock } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

const STATUS = {
  available: { label: 'Open',       color: 'var(--status-green-text)',  bg: 'var(--status-green-bg)', border: 'var(--status-green-border)' },
  occupied:  { label: 'Dining',     color: 'var(--status-rust-text)',   bg: 'var(--status-rust-bg)',  border: 'var(--status-rust-border)'  },
  kot:       { label: 'In Kitchen', color: 'var(--status-amber-text)',  bg: 'var(--status-amber-bg)', border: 'var(--status-amber-border)' },
  ready:     { label: 'Bill Ready', color: 'var(--status-blue-text)',   bg: 'var(--status-blue-bg)',  border: 'var(--status-blue-border)'  },
};

const elapsed = (iso) => {
  if (!iso) return null;
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'Just in' : `${m}m`;
};

export const FloorGridSkeleton = () => (
  <div className="grid grid-cols-3 gap-2">
    {[1, 2, 3, 4, 5, 6].map(i => (
      <div key={i} className="skeleton skeleton-card rounded-[var(--radius-md)]" />
    ))}
  </div>
);

export const FloorGrid = ({ selectedTable, onSelectTable, tables: propTables, sections: propSections, onClearTableBill, isLoading = false, drafts = {}, onOpenPairing, hubConnected, connStatus, isEnrolled }) => {
  const contextPos = usePos() || {};
  const tables = propTables || contextPos.tables || [];
  const clearTableBill = onClearTableBill || contextPos.clearTableBill;
  const [selectedSection, setSelectedSection] = React.useState('All');
  // Section chips follow what the hub reports (reception can add or rename
  // sections); fall back to the sections the tables themselves use.
  const sectionNames = propSections && propSections.length > 0
    ? propSections
    : Array.from(new Set(tables.map(t => t.section).filter(Boolean)));
  const sections = ['All', ...sectionNames];

  // A section renamed or removed while selected would leave an empty grid.
  React.useEffect(() => {
    if (selectedSection !== 'All' && !sectionNames.includes(selectedSection)) setSelectedSection('All');
  }, [sectionNames.join('|'), selectedSection]);
  const shown = selectedSection === 'All' ? tables : tables.filter(t => t.section === selectedSection);

  const [clearedTableIds, setClearedTableIds] = React.useState({});

  if (isLoading) return <FloorGridSkeleton />;

  const isUnauthorized = connStatus === 'unauthorized' || isEnrolled === false;

  const handleClearClick = async (e, tableId) => {
    e.stopPropagation();
    if (clearedTableIds[tableId]) return;
    if (!window.confirm(`Clear the bill for this table? This cannot be undone.`)) return;
    setClearedTableIds(prev => ({ ...prev, [tableId]: true }));
    try { await clearTableBill(tableId); } finally { setClearedTableIds(prev => ({ ...prev, [tableId]: false })); }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Section Filter */}
      <div className="chip-group">
        {sections.map(s => (
          <button key={s} onClick={() => setSelectedSection(s)} className={`chip${selectedSection === s ? ' active' : ''}`}>{s}</button>
        ))}
      </div>

      {/* Empty State */}
      {shown.length === 0 && !isLoading && (
        <div className="text-center rounded-[var(--radius-md)] border border-dashed p-8"
          style={{ color: 'var(--color-muted)', borderColor: 'var(--color-hairline)', background: 'var(--color-canvas)' }}>
          {isUnauthorized
            ? <Lock size={32} className="mx-auto mb-2" style={{ color: 'var(--color-muted)' }} />
            : <Armchair size={32} className="mx-auto mb-2" style={{ color: 'var(--color-muted)' }} />}
          <div className="font-bold mb-1" style={{ color: 'var(--color-ink)', fontFamily: 'var(--font-display)' }}>
            {isUnauthorized
              ? 'Handset Not Enrolled'
              : hubConnected === false
                ? 'No tables loaded'
                : 'No tables in this section'}
          </div>
          <div className="typography-body-sm mb-3" style={{ color: 'var(--color-muted)' }}>
            {isUnauthorized
              ? 'Enter the 6-character enrollment code shown on the Kitchen Display to view tables and take orders.'
              : hubConnected === false
                ? 'Connect to the kitchen hub to load your floor plan.'
                : 'Try selecting a different section above.'}
          </div>
          {(isUnauthorized || hubConnected === false) && onOpenPairing && (
            <Button size="sm" onClick={onOpenPairing}>
              {isUnauthorized ? 'Enter Enrollment Code' : 'Connect to Hub'}
            </Button>
          )}
        </div>
      )}

      {/* Table Grid */}
      <div className="floor-grid">
        {shown.map(t => {
          const st = STATUS[t.status] || STATUS.available;
          const sel = selectedTable === t.id;
          const mins = elapsed(t.occupiedSince);
          // A draft is { lineKey: row } and each row carries its own quantity (see WaiterApp), so add the quantities up.
          const draftCount = drafts[t.id] ? Object.values(drafts[t.id]).reduce((sum, row) => sum + (Number(row?.qty) || 0), 0) : 0;

          return (
            <div key={t.id} onClick={() => onSelectTable(t.id)} className={`table-card${sel ? ' selected' : ''}`}>
              <span className="absolute top-2 right-2 w-[7px] h-[7px] rounded-full" style={{ background: st.color }} />

              {draftCount > 0 && (
                <Badge variant="default" className="absolute top-1.5 left-1.5 text-[8px] px-1.5 py-0 font-mono"
                  style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
                  {draftCount}
                </Badge>
              )}

              <div className="typography-title-md" style={{ color: 'var(--color-ink)', letterSpacing: '-0.3px' }}>{t.name}</div>

              <div className="flex items-center justify-center gap-[3px] mt-[2px]" style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                <Users size={10} /> {t.capacity}p
              </div>

              <Badge variant="outline" className="mt-1.5 text-[8px] font-bold"
                style={{ color: st.color, background: st.bg, borderColor: st.border }}>
                {st.label}
              </Badge>

              {t.activeOrderTotal > 0 && (
                <div className="font-mono text-xs font-bold mt-1" style={{ color: 'var(--color-primary)' }}>₹{t.activeOrderTotal}</div>
              )}

              {mins && (
                <div className="flex items-center justify-center gap-[3px] mt-[2px]" style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                  <Clock size={9} /> {mins}
                </div>
              )}

              {t.status === 'ready' && (
                <button
                  onClick={e => handleClearClick(e, t.id)}
                  disabled={!!clearedTableIds[t.id]}
                  className="typography-uppercase-tag w-full mt-1.5 py-1 rounded-[var(--radius-sm)] border cursor-pointer"
                  style={{
                    background: 'var(--status-blue-bg)', color: 'var(--status-blue-text)',
                    borderColor: 'var(--status-blue-border)',
                    opacity: clearedTableIds[t.id] ? 0.6 : 1,
                    cursor: clearedTableIds[t.id] ? 'not-allowed' : 'pointer'
                  }}>
                  {clearedTableIds[t.id] ? 'Clearing…' : 'Clear Bill'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
