-- =====================================================================
-- MIGRATION 018: CREATING AND MANAGING A SUBSCRIPTION
-- =====================================================================
-- Migration 010 made the tables a subscription lives in; nothing wrote to them. The operator service now creates a
-- subscription for a restaurant (the owner authorises payment on Razorpay's own page), cancels it at the end of the period,
-- schedules a change of plan, and records every webhook it applies. This adds what that needs.
--
-- On `subscriptions`:
--   plan                  OUR name for the plan it is for ('pro', 'enterprise'), so the owner is shown a plan and not an id.
--   short_url             Razorpay's hosted page where the owner authorises payment. Only meaningful while the subscription is
--                         waiting to be paid; the operator service stops handing it out afterwards.
--   cancel_requested_at   When a cancellation at the end of the period was asked for. The status itself changes when Razorpay
--                         says so, at the end of the period, so without this the screen could not say "ends on ...".
--   plan_change_to        The plan a scheduled change will move to, cleared when a charge at that plan arrives.
--   last_event_at         When Razorpay said the last applied event happened. Webhooks can arrive late and out of order; an
--                         event older than this is logged and not applied over newer news.
-- On `subscription_events`:
--   razorpay_event_id     Razorpay's id for the delivery, unique, so a redelivered event is recognised and logged once. (NULLs
--                         are distinct to Postgres, so an event that arrived without one does not collide with another.)
--
-- Nothing here is readable or writable by `anon` or `authenticated`: both tables stay the operator service's alone (010, 014).
-- Safe to re-run.
-- =====================================================================

BEGIN;

ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS plan                VARCHAR(20);
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS short_url           TEXT;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS plan_change_to      VARCHAR(20);
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS last_event_at       TIMESTAMPTZ;

ALTER TABLE public.subscription_events ADD COLUMN IF NOT EXISTS razorpay_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_events_razorpay_event
    ON public.subscription_events (razorpay_event_id);

COMMIT;
