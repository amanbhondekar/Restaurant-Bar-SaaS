-- =====================================================================
-- MIGRATION 006: RECONCILIATION (CASH-UP) CLOUD REPLICATION
-- =====================================================================
-- Migration 005 carried invoices to the cloud. Cash-up records were the other
-- financial record still living only in hub_server/data/ -- so a tenant could
-- lose every shift close, every counted-cash variance and every note about
-- who closed the till, with the laptop.
--
-- Run once in the Supabase SQL editor; safe to re-run.
--
--  * hub_ref is the hub's own record id (rec_...). Unlike invoices, the hub
--    pushes these with ON CONFLICT DO NOTHING rather than DO UPDATE: a closed
--    shift is immutable, so a retried push after an unconfirmed success must
--    be a no-op, and the table needs no UPDATE grant for it to be safe.
--  * Money is NUMERIC(12,2), matching invoices: a variance of a few paise is
--    the thing a cash-up exists to surface, so float drift is unacceptable.
--  * methods, totals, voided and unpaid_at_close stay JSONB. They are the
--    shape the hub computed and the till report printed.
--  * No UPDATE and no DELETE grant. A cash-up is a signed-off record of what
--    was in the drawer; the hub only ever inserts one.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.reconciliations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id       UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    hub_ref             TEXT NOT NULL,
    seq                 INTEGER NOT NULL,
    number              TEXT NOT NULL,

    period_start        TIMESTAMPTZ,
    period_end          TIMESTAMPTZ NOT NULL,

    opening_float       NUMERIC(12,2) NOT NULL DEFAULT 0,
    counted_cash        NUMERIC(12,2) NOT NULL DEFAULT 0,
    cash_removed        NUMERIC(12,2) NOT NULL DEFAULT 0,
    closing_float       NUMERIC(12,2) NOT NULL DEFAULT 0,
    expected_cash       NUMERIC(12,2) NOT NULL DEFAULT 0,
    cash_variance       NUMERIC(12,2) NOT NULL DEFAULT 0,

    status              VARCHAR(20) NOT NULL DEFAULT 'balanced',
    has_variance        BOOLEAN NOT NULL DEFAULT FALSE,

    methods             JSONB,
    totals              JSONB,
    voided              JSONB,
    unpaid_at_close     JSONB,

    notes               TEXT,
    closed_by           TEXT,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reconciliations_status_check
        CHECK (status IN ('balanced', 'variance'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliations_hub_ref
    ON public.reconciliations (restaurant_id, hub_ref);

-- The hub's per-tenant counter guarantees this; the index makes a second hub
-- paired to one tenant fail loudly rather than interleave shift numbers.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliations_number
    ON public.reconciliations (restaurant_id, number);

CREATE INDEX IF NOT EXISTS idx_reconciliations_restaurant_period
    ON public.reconciliations (restaurant_id, period_end DESC);

ALTER TABLE public.reconciliations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolation for reconciliations" ON public.reconciliations;
CREATE POLICY "Tenant isolation for reconciliations"
    ON public.reconciliations
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- Insert only: a closed shift is never edited or removed from the hub.
GRANT SELECT, INSERT ON public.reconciliations TO authenticated;
