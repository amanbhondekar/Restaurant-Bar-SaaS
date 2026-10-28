-- =====================================================================
-- MIGRATION 025: ONE RESTAURANT'S HISTORY (Phase 2, P2-1 of docs/SUPER_ADMIN_BUILD_SHEET.md)
-- =====================================================================
-- Run once in the Supabase SQL editor after 024; safe to re-run. Adds one read-only function for the console, `admin_tenant_timeline`, and changes nothing else.
--
-- The timeline is what happened to ONE restaurant, on the spine (migration 023), newest first: what Razorpay told the operator service about its
-- subscription, what its hub reported about itself, what the alert engine did about it (migration 024), and what an administrator did. It asks
-- `spine_assert_admin()` first like every other admin function, reads nothing but `tenant_events` and the allowlist's emails, and writes nothing.
--
-- THE KINDS are filtered here, in the database, and not hidden by the page afterwards, so a page of "alerts" is a page of alerts and paging through
-- them never mixes in (or skips) what the filter would have hidden. They do not overlap. An alert is an alert even when a person acknowledged it:
--     alerts   the type starts "alert."
--     admin    the type starts "admin." (and is not an alert): what an administrator or the console did to this restaurant
--     billing  Razorpay's events (source "razorpay"), however they are named
--     hub      the hub's own reports (source "hub")
-- Events of any other kind appear in the unfiltered timeline and in none of the four. The page's words for an event (common/eventWords.js) classify
-- the same way, and a test pins that the two agree.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_tenant_timeline(
    p_restaurant_id UUID, p_kind TEXT DEFAULT NULL, p_before BIGINT DEFAULT NULL, p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    id BIGINT, occurred_at TIMESTAMPTZ, source TEXT, type TEXT, actor_type TEXT, actor_id UUID, actor_email TEXT,
    request_id TEXT, payload JSONB, chain_seq BIGINT, row_hash TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_user UUID := public.spine_assert_admin();
BEGIN
    IF p_kind IS NOT NULL AND p_kind NOT IN ('billing', 'hub', 'alerts', 'admin') THEN
        RAISE EXCEPTION 'admin_tenant_timeline: the kind must be billing, hub, alerts or admin' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 THEN
        RAISE EXCEPTION 'admin_tenant_timeline: the limit must be at least 1' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
    SELECT e.id, e.occurred_at, e.source, e.type, e.actor_type, e.actor_id, a.email, e.request_id, e.payload, e.chain_seq, e.row_hash
      FROM public.tenant_events e
      LEFT JOIN public.admin_users a ON a.user_id = e.actor_id
     WHERE e.restaurant_id = p_restaurant_id
       AND (p_before IS NULL OR e.id < p_before)
       AND (p_kind IS NULL
            OR (p_kind = 'alerts'  AND e.type LIKE 'alert.%')
            OR (p_kind = 'admin'   AND e.type LIKE 'admin.%')
            OR (p_kind = 'billing' AND e.source = 'razorpay' AND e.type NOT LIKE 'alert.%' AND e.type NOT LIKE 'admin.%')
            OR (p_kind = 'hub'     AND e.source = 'hub'      AND e.type NOT LIKE 'alert.%' AND e.type NOT LIKE 'admin.%'))
     ORDER BY e.id DESC
     LIMIT least(p_limit, 500);
END;
$$;

-- Closed to everyone, then opened to the dedicated console role alone (the pattern of migrations 014, 023 and 024).
REVOKE ALL ON FUNCTION public.admin_tenant_timeline(UUID, TEXT, BIGINT, INTEGER) FROM PUBLIC, anon, authenticated, service_role, kullina_alerts;
GRANT EXECUTE ON FUNCTION public.admin_tenant_timeline(UUID, TEXT, BIGINT, INTEGER) TO kullina_admin;

COMMIT;
