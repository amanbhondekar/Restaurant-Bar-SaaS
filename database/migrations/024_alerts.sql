-- =====================================================================
-- MIGRATION 024: THE ALERT LIFECYCLE (Phase 2, P2-2 of docs/SUPER_ADMIN_BUILD_SHEET.md)
-- =====================================================================
-- Run once in the Supabase SQL editor after 023; safe to re-run. Nothing here changes how a hub, the operator service or the existing console behaves.
--
--  1. THE WORKER'S ROLE. `kullina_alerts` is what the alert worker connects as. Like `kullina_admin` (migration 023, decision D1) it holds no privilege on
--     any table or view, and may run exactly four functions, `alert_snapshot`, `alert_apply`, `alert_notified` and `alert_notify_failed`. So a compromised
--     worker could read the few columns the rules need and open, resolve or flag alerts, and nothing else: not a bill, not a menu, not an order
--     (invariant I1), and not the service key (I2) because it never has it. It cannot sign in until a human gives it a password:
--         ALTER ROLE kullina_alerts LOGIN PASSWORD '...';   -- run by hand, once, in the SQL editor
--     The worker cannot acknowledge or resolve as a person: those two are the administrators' functions and ask who is asking.
--
--  2. `tenant_admin_meta`: what the console knows about a restaurant that the restaurant does not (its time zone and service hours, for the rule that
--     says a silent hub matters only while the restaurant is open). Set by the database's owner with `set_tenant_service_hours`, which checks the
--     hours are readable and leaves an event. A restaurant with no readable hours is flagged "service hours missing", never guessed at.
--
--  3. `alerts`: one row per alert, open -> acked -> resolved. Only one alert that is not resolved can exist for a key (the dedupe key), so a condition
--     that stays true is one alert however many times the worker looks. Its columns cannot contradict its state: an alert is acknowledged by a person
--     at a time, and resolved at a time. Every change leaves an event on the spine (migration 023), on the restaurant's own chain, naming the person
--     for what a person did and the system for what the worker did.
--
--  4. THE TWO HUMAN ACTIONS. `admin_ack_alert` and `admin_resolve_alert` ask `spine_assert_admin()` first (an active administrator with a second factor),
--     and need a reason in words, ten characters at least (invariant I4). Acknowledging stops the paging. Resolving an alert whose condition is still true does not make it go away: the worker opens
--     a fresh one on its next pass, so acknowledge is what to use for "I know".
--
-- Honest limits: paging is at-least-once. A page can go out and the worker die before it records that, and the next pass pages again. Detection of a dead hub
-- is no faster than three missed reports (fifteen minutes). Nothing here sends a message; that is the next task (P2-3).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The worker's role
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kullina_alerts') THEN
        CREATE ROLE kullina_alerts NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO kullina_alerts;

-- ---------------------------------------------------------------------
-- 2. What the console knows about a restaurant
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_admin_meta (
    restaurant_id  UUID PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,
    timezone       TEXT,
    service_hours  JSONB,
    referred_by    TEXT,
    contact_person TEXT,
    contact_phone  TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tenant_admin_meta_hours_check CHECK (service_hours IS NULL OR jsonb_typeof(service_hours) = 'object')
);

-- Are these service hours readable? An object of weekdays (mon..sun), each a list of [open, close] pairs as HH:MM, open different from close (a close before
-- the open runs past midnight), and at least one window in the week. The alert rules read them the same way and treat anything else as "unknown".
CREATE OR REPLACE FUNCTION public.alerts_valid_service_hours(p_hours JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_day     RECORD;
    v_window  JSONB;
    v_windows INTEGER := 0;
BEGIN
    IF p_hours IS NULL OR jsonb_typeof(p_hours) <> 'object' THEN RETURN FALSE; END IF;
    FOR v_day IN SELECT key, value FROM jsonb_each(p_hours) LOOP
        IF v_day.key NOT IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') OR jsonb_typeof(v_day.value) <> 'array' THEN RETURN FALSE; END IF;
        FOR v_window IN SELECT value FROM jsonb_array_elements(v_day.value) LOOP
            IF jsonb_typeof(v_window) <> 'array' OR jsonb_array_length(v_window) <> 2 THEN RETURN FALSE; END IF;
            IF jsonb_typeof(v_window -> 0) <> 'string' OR jsonb_typeof(v_window -> 1) <> 'string' THEN RETURN FALSE; END IF;
            IF (v_window ->> 0) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR (v_window ->> 1) !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN FALSE; END IF;
            IF (v_window ->> 0) = (v_window ->> 1) THEN RETURN FALSE; END IF;
            v_windows := v_windows + 1;
        END LOOP;
    END LOOP;
    RETURN v_windows > 0;
END;
$$;

-- The owner sets a restaurant's time zone and hours from the SQL editor. The time zone must be an IANA name ("Asia/Kolkata"), the same kind the alert
-- worker reads; Postgres would also accept abbreviations the worker cannot, so those are refused here.
CREATE OR REPLACE FUNCTION public.set_tenant_service_hours(p_restaurant_id UUID, p_timezone TEXT, p_hours JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = p_restaurant_id) THEN
        RAISE EXCEPTION 'set_tenant_service_hours: no such restaurant' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF p_timezone IS NULL OR (p_timezone !~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$' AND p_timezone <> 'UTC') THEN
        RAISE EXCEPTION 'set_tenant_service_hours: the time zone must be an IANA name such as Asia/Kolkata' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    BEGIN
        PERFORM now() AT TIME ZONE p_timezone;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'set_tenant_service_hours: the time zone is not one Postgres knows' USING ERRCODE = 'invalid_parameter_value';
    END;
    IF NOT public.alerts_valid_service_hours(p_hours) THEN
        RAISE EXCEPTION 'set_tenant_service_hours: the service hours are not readable: weekdays mon..sun, each a list of [HH:MM, HH:MM], at least one window'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.tenant_admin_meta (restaurant_id, timezone, service_hours)
    VALUES (p_restaurant_id, p_timezone, p_hours)
    ON CONFLICT (restaurant_id) DO UPDATE SET timezone = EXCLUDED.timezone, service_hours = EXCLUDED.service_hours, updated_at = now();

    PERFORM public.record_tenant_event(p_restaurant_id, 'system', 'admin.service_hours_set', 'system', NULL, NULL,
                                       jsonb_build_object('timezone', p_timezone, 'service_hours', p_hours));
END;
$$;

-- ---------------------------------------------------------------------
-- 3. The alerts
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alerts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    restaurant_id     UUID REFERENCES public.restaurants(id) ON DELETE CASCADE,
    rule_key          TEXT NOT NULL,
    severity          TEXT NOT NULL,
    state             TEXT NOT NULL DEFAULT 'open',
    dedupe_key        TEXT NOT NULL,
    detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
    opened_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    acked_at          TIMESTAMPTZ,
    acked_by          UUID REFERENCES public.admin_users(user_id),
    ack_reason        TEXT,
    resolved_at       TIMESTAMPTZ,
    resolved_by       UUID REFERENCES public.admin_users(user_id),   -- NULL when the worker resolved it because the condition cleared
    resolve_reason    TEXT,
    escalation_level  INTEGER NOT NULL DEFAULT 0,
    last_notified_at  TIMESTAMPTZ,
    notify_failed_at  TIMESTAMPTZ,
    unattended_at     TIMESTAMPTZ,
    CONSTRAINT alerts_severity_check CHECK (severity IN ('P1', 'P2', 'P3')),
    CONSTRAINT alerts_state_check    CHECK (state IN ('open', 'acked', 'resolved')),
    CONSTRAINT alerts_rule_check     CHECK (length(btrim(rule_key)) > 0),
    CONSTRAINT alerts_dedupe_check   CHECK (length(btrim(dedupe_key)) > 0),
    CONSTRAINT alerts_level_check    CHECK (escalation_level >= 0),
    CONSTRAINT alerts_detail_check   CHECK (jsonb_typeof(detail) = 'object'),
    -- An alert is acknowledged BY somebody AT a time, and resolved AT a time; one that is open has been neither.
    CONSTRAINT alerts_state_columns  CHECK (
        (state = 'open'     AND acked_at IS NULL     AND acked_by IS NULL     AND resolved_at IS NULL) OR
        (state = 'acked'    AND acked_at IS NOT NULL AND acked_by IS NOT NULL AND resolved_at IS NULL) OR
        (state = 'resolved' AND resolved_at IS NOT NULL)
    )
);

-- One alert that is not resolved per key: a condition that stays true is one alert, however often the worker looks.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_unresolved ON public.alerts (dedupe_key) WHERE state <> 'resolved';
CREATE INDEX IF NOT EXISTS alerts_by_restaurant ON public.alerts (restaurant_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS alerts_by_state ON public.alerts (state, opened_at DESC);

-- ---------------------------------------------------------------------
-- 4. What the worker may do
-- ---------------------------------------------------------------------
-- Everything the rules need and nothing else: the fleet (a few columns), each restaurant's hours, and the alerts not yet resolved. `now` is the
-- database's clock, so the worker's own clock cannot move a deadline. `complete` is false when the fleet is longer than `p_limit`: nothing is resolved on
-- the strength of a list that stopped early.
CREATE OR REPLACE FUNCTION public.alert_snapshot(p_limit INTEGER DEFAULT 1000)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit INTEGER := least(greatest(COALESCE(p_limit, 1000), 1), 1000);
BEGIN
    RETURN jsonb_build_object(
        'now', clock_timestamp(),
        'complete', (SELECT count(*) FROM public.restaurants) <= v_limit,
        'tenants', (SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM (
                        SELECT t.restaurant_id, t.name, t.plan_status, t.hub_seen_at, t.hub_queued, t.hub_quarantined
                          FROM public.ops_tenants t ORDER BY t.created_at DESC, t.restaurant_id LIMIT v_limit) x),
        'meta', (SELECT COALESCE(jsonb_object_agg(m.restaurant_id::text, jsonb_build_object('timezone', m.timezone, 'service_hours', m.service_hours)), '{}'::jsonb)
                   FROM public.tenant_admin_meta m),
        'alerts', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'id', a.id, 'restaurant_id', a.restaurant_id, 'restaurant_name', r.name, 'rule_key', a.rule_key, 'severity', a.severity,
                        'dedupe_key', a.dedupe_key, 'state', a.state, 'detail', a.detail, 'opened_at', a.opened_at, 'acked_at', a.acked_at,
                        'escalation_level', a.escalation_level, 'last_notified_at', a.last_notified_at, 'unattended_at', a.unattended_at
                    ) ORDER BY a.id), '[]'::jsonb)
                     FROM public.alerts a LEFT JOIN public.restaurants r ON r.id = a.restaurant_id WHERE a.state <> 'resolved')
    );
END;
$$;

-- Opens the alerts it is given (those not already open for their key), resolves the ones it is told have cleared, and flags the ones nobody has answered,
-- all in one transaction, each leaving an event on the restaurant's chain. Returns what it actually did: `opened` ([{id, dedupe_key}]), `resolved` and
-- `flagged` (ids). A restaurant that has gone since the snapshot is skipped, not an error. Anything malformed refuses the whole call.
CREATE OR REPLACE FUNCTION public.alert_apply(p_open JSONB, p_resolve JSONB, p_unattended JSONB, p_request_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_item     JSONB;
    v_id       BIGINT;
    v_rest     UUID;
    v_rule     TEXT;
    v_sev      TEXT;
    v_key      TEXT;
    v_detail   JSONB;
    v_reason   TEXT;
    v_opened   JSONB := '[]'::jsonb;
    v_resolved JSONB := '[]'::jsonb;
    v_flagged  JSONB := '[]'::jsonb;
BEGIN
    IF p_open IS NULL OR jsonb_typeof(p_open) <> 'array' OR p_resolve IS NULL OR jsonb_typeof(p_resolve) <> 'array'
       OR p_unattended IS NULL OR jsonb_typeof(p_unattended) <> 'array' THEN
        RAISE EXCEPTION 'alert_apply: each argument must be a list' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_open) LOOP
        v_rule := btrim(COALESCE(v_item ->> 'rule_key', ''));
        v_sev  := v_item ->> 'severity';
        v_key  := btrim(COALESCE(v_item ->> 'dedupe_key', ''));
        v_detail := CASE WHEN v_item ? 'detail' THEN v_item -> 'detail' ELSE '{}'::jsonb END;
        IF v_rule = '' THEN RAISE EXCEPTION 'alert_apply: an alert needs a rule' USING ERRCODE = 'invalid_parameter_value'; END IF;
        IF v_sev IS NULL OR v_sev NOT IN ('P1', 'P2', 'P3') THEN RAISE EXCEPTION 'alert_apply: severity must be P1, P2 or P3' USING ERRCODE = 'invalid_parameter_value'; END IF;
        IF v_key = '' THEN RAISE EXCEPTION 'alert_apply: an alert needs a key' USING ERRCODE = 'invalid_parameter_value'; END IF;
        IF jsonb_typeof(v_detail) <> 'object' THEN RAISE EXCEPTION 'alert_apply: detail must be an object' USING ERRCODE = 'invalid_parameter_value'; END IF;
        v_rest := NULLIF(v_item ->> 'restaurant_id', '')::uuid;
        IF v_rest IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = v_rest) THEN CONTINUE; END IF;

        v_id := NULL;
        INSERT INTO public.alerts (restaurant_id, rule_key, severity, dedupe_key, detail)
        VALUES (v_rest, v_rule, v_sev, v_key, v_detail)
        ON CONFLICT (dedupe_key) WHERE state <> 'resolved' DO NOTHING
        RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN
            PERFORM public.record_tenant_event(v_rest, 'system', 'alert.opened', 'system', NULL, p_request_id,
                                               jsonb_build_object('alert_id', v_id, 'rule_key', v_rule, 'severity', v_sev, 'detail', v_detail));
            v_opened := v_opened || jsonb_build_object('id', v_id, 'dedupe_key', v_key);
        END IF;
    END LOOP;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_resolve) LOOP
        v_reason := btrim(COALESCE(v_item ->> 'reason', ''));
        IF v_reason = '' THEN RAISE EXCEPTION 'alert_apply: resolving needs a reason' USING ERRCODE = 'invalid_parameter_value'; END IF;
        UPDATE public.alerts a
           SET state = 'resolved', resolved_at = clock_timestamp(), resolved_by = NULL, resolve_reason = left(v_reason, 500)
         WHERE a.id = (v_item ->> 'id')::bigint AND a.state <> 'resolved'
        RETURNING a.id, a.restaurant_id, a.rule_key INTO v_id, v_rest, v_rule;
        IF FOUND THEN
            PERFORM public.record_tenant_event(v_rest, 'system', 'alert.resolved', 'system', NULL, p_request_id,
                                               jsonb_build_object('alert_id', v_id, 'rule_key', v_rule, 'reason', left(v_reason, 500), 'by', 'system'));
            v_resolved := v_resolved || to_jsonb(v_id);
        END IF;
    END LOOP;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_unattended) LOOP
        UPDATE public.alerts a SET unattended_at = clock_timestamp()
         WHERE a.id = (v_item #>> '{}')::bigint AND a.state <> 'resolved' AND a.unattended_at IS NULL
        RETURNING a.id, a.restaurant_id, a.rule_key INTO v_id, v_rest, v_rule;
        IF FOUND THEN
            PERFORM public.record_tenant_event(v_rest, 'system', 'alert.unattended', 'system', NULL, p_request_id,
                                               jsonb_build_object('alert_id', v_id, 'rule_key', v_rule));
            v_flagged := v_flagged || to_jsonb(v_id);
        END IF;
    END LOOP;

    RETURN jsonb_build_object('opened', v_opened, 'resolved', v_resolved, 'flagged', v_flagged);
END;
$$;

-- A page went out. Levels go in order: the first page is level 0 and each reminder the next, so a level out of turn is a worker bug and is refused. An
-- alert that was acknowledged or resolved while the page was being sent is not an error: there is nothing to record, and false is the answer.
CREATE OR REPLACE FUNCTION public.alert_notified(p_id BIGINT, p_level INTEGER, p_request_id TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_alert    public.alerts%ROWTYPE;
    v_expected INTEGER;
BEGIN
    SELECT * INTO v_alert FROM public.alerts a WHERE a.id = p_id FOR UPDATE;
    IF NOT FOUND OR v_alert.state <> 'open' THEN RETURN FALSE; END IF;

    v_expected := CASE WHEN v_alert.last_notified_at IS NULL THEN 0 ELSE v_alert.escalation_level + 1 END;
    IF p_level IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'alert_notified: the next level for this alert is %, not %', v_expected, p_level USING ERRCODE = 'invalid_parameter_value';
    END IF;

    UPDATE public.alerts SET escalation_level = p_level, last_notified_at = clock_timestamp(), notify_failed_at = NULL WHERE id = p_id;
    PERFORM public.record_tenant_event(v_alert.restaurant_id, 'system', 'alert.notified', 'system', NULL, p_request_id,
                                       jsonb_build_object('alert_id', p_id, 'level', p_level));
    RETURN TRUE;
END;
$$;

-- A page could not be sent. Recorded at most once in ten minutes per alert, so a channel that is down does not fill the log; the alert stays due and the
-- worker tries again on its next pass. The note is short, and is all that is kept: the worker must not put a token or an address in it.
CREATE OR REPLACE FUNCTION public.alert_notify_failed(p_id BIGINT, p_level INTEGER, p_note TEXT, p_request_id TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_alert public.alerts%ROWTYPE;
BEGIN
    SELECT * INTO v_alert FROM public.alerts a WHERE a.id = p_id FOR UPDATE;
    IF NOT FOUND OR v_alert.state <> 'open' THEN RETURN FALSE; END IF;
    IF v_alert.notify_failed_at IS NOT NULL AND clock_timestamp() - v_alert.notify_failed_at < interval '10 minutes' THEN RETURN FALSE; END IF;

    UPDATE public.alerts SET notify_failed_at = clock_timestamp() WHERE id = p_id;
    PERFORM public.record_tenant_event(v_alert.restaurant_id, 'system', 'alert.notify_failed', 'system', NULL, p_request_id,
                                       jsonb_build_object('alert_id', p_id, 'level', p_level, 'note', left(COALESCE(p_note, ''), 200)));
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. What the administrators may do
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_alerts(p_state TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
    id BIGINT, restaurant_id UUID, restaurant_name TEXT, rule_key TEXT, severity TEXT, state TEXT, detail JSONB, opened_at TIMESTAMPTZ,
    acked_at TIMESTAMPTZ, acked_by UUID, acked_by_email TEXT, ack_reason TEXT, resolved_at TIMESTAMPTZ, resolved_by UUID, resolve_reason TEXT,
    escalation_level INTEGER, last_notified_at TIMESTAMPTZ, unattended_at TIMESTAMPTZ
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
    IF p_state IS NOT NULL AND p_state NOT IN ('open', 'acked', 'resolved') THEN
        RAISE EXCEPTION 'admin_alerts: the state must be open, acked or resolved' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 THEN
        RAISE EXCEPTION 'admin_alerts: the limit must be at least 1' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
    SELECT a.id, a.restaurant_id, r.name::text, a.rule_key, a.severity, a.state, a.detail, a.opened_at, a.acked_at, a.acked_by, u.email,
           a.ack_reason, a.resolved_at, a.resolved_by, a.resolve_reason, a.escalation_level, a.last_notified_at, a.unattended_at
      FROM public.alerts a
      LEFT JOIN public.restaurants r ON r.id = a.restaurant_id
      LEFT JOIN public.admin_users u ON u.user_id = a.acked_by
     WHERE p_state IS NULL OR a.state = p_state
     ORDER BY a.opened_at DESC, a.id DESC
     LIMIT least(p_limit, 500);
END;
$$;

-- "I know": stops the paging. Needs a reason in words. Acknowledging an alert that is already acknowledged changes nothing and records nothing (the first
-- acknowledgement stands), so a second tap on the same link is harmless.
CREATE OR REPLACE FUNCTION public.admin_ack_alert(p_id BIGINT, p_reason TEXT)
RETURNS TABLE (id BIGINT, state TEXT, event_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_user   UUID := public.spine_assert_admin();
    v_reason TEXT := btrim(COALESCE(p_reason, ''));
    v_alert  public.alerts%ROWTYPE;
    v_event  BIGINT;
BEGIN
    -- Invariant I4: every admin write needs a reason in words, ten characters at least (after trimming).
    IF length(v_reason) < 10 THEN RAISE EXCEPTION 'admin_ack_alert: a reason of at least 10 characters is required' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF length(v_reason) > 500 THEN RAISE EXCEPTION 'admin_ack_alert: the reason is too long (500 characters at most)' USING ERRCODE = 'invalid_parameter_value'; END IF;

    SELECT * INTO v_alert FROM public.alerts a WHERE a.id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'admin_ack_alert: alert not found' USING ERRCODE = 'no_data_found'; END IF;
    IF v_alert.state = 'resolved' THEN RAISE EXCEPTION 'admin_ack_alert: the alert is already resolved' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF v_alert.state = 'acked' THEN
        RETURN QUERY SELECT v_alert.id, v_alert.state, NULL::bigint;
        RETURN;
    END IF;

    UPDATE public.alerts a SET state = 'acked', acked_at = clock_timestamp(), acked_by = v_user, ack_reason = v_reason WHERE a.id = p_id;
    v_event := public.record_tenant_event(v_alert.restaurant_id, 'admin', 'alert.acked', 'admin', v_user, NULL,
                                          jsonb_build_object('alert_id', p_id, 'rule_key', v_alert.rule_key, 'reason', v_reason));
    RETURN QUERY SELECT p_id, 'acked'::text, v_event;
END;
$$;

-- "It is dealt with": closes the alert, from open or acknowledged, with a reason. If the condition is still true the worker opens a fresh alert on its next pass.
CREATE OR REPLACE FUNCTION public.admin_resolve_alert(p_id BIGINT, p_reason TEXT)
RETURNS TABLE (id BIGINT, state TEXT, event_id BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_user   UUID := public.spine_assert_admin();
    v_reason TEXT := btrim(COALESCE(p_reason, ''));
    v_alert  public.alerts%ROWTYPE;
    v_event  BIGINT;
BEGIN
    IF length(v_reason) < 10 THEN RAISE EXCEPTION 'admin_resolve_alert: a reason of at least 10 characters is required' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF length(v_reason) > 500 THEN RAISE EXCEPTION 'admin_resolve_alert: the reason is too long (500 characters at most)' USING ERRCODE = 'invalid_parameter_value'; END IF;

    SELECT * INTO v_alert FROM public.alerts a WHERE a.id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'admin_resolve_alert: alert not found' USING ERRCODE = 'no_data_found'; END IF;
    IF v_alert.state = 'resolved' THEN RAISE EXCEPTION 'admin_resolve_alert: the alert is already resolved' USING ERRCODE = 'invalid_parameter_value'; END IF;

    UPDATE public.alerts a SET state = 'resolved', resolved_at = clock_timestamp(), resolved_by = v_user, resolve_reason = v_reason WHERE a.id = p_id;
    v_event := public.record_tenant_event(v_alert.restaurant_id, 'admin', 'alert.resolved', 'admin', v_user, NULL,
                                          jsonb_build_object('alert_id', p_id, 'rule_key', v_alert.rule_key, 'reason', v_reason, 'by', 'admin'));
    RETURN QUERY SELECT p_id, 'resolved'::text, v_event;
END;
$$;

-- ---------------------------------------------------------------------
-- 6. Who may do what (the pattern of migrations 014 and 023: say it, do not inherit it)
-- ---------------------------------------------------------------------
ALTER TABLE public.alerts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_admin_meta ENABLE ROW LEVEL SECURITY;

-- No policy for anyone: the tables are reached only through the functions above, which run with their owner's rights.
REVOKE ALL ON public.alerts, public.tenant_admin_meta FROM PUBLIC, anon, authenticated, service_role, kullina_admin, kullina_alerts;
REVOKE ALL ON SEQUENCE public.alerts_id_seq FROM PUBLIC, anon, authenticated, service_role, kullina_admin, kullina_alerts;

REVOKE ALL ON FUNCTION public.alerts_valid_service_hours(JSONB) FROM PUBLIC, anon, authenticated, service_role, kullina_admin, kullina_alerts;
REVOKE ALL ON FUNCTION public.set_tenant_service_hours(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role, kullina_admin, kullina_alerts;
REVOKE ALL ON FUNCTION public.alert_snapshot(INTEGER) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.alert_apply(JSONB, JSONB, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.alert_notified(BIGINT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.alert_notify_failed(BIGINT, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role, kullina_admin;
REVOKE ALL ON FUNCTION public.admin_alerts(TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role, kullina_alerts;
REVOKE ALL ON FUNCTION public.admin_ack_alert(BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role, kullina_alerts;
REVOKE ALL ON FUNCTION public.admin_resolve_alert(BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role, kullina_alerts;

GRANT EXECUTE ON FUNCTION public.alert_snapshot(INTEGER) TO kullina_alerts;
GRANT EXECUTE ON FUNCTION public.alert_apply(JSONB, JSONB, JSONB, TEXT) TO kullina_alerts;
GRANT EXECUTE ON FUNCTION public.alert_notified(BIGINT, INTEGER, TEXT) TO kullina_alerts;
GRANT EXECUTE ON FUNCTION public.alert_notify_failed(BIGINT, INTEGER, TEXT, TEXT) TO kullina_alerts;
GRANT EXECUTE ON FUNCTION public.admin_alerts(TEXT, INTEGER) TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_ack_alert(BIGINT, TEXT) TO kullina_admin;
GRANT EXECUTE ON FUNCTION public.admin_resolve_alert(BIGINT, TEXT) TO kullina_admin;

COMMIT;
