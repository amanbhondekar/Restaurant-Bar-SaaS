// The Plan tab's subscription panel, without React (§4.4). Everything here turns one GET /admin/billing answer into what the panel
// says and what it offers: where things stand, in the owner's words, and which buttons exist. The panel itself only draws it.
//
// The rule that shapes every state: nothing here moves money. "Subscribe" opens a page at Razorpay where the owner authorises
// payment, so until they do nothing is charged. Anything that cannot be undone (cancelling, switching plan) is asked about first.

import { planLabel } from './plan';

const STOPPED = new Set(['cancelled', 'completed', 'expired']);

const NEVER_OFF = 'Orders, billing and the kitchen display are never switched off.';

const UNREACHABLE_COPY = {
  OFFLINE: 'This needs the internet, and the hub cannot reach the billing service right now. Everything else on this page still works.',
  NO_CLOUD_SESSION: 'This hub has not signed in to the cloud yet. It needs the internet once. Try again in a minute.',
  BILLING_UNAVAILABLE: 'The billing service is not answering. Try again in a minute.'
};

/** A date, without the time, for "renews on" and "ends on"; anything missing or unparseable reads as null. */
export function formatDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A payment page is only offered if it is an https address: this link comes back from a service, and is opened in the owner's browser. */
function paymentLink(url) {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).protocol === 'https:' ? { href: url, label: 'Open the payment page' } : undefined;
  } catch {
    return undefined;
  }
}

const subscribeActions = plans => plans.map(p => ({ id: 'subscribe', plan: p, label: `Subscribe to ${planLabel(p)}` }));
const cancelAction = { id: 'cancel', label: 'Cancel subscription', destructive: true };

/**
 * @param {{ billing: object|null, billingError?: Error|null, plan?: object|null }} input
 * @returns {{ kind: string, tone: 'neutral'|'good'|'warning', title: string, text: string, actions: object[], link?: {href: string, label: string}, subscription?: object }}
 */
export function describeBilling({ billing, billingError = null, plan = null } = {}) {
  if (!billing) {
    // A HubError's message is the hub's own plain-words sentence.
    return { kind: 'unreachable', tone: 'warning', title: 'Billing is unavailable right now', text: billingError?.message || 'The billing service could not be reached.', actions: [] };
  }

  if (billing.configured === false) {
    return { kind: 'not_connected', tone: 'neutral', title: 'Online billing is not connected', text: 'The plan on this hub is set by hand for now.', actions: [] };
  }

  if (billing.reachable === false) {
    return {
      kind: 'unreachable',
      tone: 'warning',
      title: 'Billing is unavailable right now',
      text: UNREACHABLE_COPY[billing.reason] || 'The billing service could not be reached.',
      actions: []
    };
  }

  const offered = Array.isArray(billing.plans) ? billing.plans : [];
  const sub = billing.subscription || null;

  if (!sub) {
    return offered.length
      ? {
          kind: 'none',
          tone: 'neutral',
          title: 'Not subscribed',
          text: 'Subscribing opens a payment page at Razorpay. Nothing is charged until you authorise it there.',
          actions: subscribeActions(offered)
        }
      : { kind: 'none', tone: 'neutral', title: 'Not subscribed', text: 'Plans cannot be bought online yet. The plan on this hub is set by hand.', actions: [] };
  }

  const name = planLabel(sub.plan || plan?.plan || '');
  const ends = formatDay(sub.current_end);
  const base = { subscription: sub };

  if (STOPPED.has(sub.status)) {
    return {
      ...base,
      kind: 'ended',
      tone: 'neutral',
      title: 'Subscription ended',
      text: `The ${name} subscription has ended. ${NEVER_OFF} Start a new one to go back to a paid plan.`,
      actions: subscribeActions(offered)
    };
  }

  if (sub.status === 'halted') {
    return {
      ...base,
      kind: 'ended',
      tone: 'warning',
      title: 'Payments stopped',
      text: `Razorpay stopped trying after repeated failed payments, so the ${name} subscription is not running. ${NEVER_OFF} Start a new one to go back to a paid plan.`,
      actions: subscribeActions(offered)
    };
  }

  if (sub.status === 'created') {
    const link = paymentLink(sub.short_url);
    return {
      ...base,
      kind: 'waiting',
      tone: 'neutral',
      title: `Waiting for payment: ${name}`,
      text: link
        ? 'Open the payment page and authorise the payment. Nothing is charged until you do. If you leave it, the request lapses by itself.'
        : 'The payment page link is not available on this screen. Nothing is charged until it is authorised, and the request lapses by itself if it is left.',
      actions: [],
      ...(link ? { link } : {})
    };
  }

  if (sub.cancel_requested_at && ['authenticated', 'active', 'pending'].includes(sub.status)) {
    return {
      ...base,
      kind: 'cancelling',
      tone: 'neutral',
      title: ends ? `Ends ${ends}` : 'Ends at the end of this period',
      text: `${name} keeps working until then. After that this restaurant moves to Starter. ${NEVER_OFF}`,
      actions: []
    };
  }

  if (sub.status === 'pending') {
    return {
      ...base,
      kind: 'past_due',
      tone: 'warning',
      title: 'Last payment failed',
      text: `A payment for ${name} did not go through, and Razorpay will try again. Everything keeps working through the grace period.`,
      actions: [cancelAction]
    };
  }

  if (sub.status === 'authenticated') {
    return {
      ...base,
      kind: 'active',
      tone: 'neutral',
      title: `${name}, set up`,
      text: `Payment is authorised. ${name} starts once the first payment goes through.`,
      actions: [cancelAction]
    };
  }

  if (sub.status === 'active') {
    const renews = ends ? `Renews ${ends}.` : 'Renews each period.';
    const target = sub.plan_change_to ? planLabel(sub.plan_change_to) : null;
    const others = target ? [] : offered.filter(p => p !== sub.plan).map(p => ({ id: 'change', plan: p, label: `Switch to ${planLabel(p)}` }));
    return {
      ...base,
      kind: 'active',
      tone: 'good',
      title: `${name}, running`,
      text: target ? `${renews} At the end of this period it moves to ${target}.` : renews,
      actions: [...others, cancelAction]
    };
  }

  return {
    ...base,
    kind: 'unknown',
    tone: 'neutral',
    title: `Subscription: ${sub.status}`,
    text: 'This screen does not know that status yet. The plan above is what applies.',
    actions: []
  };
}
