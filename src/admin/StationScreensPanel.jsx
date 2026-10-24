import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, MonitorSmartphone } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from 'cn';
import { explainError, hubBase, hubGet } from './api';
import { Notice } from './ui';
import { STATION_ORDER, anyScreensUp, stationStatus, unwatchedLine } from './lib/stations';

// Which stations have a screen up, and what is waiting at the ones that do not (M2 · per-station KDS).
// A tablet at a station is its own page, /station/bar, connected once by scanning a code from here.

const REFRESH_MS = 5000;

function AddTabletDialog({ station, label, onClose }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    hubGet(`/qr/station/${encodeURIComponent(station)}`).then(d => { if (live) setInfo(d); }, e => { if (live) setError(e); });
    return () => { live = false; };
  }, [station]);

  return (
    <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add a tablet for the {label.toLowerCase()}</DialogTitle>
          <DialogDescription>
            Open the camera on the tablet and scan this code. It connects the tablet to the hub and shows only the {label.toLowerCase()}&rsquo;s tickets. It is the same code the waiters use, so keep this screen to yourself.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {error && <Notice tone="error">{explainError(error)}</Notice>}
          {!info && !error && <Loader2 className="size-8 animate-spin text-muted-foreground" aria-label="Loading the code" />}
          {info && (
            <>
              <img src={info.qr_code} alt={`QR code that turns a tablet into the ${label.toLowerCase()} screen`} className="size-64 rounded-lg bg-white p-2" />
              <p className="text-center text-sm text-muted-foreground">
                No camera? Open <strong className="break-all text-foreground">{info.station_url}</strong> on the tablet and type the code <strong className="tracking-widest text-foreground">{info.enrollment_code}</strong>.
              </p>
            </>
          )}
        </div>
        <DialogFooter><Button className="h-10" onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StationScreensPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await hubGet('/kds/screens'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !data) {
    return <Notice tone="warning" title="Could not check the station screens">{explainError(error)}</Notice>;
  }
  if (!data) return null;

  const stations = data.stations;
  const anyUp = anyScreensUp(stations);
  const warning = unwatchedLine(stations);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="stn-h">
      <div>
        <h2 id="stn-h" className="typography-title-md">Station screens</h2>
        <p className="text-sm text-muted-foreground">
          A tablet at the hot line, cold line or bar that shows only that station&rsquo;s tickets and lets the cook mark them ready.
          {!anyUp && ' Until one is connected, every ticket shows on the Kitchen Display.'}
        </p>
      </div>

      {warning && <Notice tone="warning" title="A station is unwatched">{warning}</Notice>}

      <ul className="grid gap-3 sm:grid-cols-3">
        {STATION_ORDER.map(id => {
          const s = stations[id];
          const st = stationStatus(s, anyUp);
          return (
            <li key={id} className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label={s.label}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{s.label}</span>
                <Badge
                  variant="outline"
                  style={st.tone === 'muted'
                    ? undefined
                    : { background: `var(--status-${st.tone}-bg)`, color: `var(--status-${st.tone}-text)`, borderColor: `var(--status-${st.tone}-border)` }}
                >{st.headline}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{st.detail}</p>
              <div className="mt-auto flex flex-wrap gap-2">
                <Button variant="outline" className="h-9" onClick={() => setAdding({ id, label: s.label })}>
                  <MonitorSmartphone className="size-4" aria-hidden="true" />Add a tablet
                </Button>
                <a href={`${hubBase()}/station/${id}`} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'outline' }), 'h-9')}>
                  <ExternalLink className="size-4" aria-hidden="true" />Open here
                </a>
              </div>
            </li>
          );
        })}
      </ul>

      {adding && <AddTabletDialog station={adding.id} label={adding.label} onClose={() => setAdding(null)} />}
    </section>
  );
}
