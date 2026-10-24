import { STATIONS, STATION_LABEL } from '../lib/ticketView';

export function StationTabs({ stationFilter, setStationFilter, counts }) {
  return (
    <div role="tablist" aria-label="Station" style={{ display: 'flex', gap: 'var(--spacing-sm)', flexWrap: 'wrap', marginBottom: 'var(--spacing-base)' }}>
      {['all', ...STATIONS].map(s => {
        const selected = stationFilter === s;
        return (
          <button
            key={s}
            role="tab"
            aria-selected={selected}
            onClick={() => setStationFilter(s)}
            style={{
              background: selected ? 'var(--color-primary)' : 'var(--color-surface-soft)',
              color: selected ? 'var(--color-on-primary)' : 'var(--color-body)',
              border: `1px solid ${selected ? 'var(--color-primary)' : 'var(--color-hairline)'}`,
              padding: '8px 16px', borderRadius: 'var(--radius-full)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '8px', minHeight: '40px'
            }}
          >
            {s === 'all' ? 'All stations' : STATION_LABEL[s]}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', opacity: 0.85 }}>{counts[s]}</span>
          </button>
        );
      })}
    </div>
  );
}
