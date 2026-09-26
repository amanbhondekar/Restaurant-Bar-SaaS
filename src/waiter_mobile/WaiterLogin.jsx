import React, { useEffect, useState } from 'react';
import { authFetch } from '../services/hubAuth';
import { UserCircle2, KeyRound, RefreshCw, AlertTriangle } from 'lucide-react';

/**
 * PIN-login step, sits between device enrolment and the floor grid.
 *
 * Reception has already picked a device token (that's PR 7 territory); this
 * screen picks a *person* — the waiter whose name should be stamped on every
 * ticket coming from this handset. `onLogin(waiter)` fires once the hub has
 * verified the 4-digit PIN; the parent persists the choice to localStorage.
 */
export const WaiterLogin = ({ hubUrl, onLogin, currentRestaurant }) => {
  const [waiters, setWaiters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // waiter | null
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const cleanHub = (hubUrl || '').replace(/\/+$/, '');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await authFetch(`${cleanHub}/waiters`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && Array.isArray(data.waiters)) {
          setWaiters(data.waiters);
          setError(data.waiters.length === 0 ? 'No waiters set up yet. Ask reception to add one.' : '');
        } else {
          setError(data.error || 'Could not load waiters from hub.');
        }
      } catch (err) {
        if (!cancelled) setError(`Hub unreachable: ${err.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cleanHub]);

  // Auto-submit as soon as reception types the fourth digit — fewer taps at
  // the register, and the request round-trips in <10ms on LAN.
  useEffect(() => {
    if (pin.length === 4 && selected && !busy) {
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const submit = async () => {
    if (!selected || pin.length !== 4) return;
    setBusy(true);
    setError('');
    try {
      const res = await authFetch(`${cleanHub}/waiters/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waiter_id: selected.id, pin })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.waiter) {
        onLogin(data.waiter);
      } else {
        setPin('');
        setError(data.error || 'Wrong PIN.');
      }
    } catch (err) {
      setError(`Hub unreachable: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--color-canvas)', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '24px', gap: '18px'
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 28, marginBottom: 4 }}>🍽</div>
        <div className="typography-title-md" style={{ color: 'var(--color-ink)' }}>
          {currentRestaurant?.name || 'Kullina POS'}
        </div>
        <div className="typography-body-sm" style={{ color: 'var(--color-muted)' }}>
          Sign in as your waiter to start taking orders
        </div>
      </div>

      {loading && (
        <div style={{ color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} className="spin" /> Loading waiters…
        </div>
      )}

      {!loading && !selected && (
        <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {waiters.map(w => (
            <button
              key={w.id}
              onClick={() => { setSelected(w); setPin(''); setError(''); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px', borderRadius: 'var(--radius-md)',
                background: '#fff', border: '1px solid var(--color-hairline)',
                fontWeight: 700, fontSize: 15, color: 'var(--color-ink)',
                textAlign: 'left', cursor: 'pointer'
              }}
            >
              <UserCircle2 size={20} style={{ color: 'var(--color-primary)' }} />
              {w.name}
            </button>
          ))}
        </div>
      )}

      {!loading && selected && (
        <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <KeyRound size={14} /> PIN for <strong style={{ color: 'var(--color-ink)' }}>{selected.name}</strong>
          </div>
          <input
            type="password"
            inputMode="numeric"
            pattern="\d*"
            maxLength={4}
            autoFocus
            value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="••••"
            style={{
              width: 200, padding: '14px', textAlign: 'center',
              fontSize: 28, letterSpacing: '18px', fontFamily: 'var(--font-mono)',
              border: `1px solid ${error ? 'var(--status-rust-border)' : 'var(--color-hairline)'}`,
              borderRadius: 'var(--radius-md)', color: 'var(--color-ink)',
              background: '#fff'
            }}
          />
          <button
            onClick={() => { setSelected(null); setPin(''); setError(''); }}
            disabled={busy}
            style={{
              background: 'transparent', color: 'var(--color-muted)', border: 'none',
              fontSize: 12, textDecoration: 'underline', cursor: 'pointer'
            }}
          >
            ← switch waiter
          </button>
        </div>
      )}

      {error && (
        <div style={{
          background: 'var(--status-rust-bg)', color: 'var(--status-rust-text)',
          border: '1px solid var(--status-rust-border)', padding: '8px 12px', borderRadius: 8,
          fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, maxWidth: 360
        }}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}
    </div>
  );
};
