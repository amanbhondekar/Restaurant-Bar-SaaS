import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, KeyRound, Loader2, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { authFetch, authWsUrl, captureTokenFromUrl, clearToken, consumePendingEnrollmentCode, enrollWithCode } from '../services/hubAuth';
import { hubBase } from '../admin/api';
import {
  STATION_LABEL, applyMessage, board, describeLine, formatWait, mergeFetched, minutesSince, pendingKeys, upsertTicket, urgencyOf
} from './lib/board';
import { playChime, unlockAudio } from './lib/chime';

// One station's screen, on a tablet at the hot line, the cold line or the bar (M2 · per-station KDS).
//
// It is its own page rather than a filter on the Kitchen Display for two reasons. The Kitchen Display
// sends no device token, so on any device other than the reception laptop its first request is a 401
// and the live feed is refused -- a station could not be a separate tablet at all. And a station should
// not carry the display's billing, table-clearing and station switcher: one station, one button.
//
// What is shown comes from ./lib/board (pure, tested). The hub is the authority on a ticket's state.

const SOUND_KEY = 'kullina_station_sound';
const FRESH_MS = 8000;
const RECONNECT_MS = 3000;

const readSound = () => {
  try { return window.localStorage.getItem(SOUND_KEY) === 'on'; } catch { return false; }
};

const URGENCY_STYLE = {
  ok: { color: 'var(--color-muted)', border: 'var(--color-hairline)' },
  warn: { color: 'var(--status-amber-text)', border: 'var(--status-amber-border)' },
  late: { color: 'var(--status-rust-text)', border: 'var(--status-rust-border)' }
};

function EnrollForm({ station, onEnroll, busy, error }) {
  const [code, setCode] = useState('');
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <div className="flex items-center gap-3">
        <KeyRound className="size-7" aria-hidden="true" />
        <h1 className="typography-display-sm">{STATION_LABEL[station]} screen</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        This tablet needs to be connected to the hub once. Scan the code for this station from the Kitchen tab on the reception laptop, or type the code shown on the Kitchen Display.
      </p>
      <form onSubmit={e => { e.preventDefault(); if (code.trim() && !busy) onEnroll(code.trim().toUpperCase()); }} className="flex flex-col gap-3">
        <label htmlFor="station-code" className="text-sm font-medium">Enrollment code</label>
        <input
          id="station-code"
          autoFocus
          autoCapitalize="characters"
          autoComplete="off"
          value={code}
          onChange={e => setCode(e.target.value)}
          className="h-14 rounded-lg border border-input bg-background px-4 text-center text-xl uppercase tracking-widest outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <button type="submit" disabled={!code.trim() || busy} className="inline-flex h-14 items-center justify-center gap-2 rounded-lg text-base font-semibold disabled:opacity-50" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
          {busy && <Loader2 className="size-5 animate-spin" aria-hidden="true" />}Connect
        </button>
      </form>
    </main>
  );
}

function TicketCard({ entry, station, now, fresh, busy, onReady }) {
  const { ticket, since, lines } = entry;
  const minutes = minutesSince(since, now);
  const urgency = urgencyOf(minutes);
  const style = URGENCY_STYLE[urgency];
  const staged = ticket.staged === true;

  return (
    <article
      aria-label={`Ticket ${ticket.ticket_number}, ${ticket.table_name || 'no table'}`}
      className="flex flex-col gap-3 rounded-xl border-2 bg-card p-4"
      style={{ borderColor: fresh ? 'var(--color-primary)' : style.border, boxShadow: fresh ? '0 0 0 3px var(--status-amber-bg)' : undefined }}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold tabular-nums">#{ticket.ticket_number}</span>
          <span className="text-xl font-semibold">{ticket.table_name}</span>
        </div>
        <span className="text-lg font-semibold tabular-nums" style={{ color: style.color }} aria-label={`Waiting ${formatWait(minutes)}`}>
          {formatWait(minutes)}
        </span>
      </header>

      {ticket.note && (
        <p className="rounded-lg px-3 py-2 text-base font-medium" style={{ background: 'var(--status-amber-bg)', color: 'var(--status-amber-text)' }}>
          {ticket.note}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {lines.map(({ item, idx, group }) => {
          const d = describeLine(item);
          return (
            <li key={idx} className="flex items-baseline gap-3 text-xl">
              <span className="w-10 shrink-0 text-right font-bold tabular-nums">{d.qty}×</span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{d.name}</span>
                {d.size && <span className="text-muted-foreground"> · {d.size}</span>}
                {d.mods.length > 0 && <span className="block text-base text-muted-foreground">{d.mods.join(', ')}</span>}
              </span>
              {staged && <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold text-muted-foreground">Course {group}</span>}
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={() => onReady(ticket)}
        disabled={busy}
        aria-label={`Mark ticket ${ticket.ticket_number} ready at the ${STATION_LABEL[station]}`}
        className="inline-flex h-16 items-center justify-center gap-2 rounded-lg text-lg font-bold disabled:opacity-60"
        style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}
      >
        {busy ? <Loader2 className="size-6 animate-spin" aria-hidden="true" /> : <Check className="size-6" aria-hidden="true" />}
        Ready
      </button>
    </article>
  );
}

export function StationScreen({ station }) {
  const base = useMemo(() => hubBase(), []);
  const [auth, setAuth] = useState('checking');          // checking | ok | enroll
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState('');
  const [tickets, setTickets] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [conn, setConn] = useState('connecting');        // connecting | live | offline
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [fresh, setFresh] = useState(() => new Set());
  const [sound, setSound] = useState(readSound);
  const [now, setNow] = useState(() => Date.now());

  // The latest list, kept in a ref as well as in state: a live message is applied to what is there NOW,
  // not to whatever a closure captured, and the answer (did it ask for a re-read?) is known at once.
  const ticketsRef = useRef([]);
  const commit = useCallback(next => { ticketsRef.current = next; setTickets(next); }, []);
  // Tickets a live message brought in or changed while a read of the whole list was in flight, so the
  // answer (which may be older than the message) does not undo them. Cleared when a read starts.
  const arrivedRef = useRef(new Set());
  const readsInFlight = useRef(0);

  const seenRef = useRef(null);                          // pending keys at the last look; null until the first load
  const soundRef = useRef(sound);
  soundRef.current = sound;

  // Tell the person at the pass about work that was not there a moment ago. Worked out after the list
  // changes (an effect), not inside the update that changes it, so it happens once per change.
  useEffect(() => {
    if (!loaded) return;
    const keys = pendingKeys(tickets, station);
    const before = seenRef.current;
    seenRef.current = keys;
    if (before === null) return;                         // the first load is the backlog, not news
    const added = [...keys].filter(k => !before.has(k));
    if (added.length === 0) return;
    if (soundRef.current) playChime();
    const ids = added.map(k => k.split(':')[0]);
    setFresh(f => new Set([...f, ...ids]));
    setTimeout(() => setFresh(f => { const n = new Set(f); ids.forEach(i => n.delete(i)); return n; }), FRESH_MS);
  }, [tickets, loaded, station]);

  const load = useCallback(async () => {
    if (readsInFlight.current === 0) arrivedRef.current = new Set();
    readsInFlight.current += 1;
    try {
      const res = await authFetch(`${base}/orders/active`);
      if (res.status === 401) { setAuth('enroll'); return; }
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setAuth('ok');
      commit(mergeFetched(ticketsRef.current, Array.isArray(data.tickets) ? data.tickets : [], arrivedRef.current));
      setLoaded(true);
      setError('');
    } catch {
      setError('Could not reach the hub. Showing the last tickets it sent.');
    } finally {
      readsInFlight.current -= 1;
    }
  }, [base, commit]);

  // First look: pick up a code from a scanned QR, enrol with it if there is one, then read the tickets.
  useEffect(() => {
    captureTokenFromUrl();
    const code = consumePendingEnrollmentCode();
    (async () => {
      if (code) {
        const r = await enrollWithCode(base, code, `${STATION_LABEL[station]} screen`);
        if (!r.ok) setEnrollError(r.error);
      }
      await load();
    })();
  }, [base, station, load]);

  // The live feed. Declares the station so the hub can tell reception when a station has no screen.
  useEffect(() => {
    if (auth !== 'ok') return undefined;
    let ws = null;
    let timer = null;
    let closed = false;

    const connect = () => {
      const wsBase = base.replace(/^http/, 'ws');
      ws = new WebSocket(authWsUrl(`${wsBase}/live?station=${encodeURIComponent(station)}&label=${encodeURIComponent(`${STATION_LABEL[station]} screen`)}`));
      ws.onopen = () => { setConn('live'); load(); };       // a reconnect may have missed messages: read it all again
      ws.onmessage = event => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        const result = applyMessage(ticketsRef.current, msg);
        const id = msg?.payload?.ticket?.id ?? msg?.payload?.id;
        if (id) arrivedRef.current.add(id);
        commit(result.tickets);
        if (result.refetch) load();
      };
      ws.onclose = () => {
        if (closed) return;
        setConn('offline');
        timer = setTimeout(connect, RECONNECT_MS);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* nothing to do */ }
    };
  }, [auth, base, station, load, commit]);

  // The wait on each card moves on by itself.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const enroll = async code => {
    setEnrollBusy(true);
    setEnrollError('');
    const r = await enrollWithCode(base, code, `${STATION_LABEL[station]} screen`);
    setEnrollBusy(false);
    if (!r.ok) { setEnrollError(r.error); return; }
    setAuth('checking');
    await load();
  };

  const markReady = async ticket => {
    setBusyId(ticket.id);
    setError('');
    try {
      const res = await authFetch(`${base}/orders/${encodeURIComponent(ticket.id)}/stations/${station}/ready`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status === 401) { clearToken(); setAuth('enroll'); return; }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ticket) {
        commit(upsertTicket(ticketsRef.current, data.ticket));
      } else {
        // Somebody else may have just done it, so read the board again -- and only then say why, because
        // a successful read clears the message line and the cook would never see the reason.
        await load();
        setError(data.error || 'The hub could not mark that ready.');
      }
    } catch {
      setError('Could not reach the hub. That was not marked ready.');
    } finally {
      setBusyId(null);
    }
  };

  const toggleSound = () => {
    const next = !sound;
    if (next) unlockAudio();                                // this tap is what lets the browser play sound later
    setSound(next);
    try { window.localStorage.setItem(SOUND_KEY, next ? 'on' : 'off'); } catch { /* storage blocked */ }
    if (next) playChime();
  };

  if (auth === 'checking' && !loaded) {
    return <main className="flex min-h-screen items-center justify-center"><Loader2 className="size-8 animate-spin text-muted-foreground" aria-label="Loading" /></main>;
  }
  if (auth === 'enroll') {
    return <EnrollForm station={station} onEnroll={enroll} busy={enrollBusy} error={enrollError} />;
  }

  const entries = board(tickets, station, now);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-5 py-3">
        <div className="flex items-baseline gap-4">
          <h1 className="text-3xl font-bold">{STATION_LABEL[station]}</h1>
          <span className="text-lg text-muted-foreground" aria-live="polite">{entries.length === 0 ? 'Clear' : `${entries.length} waiting`}</span>
        </div>
        <div className="flex items-center gap-3">
          <span
            role="status"
            className="inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-medium"
            style={conn === 'live'
              ? { background: 'var(--status-green-bg)', color: 'var(--status-green-text)', borderColor: 'var(--status-green-border)' }
              : { background: 'var(--status-rust-bg)', color: 'var(--status-rust-text)', borderColor: 'var(--status-rust-border)' }}
          >
            {conn === 'live' ? <span className="size-2 rounded-full bg-current" aria-hidden="true" /> : <WifiOff className="size-4" aria-hidden="true" />}
            {conn === 'live' ? 'Live' : conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </span>
          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={sound}
            aria-label={sound ? 'Turn the new-ticket sound off' : 'Turn the new-ticket sound on'}
            className="inline-flex size-12 items-center justify-center rounded-lg border border-border"
          >
            {sound ? <Volume2 className="size-6" aria-hidden="true" /> : <VolumeX className="size-6" aria-hidden="true" />}
          </button>
        </div>
      </header>

      {conn !== 'live' && loaded && (
        <p role="alert" className="px-5 py-2 text-center text-base font-medium" style={{ background: 'var(--status-rust-bg)', color: 'var(--status-rust-text)' }}>
          Not connected to the hub. New tickets will not appear until it reconnects; the ones below may be out of date.
        </p>
      )}
      {error && <p role="alert" className="px-5 py-2 text-center text-base font-medium" style={{ background: 'var(--status-amber-bg)', color: 'var(--status-amber-text)' }}>{error}</p>}

      <main className="p-4">
        {entries.length === 0 ? (
          <p className="py-24 text-center text-2xl text-muted-foreground">Nothing waiting for the {STATION_LABEL[station].toLowerCase()}.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {entries.map(entry => (
              <TicketCard
                key={entry.ticket.id}
                entry={entry}
                station={station}
                now={now}
                fresh={fresh.has(entry.ticket.id)}
                busy={busyId === entry.ticket.id}
                onReady={markReady}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
