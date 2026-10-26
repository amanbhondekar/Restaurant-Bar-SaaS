-- =====================================================================
-- MIGRATION 023: THE SUPER ADMIN CONSOLE'S FOUNDATION (Phase 1, P1-1 / P1-2 / P1-4)
-- =====================================================================
-- docs/SUPER_ADMIN_BUILD_SHEET.md, Phase 1. This is the part of the console that has to be right before anything is built on it: who may
-- use it, the one log everything is recorded on, and the single door the admin API gets through.
--
-- Run once in the Supabase SQL editor; safe to re-run. Nothing here changes how a restaurant's hub, the operator service or the existing
-- /ops console behaves (the two hooks that watch `subscription_events` and `hub_status` can never make either of them fail).
--
--  1. THE DEDICATED ROLE (decision D1). `kullina_admin` is what the admin API connects as. It is NOT the service key: it holds no privilege
--     on any table or view at all, and may run exactly the `admin_*` functions below, each of which checks WHO is asking before it does
--     anything. So an admin API that were compromised could read the console's views and nothing else: not a bill, not a menu, not an order
--     (invariant I1). The role cannot log in until a human gives it a password; no password lives in this repository:
--         ALTER ROLE kullina_admin LOGIN PASSWORD '...';   -- run by hand, once, in the SQL editor
--
--  2. THE ALLOWLIST. `admin_users` is the people who may sign in to the console. At most two can be active at a time (the founders; role
--     based access is a non-goal). Only the database's owner can change it, from the SQL editor, with `seed_admin_user` and
--     `deactivate_admin_user`, and both leave an event.
--
--  3. THE ASKER. Every `admin_*` function begins with `spine_assert_admin()`: the caller's signed token (the claims PostgREST, or the admin
--     API, puts in `request.jwt.claims`) must name an ACTIVE administrator AND carry `aal: aal2` (a second factor was used this session).
--     The check is repeated here on purpose: the admin API checks the same two things first, and this is what holds if it ever has a bug.
--
--  4. THE SPINE. `tenant_events` is an append-only log of everything that happens to a restaurant or to the console, one hash chain per
--     restaurant (and one for events that belong to none). Nobody inserts into it directly: `record_tenant_event()` is the only way in,
--     and a trigger numbers each event, links it to the one before and hashes it, whatever the caller supplied. The hash is SHA-256 over:
--         prev_hash | chain_key | chain_seq | occurred_at (UTC, microseconds) | source | type | actor_type | actor_id | request_id |
--         source_ref | payload::text
--     so `tenant_events_verify()` (and anyone with a copy of the rows) can recompute it. UPDATE, DELETE and TRUNCATE are refused for every
--     role including the owner and the service role (invariant I5); the one deletion allowed is the cascade from removing a restaurant,
--     which is how a tenant's data is erased. An admin event must name its actor, by a CHECK (invariant I3).
--     Honest limits: a chain written by the database shows an edit, a removal from the middle, a reordering or an inserted event; it does
--     not show events cut off the END, and a database administrator can drop the triggers. Keeping each chain's head somewhere else is
--     the answer to both, and is not built.
--
--  5. INGEST (P1-4). A subscription event the operator service logs, and a change in what a hub reports about itself (first report, new
--     version, restart, orders shelved or freed), now also land on the spine, as they happen. Counts and times only (invariant I9): nothing
--     Razorpay sent, no name, no token. Both hooks swallow their own errors, so a fault here can never fail a webhook or a hub's heartbeat
--     (invariant I7). `spine_backfill_subscription_events()` brings in events from before this migration, and any a hook missed, once.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The dedicated role
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kullina_admin') THEN
        CREATE ROLE kullina_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO kullina_admin;

-- ---------------------------------------------------------------------
-- 2. The allowlist
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_users (
    user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
    email           TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    -- Role based access is deferred; the column is here so adding it later is not a migration of existing rows.
    role            TEXT NOT NULL DEFAULT 'founder',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID REFERENCES auth.users(id),
    deactivated_at  TIMESTAMPTZ,

    CONSTRAINT admin_users_email_lower CHECK (email = lower(email)),
    CONSTRAINT admin_users_role_check  CHECK (role IN ('founder'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_users_email ON public.admin_users (email);

CREATE OR REPLACE FUNCTION public.allowlist_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.active AND (SELECT count(*) FROM public.admin_users a WHERE a.active AND a.user_id <> NEW.user_id) >= 2 THEN
        RAISE EXCEPTION 'admin_users: at most two administrators can be active at a time'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS allowlist_cap ON public.admin_users;
CREATE TRIGGER allowlist_cap
    BEFORE INSERT OR UPDATE OF active ON public.admin_users
    FOR EACH ROW EXECUTE FUNCTION public.allowlist_cap();

-- ---------------------------------------------------------------------
-- 3. The spine
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Null only for an event that belongs to no restaurant (a founder signing in; a subscription event for a subscription nobody knows).
    restaurant_id   UUID REFERENCES public.restaurants(id) ON DELETE CASCADE,
    -- The chain this event is on: its restaurant, or the all-zero id for events that belong to none.
    chain_key       UUID GENERATED ALWAYS AS (COALESCE(restaurant_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
    chain_seq       BIGINT NOT NULL,

    -- The database's clock, unless an ingest says when the thing really happened.
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    source          TEXT NOT NULL,
    type            TEXT NOT NULL,
    actor_type      TEXT NOT NULL,
    actor_id        UUID,
    request_id      TEXT,
    -- What an ingested event was copied from (for example "subscription_events:<id>"), so copying it again is a no-op.
    source_ref      TEXT,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

    prev_hash       TEXT NOT NULL,
    row_hash        TEXT NOT NULL,

    CONSTRAINT tenant_events_source_check      CHECK (source IN ('hub', 'razorpay', 'admin', 'system', 'support')),
    CONSTRAINT tenant_events_actor_type_check  CHECK (actor_type IN ('admin', 'hub', 'system', 'webhook')),
    CONSTRAINT tenant_events_type_check        CHECK (length(btrim(type)) > 0),
    CONSTRAINT tenant_events_payload_check     CHECK (jsonb_typeof(payload) = 'object'),
    -- Invariant I3: every admin action is attributed.
    CONSTRAINT tenant_events_admin_actor_check CHECK (actor_type <> 'admin' OR actor_id IS NOT NULL),
    CONSTRAINT tenant_events_hash_check        CHECK (row_hash ~ '^[0-9a-f]{64}$' AND prev_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_events_chain ON public.tenant_events (chain_key, chain_seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_events_source_ref ON public.tenant_events (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_events_restaurant ON public.tenant_events (restaurant_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_events_type ON public.tenant_events (type, id DESC);

-- What an event hashes to. Everything that identifies it, joined with "|", so a field cannot slide into its neighbour unnoticed.
CREATE OR REPLACE FUNCTION public.tenant_events_hash(
    p_prev TEXT, p_key UUID, p_seq BIGINT, p_at TIMESTAMPTZ, p_source TEXT, p_type TEXT,
    p_actor_type TEXT, p_actor_id UUID, p_request_id TEXT, p_source_ref TEXT, p_payload JSONB
)
RETURNS TEXT
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    SELECT encode(sha256(convert_to(
        p_prev || '|' || p_key::text || '|' || p_seq::text || '|'
        || to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
        || p_source || '|' || p_type || '|' || p_actor_type || '|' || COALESCE(p_actor_id::text, '') || '|'
        || COALESCE(p_request_id, '') || '|' || COALESCE(p_source_ref, '') || '|' || p_payload::text,
        'UTF8')), 'hex');
$$;

-- Numbers each event, links it to the one before and hashes it, whatever the caller put in those columns. One chain is written at a time.
CREATE OR REPLACE FUNCTION public.tenant_events_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_key  UUID := COALESCE(NEW.restaurant_id, '00000000-0000-0000-0000-000000000000'::uuid);
    v_seq  BIGINT;
    v_hash TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('tenant_events:' || v_key::text, 0));
    SELECT e.chain_seq, e.row_hash INTO v_seq, v_hash
      FROM public.tenant_events e
     WHERE e.chain_key = v_key
     ORDER BY e.chain_seq DESC
     LIMIT 1;
    NEW.chain_seq := COALESCE(v_seq, 0) + 1;
    NEW.prev_hash := COALESCE(v_hash, repeat('0', 64));
    NEW.row_hash  := public.tenant_events_hash(NEW.prev_hash, v_key, NEW.chain_seq, NEW.occurred_at, NEW.source, NEW.type,
                                               NEW.actor_type, NEW.actor_id, NEW.request_id, NEW.source_ref, NEW.payload);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_events_chain ON public.tenant_events;
CREATE TRIGGER tenant_events_chain
    BEFORE INSERT ON public.tenant_events
    FOR EACH ROW EXECUTE FUNCTION public.tenant_events_chain();

-- Append only, for every role. pg_trigger_depth() is 1 for a DELETE someone ran and 2 or more for one the foreign key ran when a
-- restaurant was removed: that is the only deletion allowed.
CREATE OR REPLACE FUNCTION public.tenant_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'tenant_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS tenant_events_append_only ON public.tenant_events;
CREATE TRIGGER tenant_events_append_only
    BEFORE UPDATE OR DELETE ON public.tenant_events
    FOR EACH ROW EXECUTE FUNCTION public.tenant_events_append_only();

DROP TRIGGER IF EXISTS tenant_events_no_truncate ON public.tenant_events;
CREATE TRIGGER tenant_events_no_truncate
    BEFORE TRUNCATE ON public.tenant_events
    FOR EACH STATEMENT EXECUTE FUNCTION public.tenant_events_append_only();

-- The only way to add an event. Returns its id.
CREATE OR REPLACE FUNCTION public.record_tenant_event(
    p_restaurant_id UUID, p_source TEXT, p_type TEXT, p_actor_type TEXT, p_actor_id UUID,
    p_request_id TEXT, p_payload JSONB, p_occurred_at TIMESTAMPTZ DEFAULT NULL, p_source_ref TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO public.tenant_events (restaurant_id, occurred_at, source, type, actor_type, actor_id, request_id, source_ref, payload)
    VALUES (p_restaurant_id, COALESCE(p_occurred_at, clock_timestamp()), p_source, p_type, p_actor_type, p_actor_id,
            p_request_id, p_source_ref, COALESCE(p_payload, '{}'::jsonb))
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- Walks one chain from its start and says where it first breaks. The link is checked before the hash, so a rewritten hash that is
-- consistent with its own row is still found, at the event after it.
CREATE OR REPLACE FUNCTION public.tenant_events_verify(p_restaurant_id UUID)
RETURNS TABLE (ok BOOLEAN, checked BIGINT, broken_at BIGINT, reason TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_key      UUID := COALESCE(p_restaurant_id, '00000000-0000-0000-0000-000000000000'::uuid);
    r          RECORD;
    v_prev     TEXT := repeat('0', 64);
    v_expected BIGINT := 1;
    v_count    BIGINT := 0;
BEGIN
    FOR r IN SELECT * FROM public.tenant_events e WHERE e.chain_key = v_key ORDER BY e.chain_seq, e.id LOOP
        IF r.chain_seq <> v_expected THEN
            RETURN QUERY SELECT FALSE, v_count, r.chain_seq,
                format('event %s is missing or out of order (seq %s found where %s was expected)', v_expected, r.chain_seq, v_expected);
            RETURN;
        END IF;
        IF r.prev_hash <> v_prev THEN
            RETURN QUERY SELECT FALSE, v_count, r.chain_seq,
                format('the prev_hash of event %s does not match the hash of the event before it (the chain is broken here)', r.chain_seq);
            RETURN;
        END IF;
        IF r.row_hash <> public.tenant_events_hash(r.prev_hash, r.chain_key, r.chain_seq, r.occurred_at, r.source, r.type,
                                                  r.actor_type, r.actor_id, r.request_id, r.source_ref, r.payload) THEN
            RETURN QUERY SELECT FALSE, v_count, r.chain_seq,
                format('the hash of event %s does not match its contents (it was edited)', r.chain_seq);
            RETURN;
        END IF;
        v_prev := r.row_hash;
        v_expected := v_expected + 1;
        v_count := v_count + 1;
    END LOOP;
    RETURN QUERY SELECT TRUE, v_count, NULL::BIGINT, NULL::TEXT;
END;
$$;

-- ---------------------------------------------------------------------
-- 4. Who is asking
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.spine_assert_admin()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_claims JSONB;
    v_sub    UUID;
BEGIN
    -- Claims that are missing, are not JSON, are not an object, or name a subject that is not an id all come to the same thing: nobody is signed in.
    BEGIN
        v_claims := NULLIF(current_setting('request.jwt.claims', TRUE), '')::jsonb;
        v_sub := (v_claims ->> 'sub')::uuid;
    EXCEPTION WHEN OTHERS THEN
        v_sub := NULL;
    END;
    IF v_sub IS NULL THEN
        RAISE EXCEPTION 'admin access denied: no signed-in user' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = v_sub AND a.active) THEN
        RAISE EXCEPTION 'admin access denied: not an active administrator' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF (v_claims ->> 'aal') IS DISTINCT FROM 'aal2' THEN
        RAISE EXCEPTION 'admin access denied: multi-factor sign-in (aal2) required' USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN v_sub;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Putting people on the allowlist (by the database's owner, in the SQL editor)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_admin_user(p_email TEXT, p_display_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_email  TEXT := lower(btrim(p_email));
    v_user   UUID;
    v_active BOOLEAN;
BEGIN
    SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = v_email;
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'seed_admin_user: no such user %; they must sign up in Supabase Auth first', v_email;
    END IF;

    SELECT a.active INTO v_active FROM public.admin_users a WHERE a.user_id = v_user;
    IF FOUND THEN
        IF v_active THEN
            RETURN v_user;
        END IF;
        UPDATE public.admin_users SET active = TRUE, deactivated_at = NULL, display_name = btrim(p_display_name) WHERE user_id = v_user;
        PERFORM public.record_tenant_event(NULL, 'system', 'admin.user_reactivated', 'system', NULL, NULL,
                                           jsonb_build_object('email', v_email, 'display_name', btrim(p_display_name)));
    ELSE
        INSERT INTO public.admin_users (user_id, email, display_name) VALUES (v_user, v_email, btrim(p_display_name));
        PERFORM public.record_tenant_event(NULL, 'system', 'admin.user_added', 'system', NULL, NULL,
                                           jsonb_build_object('email', v_email, 'display_name', btrim(p_display_name)));
    END IF;
    RETURN v_user;
END;
$$;

CREATE OR REPLACE FUNCTION public.deactivate_admin_user(p_email TEXT, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_email TEXT := lower(btrim(p_email));
    v_user  UUID;
BEGIN
    IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
        RAISE EXCEPTION 'deactivate_admin_user: a reason of at least 10 characters is required';
    END IF;
    SELECT a.user_id INTO v_user FROM public.admin_users a WHERE a.email = v_email AND a.active;
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'deactivate_admin_user: % is not an active administrator', v_email;
    END IF;
    UPDATE public.admin_users SET active = FALSE, deactivated_at = now() WHERE user_id = v_user;
    PERFORM public.record_tenant_event(NULL, 'system', 'admin.user_deactivated', 'system', NULL, NULL,
                                       jsonb_build_object('email', v_email, 'reason', btrim(p_reason)));
END;
$$;

-- ---------------------------------------------------------------------
-- 6. The admin functions: the whole surface the admin API may call
-- ---------------------------------------------------------------------
-- Each one asks spine_assert_admin() first. Reads only, in Phase 1, except that signing in is recorded.

CREATE OR REPLACE FUNCTION public.admin_whoami()
RETURNS TABLE (user_id UUID, email TEXT, display_name TEXT, role TEXT, aal TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_user UUID := public.spine_assert_admin();
BEGIN
    RETURN QUERY SELECT a.user_id, a.email, a.display_name, a.role, 'aal2'::text FROM public.admin_users a WHERE a.user_id = v_user;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_record_signin(p_request_id TEXT DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user UUID := public.spine_assert_admin();
BEGIN
    RETURN public.record_tenant_event(NULL, 'admin', 'admin.signin', 'admin', v_user, p_request_id, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_events(
    p_restaurant_id UUID DEFAULT NULL, p_type TEXT DEFAULT NULL, p_source TEXT DEFAULT NULL, p_actor_id UUID DEFAULT NULL,
    p_from TIMESTAMPTZ DEFAULT NULL, p_to TIMESTAMPTZ DEFAULT NULL, p_before BIGINT DEFAULT NULL, p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
    id BIGINT, restaurant_id UUID, restaurant_name TEXT, occurred_at TIMESTAMPTZ, source TEXT, type TEXT, actor_type TEXT,
    actor_id UUID, actor_email TEXT, request_id TEXT, payload JSONB, chain_seq BIGINT, row_hash TEXT
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
    IF p_limit IS NULL OR p_limit < 1 THEN
        RAISE EXCEPTION 'admin_list_events: the limit must be at least 1' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
    SELECT e.id, e.restaurant_id, r.name::text, e.occurred_at, e.source, e.type, e.actor_type, e.actor_id, a.email,
           e.request_id, e.payload, e.chain_seq, e.row_hash
      FROM public.tenant_events e
      LEFT JOIN public.restaurants r ON r.id = e.restaurant_id
      LEFT JOIN public.admin_users a ON a.user_id = e.actor_id
     WHERE (p_restaurant_id IS NULL OR e.restaurant_id = p_restaurant_id)
       AND (p_type   IS NULL OR e.type = p_type)
       AND (p_source IS NULL OR e.source = p_source)
       AND (p_actor_id IS NULL OR e.actor_id = p_actor_id)
       AND (p_from   IS NULL OR e.occurred_at >= p_from)
       AND (p_to     IS NULL OR e.occurred_at <  p_to)
       AND (p_before IS NULL OR e.id < p_before)
     ORDER BY e.id DESC
     LIMIT least(p_limit, 500);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_verify_chain(p_restaurant_id UUID DEFAULT NULL)
RETURNS TABLE (ok BOOLEAN, checked BIGINT, broken_at BIGINT, reason TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user UUID := public.spine_assert_admin();
BEGIN
    RETURN QUERY SELECT * FROM public.tenant_events_verify(p_restaurant_id);
END;
$$;

-- The three reads the operator console (/ops) makes, for the console that replaces it. The views leave out the pairing code, the hash of the
-- hub's secret, the restaurant's settings and everything Razorpay sent.
CREATE OR REPLACE FUNCTION public.admin_fleet(p_limit INTEGER DEFAULT 1000)
RETURNS SETOF public.ops_tenants
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user UUID := public.spine_assert_admin();
BEGIN
    RETURN QUERY SELECT * FROM public.ops_tenants t ORDER BY t.created_at DESC LIMIT least(COALESCE(p_limit, 1000), 1000);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_tenant(p_restaurant_id UUID)
RETURNS SETOF public.ops_tenants
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user UUID := public.spine_assert_admin();
BEGIN
    RETURN QUERY SELECT * FROM public.ops_tenants t WHERE t.restaurant_id = p_restaurant_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_ops_events(p_restaurant_id UUID DEFAULT NULL, p_limit INTEGER DEFAULT 30)
RETURNS SETOF public.ops_events
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user UUID := public.spine_assert_admin();
BEGIN
    RETURN QUERY SELECT * FROM public.ops_events x
                  WHERE p_restaurant_id IS NULL OR x.restaurant_id = p_restaurant_id
                  ORDER BY x.received_at DESC LIMIT least(COALESCE(p_limit, 30), 200);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_tenant_subscriptions(p_restaurant_id UUID, p_limit INTEGER DEFAULT 20)
RETURNS TABLE (
    razorpay_subscription_id TEXT, status TEXT, plan TEXT, plan_change_to TEXT, cancel_requested_at TIMESTAMPTZ,
    current_start TIMESTAMPTZ, current_end TIMESTAMPTZ, last_event_at TIMESTAMPTZ, created_at TIMESTAMPTZ
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
    RETURN QUERY SELECT s.razorpay_subscription_id::text, s.status::text, s.plan::text, s.plan_change_to::text, s.cancel_requested_at,
                        s.current_start, s.current_end, s.last_event_at, s.created_at
                   FROM public.subscriptions s
                  WHERE s.restaurant_id = p_restaurant_id
                  ORDER BY s.created_at DESC LIMIT least(COALESCE(p_limit, 20), 100);
END;
$$;

-- ---------------------------------------------------------------------
-- 7. Ingest: subscription events (P1-4)
-- ---------------------------------------------------------------------
-- Copies one subscription event onto the spine, once. Returns the event's id, or null if it was already there. Only what the console needs:
-- what happened, what it did to the plan, and which subscription. Not the payload Razorpay sent, which carries a customer's details.
CREATE OR REPLACE FUNCTION public.spine_copy_subscription_event(p_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    e public.subscription_events%ROWTYPE;
    v_ref TEXT := 'subscription_events:' || p_id::text;
BEGIN
    IF EXISTS (SELECT 1 FROM public.tenant_events t WHERE t.source = 'razorpay' AND t.source_ref = v_ref) THEN
        RETURN NULL;
    END IF;
    SELECT * INTO e FROM public.subscription_events WHERE id = p_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN public.record_tenant_event(
        e.restaurant_id, 'razorpay', e.event, 'webhook', NULL, NULL,
        jsonb_build_object('event', e.event, 'applied_plan_status', e.applied_plan_status, 'razorpay_subscription_id', e.razorpay_subscription_id),
        e.received_at, v_ref);
END;
$$;

-- As the operator service logs a subscription event, it lands on the spine too. A fault here must never fail the webhook that caused it.
CREATE OR REPLACE FUNCTION public.spine_subscription_event_logged()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    BEGIN
        PERFORM public.spine_copy_subscription_event(NEW.id);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'spine: could not record subscription event %: %', NEW.id, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS spine_subscription_event_logged ON public.subscription_events;
CREATE TRIGGER spine_subscription_event_logged
    AFTER INSERT ON public.subscription_events
    FOR EACH ROW EXECUTE FUNCTION public.spine_subscription_event_logged();

-- Brings in events from before the spine existed, and any a hook missed. Run by the operator service or by hand; safe to run again.
CREATE OR REPLACE FUNCTION public.spine_backfill_subscription_events()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r       RECORD;
    v_total BIGINT := 0;
BEGIN
    FOR r IN
        SELECT s.id FROM public.subscription_events s
         WHERE NOT EXISTS (SELECT 1 FROM public.tenant_events t WHERE t.source = 'razorpay' AND t.source_ref = 'subscription_events:' || s.id::text)
         ORDER BY s.received_at, s.id
    LOOP
        IF public.spine_copy_subscription_event(r.id) IS NOT NULL THEN
            v_total := v_total + 1;
        END IF;
    END LOOP;
    RETURN v_total;
END;
$$;

-- ---------------------------------------------------------------------
-- 8. Ingest: what a hub says about itself (P1-4)
-- ---------------------------------------------------------------------
-- A hub reports every five minutes, so only a CHANGE worth knowing about is an event: its first report, a new version, a restart, orders
-- shelved or freed. A queue that grows and shrinks is not. Counts, versions and times only. A fault here must never fail a heartbeat.
CREATE OR REPLACE FUNCTION public.spine_hub_status_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_started TEXT := to_char(NEW.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
    BEGIN
        IF TG_OP = 'INSERT' THEN
            PERFORM public.record_tenant_event(NEW.restaurant_id, 'hub', 'hub.first_report', 'hub', NULL, NULL,
                                               jsonb_build_object('version', NEW.version, 'started_at', v_started));
        ELSE
            IF NEW.version IS DISTINCT FROM OLD.version THEN
                PERFORM public.record_tenant_event(NEW.restaurant_id, 'hub', 'hub.version_changed', 'hub', NULL, NULL,
                                                   jsonb_build_object('from', OLD.version, 'to', NEW.version));
            END IF;
            IF NEW.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
                PERFORM public.record_tenant_event(NEW.restaurant_id, 'hub', 'hub.restarted', 'hub', NULL, NULL,
                                                   jsonb_build_object('started_at', v_started));
            END IF;
            IF NEW.quarantined IS DISTINCT FROM OLD.quarantined THEN
                PERFORM public.record_tenant_event(NEW.restaurant_id, 'hub', 'hub.shelved_changed', 'hub', NULL, NULL,
                                                   jsonb_build_object('from', OLD.quarantined, 'to', NEW.quarantined));
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'spine: could not record the hub report of %: %', NEW.restaurant_id, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS spine_hub_status_changed ON public.hub_status;
CREATE TRIGGER spine_hub_status_changed
    AFTER INSERT OR UPDATE ON public.hub_status
    FOR EACH ROW EXECUTE FUNCTION public.spine_hub_status_changed();

-- ---------------------------------------------------------------------
-- 9. Who may do what (the pattern of migration 014: say it, do not inherit it)
-- ---------------------------------------------------------------------
ALTER TABLE public.admin_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_events ENABLE ROW LEVEL SECURITY;

-- No policy for anyone: these tables are reached only through the functions above, which run with their owner's rights.
REVOKE ALL ON public.admin_users, public.tenant_events FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON SEQUENCE public.tenant_events_id_seq FROM PUBLIC, anon, authenticated, service_role, kullina_admin;

-- Every function this migration adds starts closed. Then the admin functions are opened to the dedicated role, and the one backfill to the
-- operator service.
REVOKE ALL ON FUNCTION public.allowlist_cap() FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.tenant_events_hash(TEXT, UUID, BIGINT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.tenant_events_chain() FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.tenant_events_append_only() FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.record_tenant_event(UUID, TEXT, TEXT, TEXT, UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.tenant_events_verify(UUID) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.spine_assert_admin() FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.seed_admin_user(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.deactivate_admin_user(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.spine_copy_subscription_event(UUID) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.spine_subscription_event_logged() FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.spine_backfill_subscription_events() FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.spine_hub_status_changed() FROM PUBLIC, anon, authenticated, service_role, kullina_admin;

REVOKE ALL ON FUNCTION public.admin_whoami() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_record_signin(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_list_events(UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_verify_chain(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_fleet(INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_tenant(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_ops_events(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_tenant_subscriptions(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_whoami() TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_record_signin(TEXT) TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_events(UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT, INTEGER) TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_verify_chain(UUID) TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_fleet(INTEGER) TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_tenant(UUID) TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_ops_events(UUID, INTEGER) TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_tenant_subscriptions(UUID, INTEGER) TO kullina_admin;

GRANT EXECUTE ON FUNCTION public.spine_backfill_subscription_events() TO service_role;

COMMIT;
