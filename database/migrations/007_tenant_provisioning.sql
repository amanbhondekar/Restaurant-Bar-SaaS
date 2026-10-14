-- =====================================================================
-- MIGRATION 007: TENANT PROVISIONING (M3 · PR 17)
-- =====================================================================
-- Onboarding a restaurant is currently four manual steps in the SQL editor:
-- hand-write a restaurants row, invent a unique pairing_code, run
-- set_hub_provisioning_secret(), then paste the secret into that hub's .env.
-- Every one of them is a chance to create a tenant that is subtly wrong --
-- a duplicate pairing code, a missing secret, a plan with no trial end --
-- and M3's goal is onboarding a restaurant without engineering.
--
-- This makes it one call that either produces a complete, usable tenant or
-- changes nothing. Run once in the Supabase SQL editor; safe to re-run.
--
--   SELECT * FROM public.provision_restaurant(
--       p_name    => 'Spice Garden Bistro',
--       p_city    => 'Bengaluru',
--       p_secret  => '<a long random secret for this hub>'
--   );
--
-- It returns the restaurant id, the pairing code to type into the hub, and
-- when the trial ends. The secret is never returned or stored in plaintext --
-- the caller already has it, and it goes in that hub's .env as
-- HUB_PROVISIONING_SECRET.
-- =====================================================================

BEGIN;

-- How long a new restaurant gets before a plan decision is needed.
CREATE OR REPLACE FUNCTION public.default_trial_days()
RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$ SELECT 14 $$;

-- A pairing code a human has to read off a screen and type on a handset:
-- three letters from the name, a dash, four digits. Ambiguous characters are
-- avoided because this gets dictated over a phone in a noisy kitchen.
CREATE OR REPLACE FUNCTION public.generate_pairing_code(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_alpha  TEXT := regexp_replace(upper(coalesce(p_name, '')), '[^A-Z]', '', 'g');
    v_prefix TEXT;
    v_code   TEXT;
    v_try    INTEGER := 0;
BEGIN
    -- coalesce, not just rpad: a name with no usable letters ("123", or a script this strips
    -- entirely) leaves an empty string, and NULL || '-' is NULL, which would have produced a
    -- tenant with a null pairing code that no hub could ever pair with.
    v_prefix := rpad(coalesce(nullif(substr(translate(v_alpha, 'IO', ''), 1, 3), ''), 'RST'), 3, 'X');

    LOOP
        v_code := v_prefix || '-' || lpad((floor(random() * 9000) + 1000)::TEXT, 4, '0');
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.restaurants WHERE pairing_code = v_code);
        v_try := v_try + 1;
        IF v_try > 50 THEN
            RAISE EXCEPTION 'Could not find a free pairing code for %', p_name;
        END IF;
    END LOOP;

    RETURN v_code;
END;
$$;

-- A slug that is unique, derived from the name, and safe in a URL.
CREATE OR REPLACE FUNCTION public.generate_restaurant_slug(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_base TEXT := trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'));
    v_slug TEXT;
    v_n    INTEGER := 1;
BEGIN
    IF v_base = '' THEN v_base := 'restaurant'; END IF;
    v_slug := v_base;
    WHILE EXISTS (SELECT 1 FROM public.restaurants WHERE slug = v_slug) LOOP
        v_n := v_n + 1;
        v_slug := v_base || '-' || v_n;
    END LOOP;
    RETURN v_slug;
END;
$$;

/**
 * Creates a complete, trialing tenant in one transaction.
 *
 * Deliberately starts on 'pro' with plan_status 'trialing': a restaurant
 * evaluating the product should see what it is buying, and lib/plans.js
 * already degrades a trial to Starter the moment trial_ends_at passes,
 * without interrupting service.
 */
CREATE OR REPLACE FUNCTION public.provision_restaurant(
    p_name       TEXT,
    p_city       TEXT,
    p_secret     TEXT,
    p_plan       TEXT DEFAULT 'pro',
    p_cuisine    TEXT DEFAULT 'Multi-Cuisine',
    p_phone      TEXT DEFAULT NULL,
    p_address    TEXT DEFAULT NULL,
    p_currency   TEXT DEFAULT '₹',
    p_trial_days INTEGER DEFAULT NULL
)
RETURNS TABLE (restaurant_id UUID, pairing_code TEXT, slug TEXT, trial_ends_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id    UUID;
    v_code  TEXT;
    v_slug  TEXT;
    v_trial TIMESTAMPTZ;
    v_days  INTEGER := coalesce(p_trial_days, public.default_trial_days());
BEGIN
    IF coalesce(trim(p_name), '') = '' THEN
        RAISE EXCEPTION 'A restaurant name is required';
    END IF;
    IF coalesce(trim(p_city), '') = '' THEN
        RAISE EXCEPTION 'A city is required';
    END IF;
    -- Without a secret the hub can never bind itself, so the tenant would exist
    -- but never sync. Refuse rather than create a tenant that cannot work.
    IF length(coalesce(p_secret, '')) < 16 THEN
        RAISE EXCEPTION 'A hub provisioning secret of at least 16 characters is required';
    END IF;
    IF p_plan NOT IN ('starter', 'pro', 'enterprise') THEN
        RAISE EXCEPTION 'Unknown plan %', p_plan;
    END IF;

    v_code  := public.generate_pairing_code(p_name);
    v_slug  := public.generate_restaurant_slug(p_name);
    v_trial := NOW() + (v_days || ' days')::INTERVAL;

    INSERT INTO public.restaurants (
        name, slug, cuisine, address, city, phone, currency,
        plan, plan_status, trial_ends_at, pairing_code,
        hub_provisioning_secret_hash
    ) VALUES (
        trim(p_name), v_slug, p_cuisine, p_address, trim(p_city), p_phone, p_currency,
        p_plan, 'trialing', v_trial, v_code,
        crypt(p_secret, gen_salt('bf'))
    )
    RETURNING id INTO v_id;

    RETURN QUERY SELECT v_id, v_code, v_slug, v_trial;
END;
$$;

-- Same posture as set_hub_provisioning_secret: not reachable from the API.
-- Creating tenants is an operator action, run from the SQL editor or by a
-- trusted signup service with its own credentials -- never by anon, which
-- could otherwise fill the table with restaurants.
REVOKE ALL ON FUNCTION public.provision_restaurant(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_pairing_code(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_restaurant_slug(TEXT) FROM PUBLIC, anon, authenticated;

COMMIT;
