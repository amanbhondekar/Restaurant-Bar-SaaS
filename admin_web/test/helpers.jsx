import { vi } from 'vitest';
import { AdminApiError } from '../src/lib/api.js';
import { AuthError } from '../src/lib/auth.js';

// Fixtures and fakes for the console's page tests. The real API is tested in hub_server/test/adminApi.test.mjs and the real auth library is
// replaced by an adapter, so what these tests are about is what a person sees and does.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const NOW = Date.parse('2026-10-26T10:00:00.000Z');
export const iso = ms => new Date(NOW + ms).toISOString();

export const hub = (over = {}) => ({
  state: 'live', seen_at: iso(-2 * MIN), reported_at: iso(-2 * MIN), started_at: iso(-5 * HOUR), version: '1.0.0',
  queued: 0, quarantined: 0, last_synced_at: iso(-3 * MIN), devices: 3, waiters: 5, ...over
});

export const tenant = (id, name, over = {}) => ({
  id, name, slug: name.toLowerCase().replace(/\W+/g, '-'), city: 'Nagpur', phone: '9822012345', plan: 'pro', plan_status: 'active',
  trial_ends_at: null, current_period_end: iso(20 * DAY), created_at: iso(-90 * DAY),
  subscription: { status: 'active', plan: 'pro', plan_change_to: null, cancel_requested_at: null, period_end: iso(20 * DAY), last_event_at: iso(-10 * DAY) },
  hub: hub(), activity: { last_invoice_at: iso(-20 * MIN), invoices_7d: 140 }, attention: [], severity: null, ...over
});

export const A_ID = 'a0a0a0a0-0000-4000-8000-000000000001';
export const B_ID = 'b0b0b0b0-0000-4000-8000-000000000002';

export function fleetPayload(over = {}) {
  const a = tenant(A_ID, 'Spice Route', {
    plan_status: 'past_due', severity: 'high',
    attention: [{ code: 'past_due', severity: 'high', message: 'Payment is overdue.' }]
  });
  const b = tenant(B_ID, 'Chai Corner');
  return {
    success: true,
    generated_at: iso(0),
    truncated: false,
    summary: {
      tenants: 2,
      by_status: { active: 1, trialing: 0, past_due: 1, suspended: 0, cancelled: 0, other: 0 },
      by_plan: { starter: 0, pro: 2, enterprise: 0, other: 0 },
      hubs: { live: 2, quiet: 0, silent: 0, never: 0 },
      attention: { high: 1, medium: 0 }
    },
    attention: [{ restaurant_id: A_ID, name: 'Spice Route', code: 'past_due', severity: 'high', message: 'Payment is overdue.' }],
    tenants: [a, b],
    events: [{ id: 'e1', restaurant_id: A_ID, restaurant_name: 'Spice Route', razorpay_subscription_id: 'sub_1', event: 'subscription.halted', applied_plan_status: 'past_due', received_at: iso(-3 * HOUR) }],
    ...over
  };
}

export const tenantPayload = (id = A_ID, name = 'Spice Route') => ({
  success: true,
  generated_at: iso(0),
  tenant: tenant(id, name),
  subscriptions: [{ razorpay_subscription_id: 'sub_1', status: 'active', plan: 'pro', plan_change_to: null, cancel_requested_at: null, current_start: iso(-30 * DAY), current_end: iso(20 * DAY), last_event_at: iso(-10 * DAY), created_at: iso(-90 * DAY) }],
  events: []
});

export const auditEvent = (id, over = {}) => ({
  id, restaurant_id: A_ID, restaurant_name: 'Spice Route', occurred_at: iso(-id * MIN), source: 'razorpay', type: 'subscription.halted',
  actor_type: 'webhook', actor_id: null, actor_email: null, request_id: null, payload: { applied_plan_status: 'past_due' }, chain_seq: id, row_hash: 'a'.repeat(64), ...over
});

export const auditPayload = (events, over = {}) => ({
  success: true, generated_at: iso(0), events, next_before: null, ...over
});

/** An alert as the API sends it (a closed list of fields, the words already said). */
export const alertRow = (id, over = {}) => ({
  id, restaurant_id: A_ID, restaurant_name: 'Spice Route', rule_key: 'orders_shelved', severity: 'P1', state: 'open',
  what: 'orders shelved', text: '2 orders were shelved and have not reached the cloud.', detail: { count: 2 },
  opened_at: iso(-30 * MIN), acked_at: null, acked_by_email: null, ack_reason: null, resolved_at: null, resolved_by: null, resolve_reason: null,
  escalation_level: 0, reminders: 3, last_notified_at: iso(-29 * MIN), unattended_at: null, ...over
});

export const alertsPayload = (alerts, over = {}) => ({
  success: true, generated_at: iso(0), truncated: false,
  counts: {
    open: alerts.filter(a => a.state === 'open').length,
    acked: alerts.filter(a => a.state === 'acked').length,
    unattended: alerts.filter(a => a.state === 'open' && a.unattended_at).length
  },
  alerts, ...over
});

export const defaultAlerts = () => [
  alertRow(1),
  alertRow(2, { rule_key: 'sync_backlog', severity: 'P2', restaurant_id: B_ID, restaurant_name: 'Chai Corner', what: 'bills waiting to sync', text: '60 bills are waiting to reach the cloud.', detail: { count: 60 }, last_notified_at: null }),
  alertRow(3, { rule_key: 'payment_past_due', severity: 'P2', state: 'acked', what: 'payment overdue', text: 'Payment is overdue.', detail: {}, acked_at: iso(-10 * MIN), acked_by_email: 'darshil@example.test', ack_reason: 'ringing the owner now' })
];

export const ME = { success: true, generated_at: iso(0), user: { id: 'f1', email: 'aman@example.test', display_name: 'Aman', role: 'founder' } };

/** A fake of the API client: every method is a mock, with sensible good answers that a test can replace. */
export function fakeApi(over = {}) {
  return {
    me: vi.fn(async () => ME),
    recordSession: vi.fn(async () => ({ success: true, generated_at: iso(0), event_id: 7 })),
    fleet: vi.fn(async () => fleetPayload()),
    tenant: vi.fn(async (id) => tenantPayload(id, id === B_ID ? 'Chai Corner' : 'Spice Route')),
    audit: vi.fn(async () => auditPayload([auditEvent(3), auditEvent(2), auditEvent(1)])),
    auditCsv: vi.fn(async () => ({ blob: new Blob(['x']), filename: 'kullina-audit-2026-10-26.csv' })),
    alerts: vi.fn(async () => alertsPayload(defaultAlerts())),
    acknowledgeAlert: vi.fn(async id => ({ success: true, generated_at: iso(0), alert: { id, state: 'acked' }, event_id: 41 })),
    resolveAlert: vi.fn(async id => ({ success: true, generated_at: iso(0), alert: { id, state: 'resolved' }, event_id: 42 })),
    verify: vi.fn(async (restaurant) => ({ success: true, generated_at: iso(0), restaurant_id: restaurant ?? null, ok: true, checked: 12, broken_at: null, reason: null })),
    ...over
  };
}

/** A fake of the auth adapter. `start` is the state it begins in; `emit` pushes a change the way Supabase would. */
export function fakeAuth(start = { status: 'signed_out' }, over = {}) {
  let state = start;
  const listeners = new Set();
  const auth = {
    state: vi.fn(async () => state),
    signIn: vi.fn(async () => state),
    startEnrolment: vi.fn(async () => ({ factorId: 'factor-new', qr: 'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg"/>', secret: 'JBSWY3DPEHPK3PXP' })),
    verifyEnrolment: vi.fn(async () => state),
    challenge: vi.fn(async () => state),
    token: vi.fn(async () => 'access-token'),
    signOut: vi.fn(async () => { state = { status: 'signed_out' }; }),
    onChange: vi.fn(cb => { listeners.add(cb); return () => listeners.delete(cb); }),
    set(next) { state = next; },
    emit(next) { state = next; listeners.forEach(cb => cb(next)); },
    ...over
  };
  return auth;
}

export const READY = { status: 'ready', email: 'aman@example.test' };
export const apiError = (kind, message = 'Something went wrong.') => new AdminApiError(kind, message);
export const authError = (kind, message = 'That did not work.') => new AuthError(kind, message);
