-- =====================================================================
-- MIGRATION 020: A GUEST'S REQUEST FOR A TABLE, WAITING FOR THE RESTAURANT
-- =====================================================================
-- A restaurant can switch on a public page where a guest asks for a table. It is a REQUEST, not a booking: the hub owns the diary
-- and checks every booking against the real table layout, so the page cannot promise a table the restaurant has not agreed to.
-- The request waits here until the restaurant's hub collects it; staff accept it (which books it, with the usual check) or decline
-- it, and tell the guest from their own phone, as with every other message the product sends.
--
--   booking_pages     one row per restaurant that has switched the page on: the public code in the page's address, and whether
--                     it is currently taking requests. The hub creates it, switches it off and on, and gives it a new code if the
--                     address is shared where it should not be.
--   booking_requests  the inbox. Written ONLY by the operator service (the service role), after it has checked and rate-limited
--                     the request. The hub reads it and clears what it has dealt with. Nothing ever edits a request.
--
-- Nothing here is open to `anon`. A guest never talks to the database: they talk to the operator service, which is the one public
-- thing in the product and the place where abuse is dealt with. An owner or manager may read, as everywhere (015); only the hub's
-- own identity (role 'kitchen') may write what a tenant may write.
--
-- Safe to run again.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.booking_pages (
    restaurant_id  UUID PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,
    -- In the page's address. Lower case letters and digits only, so it is safe in a URL and cannot be anything else.
    code           TEXT NOT NULL UNIQUE,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT booking_pages_code_check CHECK (code ~ '^[a-z0-9]{10,32}$')
);

CREATE TABLE IF NOT EXISTS public.booking_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id  UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    guest_name     VARCHAR(80) NOT NULL,
    -- Needed to answer the request. Kept only until the hub has dealt with it: the hub deletes the row when staff decide, and the
    -- operator service clears out requests whose time has passed.
    phone          VARCHAR(20) NOT NULL,
    party_size     SMALLINT NOT NULL,
    requested_for  TIMESTAMPTZ NOT NULL,
    note           VARCHAR(200),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT booking_requests_party_check CHECK (party_size BETWEEN 1 AND 40)
);

CREATE INDEX IF NOT EXISTS idx_booking_requests_restaurant
    ON public.booking_requests (restaurant_id, created_at);

ALTER TABLE public.booking_pages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_requests ENABLE ROW LEVEL SECURITY;

-- Start from nothing, then give back what each caller does (the way 014 does). service_role bypasses row-level security and keeps
-- its default privileges: it is how the operator service writes a guest's request.
REVOKE ALL ON public.booking_pages, public.booking_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.booking_pages    TO authenticated;
GRANT SELECT, DELETE         ON public.booking_requests TO authenticated;

DROP POLICY IF EXISTS "Tenant read for booking_pages"   ON public.booking_pages;
DROP POLICY IF EXISTS "Hub insert for booking_pages"    ON public.booking_pages;
DROP POLICY IF EXISTS "Hub update for booking_pages"    ON public.booking_pages;
DROP POLICY IF EXISTS "Tenant read for booking_requests" ON public.booking_requests;
DROP POLICY IF EXISTS "Hub delete for booking_requests"  ON public.booking_requests;

CREATE POLICY "Tenant read for booking_pages" ON public.booking_pages FOR SELECT
    USING (restaurant_id = public.current_restaurant_id());
CREATE POLICY "Hub insert for booking_pages" ON public.booking_pages FOR INSERT
    WITH CHECK (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = 'kitchen');
CREATE POLICY "Hub update for booking_pages" ON public.booking_pages FOR UPDATE
    USING (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = 'kitchen')
    WITH CHECK (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = 'kitchen');

CREATE POLICY "Tenant read for booking_requests" ON public.booking_requests FOR SELECT
    USING (restaurant_id = public.current_restaurant_id());
CREATE POLICY "Hub delete for booking_requests" ON public.booking_requests FOR DELETE
    USING (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = 'kitchen');

COMMIT;
