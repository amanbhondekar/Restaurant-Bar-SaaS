-- =====================================================================
-- MIGRATION 021: WHAT THE OPERATOR SEES OF EVERY RESTAURANT AT ONCE
-- =====================================================================
-- Until now the person running Kullina had no single place to look. Which restaurants have not paid, whose trial is about to end, whose
-- laptop has been off for three days: each answer was a different table, or the Supabase dashboard, or a phone call. This migration
-- adds the two things the operator console (signup_server/ + src/ops/) reads.
--
--   hub_status   A hub says, every few minutes, that it is alive and how its sync is doing: its version, since when it has been running,
--                how many bills are waiting to reach the cloud, how many were shelved, when it last got something through, how many
--                handsets and waiters it knows. Until now the only sign of life the cloud had was a bill arriving, which on a quiet
--                day is no sign at all. One row per restaurant, replaced each time. The hub writes it with its own login (role
--                'kitchen'), as it writes everything; an owner or manager may read it, as everywhere (015).
--
--                `received_at` is the DATABASE's clock, set by a trigger whatever the hub sends. The hub's own clock is kept beside it
--                (`reported_at`) because the difference between the two is how a laptop with the wrong time is found: a wrong clock
--                quietly moves a trial's end and a billing period's end on that hub.
--
--   ops_tenants  One row per restaurant: who it is, its plan and the state of its payment, its newest subscription, its hub's last
--                report, and how many bills it issued this week. Not a table: a view, so there is nothing to keep in step.
--   ops_events   The subscription log across every restaurant, newest first when asked for: "why is this tenant past_due".
--
-- THE VIEWS SPAN EVERY RESTAURANT. That is their whole purpose and their whole risk: a tenant's own login must never be able to see that
-- another restaurant exists, and `anon` must not see anything. They are readable by the service role ONLY (the operator service), and
-- by nothing else; the REVOKE below matters because a Supabase project grants every new relation to anon and authenticated by default.
-- They are read-only for everyone, the operator service included.
--
-- What they leave out on purpose: the pairing code, the hash of the hub's provisioning secret, the restaurant's settings, the payment
-- link of a subscription and the payload Razorpay sent (which carries a customer's details). The operator needs to see what is
-- happening, not to hold what would let someone act as a restaurant.
--
-- Safe to run again.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The hub's report on itself
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hub_status (
    restaurant_id   UUID PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,

    -- By the hub's clock.
    reported_at     TIMESTAMPTZ NOT NULL,
    started_at      TIMESTAMPTZ,
    version         VARCHAR(40),

    -- The sync queue: bills waiting, orders shelved because the cloud refused them, and the last time something got through.
    queued          INTEGER NOT NULL DEFAULT 0,
    quarantined     INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TIMESTAMPTZ,

    -- What the hub knows of its floor: enrolled handsets, and waiters who can sign in. Counts only; never a name or a token.
    devices         INTEGER NOT NULL DEFAULT 0,
    waiters         INTEGER NOT NULL DEFAULT 0,

    -- By the database's clock, set by the trigger below.
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT hub_status_counts_check CHECK (queued >= 0 AND quarantined >= 0 AND devices >= 0 AND waiters >= 0)
);

CREATE OR REPLACE FUNCTION public.hub_status_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.received_at := now();
    RETURN NEW;
END;
$$;

-- Only ever run by the trigger.
REVOKE ALL ON FUNCTION public.hub_status_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS hub_status_stamp ON public.hub_status;
CREATE TRIGGER hub_status_stamp
    BEFORE INSERT OR UPDATE ON public.hub_status
    FOR EACH ROW EXECUTE FUNCTION public.hub_status_stamp();

ALTER TABLE public.hub_status ENABLE ROW LEVEL SECURITY;

-- Start from nothing, then give back what each caller does (the way 014 does). service_role bypasses row-level security and keeps its
-- default privileges.
REVOKE ALL ON public.hub_status FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hub_status TO authenticated;

DROP POLICY IF EXISTS "Tenant read for hub_status" ON public.hub_status;
DROP POLICY IF EXISTS "Hub insert for hub_status"  ON public.hub_status;
DROP POLICY IF EXISTS "Hub update for hub_status"  ON public.hub_status;

CREATE POLICY "Tenant read for hub_status" ON public.hub_status FOR SELECT
    USING (restaurant_id = public.current_restaurant_id());
CREATE POLICY "Hub insert for hub_status" ON public.hub_status FOR INSERT
    WITH CHECK (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = 'kitchen');
CREATE POLICY "Hub update for hub_status" ON public.hub_status FOR UPDATE
    USING (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = 'kitchen')
    WITH CHECK (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = 'kitchen');

-- ---------------------------------------------------------------------
-- 2. The fleet, for the operator service
-- ---------------------------------------------------------------------
-- A bill counts by when it was ISSUED, which is what the existing index (005) is on: the newest bill is an index lookup, and the week's
-- count is a range scan, however many bills a restaurant has issued over the years.
CREATE OR REPLACE VIEW public.ops_tenants AS
SELECT
    r.id                  AS restaurant_id,
    r.name,
    r.slug,
    r.city,
    r.phone,
    r.plan,
    r.plan_status,
    r.trial_ends_at,
    r.current_period_end,
    r.created_at,

    s.status              AS subscription_status,
    s.plan                AS subscription_plan,
    s.cancel_requested_at AS subscription_cancel_requested_at,
    s.plan_change_to      AS subscription_plan_change_to,
    s.current_end         AS subscription_period_end,
    s.last_event_at       AS subscription_last_event_at,

    h.received_at         AS hub_seen_at,
    h.reported_at         AS hub_reported_at,
    h.started_at          AS hub_started_at,
    h.version             AS hub_version,
    h.queued              AS hub_queued,
    h.quarantined         AS hub_quarantined,
    h.last_synced_at      AS hub_last_synced_at,
    h.devices             AS hub_devices,
    h.waiters             AS hub_waiters,

    li.last_invoice_at,
    wk.invoices_7d
FROM public.restaurants r
LEFT JOIN LATERAL (
    SELECT x.status, x.plan, x.cancel_requested_at, x.plan_change_to, x.current_end, x.last_event_at
      FROM public.subscriptions x
     WHERE x.restaurant_id = r.id
     ORDER BY x.created_at DESC
     LIMIT 1
) s ON TRUE
LEFT JOIN public.hub_status h ON h.restaurant_id = r.id
LEFT JOIN LATERAL (
    SELECT max(i.issued_at) AS last_invoice_at
      FROM public.invoices i
     WHERE i.restaurant_id = r.id
) li ON TRUE
LEFT JOIN LATERAL (
    SELECT count(*)::int AS invoices_7d
      FROM public.invoices i
     WHERE i.restaurant_id = r.id AND i.issued_at > now() - interval '7 days'
) wk ON TRUE;

-- An event that matched no restaurant (a webhook for a subscription nobody knows) is still listed, with no name.
CREATE OR REPLACE VIEW public.ops_events AS
SELECT
    e.id,
    e.restaurant_id,
    r.name AS restaurant_name,
    e.razorpay_subscription_id,
    e.event,
    e.applied_plan_status,
    e.received_at
FROM public.subscription_events e
LEFT JOIN public.restaurants r ON r.id = e.restaurant_id;

-- Nothing for anon or a tenant's login, and not even a write for the service role.
REVOKE ALL ON public.ops_tenants, public.ops_events FROM anon, authenticated, service_role;
GRANT SELECT ON public.ops_tenants, public.ops_events TO service_role;

COMMIT;
