-- =====================================================================
-- MULTI-TENANT RESTAURANT POS SAAS (MEJWANI PILOT) — SUPABASE RLS SCHEMA
-- =====================================================================
-- Architecture:
-- 1. `restaurants` table is the root tenant entity.
-- 2. All tenant data tables carry a mandatory `restaurant_id` foreign key.
-- 3. Row Level Security (RLS) is enabled on all tenant tables.
-- 4. RLS policies enforce isolation based on staff_users membership.
-- =====================================================================

-- 1. EXTENSIONS & FUNCTIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. TENANTS TABLE (restaurants)
CREATE TABLE IF NOT EXISTS public.restaurants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    cuisine VARCHAR(100) DEFAULT 'Multi-Cuisine',
    address TEXT,
    city VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    currency VARCHAR(10) DEFAULT '₹',
    plan VARCHAR(20) NOT NULL DEFAULT 'starter', -- 'starter', 'pro', 'enterprise'
    pairing_code VARCHAR(10) NOT NULL,
    settings JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast tenant lookups by slug
CREATE INDEX IF NOT EXISTS idx_restaurants_slug ON public.restaurants(slug);
CREATE INDEX IF NOT EXISTS idx_restaurants_pairing_code ON public.restaurants(pairing_code);

-- 3. STAFF & USER ROLES TABLE (staff_users)
CREATE TABLE IF NOT EXISTS public.staff_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'manager', 'waiter', 'kitchen')),
    pin_code VARCHAR(6),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_users_tenant ON public.staff_users(restaurant_id);

-- Helper function to get current user's restaurant_id from auth token or staff mapping
CREATE OR REPLACE FUNCTION public.current_restaurant_id()
RETURNS UUID AS $$
    SELECT restaurant_id 
    FROM public.staff_users 
    WHERE user_id = auth.uid() 
    LIMIT 1;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- 4. FLOOR TABLES / LAYOUT (tables)
CREATE TABLE IF NOT EXISTS public.tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    section VARCHAR(100) NOT NULL DEFAULT 'Main Hall',
    capacity INT NOT NULL DEFAULT 4,
    status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'kot', 'ready')),
    active_order_total NUMERIC(10,2) DEFAULT 0,
    occupied_since TIMESTAMPTZ,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tables_tenant ON public.tables(restaurant_id);

-- 5. MENU CATEGORIES & MENU ITEMS
CREATE TABLE IF NOT EXISTS public.menu_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.menu_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    category_id UUID REFERENCES public.menu_categories(id) ON DELETE SET NULL,
    category_name VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    is_veg BOOLEAN DEFAULT TRUE,
    available BOOLEAN DEFAULT TRUE,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_tenant ON public.menu_items(restaurant_id);

-- 6. ORDERS & KITCHEN TICKETS (orders & order_items)
CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    table_id UUID REFERENCES public.tables(id) ON DELETE SET NULL,
    table_name VARCHAR(50) NOT NULL,
    ticket_number INT NOT NULL,
    status VARCHAR(20) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'ready', 'billed', 'completed', 'cancelled')),
    total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    note TEXT,
    created_by_waiter VARCHAR(100),
    synced_to_cloud BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    menu_item_id UUID REFERENCES public.menu_items(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    qty INT NOT NULL,
    price NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_tenant ON public.orders(restaurant_id);

-- 7. DIGITAL QUEUE & WAITLIST (waitlist_entries)
CREATE TABLE IF NOT EXISTS public.waitlist_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    customer_name VARCHAR(150) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    party_size INT NOT NULL DEFAULT 2,
    section_preference VARCHAR(100) DEFAULT 'Any',
    status VARCHAR(20) DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'seated', 'cancelled')),
    estimated_wait_mins INT DEFAULT 15,
    assigned_table_id UUID REFERENCES public.tables(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_tenant ON public.waitlist_entries(restaurant_id);

-- 8. DEVICE PAIRINGS (device_pairings)
CREATE TABLE IF NOT EXISTS public.device_pairings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    device_name VARCHAR(100) NOT NULL,
    device_role VARCHAR(50) NOT NULL, -- 'waiter_mobile', 'kitchen_kds', 'reception'
    pairing_code VARCHAR(10) NOT NULL,
    ip_address VARCHAR(45),
    last_active TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_pairings_tenant ON public.device_pairings(restaurant_id);

-- 9. INVOICES (invoices) — issued at bill-close, cloud replica of hub invoiceStore
CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    hub_invoice_id VARCHAR(64) UNIQUE, -- Matches invoiceStore's local id, keeps hub-cloud replication idempotent
    invoice_number VARCHAR(20) NOT NULL, -- Tenant-sequential, e.g. INV-000123
    table_id VARCHAR(50),
    table_name VARCHAR(50),
    currency VARCHAR(10) DEFAULT '₹',
    subtotal NUMERIC(12,2) NOT NULL,
    tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    grand_total NUMERIC(12,2) NOT NULL,
    tax_rows JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{label, rate_percent, taxable_amount, amount}]
    ticket_ids JSONB NOT NULL DEFAULT '[]'::jsonb, -- Local hub ticket ids folded into this bill
    payment_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'refunded', 'voided')),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(restaurant_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON public.invoices(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_table ON public.invoices(restaurant_id, table_id);
CREATE INDEX IF NOT EXISTS idx_invoices_issued_at ON public.invoices(restaurant_id, issued_at DESC);

-- 10. INVOICE LINES (invoice_lines) — one row per priced line item on the bill
CREATE TABLE IF NOT EXISTS public.invoice_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    menu_item_id VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    qty INT NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    line_total NUMERIC(12,2) NOT NULL,
    ticket_number INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON public.invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_tenant ON public.invoice_lines(restaurant_id);

-- =====================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES — ENFORCING STRUCTURAL DATA ISOLATION
-- =====================================================================

-- Enable RLS on all tenant tables
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;

-- 1. RESTAURANTS POLICY
CREATE POLICY "Users can access their own restaurant record"
    ON public.restaurants
    FOR ALL
    USING (id = public.current_restaurant_id());

-- 2. STAFF_USERS POLICY
CREATE POLICY "Staff can view staff members in their restaurant"
    ON public.staff_users
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- 3. TABLES POLICY
CREATE POLICY "Tenant isolation for tables"
    ON public.tables
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- 4. MENU ITEMS POLICY
CREATE POLICY "Tenant isolation for menu_items"
    ON public.menu_items
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- 5. ORDERS POLICY
CREATE POLICY "Tenant isolation for orders"
    ON public.orders
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- 6. WAITLIST POLICY
CREATE POLICY "Tenant isolation for waitlist_entries"
    ON public.waitlist_entries
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- 7. DEVICE PAIRINGS POLICY
CREATE POLICY "Tenant isolation for device_pairings"
    ON public.device_pairings
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- 8. INVOICES POLICY
CREATE POLICY "Tenant isolation for invoices"
    ON public.invoices
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- 9. INVOICE LINES POLICY
CREATE POLICY "Tenant isolation for invoice_lines"
    ON public.invoice_lines
    FOR ALL
    USING (restaurant_id = public.current_restaurant_id());

-- =====================================================================
-- SEED DATA FOR DEMO TENANTS
-- Tenant 1: Hotel Mejwani (Pilot Restaurant - Nagpur, Plan: 'pro')
-- Tenant 2: Spice Garden Bistro (2nd Restaurant - Bengaluru, Plan: 'starter')
-- =====================================================================

INSERT INTO public.restaurants (id, name, slug, cuisine, address, city, phone, currency, plan, pairing_code)
VALUES 
  ('11111111-1111-1111-1111-111111111111', 'Hotel Mejwani', 'hotel-mejwani', 'Nagpuri Saoji & Indian', 'Manish Nagar', 'Nagpur', '9822012345', '₹', 'pro', 'MJW-7492'),
  ('22222222-2222-2222-2222-222222222222', 'Spice Garden Bistro', 'spice-garden', 'North Indian & Chinese', 'Indiranagar 100ft Rd', 'Bengaluru', '9845098765', '₹', 'starter', 'SPG-3108')
ON CONFLICT (id) DO NOTHING;
