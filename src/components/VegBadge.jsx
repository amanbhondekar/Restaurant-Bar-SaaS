import React from 'react';

const COLORS = {
  veg: 'var(--status-green-text)',
  nonveg: 'var(--status-rust-text)',
};

export const VegBadge = ({ isVeg, size = 10 }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: size + 4,
      height: size + 4,
      border: `1.5px solid ${isVeg ? COLORS.veg : COLORS.nonveg}`,
      borderRadius: '2px',
      flexShrink: 0,
    }}
  >
    <span
      style={{
        width: size - 2,
        height: size - 2,
        borderRadius: '50%',
        background: isVeg ? COLORS.veg : COLORS.nonveg,
      }}
    />
  </span>
);
