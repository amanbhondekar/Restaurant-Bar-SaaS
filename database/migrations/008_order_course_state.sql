-- =====================================================================
-- MIGRATION 008: COURSE STATE ON CLOUD ORDERS
-- =====================================================================
-- The hub tracks, per ticket, whether it is served in courses, which
-- courses have been fired and when, and when each kitchen station finished
-- each course (hub_server/lib/courses.js). The cloud copy of an order held
-- only a coarse status, so a ticket that was slow could not be told from one
-- that was deliberately held back for a later course.
--
-- This adds the columns the hub pushes that state into. Run once in the
-- Supabase SQL editor; safe to re-run. Nothing is dropped or rewritten.
--
--  * orders.staged       -- true when the waiter chose "serve in courses".
--  * orders.course_log   -- JSONB, one entry per fired course:
--        { "1": { "fired_at": "...", "stations_ready": { "hot": "..." },
--                 "ready_at": "...", "recall_count": 1 }, ... }
--    A course that is still held has no entry, so the fired courses are
--    simply the keys. It is JSONB rather than a child table: it is a short
--    log of one ticket's own history, never queried relationally, and the
--    hub rewrites it whole on every change.
--  * order_items.course  -- the line's serving course, 1..9.
--  * order_items.station -- which kitchen station the line routes to.
--
-- The hub tolerates this migration not being applied yet: it retries the
-- write without these columns, so orders and status updates keep reaching
-- the cloud and only the course detail is missing until this is run.
--
-- RLS and grants are unchanged. Both tables already have a tenant policy
-- and the hub already inserts/updates them; these are new columns on the
-- same rows.
-- =====================================================================

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS staged     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS course_log JSONB;

ALTER TABLE public.order_items
    ADD COLUMN IF NOT EXISTS course  SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS station VARCHAR(10);

-- Added separately from the columns so a re-run does not fail on a constraint that exists.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_course_range') THEN
        ALTER TABLE public.order_items
            ADD CONSTRAINT order_items_course_range CHECK (course BETWEEN 1 AND 9);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_station_known') THEN
        ALTER TABLE public.order_items
            ADD CONSTRAINT order_items_station_known CHECK (station IS NULL OR station IN ('hot', 'cold', 'bar'));
    END IF;
END $$;
