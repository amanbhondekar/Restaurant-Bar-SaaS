-- =====================================================================
-- MIGRATION 012: INGREDIENT COST AND STOCK-UP-TO LEVEL
-- =====================================================================
-- Two optional figures per ingredient, so a restaurant can see what a dish costs and what to buy:
--
--   par       "stock up to": the level a delivery should bring the ingredient back to. 0 = not set.
--   unit_cost what one unit (one kg, one litre, one piece) costs, in rupees. NULL = not costed,
--             which is NOT the same as free: a dish with an uncosted ingredient has an unknown cost.
--
-- Additive and safe to re-run. The hub still pushes without these two columns when the project has not
-- run this yet (everything else about stock keeps replicating), so this can be run whenever convenient.
-- Until it is run, a replacement hub restored from the cloud gets its stock back WITHOUT costs and levels.
-- =====================================================================

ALTER TABLE public.inventory_items
    ADD COLUMN IF NOT EXISTS par       NUMERIC(14,3),
    ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_par_check') THEN
        ALTER TABLE public.inventory_items
            ADD CONSTRAINT inventory_items_par_check CHECK (par IS NULL OR par >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_unit_cost_check') THEN
        ALTER TABLE public.inventory_items
            ADD CONSTRAINT inventory_items_unit_cost_check CHECK (unit_cost IS NULL OR unit_cost >= 0);
    END IF;
END $$;
