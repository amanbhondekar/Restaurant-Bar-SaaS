-- =====================================================================
-- MIGRATION 011: RESERVATIONS & WAITLIST (cloud copy of the diary)
-- =====================================================================
-- Bookings are taken at the reception laptop, over the phone or at the
-- door, and the hub has to keep working with the internet down: a
-- restaurant that cannot look up tonight's bookings because its line is out
-- has a worse problem than one without a cloud. So the hub owns the diary
-- and this is the copy that survives the laptop.
--
-- Same arrangement as the menu, tables and stock: the hub is the single
-- writer, each push is a full snapshot upserted on (restaurant_id, hub_ref),
-- and rows the snapshot no longer holds are deleted. Run once in the
-- Supabase SQL editor; safe to re-run.
--
-- A NOTE ON THE GUEST'S NUMBER. Two columns, deliberately:
--
--   phone      the number itself, because staff have to be able to ring
--              someone whose table is ready;
--   phone_key  a salted hash, which is what loyalty MATCHES on.
--
-- Loyalty never needs to read a number back, only to know it is the same
-- person, so the thing that accumulates a visit history keys on something
-- that cannot be read out of a stolen copy. The salt is the restaurant's own
-- id, so one tenant's guest list can never be joined against another's.
--
-- There is deliberately no public-facing booking page yet: the existing
-- waitlist_entries table is from the original schema and is unused by the
-- hub. This replaces it in practice without dropping it, because dropping a
-- table nothing writes to is a change with no upside and a real downside if
-- someone's report reads it.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.reservations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id  UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    -- The hub's own id for this booking; the upsert key.
    hub_ref        TEXT NOT NULL,

    guest_name     VARCHAR(80) NOT NULL,
    phone          VARCHAR(20),
    phone_key      TEXT,

    party_size     SMALLINT NOT NULL,
    booked_for     TIMESTAMPTZ NOT NULL,
    duration_mins  SMALLINT NOT NULL DEFAULT 90,

    status         VARCHAR(20) NOT NULL DEFAULT 'booked',
    overbooked     BOOLEAN NOT NULL DEFAULT FALSE,
    note           VARCHAR(200),

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    seated_at      TIMESTAMPTZ,
    cancelled_at   TIMESTAMPTZ,
    no_show_at     TIMESTAMPTZ,
    synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reservations_status_check CHECK (status IN ('booked', 'seated', 'no_show', 'cancelled')),
    CONSTRAINT reservations_party_check  CHECK (party_size BETWEEN 1 AND 40)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_hub_ref
    ON public.reservations (restaurant_id, hub_ref);

-- The diary is read by day, and loyalty by guest.
CREATE INDEX IF NOT EXISTS idx_reservations_when
    ON public.reservations (restaurant_id, booked_for DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_guest
    ON public.reservations (restaurant_id, phone_key);

CREATE TABLE IF NOT EXISTS public.walkins (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id     UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    hub_ref           TEXT NOT NULL,

    guest_name        VARCHAR(80) NOT NULL,
    phone             VARCHAR(20),
    phone_key         TEXT,

    party_size        SMALLINT NOT NULL,
    quoted_wait_mins  SMALLINT,
    status            VARCHAR(20) NOT NULL DEFAULT 'waiting',

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notified_at       TIMESTAMPTZ,
    seated_at         TIMESTAMPTZ,
    left_at           TIMESTAMPTZ,
    synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT walkins_status_check CHECK (status IN ('waiting', 'notified', 'seated', 'left')),
    CONSTRAINT walkins_party_check  CHECK (party_size BETWEEN 1 AND 40)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_walkins_hub_ref
    ON public.walkins (restaurant_id, hub_ref);
CREATE INDEX IF NOT EXISTS idx_walkins_guest
    ON public.walkins (restaurant_id, phone_key);

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.walkins      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolation for reservations" ON public.reservations;
CREATE POLICY "Tenant isolation for reservations"
    ON public.reservations FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

DROP POLICY IF EXISTS "Tenant isolation for walkins" ON public.walkins;
CREATE POLICY "Tenant isolation for walkins"
    ON public.walkins FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- A snapshot push removes what the hub no longer holds, so DELETE is granted
-- as it is for the menu. RLS still limits every statement to the hub's own
-- restaurant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reservations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.walkins      TO authenticated;

COMMENT ON COLUMN public.reservations.phone_key IS
    'Salted hash of the phone number, salted with the restaurant id. What loyalty matches on; cannot be read back, and cannot be joined across tenants.';

COMMIT;
