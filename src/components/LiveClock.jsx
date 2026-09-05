import React, { useState, useEffect } from 'react';

export const LiveClock = () => {
  const [t, setT] = useState(new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 1000); return () => clearInterval(i); }, []);
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '22px', fontWeight: 700, color: 'var(--color-primary)', letterSpacing: '-0.5px' }}>
        {t.getHours().toString().padStart(2,'0')}:{t.getMinutes().toString().padStart(2,'0')}
        <span style={{ fontSize: '13px', color: 'var(--color-muted)', marginLeft: '4px' }}>:{t.getSeconds().toString().padStart(2,'0')}</span>
      </div>
      <div className="typography-caption-sm" style={{ color: 'var(--color-muted)', textTransform: 'uppercase' }}>
        {t.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
      </div>
    </div>
  );
};
