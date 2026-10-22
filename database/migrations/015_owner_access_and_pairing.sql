-- =====================================================================
-- MIGRATION 015: PAIRING FROM A FRESH HUB, AND A READ-ONLY OWNER LOGIN
-- =====================================================================
-- Two changes that are about the same question -- who may read what -- and both found
-- by running the SQL on a real Postgres (see migration 014).
--
-- 1. A HUB THAT IS NOT YET BOUND COULD NOT FIND ITS OWN RESTAURANT
--    Pairing looked the restaurant up by the code on its screen with a plain SELECT on
--    `restaurants`. Row-level security shows a login only its own restaurant, and a hub
--    that has not paired yet has none, so the query returned nothing and the hub said "No
--    restaurant found matching pairing code". A freshly provisioned restaurant could never
--    be paired. `restaurant_for_pairing_code()` is the way in: a SECURITY DEFINER function
--    that returns the handful of non-secret columns pairing needs for exactly one code.
--    Binding still needs the provisioning secret (migration 001); knowing a code gets a
--    caller a name, a city and a plan, not access.
--
-- 2. AN OWNER MUST BE ABLE TO READ THEIR RESTAURANT FROM A BROWSER AND CHANGE NOTHING
--    An owner signs in with the same database role the hub uses (`authenticated`), and
--    every policy so far said "any staff login of this restaurant, for anything". What
--    limits a login has to be the role in staff_users:
--      * any staff login of a restaurant may READ that restaurant's rows;
--      * only the hub's own identity (role 'kitchen') may INSERT, UPDATE or DELETE them.
--    So an owner or manager reads everything and writes nothing, and so does a login with
--    a role it was never meant to have. Nothing about the hub changes: it is 'kitchen'.
--
--    Two columns are not for any login to read: the hash of the hub's provisioning secret
--    (`restaurants`) and the PIN hashes (`staff_users`). They are taken out of what
--    `authenticated` may SELECT, which means `SELECT *` on those two tables is refused and
--    the columns must be named. The hub already names them where it reads staff_users, and
--    pairing no longer reads `restaurants` directly.
--
--    `provision_owner()` is the operator's way to make someone an owner or manager: it
--    binds an auth user (invited by the operator service) to a restaurant, and is not
--    reachable by anyone else.
--
-- One login, one restaurant: current_restaurant_id() resolves a login to a single
-- restaurant, so provision_owner refuses to attach a login that already works for another.
-- Safe to run more than once.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Pairing lookup
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restaurant_for_pairing_code(p_code TEXT)
RETURNS TABLE (
    id UUID, name VARCHAR, slug VARCHAR, city VARCHAR, pairing_code VARCHAR,
    plan VARCHAR, plan_status VARCHAR, trial_ends_at TIMESTAMPTZ, current_period_end TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT r.id, r.name, r.slug, r.city, r.pairing_code, r.plan, r.plan_status, r.trial_ends_at, r.current_period_end
      FROM public.restaurants r
     -- An exact match, compared as the code is written (upper case, no surrounding space). Not ILIKE: a code
     -- of '%' must not match every restaurant.
     WHERE nullif(trim(p_code), '') IS NOT NULL
       AND upper(r.pairing_code) = upper(trim(p_code))
     LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.restaurant_for_pairing_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_for_pairing_code(TEXT) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. The role of the caller
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_staff_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT role FROM public.staff_users WHERE user_id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.current_staff_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_staff_role() TO authenticated;

-- ---------------------------------------------------------------------
-- 3. Read by any staff login of the restaurant; write only by the hub
-- ---------------------------------------------------------------------
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'tables', 'menu_categories', 'menu_items', 'orders', 'invoices', 'reconciliations',
        'inventory_items', 'recipes', 'reservations', 'walkins', 'guest_feedback'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Tenant isolation for ' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Tenant read for ' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Hub insert for ' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Hub update for ' || t, t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Hub delete for ' || t, t);

        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (restaurant_id = public.current_restaurant_id())',
                       'Tenant read for ' || t, t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = ''kitchen'')',
                       'Hub insert for ' || t, t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = ''kitchen'') WITH CHECK (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = ''kitchen'')',
                       'Hub update for ' || t, t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = ''kitchen'')',
                       'Hub delete for ' || t, t);
    END LOOP;
END
$$;

-- order_items has no restaurant_id of its own: it belongs to its order's restaurant.
DROP POLICY IF EXISTS "Tenant isolation for order_items" ON public.order_items;
DROP POLICY IF EXISTS "Tenant read for order_items" ON public.order_items;
DROP POLICY IF EXISTS "Hub insert for order_items" ON public.order_items;
DROP POLICY IF EXISTS "Hub update for order_items" ON public.order_items;
DROP POLICY IF EXISTS "Hub delete for order_items" ON public.order_items;

CREATE POLICY "Tenant read for order_items" ON public.order_items FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_items.order_id AND o.restaurant_id = public.current_restaurant_id()));
CREATE POLICY "Hub insert for order_items" ON public.order_items FOR INSERT
    WITH CHECK (public.current_staff_role() = 'kitchen'
        AND EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_items.order_id AND o.restaurant_id = public.current_restaurant_id()));
CREATE POLICY "Hub update for order_items" ON public.order_items FOR UPDATE
    USING (public.current_staff_role() = 'kitchen'
        AND EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_items.order_id AND o.restaurant_id = public.current_restaurant_id()))
    WITH CHECK (public.current_staff_role() = 'kitchen'
        AND EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_items.order_id AND o.restaurant_id = public.current_restaurant_id()));
CREATE POLICY "Hub delete for order_items" ON public.order_items FOR DELETE
    USING (public.current_staff_role() = 'kitchen'
        AND EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_items.order_id AND o.restaurant_id = public.current_restaurant_id()));

-- ---------------------------------------------------------------------
-- 4. Two columns no login reads
-- ---------------------------------------------------------------------
REVOKE SELECT ON public.restaurants FROM authenticated;
GRANT SELECT (id, name, slug, cuisine, address, city, phone, currency, plan, plan_status,
              trial_ends_at, current_period_end, pairing_code, settings, created_at, updated_at)
    ON public.restaurants TO authenticated;

REVOKE SELECT ON public.staff_users FROM authenticated;
GRANT SELECT (id, restaurant_id, user_id, full_name, role, created_at)
    ON public.staff_users TO authenticated;

-- ---------------------------------------------------------------------
-- 5. Making someone an owner or manager (the operator's call)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_owner(
    p_restaurant_id UUID,
    p_user_id       UUID,
    p_full_name     TEXT DEFAULT 'Owner',
    p_role          TEXT DEFAULT 'owner'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.staff_users%ROWTYPE;
    v_id       UUID;
BEGIN
    IF p_role NOT IN ('owner', 'manager') THEN
        RAISE EXCEPTION 'A login made this way is an owner or manager, not %', p_role;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.restaurants WHERE id = p_restaurant_id) THEN
        RAISE EXCEPTION 'No such restaurant';
    END IF;

    SELECT * INTO v_existing FROM public.staff_users WHERE user_id = p_user_id LIMIT 1;
    IF FOUND THEN
        IF v_existing.restaurant_id <> p_restaurant_id THEN
            RAISE EXCEPTION 'That login already works for another restaurant';
        END IF;
        RETURN v_existing.id;
    END IF;

    INSERT INTO public.staff_users (restaurant_id, user_id, full_name, role)
    VALUES (p_restaurant_id, p_user_id, coalesce(nullif(trim(p_full_name), ''), 'Owner'), p_role)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_owner(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

COMMIT;
