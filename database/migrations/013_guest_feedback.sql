-- =====================================================================
-- MIGRATION 013: GUEST FEEDBACK (cloud copy)
-- =====================================================================
-- A guest rates their meal from the diner page and the hub keeps it. Until now
-- it lived only in hub_server/data/feedback.json, so a tenant could lose every
-- rating and comment with the laptop.
--
-- Run once in the Supabase SQL editor; safe to re-run.
--
--  * hub_ref is the hub's own id for the entry (fb_...), the key a retried
--    push is de-duplicated on. Feedback is a statement a guest made: the hub
--    only ever inserts it, so, like cash-ups (006), pushes are
--    ON CONFLICT DO NOTHING and the table has no UPDATE and no DELETE grant.
--  * table_label is the label the guest's table code carried (for example
--    "T4"), as text: it is what reception reads, not a join to tables.
--  * invoice_number and invoice_ref are stamped by the hub from the table's own
--    recently settled bill, never taken from the guest. Both are null when the
--    feedback is about the place rather than a meal.
--  * comment is text a stranger typed. It is stored as the text it is, capped
--    at 500 characters like the hub's own limit.
--  * Nothing identifying the guest is stored: the hub never asks for a name or
--    a number on this form, so there is none to copy.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.guest_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id   UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    hub_ref         TEXT NOT NULL,

    rating          SMALLINT NOT NULL,
    comment         VARCHAR(500),
    table_label     VARCHAR(40),

    invoice_number  VARCHAR(40),
    invoice_ref     TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT guest_feedback_rating_check CHECK (rating BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_feedback_hub_ref
    ON public.guest_feedback (restaurant_id, hub_ref);

-- Read newest first.
CREATE INDEX IF NOT EXISTS idx_guest_feedback_when
    ON public.guest_feedback (restaurant_id, created_at DESC);

ALTER TABLE public.guest_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolation for guest_feedback" ON public.guest_feedback;
CREATE POLICY "Tenant isolation for guest_feedback"
    ON public.guest_feedback FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- Insert and read only: what a guest said is not edited or removed by the hub.
GRANT SELECT, INSERT ON public.guest_feedback TO authenticated;

COMMIT;
