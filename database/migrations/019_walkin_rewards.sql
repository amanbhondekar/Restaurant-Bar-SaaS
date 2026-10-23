-- =====================================================================
-- MIGRATION 019: THE REWARD GIVEN TO A GUEST AT THE DOOR
-- =====================================================================
-- Migration 017 recorded the reward a restaurant gave a returning guest on their booking. A guest in the walk-in queue who has
-- been here before (they left a number, so they can be recognised) is offered the same reward under the same rule, and what was
-- given has to survive the laptop for the same reason: a hub that restored the queue but not what was given would offer the
-- same guest the same reward again.
--
-- Three nullable columns on the table migration 011 created, the same three as 017 added to `reservations`. The privileges of
-- migration 014 are table-level, so they already cover them. Safe to re-run.
-- =====================================================================

BEGIN;

ALTER TABLE public.walkins ADD COLUMN IF NOT EXISTS reward_given_at   TIMESTAMPTZ;
ALTER TABLE public.walkins ADD COLUMN IF NOT EXISTS reward_given_text VARCHAR(80);
ALTER TABLE public.walkins ADD COLUMN IF NOT EXISTS reward_visit      SMALLINT;

COMMIT;
