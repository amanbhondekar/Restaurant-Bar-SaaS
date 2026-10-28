-- =====================================================================
-- MIGRATION 014: SAY WHAT EACH ROLE MAY DO TO EACH TABLE
-- =====================================================================
-- Found by running migrations 001-013 on a real Postgres engine for the first time.
--
-- THE PROBLEM
-- A Supabase project grants every new table in `public` to anon, authenticated and
-- service_role by default (default privileges), and the earlier migrations only ever
-- ADDED grants. So the table comments saying "no UPDATE and no DELETE grant" (006
-- cash-ups, 013 feedback, 005 invoices) and "service_role only" (010) described a
-- restriction that did not exist: the privilege was already there. What actually
-- limited a tenant's login was the row-level-security policies, and those are
-- `FOR ALL`. In practice that meant a tenant's own hub login could:
--   * UPDATE its own restaurants row -- set plan = 'enterprise', plan_status = 'active',
--     push out current_period_end -- and so grant itself a plan it had not paid for;
--   * UPDATE or DELETE its own cash-up records and guest feedback, which are meant to
--     be insert-only evidence;
--   * rewrite staff_users (its own role, or the user a staff row is bound to);
--   * TRUNCATE any table (TRUNCATE is not subject to row-level security);
--   and `anon` held every privilege on every table (row-level security still returned
--   it nothing, because current_restaurant_id() is null for it, but that is one policy
--   standing between an unauthenticated caller and the data rather than none).
--
-- THE FIX
-- Take everything away from anon and authenticated on the tenant tables, then grant
-- back exactly what the hub does (from reading what it calls): it reads its own
-- restaurant and staff, is the single writer of the catalogs, inserts and moves orders
-- along, and updates but never deletes bills. service_role is untouched: it bypasses
-- row-level security and is how the operator service and `npm run cloud:check` work.
--
-- It is an explicit statement, not a delta, so it gives the same answer whatever a
-- project's defaults are, and running it again changes nothing. A table added later
-- starts with NOTHING for anon and authenticated (the default is reset below), so a
-- migration that forgets to grant fails loudly the first time it is used rather than
-- quietly handing a table to everyone.
-- =====================================================================

BEGIN;

-- 1. Nothing for anon: the hub is the only client, it signs in, and the guest and
--    reception pages are served by the hub itself, never by this database.
REVOKE ALL ON
    public.restaurants, public.staff_users, public.tables, public.menu_categories,
    public.menu_items, public.orders, public.order_items, public.waitlist_entries,
    public.device_pairings, public.invoices, public.reconciliations,
    public.inventory_items, public.recipes, public.reservations, public.walkins,
    public.guest_feedback, public.subscriptions, public.subscription_events
FROM anon;

-- 2. Start the tenant login from nothing...
REVOKE ALL ON
    public.restaurants, public.staff_users, public.tables, public.menu_categories,
    public.menu_items, public.orders, public.order_items, public.waitlist_entries,
    public.device_pairings, public.invoices, public.reconciliations,
    public.inventory_items, public.recipes, public.reservations, public.walkins,
    public.guest_feedback, public.subscriptions, public.subscription_events
FROM authenticated;

-- 3. ...and give back what the hub does.

-- It reads its own plan and who it is. Only the operator service writes either.
GRANT SELECT ON public.restaurants, public.staff_users TO authenticated;

-- The catalogs and the diary: the hub is the single writer, and a push removes what the
-- hub no longer holds.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.tables, public.menu_categories, public.menu_items,
    public.inventory_items, public.recipes, public.reservations, public.walkins
TO authenticated;

-- Orders are inserted and then moved along; a bill is updated (a void is a state, not a
-- removal). Neither is deleted.
GRANT SELECT, INSERT, UPDATE ON public.orders, public.order_items, public.invoices TO authenticated;

-- Evidence: a closed shift and a guest's statement are added and read, never changed.
GRANT SELECT, INSERT ON public.reconciliations, public.guest_feedback TO authenticated;

-- Not granted to a tenant at all: waitlist_entries and device_pairings (the hub does not
-- use them) and the operator's subscriptions and subscription_events.

-- 4. Say it in the policies too, so the intent survives someone granting more later.
--    (FOR ALL policies on these two said "a tenant may change them"; they may not.)
DROP POLICY IF EXISTS "Users can access their own restaurant record" ON public.restaurants;
CREATE POLICY "Users can access their own restaurant record"
    ON public.restaurants FOR SELECT
    USING (id = public.current_restaurant_id());

DROP POLICY IF EXISTS "Staff can view staff members in their restaurant" ON public.staff_users;
CREATE POLICY "Staff can view staff members in their restaurant"
    ON public.staff_users FOR SELECT
    USING (restaurant_id = public.current_restaurant_id());

-- 5. A table created from now on starts with nothing for anon and authenticated.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

COMMIT;
