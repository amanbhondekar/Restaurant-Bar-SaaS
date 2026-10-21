// Wording and checks for the Staff tab. Pure functions, no React. The hub re-checks everything; these
// exist so reception hears about a mistake beside the field rather than after a round trip.

export const ROLE_LABEL = { waiter: 'Waiter', manager: 'Manager', kitchen: 'Kitchen' };

/** What a role means here, in the one sentence reception needs when choosing one. */
export const ROLE_HINT = {
  waiter: 'Takes orders and bills at a handset.',
  manager: 'The same, and runs the floor.',
  kitchen: 'Works a kitchen station screen.'
};

const WEAK_PINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '1212', '2580']);

/**
 * Check a PIN the way the hub does, so the two never disagree about what is acceptable.
 * The weak list is short on purpose: it catches what someone types without thinking, and a longer
 * one would start refusing PINs people have a reason for.
 */
export function checkPin(pin) {
  const raw = String(pin ?? '');
  if (raw === '') return { ok: false, error: 'Enter a 4-digit PIN.' };
  if (!/^\d{4}$/.test(raw)) return { ok: false, error: 'A PIN is exactly 4 digits.' };
  if (WEAK_PINS.has(raw)) return { ok: false, error: 'That PIN is too easy to guess. Choose another.' };
  return { ok: true, value: raw };
}

/** Check a name before asking the hub, including against the people already on the list. */
export function checkName(name, existing = []) {
  const clean = String(name ?? '').trim();
  if (!clean) return { ok: false, error: 'Give them a name.' };
  if (clean.length > 60) return { ok: false, error: 'At most 60 characters.' };
  if (existing.some(n => String(n).trim().toLowerCase() === clean.toLowerCase())) {
    return { ok: false, error: `${clean} is already on the staff list.` };
  }
  return { ok: true, value: clean };
}

/**
 * Where a staff member stands, as a badge and a line of detail.
 *
 * The three states that matter to reception are: can sign in, invited and waiting, and invited but
 * the code has gone stale -- because only the last one needs them to do something.
 */
export function staffStatus(person) {
  if (person?.active === false) return { tone: 'muted', label: 'Removed', detail: 'Cannot sign in. Kept on the list because past bills name them.' };
  if (person?.pin_set) return { tone: 'green', label: 'Can sign in', detail: person.pin_set_at ? `PIN set ${shortDate(person.pin_set_at)}` : 'PIN set' };
  if (person?.invite_expired) return { tone: 'rust', label: 'Invite expired', detail: 'They never set a PIN. Send a new invite.' };
  return { tone: 'amber', label: 'Invited', detail: person?.invite_expires_at ? `Code works until ${shortDate(person.invite_expires_at)}` : 'Waiting for them to set a PIN' };
}

/** "19 Oct" — enough to judge whether something is stale, without a wall of timestamp. */
export function shortDate(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
}

/** A device row as reception reads it: what it is, and whether it still counts. */
export function deviceStatus(device) {
  if (device?.expired) return { tone: 'muted', label: 'Expired', detail: 'Already refused. Tidy it away whenever.' };
  return { tone: 'green', label: 'Enrolled', detail: device?.expires_at ? `Until ${shortDate(device.expires_at)}` : '' };
}

/** The header line: "4 staff · 1 invited · 2 devices". */
export function staffSummary(staff = [], devices = []) {
  const live = staff.filter(s => s.active !== false);
  const invited = live.filter(s => !s.pin_set).length;
  const parts = [`${live.length} ${live.length === 1 ? 'person' : 'people'}`];
  if (invited) parts.push(`${invited} yet to set a PIN`);
  const active = devices.filter(d => !d.expired).length;
  parts.push(`${active} ${active === 1 ? 'device' : 'devices'}`);
  return parts.join(' · ');
}
