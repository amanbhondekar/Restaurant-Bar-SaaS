-- =====================================================================
-- MIGRATION 010: SUBSCRIPTIONS (Razorpay) — M3 · PR 19
-- =====================================================================
-- What the restaurant pays US. Distinct from `invoices`, which is what a
-- guest pays the restaurant; the two must never be confused in a query.
--
-- The plan machinery already exists and is enforced on the hub: migration
-- 004 put plan, plan_status, trial_ends_at and current_period_end on
-- restaurants, and hub_server/lib/plans.js degrades a tenant to Starter
-- limits while past_due, suspended or cancelled -- without ever switching
-- off orders, billing or the kitchen display. So a subscription's only job
-- is to keep those columns honest.
--
-- This table is therefore a RECORD, not a source of truth for entitlement:
--   * which Razorpay subscription belongs to which restaurant, so it can be
--     found, cancelled or asked about later;
--   * an append-only log of the events that have been applied, so "why is
--     this tenant past_due" has an answer that is not a Razorpay dashboard.
--
-- Run once in the Supabase SQL editor; safe to re-run.
--
-- NOTE ON WHO WRITES THIS. Razorpay delivers subscription events as webhooks
-- to a public address. A hub has none, and must never hold the Razorpay
-- secret -- it sits on a restaurant's wifi. The operator service in
-- signup_server/ is what receives them, exactly as it is what may call
-- provision_restaurant(). Nothing here is reachable by anon or authenticated.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.subscriptions (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id            UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    -- Razorpay's own ids. The subscription id is the upsert key: one live
    -- subscription per restaurant is the intent, but a tenant that cancels
    -- and re-subscribes gets a new one, and the old row is worth keeping.
    razorpay_subscription_id TEXT NOT NULL,
    razorpay_plan_id         TEXT,
    razorpay_customer_id     TEXT,

    -- Razorpay's vocabulary, not ours: created, authenticated, active,
    -- pending, halted, cancelled, completed, expired. The translation into
    -- plan_status lives in hub_server/lib/razorpay.js so that one mapping is
    -- tested in one place rather than written out again in SQL.
    status                   TEXT NOT NULL,

    current_start            TIMESTAMPTZ,
    current_end              TIMESTAMPTZ,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_razorpay_id
    ON public.subscriptions (razorpay_subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_restaurant
    ON public.subscriptions (restaurant_id, created_at DESC);

-- Every event that was applied, in the order it was applied. Append-only: a
-- billing state that cannot be explained is worse than one that is wrong,
-- and Razorpay redelivers, so the same event id may arrive more than once.
CREATE TABLE IF NOT EXISTS public.subscription_events (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id            UUID REFERENCES public.restaurants(id) ON DELETE CASCADE,
    razorpay_subscription_id TEXT,

    event                    TEXT NOT NULL,
    -- What the tenant's plan_status was set to as a result. Null when the
    -- event was acknowledged but acted on by nobody.
    applied_plan_status      TEXT,
    payload                  JSONB,
    received_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_restaurant
    ON public.subscription_events (restaurant_id, received_at DESC);

ALTER TABLE public.subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_events  ENABLE ROW LEVEL SECURITY;

-- Deliberately NO policy for anon or authenticated on either table.
--
-- Every other tenant table has a `current_restaurant_id()` policy so a hub can
-- read its own rows. These two are different: a hub never needs them. It
-- learns everything it is entitled to from restaurants.plan_status, which it
-- already syncs, and a hub that could read its own billing could also write
-- it. With RLS on and no policy, only the service key reaches these -- which
-- is the operator service, and nothing else.
--
-- A grant is still needed for that service key to see the columns at all;
-- the service role bypasses RLS but not table privileges.
GRANT SELECT, INSERT, UPDATE ON public.subscriptions       TO service_role;
GRANT SELECT, INSERT         ON public.subscription_events TO service_role;

COMMENT ON TABLE public.subscriptions IS
    'What a restaurant pays Kullina (Razorpay). Not what a guest pays a restaurant -- that is invoices.';
COMMENT ON TABLE public.subscription_events IS
    'Append-only log of applied Razorpay events, so a plan_status always has an explanation.';

COMMIT;
