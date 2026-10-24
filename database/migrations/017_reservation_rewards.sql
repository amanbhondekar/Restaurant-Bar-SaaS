-- =====================================================================
-- MIGRATION 017: THE REWARD GIVEN FOR COMING BACK
-- =====================================================================
-- A restaurant may set its own rule for rewarding a guest who comes back
-- ("every 5th visit, a free dessert"). The product chooses nothing and applies
-- nothing: the hub tells the host when a booking is the guest's Nth visit, and
-- records that the reward was given.
--
-- That record has to survive the laptop like the rest of the diary. A hub that
-- restored the bookings but not what was given would offer the same guest the
-- same reward a second time.
--
-- What is stored is what happened, not the rule: when it was given, the words
-- that were promised, and which visit it was. The rule itself is a setting on
-- the hub, so changing it later does not rewrite what a guest was told.
--
-- Three nullable columns on the table migration 011 created. The privileges of
-- migration 014 are table-level, so they already cover them. Safe to re-run.
-- =====================================================================

BEGIN;

ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reward_given_at   TIMESTAMPTZ;
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reward_given_text VARCHAR(80);
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reward_visit      SMALLINT;

COMMIT;
