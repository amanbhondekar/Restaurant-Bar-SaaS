-- =====================================================================
-- MIGRATION 016: RESERVATION REMINDERS
-- =====================================================================
-- The hub sends nothing by itself: staff tap a WhatsApp link and send a guest
-- a reminder from their own phone. What the hub CAN do is remember that a
-- person said they sent it, and when, so two people do not ring the same guest
-- and the host can see who still has to be chased.
--
-- That mark has to survive the laptop like the rest of the diary: a
-- replacement hub that restores the bookings but not the marks would offer to
-- remind everybody a second time.
--
-- It is a person's word, not a delivery receipt. Nothing here says the message
-- arrived.
--
-- Two nullable columns on the table migration 011 created; nothing else
-- changes, and the privileges of migration 014 are table-level so they already
-- cover them. Safe to re-run.
-- =====================================================================

BEGIN;

ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
ALTER TABLE public.reservations ADD COLUMN IF NOT EXISTS reminded_by VARCHAR(60);

COMMIT;
