-- =====================================================================
-- 002 — Subscription plan status (M3 · PR 16)
-- =====================================================================
--
-- The hub syncs these columns from public.restaurants and derives the
-- tenant's effective entitlements from them (see hub_server/lib/plans.js):
--
--   plan_status         active | trialing | past_due | suspended | cancelled
--   trial_ends_at       end of the free trial (status = trialing)
--   current_period_end  end of the paid period (used for the past_due grace window)
--
-- A hub NEVER goes offline over these values. Suspended / cancelled / expired
-- tenants degrade to starter limits and features; order entry and billing keep
-- working. Safe to run more than once.
-- =====================================================================

BEGIN;

ALTER TABLE public.restaurants
    ADD COLUMN IF NOT EXISTS plan_status        VARCHAR(20) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS trial_ends_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

ALTER TABLE public.restaurants
    DROP CONSTRAINT IF EXISTS restaurants_plan_check,
    ADD CONSTRAINT restaurants_plan_check
        CHECK (plan IN ('starter', 'pro', 'enterprise'));

ALTER TABLE public.restaurants
    DROP CONSTRAINT IF EXISTS restaurants_plan_status_check,
    ADD CONSTRAINT restaurants_plan_status_check
        CHECK (plan_status IN ('active', 'trialing', 'past_due', 'suspended', 'cancelled'));

COMMENT ON COLUMN public.restaurants.plan_status IS
    'Subscription state. Drives hub entitlements; non-active states degrade the tenant to starter, never block service.';

COMMIT;
