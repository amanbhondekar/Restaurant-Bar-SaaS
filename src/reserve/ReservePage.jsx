import React, { useCallback, useEffect, useState } from 'react';
import { NOTE_MAX, checkRequest, codeFromPath, inputValue, requestBody } from './lib/form';

// The page where a guest asks a restaurant for a table (§4.6), opened from an address on a card or a screen, on the guest's own phone.
//
// It is a REQUEST, and says so: the restaurant decides, and answers by WhatsApp or by phone. It does not promise a table, it does not take
// a deposit, and it does not ask for anything the restaurant does not need to answer (a name, a number, how many, when). Plain on purpose,
// like the diner menu: nothing to install, no account, and it follows the phone's own light or dark setting.

const BLANK = { guest_name: '', phone: '', party_size: '2', at: '', note: '' };
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** The error under a field, tied to it so a screen reader reads it with the field. */
function Field({ id, label, error, hint, children }) {
  const described = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children, { id, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': described })}
      {hint && <p id={`${id}-hint`} className="hint">{hint}</p>}
      {error && <p id={`${id}-error`} className="error">{error}</p>}
    </div>
  );
}

export function ReservePage() {
  const code = codeFromPath(window.location.pathname);
  const [phase, setPhase] = useState(code ? 'loading' : 'unavailable');   // loading | ready | unavailable | failed | sent
  const [page, setPage] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [trap, setTrap] = useState('');
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [banner, setBanner] = useState(null);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const res = await fetch(`/public/booking/${code}`, { cache: 'no-store' });
      if (res.status === 404) return setPhase('unavailable');
      if (!res.ok) return setPhase('failed');
      setPage(await res.json());
      return setPhase('ready');
    } catch {
      return setPhase('failed');
    }
  }, [code]);
  useEffect(() => { if (code) load(); }, [code, load]);

  if (phase === 'loading') return <main className="wrap"><p aria-busy="true" className="muted">Loading…</p></main>;
  if (phase === 'unavailable') {
    return (
      <main className="wrap">
        <h1>This booking page is not available</h1>
        <p className="muted">The restaurant may have switched it off, or the address may have changed. Please phone them instead.</p>
      </main>
    );
  }
  if (phase === 'failed') {
    return (
      <main className="wrap">
        <p role="alert" className="error">We could not load this page. Please check your connection and try again.</p>
        <button type="button" className="primary" onClick={load}>Try again</button>
      </main>
    );
  }

  const { restaurant, limits } = page;
  const name = restaurant.name;

  if (phase === 'sent') {
    return (
      <main className="wrap" aria-live="polite">
        <h1>Request sent</h1>
        <p>{name} will message you to confirm. This is not a confirmed booking yet.</p>
        <button type="button" className="secondary" onClick={() => { setForm(BLANK); setTrap(''); setTried(false); setServerErrors({}); setBanner(null); setPhase('ready'); }}>
          Ask for another table
        </button>
      </main>
    );
  }

  const checked = checkRequest(form, limits);
  const shown = { ...(tried ? checked.errors : {}), ...serverErrors };
  const set = key => e => {
    setForm(f => ({ ...f, [key]: e.target.value }));
    setServerErrors(s => { if (!s[key]) return s; const { [key]: _gone, ...rest } = s; return rest; });
  };
  const now = Date.now();

  const submit = async event => {
    event.preventDefault();
    if (sending) return;
    setTried(true);
    setBanner(null);
    if (!checked.ok) return;
    setSending(true);
    try {
      const res = await fetch(`/public/booking/${code}/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody(form, trap))
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { setPhase('sent'); return; }
      if (res.status === 404) { setPhase('unavailable'); return; }
      if (res.status === 400 && Array.isArray(body.errors)) {
        setServerErrors(Object.fromEntries(body.errors.map(e => [e.field, e.message])));
        return;
      }
      setBanner(body.error || 'We could not send that. Please try again in a minute, or phone the restaurant.');
    } catch {
      setBanner('We could not send that. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="wrap">
      <header className="head">
        <h1>Ask for a table at {name}</h1>
        {restaurant.city && <p className="muted city">{restaurant.city}</p>}
      </header>

      <p className="explain">This is a request, not a booking. {name} will reply on WhatsApp or by phone to confirm.</p>

      <form onSubmit={submit} noValidate>
        <Field id="rq-name" label="Your name" error={shown.guest_name}>
          <input type="text" name="guest_name" autoComplete="name" value={form.guest_name} onChange={set('guest_name')} />
        </Field>
        <Field id="rq-phone" label="Phone number" error={shown.phone}>
          <input type="tel" name="phone" inputMode="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} />
        </Field>
        <Field id="rq-party" label="How many people" error={shown.party_size}>
          <select name="party_size" value={form.party_size} onChange={set('party_size')}>
            {Array.from({ length: limits.max_party }, (_, i) => i + 1).map(n => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </Field>
        <Field id="rq-at" label="Day and time" error={shown.at}>
          <input
            type="datetime-local"
            name="at"
            value={form.at}
            min={inputValue(new Date(now + limits.min_notice_mins * MIN))}
            max={inputValue(new Date(now + limits.max_ahead_days * DAY))}
            onChange={set('at')}
          />
        </Field>
        <Field id="rq-note" label="Anything we should know? (optional)" error={shown.note} hint="A birthday, an allergy, a table you prefer.">
          <textarea name="note" rows={3} maxLength={NOTE_MAX} value={form.note} onChange={set('note')} />
        </Field>

        {/* A field a robot fills in and a person never sees, reaches or hears. */}
        <div className="trap" aria-hidden="true">
          <label>Website <input type="text" name="website" tabIndex={-1} autoComplete="off" value={trap} onChange={e => setTrap(e.target.value)} /></label>
        </div>

        {banner && <p role="alert" className="error banner">{banner}</p>}
        <button type="submit" className="primary" disabled={sending}>{sending ? 'Sending…' : 'Send request'}</button>
        <p className="muted privacy">Your number is used only to answer this request.</p>
      </form>
    </main>
  );
}
