-- =====================================================================
-- MIGRATION 003: HUB-AUTHORITATIVE MENU & TABLES (cloud write-through)
-- =====================================================================
-- The reception hub now edits the menu and the table layout and pushes full
-- snapshots to the cloud. Run once in the Supabase SQL editor; safe to re-run.
--
--  * menu_items gains the columns the hub already uses locally.
--  * menu_items, menu_categories and tables gain hub_ref: the hub's own id for the
--    row. The hub upserts on (restaurant_id, hub_ref), so it keeps its ids (open
--    tickets stay valid) and no id mapping is needed.
--  * Existing rows are backfilled with hub_ref = id::text (the name for
--    categories), which is exactly the id a hub that pulled them from the cloud
--    already holds, so the first push updates them in place instead of
--    duplicating the menu.
-- =====================================================================

-- 1. Menu item fields that only lived on the hub until now
ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS variants        JSONB;
ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS modifier_groups JSONB;
ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS day_parts       JSONB;
ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS station         VARCHAR(20);

-- 2. The hub's own id for each row
ALTER TABLE public.menu_items      ADD COLUMN IF NOT EXISTS hub_ref TEXT;
ALTER TABLE public.menu_categories ADD COLUMN IF NOT EXISTS hub_ref TEXT;
ALTER TABLE public.tables          ADD COLUMN IF NOT EXISTS hub_ref TEXT;

UPDATE public.menu_items      SET hub_ref = id::text WHERE hub_ref IS NULL;
UPDATE public.menu_categories SET hub_ref = name     WHERE hub_ref IS NULL;
UPDATE public.tables          SET hub_ref = id::text WHERE hub_ref IS NULL;

-- Two categories with the same name would make the unique index below fail. Keep the
-- first of each; the next push from the hub recreates whatever it still needs.
DELETE FROM public.menu_categories a
 USING public.menu_categories b
 WHERE a.restaurant_id = b.restaurant_id
   AND a.hub_ref = b.hub_ref
   AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_items_hub_ref
    ON public.menu_items (restaurant_id, hub_ref);
CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_categories_hub_ref
    ON public.menu_categories (restaurant_id, hub_ref);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tables_hub_ref
    ON public.tables (restaurant_id, hub_ref);

-- 3. A snapshot push removes rows the owner deleted on the hub. Migration 002 granted
--    menu_categories only SELECT/INSERT/UPDATE. Row-level security still limits every
--    statement to the hub's own restaurant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.menu_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.menu_items      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tables          TO authenticated;
