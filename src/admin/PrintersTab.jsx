import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Printer, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { explainError, hubGet, hubSend } from './api';
import { ConfirmDialog, Field, ListSkeleton, NativeSelect, Notice, TextInput } from './ui';

// Printer setup for the reception laptop: see what is configured, print a test page, and add a
// network, USB or device printer without editing hub_config.json by hand.

const ROLE_LABEL = { kot: 'Kitchen tickets', receipt: 'Customer receipts' };
const STATION_LABEL = { hot: 'Hot line', cold: 'Cold line', bar: 'Bar' };
const TRANSPORT_LABEL = { tcp: 'Network', usb: 'USB', device: 'Device' };

const blankForm = { role: 'receipt', transport: 'usb', name: '', host: '', port: '9100', system_name: '', device_path: '/dev/usb/lp0', station: '' };

function describe(p) {
  if (p.transport === 'usb') return `USB · ${p.system_name}`;
  if (p.transport === 'device') return `Device · ${p.device_path}`;
  return `Network · ${p.host}:${p.port}`;
}

export function PrintersTab({ notify }) {
  const [printers, setPrinters] = useState(null);
  const [system, setSystem] = useState({ loading: true, printers: [], error: null });
  const [error, setError] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [fieldError, setFieldError] = useState(null);
  const [busy, setBusy] = useState(null); // 'add' | 'test:<id>'
  const [removing, setRemoving] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await hubGet('/printers');
      setPrinters(data.printers);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  const discover = useCallback(async () => {
    setSystem(s => ({ ...s, loading: true }));
    try {
      const data = await hubGet('/printers/system');
      setSystem({ loading: false, printers: data.printers || [], error: data.success ? null : (data.error || 'Could not list the printers on this computer.') });
    } catch (e) {
      setSystem({ loading: false, printers: [], error: explainError(e) });
    }
  }, []);

  useEffect(() => { load(); discover(); }, [load, discover]);

  const set = key => e => { setForm(f => ({ ...f, [key]: e.target.value })); setFieldError(null); };

  const add = async () => {
    setBusy('add');
    setFieldError(null);
    try {
      const body = { role: form.role, transport: form.transport, name: form.name.trim() || undefined };
      if (form.transport === 'tcp') { body.host = form.host.trim(); body.port = Number(form.port) || 9100; }
      if (form.transport === 'usb') body.system_name = form.system_name;
      if (form.transport === 'device') body.device_path = form.device_path;
      if (form.role === 'kot' && form.station) body.station = form.station;
      await hubSend('POST', '/printers', body);
      notify('Printer added. Print a test page to check it.');
      setForm(blankForm);
      await load();
    } catch (e) {
      setFieldError(explainError(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async p => {
    setBusy(`test:${p.id}`);
    try {
      await hubSend('POST', `/printers/${encodeURIComponent(p.id)}/test`);
      notify(`Test page sent to ${p.name || p.id}.`);
    } catch (e) {
      notify(`${p.name || p.id}: ${explainError(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const p = removing;
    setBusy(`remove:${p.id}`);
    try {
      await hubSend('DELETE', `/printers/${encodeURIComponent(p.id)}`);
      notify(`${p.name || p.id} removed.`);
      setRemoving(null);
      await load();
    } catch (e) {
      notify(explainError(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (error && !printers) {
    return <Notice tone="error" title="Could not load printers" action={<Button className="h-10" onClick={load}>Try again</Button>}>{explainError(error)}</Notice>;
  }
  if (!printers) return <ListSkeleton rows={4} className="pt-2" />;

  const canAdd = form.transport === 'tcp' ? form.host.trim() !== '' : form.transport === 'usb' ? form.system_name !== '' : form.device_path !== '';

  return (
    <div className="grid gap-4 pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="printers-h">
        <h2 id="printers-h" className="typography-title-md">Configured printers</h2>
        {printers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No printer is set up, so tickets and receipts show on screen only. Add one on the right.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {printers.map(p => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="flex min-w-0 items-start gap-3">
                  <Printer className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{p.name || p.id}</div>
                    <div className="text-xs text-muted-foreground">
                      {ROLE_LABEL[p.role]}{p.station ? ` · ${STATION_LABEL[p.station]} only` : ''}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{describe(p)}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="h-9" disabled={busy !== null} onClick={() => test(p)}>
                    {busy === `test:${p.id}` && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Test page
                  </Button>
                  <Button variant="outline" className="h-9" aria-label={`Remove ${p.name || p.id}`} disabled={busy !== null} onClick={() => setRemoving(p)}>
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="add-printer-h">
        <h2 id="add-printer-h" className="typography-title-md">Add a printer</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What does it print?" htmlFor="p-role">
            <NativeSelect id="p-role" value={form.role} onChange={set('role')}>
              <option value="receipt">Customer receipts</option>
              <option value="kot">Kitchen tickets</option>
            </NativeSelect>
          </Field>
          <Field label="How is it connected?" htmlFor="p-transport">
            <NativeSelect id="p-transport" value={form.transport} onChange={set('transport')}>
              <option value="usb">USB (installed on this computer)</option>
              <option value="tcp">Network (IP address)</option>
              <option value="device">Linux device (/dev/usb/lp0)</option>
            </NativeSelect>
          </Field>

          {form.transport === 'usb' && (
            <Field
              label="Printer"
              htmlFor="p-system"
              className="sm:col-span-2"
              hint={system.loading ? 'Looking for printers…' : 'Choose it as it is named in Windows or CUPS. Install the printer first if it is not listed.'}
            >
              <div className="flex gap-2">
                <NativeSelect id="p-system" value={form.system_name} onChange={set('system_name')}>
                  <option value="">Choose a printer…</option>
                  {system.printers.map(sp => <option key={sp.name} value={sp.name}>{sp.name}</option>)}
                </NativeSelect>
                <Button variant="outline" className="h-10 shrink-0" onClick={discover} aria-label="Look for printers again" disabled={system.loading}>
                  <RefreshCw className={system.loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
                </Button>
              </div>
            </Field>
          )}
          {form.transport === 'usb' && system.error && (
            <Notice tone="warning" className="sm:col-span-2">{system.error}</Notice>
          )}
          {form.transport === 'tcp' && (
            <>
              <Field label="IP address or host" htmlFor="p-host" hint="From the printer's self-test page.">
                <TextInput id="p-host" placeholder="192.168.1.60" value={form.host} onChange={set('host')} />
              </Field>
              <Field label="Port" htmlFor="p-port" hint="Almost always 9100.">
                <TextInput id="p-port" inputMode="numeric" value={form.port} onChange={set('port')} />
              </Field>
            </>
          )}
          {form.transport === 'device' && (
            <Field label="Device path" htmlFor="p-device" className="sm:col-span-2" hint="For Linux kiosks without CUPS.">
              <TextInput id="p-device" value={form.device_path} onChange={set('device_path')} />
            </Field>
          )}

          <Field label="Label (optional)" htmlFor="p-name" hint="Shown in this list, for example “Bar printer”.">
            <TextInput id="p-name" value={form.name} onChange={set('name')} maxLength={40} />
          </Field>
          {form.role === 'kot' && (
            <Field label="Only this station" htmlFor="p-station" hint="Leave on “All” if one printer takes every ticket.">
              <NativeSelect id="p-station" value={form.station} onChange={set('station')}>
                <option value="">All stations</option>
                {Object.entries(STATION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </NativeSelect>
            </Field>
          )}
        </div>
        {fieldError && <Notice tone="error">{fieldError}</Notice>}
        <div className="flex justify-end">
          <Button className="h-11 px-6" disabled={!canAdd || busy !== null} onClick={add}>
            {busy === 'add' && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Add printer
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={Boolean(removing)}
        title={`Remove ${removing?.name || removing?.id || 'this printer'}?`}
        confirmLabel="Remove"
        busy={busy?.startsWith('remove:')}
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      >
        Tickets and receipts for it will show on screen only until you add another printer. The printer itself is not affected.
      </ConfirmDialog>
    </div>
  );
}
