-- =====================================================================
-- MIGRATION 002: ONLINE CLOUD SYNC, RLS POLICIES & ORDER ITEM PERMISSIONS
-- =====================================================================
-- Closes the RLS deny-all gap on order_items and menu_categories so that
-- the authenticated kitchen hub can synchronize order line items to Supabase,
-- and adds order_request_id for cloud-level idempotent insertions.
-- =====================================================================

-- 1. Add order_request_id for idempotency during cloud retries
ALTER TABLE public.orders 
ADD COLUMN IF NOT EXISTS order_request_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_orders_request_id ON public.orders(order_request_id);

-- 2. RLS Policy for menu_categories (tenant isolation)
DROP POLICY IF EXISTS "Tenant isolation for menu_categories" ON public.menu_categories;
CREATE POLICY "Tenant isolation for menu_categories"
    ON public.menu_categories
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- 3. RLS Policy for order_items (linked via parent orders table tenant ID)
DROP POLICY IF EXISTS "Tenant isolation for order_items" ON public.order_items;
CREATE POLICY "Tenant isolation for order_items"
    ON public.order_items
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.orders
            WHERE orders.id = order_items.order_id
              AND orders.restaurant_id = public.current_restaurant_id()
        )
    );

-- 4. Grant appropriate table permissions to authenticated role
GRANT SELECT, INSERT, UPDATE ON public.menu_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.order_items TO authenticated;
