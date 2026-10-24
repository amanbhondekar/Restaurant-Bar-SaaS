-- =====================================================================
-- MIGRATION 005: INVOICE CLOUD REPLICATION
-- =====================================================================
-- Until now the hub was the only place a bill ever existed. Invoices are
-- written to hub_server/data/invoices.json, and the sync queue replicated
-- orders but never bills -- so a tenant's revenue history lived on one
-- reception laptop and was lost with it, and no cloud-side reporting was
-- possible. invoiceStore even stamped every invoice `synced_to_cloud: false`
-- and nothing ever set it true.
--
-- This adds the table the hub pushes to. Run once in the Supabase SQL
-- editor; safe to re-run.
--
--  * hub_ref is the hub's own invoice id (inv_...). The hub upserts on
--    (restaurant_id, hub_ref), so a bill that is later paid, voided,
--    refunded or split updates in place instead of duplicating.
--  * The money columns are NUMERIC(12,2), not float: these are rupee
--    amounts that have to add up exactly, and the hub already does its
--    rounding with largest-remainder before they get here.
--  * The breakdown rows (items, taxes, discounts, splits) are JSONB rather
--    than child tables. They are an immutable record of what was printed,
--    never queried relationally, and a child table would need its own
--    delete-stale pass on every push.
--  * RLS mirrors every other tenant table: one policy keyed on
--    current_restaurant_id(), which resolves auth.uid() through staff_users.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.invoices (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id            UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    -- The hub's own id for this bill; the upsert key.
    hub_ref                  TEXT NOT NULL,
    invoice_number           TEXT NOT NULL,

    table_id                 TEXT,
    table_name               TEXT,
    currency                 VARCHAR(8) DEFAULT '₹',

    -- Money. Every one of these is produced by the hub's pricer, never by a client.
    subtotal                 NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount_total           NUMERIC(12,2) NOT NULL DEFAULT 0,
    subtotal_after_discount  NUMERIC(12,2) NOT NULL DEFAULT 0,
    service_charge_percent   NUMERIC(6,3)  NOT NULL DEFAULT 0,
    service_charge_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    taxable_base             NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_total                NUMERIC(12,2) NOT NULL DEFAULT 0,
    grand_total              NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- Settlement
    payment_status           VARCHAR(20) NOT NULL DEFAULT 'pending',
    payment_method           VARCHAR(20),
    payment_ref              TEXT,
    paid_at                  TIMESTAMPTZ,
    voided_at                TIMESTAMPTZ,
    void_reason              TEXT,
    refunded_at              TIMESTAMPTZ,
    refund_reason            TEXT,

    -- The printed breakdown, kept whole.
    tickets                  JSONB,
    ticket_ids               JSONB,
    items                    JSONB,
    tax_rows                 JSONB,
    discount_rows            JSONB,
    splits                   JSONB,

    issued_at                TIMESTAMPTZ,
    synced_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT invoices_payment_status_check
        CHECK (payment_status IN ('pending', 'paid', 'void', 'refunded', 'split'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_hub_ref
    ON public.invoices (restaurant_id, hub_ref);

-- Reporting reads bills for a restaurant over a period.
CREATE INDEX IF NOT EXISTS idx_invoices_restaurant_issued
    ON public.invoices (restaurant_id, issued_at DESC);

-- An invoice number is unique within a restaurant; the hub's counter guarantees it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_number
    ON public.invoices (restaurant_id, invoice_number);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolation for invoices" ON public.invoices;
CREATE POLICY "Tenant isolation for invoices"
    ON public.invoices
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- No DELETE: a bill is a financial record. Voids and refunds are state
-- transitions that the hub pushes as updates, never removals.
GRANT SELECT, INSERT, UPDATE ON public.invoices TO authenticated;
