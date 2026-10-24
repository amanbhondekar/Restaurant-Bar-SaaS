import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Plus, Smartphone, Trash2, UserPlus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { explainError, hubGet, hubSend } from './api';
import { ConfirmDialog, EmptyState, Field, ListSkeleton, NativeSelect, Notice, TextInput } from './ui';
import { ROLE_HINT, ROLE_LABEL, checkName, checkPin, deviceKind, deviceStatus, staffStatus, staffSummary } from './lib/staff';

// Who may take money in this restaurant, and which devices may talk to the hub (§4.4).
//
// Reception never types someone else's PIN. They create the person with a role and read out a
// short-lived invite code; the staff member sets their own PIN on a handset. Until they do, the row
// has no PIN at all and cannot sign in -- an invited person is not yet a credential.

const toneStyle = tone => (tone === 'muted'
  ? undefined
  : { background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` });

/** The one screen the invite code is ever shown on. */
function InviteCodeDialog({ invite, onClose }) {
  return (
    <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{invite.waiter.name} is on the list</DialogTitle>
          <DialogDescription>
            Read them this code. On a handset they tap <strong>I have an invite code</strong>, type it, and choose their own PIN.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-2 py-4">
          <div className="rounded-xl border-2 border-dashed border-border px-8 py-4 font-mono text-4xl font-bold tracking-[0.3em]">
            {invite.invite_code}
          </div>
          <p className="text-sm text-muted-foreground">It works for a week, once.</p>
          <p className="max-w-sm text-center text-xs text-muted-foreground">
            This is the only time it is shown. If it is lost, send a new invite &mdash; the hub keeps only a fingerprint of it.
          </p>
        </div>
        <DialogFooter><Button className="h-10" onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormDialog({ open, title, description, confirmLabel, busy, canConfirm = true, onConfirm, onCancel, children }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onCancel(); }}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <form onSubmit={e => { e.preventDefault(); if (canConfirm && !busy) onConfirm(); }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="flex flex-col gap-3 py-3">{children}</div>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button type="submit" className="h-10" disabled={busy || !canConfirm}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddStaffDialog({ existingNames, onSave, onCancel, busy, serverError }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('waiter');
  const [touched, setTouched] = useState(false);
  const check = checkName(name, existingNames);

  return (
    <FormDialog
      open
      title="Add someone to the staff list"
      description="They set their own PIN from an invite code, so you never have to know it."
      confirmLabel="Create invite"
      busy={busy}
      canConfirm={check.ok}
      onCancel={onCancel}
      onConfirm={() => onSave({ name: check.value, role })}
    >
      <Field label="Name" htmlFor="staff-name" error={touched && !check.ok ? check.error : undefined}>
        <TextInput id="staff-name" autoFocus value={name} maxLength={60} invalid={touched && !check.ok} onChange={e => { setName(e.target.value); setTouched(true); }} />
      </Field>
      <Field label="Role" htmlFor="staff-role" hint={ROLE_HINT[role]}>
        <NativeSelect id="staff-role" value={role} onChange={e => setRole(e.target.value)}>
          {Object.entries(ROLE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </NativeSelect>
      </Field>
      {serverError && <Notice tone="error">{serverError}</Notice>}
    </FormDialog>
  );
}

function ResetPinDialog({ person, onSave, onCancel, busy, serverError }) {
  const [pin, setPin] = useState('');
  const [touched, setTouched] = useState(false);
  const check = checkPin(pin);

  return (
    <FormDialog
      open
      title={`Set a new PIN for ${person.name}`}
      description="It works straight away, and their old PIN stops working. Tell them what it is."
      confirmLabel="Set PIN"
      busy={busy}
      canConfirm={check.ok}
      onCancel={onCancel}
      onConfirm={() => onSave(check.value)}
    >
      <Field label="New PIN" htmlFor="staff-pin" error={touched && !check.ok ? check.error : undefined} hint="4 digits.">
        <TextInput
          id="staff-pin"
          autoFocus
          inputMode="numeric"
          maxLength={4}
          value={pin}
          invalid={touched && !check.ok}
          className="text-center text-2xl tracking-[0.4em]"
          onChange={e => { setPin(e.target.value.replace(/\D/g, '')); setTouched(true); }}
        />
      </Field>
      {serverError && <Notice tone="error">{serverError}</Notice>}
    </FormDialog>
  );
}

export function StaffTab({ notify }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [invite, setInvite] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await hubGet('/admin/staff'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const close = () => { setDialog(null); setServerError(null); };

  /** Run a write, reload, and keep a refusal in the dialog in the hub's own words. */
  const run = async (send, done) => {
    setBusy(true);
    setServerError(null);
    try {
      const result = await send();
      close();
      setRemoving(null);
      setRotating(false);
      if (done) notify(done(result));
      await load();
      return result;
    } catch (e) {
      setServerError(explainError(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return <Notice tone="error" title="Could not load the staff list" action={<Button className="h-10" onClick={load}>Try again</Button>}>{explainError(error)}</Notice>;
  }
  if (!data) return <ListSkeleton rows={5} className="pt-2" />;

  const staff = data.staff ?? [];
  const devices = data.devices ?? [];
  const live = staff.filter(s => s.active !== false);

  const addStaff = async payload => {
    const result = await run(() => hubSend('POST', '/admin/staff', payload));
    if (result) setInvite(result);
  };
  const reinvite = async person => {
    const result = await run(() => hubSend('POST', `/admin/staff/${encodeURIComponent(person.id)}/reinvite`));
    if (result) setInvite(result);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Staff &amp; devices</div>
          <div className="mt-1 text-sm" aria-live="polite">{staffSummary(staff, devices)}</div>
        </div>
        <Button className="h-10" onClick={() => setDialog({ type: 'add' })}>
          <UserPlus className="size-4" aria-hidden="true" />Add someone
        </Button>
      </div>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="staff-h">
        <h2 id="staff-h" className="typography-title-md">Staff</h2>
        {live.length === 0 ? (
          <EmptyState icon={Users} title="Nobody on the list yet">
            Add someone and read them the invite code. They choose their own PIN, so you never have to know it.
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {staff.map(person => {
              const status = staffStatus(person);
              const removed = person.active === false;
              return (
                <li key={person.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" aria-label={person.name}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={removed ? 'truncate font-semibold text-muted-foreground line-through' : 'truncate font-semibold'}>{person.name}</span>
                      <Badge variant="outline">{ROLE_LABEL[person.role] ?? person.role}</Badge>
                      <Badge variant="outline" style={toneStyle(status.tone)}>{status.label}</Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">{status.detail}</div>
                  </div>
                  {!removed && (
                    <div className="flex flex-wrap gap-2">
                      <NativeSelect
                        aria-label={`Role for ${person.name}`}
                        className="h-9 w-32"
                        value={person.role}
                        onChange={e => {
                          // Read it now: the select is controlled by person.role, so after the await
                          // it has already snapped back to the old value and the message would lie.
                          const role = e.target.value;
                          run(() => hubSend('PUT', `/admin/staff/${encodeURIComponent(person.id)}/role`, { role }), () => `${person.name} is now a ${ROLE_LABEL[role].toLowerCase()}.`);
                        }}
                      >
                        {Object.entries(ROLE_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      </NativeSelect>
                      {person.pin_set
                        ? <Button variant="outline" className="h-9" onClick={() => setDialog({ type: 'pin', person })}><KeyRound className="size-4" aria-hidden="true" />Reset PIN</Button>
                        : <Button variant="outline" className="h-9" onClick={() => reinvite(person)} disabled={busy}>New invite</Button>}
                      <Button variant="outline" className="h-9" aria-label={`Remove ${person.name}`} onClick={() => setRemoving(person)}>
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="devices-h">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="devices-h" className="typography-title-md">Devices</h2>
            <p className="text-xs text-muted-foreground">
              Handsets and station screens that have been let onto this hub. Removing one refuses it on its very next request.
            </p>
          </div>
          <Button variant="outline" className="h-10" onClick={() => setRotating(true)}>Rotate the enrollment code</Button>
        </div>
        {devices.length === 0 ? (
          <EmptyState icon={Smartphone} title="No devices enrolled">
            A handset joins by scanning the code on the Kitchen Display; a station screen by scanning one from the Kitchen tab.
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {devices.map(device => {
              const status = deviceStatus(device);
              const kind = deviceKind(device);
              return (
                <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" aria-label={device.label}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold">{device.label}</span>
                      <Badge variant="outline" style={toneStyle(status.tone)}>{status.label}</Badge>
                      {kind.label && <Badge variant="outline">{kind.label}</Badge>}
                    </div>
                    <div className="text-sm text-muted-foreground">{[status.detail, kind.note].filter(Boolean).join(' · ')}</div>
                  </div>
                  <Button
                    variant="outline"
                    className="h-9"
                    aria-label={`Remove ${device.label}`}
                    disabled={busy}
                    onClick={() => run(() => hubSend('DELETE', `/admin/devices/${encodeURIComponent(device.id)}`), () => `${device.label} can no longer reach the hub.`)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {dialog?.type === 'add' && (
        <AddStaffDialog existingNames={live.map(s => s.name)} busy={busy} serverError={serverError} onCancel={close} onSave={addStaff} />
      )}
      {dialog?.type === 'pin' && (
        <ResetPinDialog
          person={dialog.person}
          busy={busy}
          serverError={serverError}
          onCancel={close}
          onSave={pin => run(() => hubSend('POST', `/admin/staff/${encodeURIComponent(dialog.person.id)}/pin`, { pin }), () => `${dialog.person.name} has a new PIN.`)}
        />
      )}
      {invite && <InviteCodeDialog invite={invite} onClose={() => setInvite(null)} />}

      <ConfirmDialog
        open={Boolean(removing)}
        title={`Remove ${removing?.name ?? ''} from the staff list?`}
        confirmLabel="Remove"
        busy={busy}
        onCancel={() => { setRemoving(null); setServerError(null); }}
        onConfirm={() => run(() => hubSend('DELETE', `/admin/staff/${encodeURIComponent(removing.id)}`), () => `${removing.name} can no longer sign in.`)}
      >
        {serverError || 'They stop being able to sign in straight away. They stay on the list, because the bills they took still name them.'}
      </ConfirmDialog>

      <ConfirmDialog
        open={rotating}
        title="Rotate the enrollment code?"
        confirmLabel="Rotate it"
        busy={busy}
        onCancel={() => { setRotating(false); setServerError(null); }}
        onConfirm={() => run(() => hubSend('POST', '/admin/devices/rotate-code'), r => `Code rotated. ${r.revoked} device(s) must join again.`)}
      >
        {serverError || `Every one of the ${devices.length} device(s) above has to join again with the new code, including handsets in the middle of service. To lock out a single device, remove just that one instead.`}
      </ConfirmDialog>
    </div>
  );
}
