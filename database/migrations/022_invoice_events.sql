-- =====================================================================
-- MIGRATION 022: THE HISTORY OF A BILL (invoice_events)
-- =====================================================================
-- Found by the G0-4 analysis (Darshil_docs/reports/report_2026-10-26_134500_ledger_analysis.md): a bill in the cloud (005)
-- is one row, overwritten in place by every push, so the cloud could say only what a bill looks like NOW. Who paid it, who voided
-- or refunded it, how it was split and what an undone split used to say were on the reception laptop alone, and the grant in 014
-- lets the hub's login rewrite any column of an issued bill.
--
-- Run once in the Supabase SQL editor; safe to re-run. The hub keeps working without it: a project that has not run this simply
-- does not receive events (the push is retried, then set aside), and nothing about taking an order or a payment waits on it.
--
--  * One row per change to a bill. `seq` numbers a bill's events from 1; `prev_hash` is the hash of the event before it (64 zeros for
--    the first); `hash` is SHA-256 over this event's own fields and `prev_hash`, computed by the hub. The database does NOT recompute
--    it (it would have to encode JSON byte for byte as the hub does); it checks the LINKS, which is what makes a gap or a fork
--    impossible to insert, and leaves the hashes to be verified by whoever reads the chain.
--  * Append only, for everyone. 014's lesson applies: a Supabase project grants every new table to every role by default, so the
--    privileges are stated here, and a trigger refuses UPDATE, DELETE and TRUNCATE for any role, the table's owner and the service
--    role included. (A superuser can still drop the trigger. Nothing in a database can stop its own administrator.) The one thing that
--    removes events is removing the restaurant they belong to, which is how a tenant's data is erased.
--  * Only the hub's own login adds events (a `kitchen` staff row, as in 015); any staff login of the restaurant may read them.
--  * Read this once before relying on it: a hash chain that the hub itself writes shows an edit, a deletion in the middle, a reordering
--    or an inserted event. It does NOT show events cut off the end, and it cannot stop whoever controls the hub's cloud login from
--    rewriting a whole chain from the start. Keeping the latest hash of each bill somewhere the hub cannot write to is what closes that,
--    and is not part of this migration.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.invoice_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id    UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    -- The hub's own id for the bill (inv_...), the same key invoices.hub_ref uses. Not a foreign key: the history must be able to
    -- arrive before the bill's own row does, and must outlive it.
    invoice_hub_ref  TEXT NOT NULL,
    seq              INTEGER NOT NULL,

    event_type       VARCHAR(20) NOT NULL,
    -- A label the till sent, not a verified identity. Null when the change had no named person.
    actor            VARCHAR(60),
    -- The hub's clock when the change was made.
    occurred_at      TIMESTAMPTZ NOT NULL,
    -- 'issued' and 'baseline': { invoice }. Every other kind: { changes: { field: { from, to } } }, which keeps what it destroyed.
    payload          JSONB NOT NULL,

    prev_hash        TEXT NOT NULL,
    hash             TEXT NOT NULL,

    synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT invoice_events_seq_check     CHECK (seq >= 1),
    CONSTRAINT invoice_events_type_check    CHECK (event_type IN ('baseline', 'issued', 'split', 'unsplit', 'paid', 'split_paid', 'voided', 'refunded')),
    CONSTRAINT invoice_events_payload_check CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT invoice_events_prev_check    CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT invoice_events_hash_check    CHECK (hash ~ '^[0-9a-f]{64}$')
);

-- A bill's chain: one event per number. The hub's push upserts on this and ignores a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_events_chain
    ON public.invoice_events (restaurant_id, invoice_hub_ref, seq);

-- ---------------------------------------------------------------------
-- 1. The links: no gap, no fork, a start at the beginning
-- ---------------------------------------------------------------------
-- A BEFORE trigger runs before ON CONFLICT is decided, so this is also where a DIFFERENT event under a number already used is caught:
-- left alone, ON CONFLICT DO NOTHING would swallow it and the hub would believe it had been recorded. An identical event passes and is
-- skipped by the conflict, which is what makes a retried push harmless. Rows of one statement are checked in order, so a bill's whole
-- history can be sent in one call.
CREATE OR REPLACE FUNCTION public.invoice_events_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_same TEXT;
    v_prev TEXT;
BEGIN
    SELECT hash INTO v_same
      FROM public.invoice_events
     WHERE restaurant_id = NEW.restaurant_id AND invoice_hub_ref = NEW.invoice_hub_ref AND seq = NEW.seq;
    IF FOUND THEN
        IF v_same <> NEW.hash THEN
            RAISE EXCEPTION 'invoice_events: a different event already holds seq % of bill % (a fork is refused)', NEW.seq, NEW.invoice_hub_ref
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.seq = 1 THEN
        IF NEW.prev_hash <> repeat('0', 64) THEN
            RAISE EXCEPTION 'invoice_events: the first event of bill % must chain to the genesis hash', NEW.invoice_hub_ref
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        SELECT hash INTO v_prev
          FROM public.invoice_events
         WHERE restaurant_id = NEW.restaurant_id AND invoice_hub_ref = NEW.invoice_hub_ref AND seq = NEW.seq - 1;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'invoice_events: event % of bill % has a gap before it (event % is missing)', NEW.seq, NEW.invoice_hub_ref, NEW.seq - 1
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.prev_hash <> v_prev THEN
            RAISE EXCEPTION 'invoice_events: event % of bill % does not chain to the event before it', NEW.seq, NEW.invoice_hub_ref
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoice_events_guard_insert ON public.invoice_events;
CREATE TRIGGER invoice_events_guard_insert
    BEFORE INSERT ON public.invoice_events
    FOR EACH ROW EXECUTE FUNCTION public.invoice_events_guard_insert();

-- ---------------------------------------------------------------------
-- 2. Append only, for every role
-- ---------------------------------------------------------------------
-- pg_trigger_depth() is 1 for a DELETE someone ran and 2 or more for one the foreign key ran when a restaurant was removed: that is
-- the only deletion allowed.
CREATE OR REPLACE FUNCTION public.invoice_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS invoice_events_append_only ON public.invoice_events;
CREATE TRIGGER invoice_events_append_only
    BEFORE UPDATE OR DELETE ON public.invoice_events
    FOR EACH ROW EXECUTE FUNCTION public.invoice_events_append_only();

DROP TRIGGER IF EXISTS invoice_events_no_truncate ON public.invoice_events;
CREATE TRIGGER invoice_events_no_truncate
    BEFORE TRUNCATE ON public.invoice_events
    FOR EACH STATEMENT EXECUTE FUNCTION public.invoice_events_append_only();

-- ---------------------------------------------------------------------
-- 3. Who may do what
-- ---------------------------------------------------------------------
ALTER TABLE public.invoice_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant read for invoice_events" ON public.invoice_events;
CREATE POLICY "Tenant read for invoice_events"
    ON public.invoice_events FOR SELECT
    USING (restaurant_id = public.current_restaurant_id());

DROP POLICY IF EXISTS "Hub insert for invoice_events" ON public.invoice_events;
CREATE POLICY "Hub insert for invoice_events"
    ON public.invoice_events FOR INSERT
    WITH CHECK (restaurant_id = public.current_restaurant_id() AND public.current_staff_role() = 'kitchen');

-- No UPDATE, DELETE or TRUNCATE for anyone; nothing at all for anon. The service role keeps the two it needs to read the history and
-- to run `npm run cloud:check`.
REVOKE ALL ON public.invoice_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.invoice_events TO authenticated, service_role;

COMMIT;
