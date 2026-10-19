-- =====================================================================
-- MIGRATION 009: INVENTORY & RECIPES (cloud copy of the hub's stock)
-- =====================================================================
-- The hub keeps stock and recipes on the reception laptop and takes
-- ingredients out as orders arrive (hub_server/lib/inventory.js), so it has
-- to work with the internet down. This adds the tables the hub pushes a
-- snapshot into, so the figures are not lost with the laptop and a
-- replacement hub can rebuild its ingredients and recipes. Run once in the
-- Supabase SQL editor; safe to re-run.
--
--  * Same arrangement as the menu and tables (migration 003): the hub is
--    the single writer, each push is a full snapshot upserted on
--    (restaurant_id, hub_ref), and rows the snapshot no longer holds are
--    deleted. hub_ref is the hub's own id, so nothing needs mapping.
--  * on_hand is a SNAPSHOT of the figure when the hub last pushed. The hub
--    is the authority: it changes with every order, offline, so the cloud
--    never writes it back except when a replacement hub starts empty.
--  * Quantities are NUMERIC(14,3), not float: three decimals is what a
--    kitchen can weigh, and a running total of sales must not drift.
--  * recipes.lines is JSONB, [{ "inventory_item_id": "<hub_ref>", "qty": 150 }].
--    A recipe is replaced whole on every push and never queried relationally,
--    so a child table would only add a delete-stale pass per recipe.
--  * menu_item_ref / variant_ref are the hub's menu ids (menu_items.hub_ref)
--    stored as text with no foreign key: the menu and the recipes are
--    pushed independently, and a recipe may briefly refer to a dish the
--    cloud has not received yet.
--  * The movement log is NOT replicated. It is an audit trail of the hub's
--    own, capped there, and is not needed to rebuild anything.
--  * RLS mirrors every other tenant table: one policy keyed on
--    current_restaurant_id().
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.inventory_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    -- The hub's own id for this ingredient; the upsert key.
    hub_ref       TEXT NOT NULL,

    name          VARCHAR(80)   NOT NULL,
    unit          VARCHAR(8)    NOT NULL,
    on_hand       NUMERIC(14,3) NOT NULL DEFAULT 0,
    low_at        NUMERIC(14,3) NOT NULL DEFAULT 0,
    synced_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT inventory_items_unit_check   CHECK (unit IN ('g', 'kg', 'ml', 'l', 'pcs')),
    CONSTRAINT inventory_items_on_hand_check CHECK (on_hand >= 0),
    CONSTRAINT inventory_items_low_at_check  CHECK (low_at >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_items_hub_ref
    ON public.inventory_items (restaurant_id, hub_ref);

CREATE TABLE IF NOT EXISTS public.recipes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,

    hub_ref       TEXT NOT NULL,

    -- The dish, and the size when the recipe is for one size of it. A NULL
    -- variant_ref is the dish-wide recipe, used for any size with no recipe of its own.
    menu_item_ref TEXT NOT NULL,
    variant_ref   TEXT,

    lines         JSONB NOT NULL DEFAULT '[]'::jsonb,
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT recipes_lines_is_array CHECK (jsonb_typeof(lines) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recipes_hub_ref
    ON public.recipes (restaurant_id, hub_ref);

-- Deliberately NO unique index on (restaurant_id, menu_item_ref, variant_ref). The hub already
-- guarantees one recipe per dish-and-size, and a cloud constraint can only make a valid snapshot
-- unpushable: clear a dish's recipe and set it again while offline and the hub gives the new one a
-- fresh id, so the upsert of the new row would meet the old row for the same dish before the
-- delete-stale pass removes it, and fail with a unique violation. That is not a systemic error, so
-- the push would burn its retries and be shelved. An index for reading by dish is enough:
CREATE INDEX IF NOT EXISTS idx_recipes_subject
    ON public.recipes (restaurant_id, menu_item_ref);

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant isolation for inventory_items" ON public.inventory_items;
CREATE POLICY "Tenant isolation for inventory_items"
    ON public.inventory_items
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

DROP POLICY IF EXISTS "Tenant isolation for recipes" ON public.recipes;
CREATE POLICY "Tenant isolation for recipes"
    ON public.recipes
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- A snapshot push removes ingredients and recipes the owner deleted on the hub, so DELETE is granted
-- here (unlike invoices, which are never removed). Row-level security still limits every statement
-- to the hub's own restaurant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipes         TO authenticated;
