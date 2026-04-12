-- =================================================================================
-- INITIALIZATION SQL FOR SUPABASE
-- Run this completely in the SQL Editor in your Supabase Dashboard
-- =================================================================================

-- 1. Locations Table
CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT,
    type TEXT,
    status TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Suppliers Table
CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    contact TEXT,
    phone TEXT,
    email TEXT,
    location TEXT,
    itemsCount INTEGER DEFAULT 0,
    minOrder TEXT,
    paymentTerms TEXT,
    leadTime TEXT,
    orderFreq TEXT,
    onTimePct NUMERIC DEFAULT 100,
    priceVariance NUMERIC DEFAULT 0,
    status TEXT,
    rating TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Inventory Items Table
-- Utilizing TEXT for ID mapping internal codes natively natively. JSONB safely preserves dynamic nested units.
CREATE TABLE IF NOT EXISTS inventory_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    itemType TEXT,
    baseUnit TEXT,
    unit TEXT,
    inStock NUMERIC DEFAULT 0,
    parLevel NUMERIC DEFAULT 0,
    cost NUMERIC DEFAULT 0,
    supplierId INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    priceTrend TEXT,
    priceIncrease BOOLEAN DEFAULT FALSE,
    purchaseUnits JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Recipes Table
CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    yieldQty NUMERIC DEFAULT 0,
    yieldUnit TEXT,
    theoreticalCost NUMERIC DEFAULT 0,
    margin NUMERIC DEFAULT 0,
    ingredients JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Users Architecture Boundary
CREATE TABLE IF NOT EXISTS system_users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT,
    assignedLocations JSONB DEFAULT '[]'::jsonb,
    status TEXT DEFAULT 'Active',
    lastActive TEXT,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Central Orders Storage
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    supplierId INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    supplierName TEXT,
    date TEXT,
    deliveryDate TEXT,
    items INTEGER DEFAULT 0,
    total NUMERIC DEFAULT 0,
    status TEXT,
    location TEXT,
    createdBy TEXT,
    receivedBy TEXT,
    receivedAt TEXT,
    notes TEXT,
    lineItems JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Internal Network Requisitions
CREATE TABLE IF NOT EXISTS requisitions (
    id TEXT PRIMARY KEY,
    location TEXT,
    requestedBy TEXT,
    date TEXT,
    status TEXT,
    items INTEGER DEFAULT 0,
    notes TEXT,
    lineItems JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Auditing (Counts) Matrix
CREATE TABLE IF NOT EXISTS counts (
    id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT,
    status TEXT,
    date TEXT,
    location TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    totalVarianceValue NUMERIC DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Production Manufacturing Plans
CREATE TABLE IF NOT EXISTS production_plans (
    id TEXT PRIMARY KEY,
    fgId TEXT,
    fgName TEXT,
    quantity NUMERIC DEFAULT 0,
    unit TEXT,
    date TEXT,
    status TEXT,
    priority TEXT,
    location TEXT,
    assignedTo TEXT,
    notes TEXT,
    ingredients JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 10. Production Historical Maps
CREATE TABLE IF NOT EXISTS production_history (
    id TEXT PRIMARY KEY,
    planId TEXT,
    fgId TEXT,
    fgName TEXT,
    quantity NUMERIC DEFAULT 0,
    unit TEXT,
    date TEXT,
    completedBy TEXT,
    variance NUMERIC DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 11. Core Inventory Actions & Alerts Logging
CREATE TABLE IF NOT EXISTS inventory_activity (
    id SERIAL PRIMARY KEY,
    inventory_id TEXT,
    date TEXT,
    type TEXT,
    qty NUMERIC,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 12. Batch Record Syncs
CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    date TEXT,
    status TEXT,
    recordsInserted INTEGER DEFAULT 0,
    uploadedBy TEXT,
    filename TEXT,
    metrics JSONB DEFAULT '{}'::jsonb,
    created_ids JSONB DEFAULT '[]'::jsonb,
    updated_ids JSONB DEFAULT '[]'::jsonb,
    rollback_data JSONB DEFAULT '{}'::jsonb,
    failed_rows JSONB DEFAULT '[]'::jsonb,
    summary_payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =================================================================================
-- DISABLE RLS UNTIL WE MIGRATE SUPABASE JWT RULES (OPTIONAL)
-- Since we are moving fast, RLS is temporarily disabled across all layers to allow
-- simple local client connections. Do not deploy to actual public instances without 
-- formalizing RLS bounds.
-- =================================================================================

ALTER TABLE locations DISABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers DISABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE recipes DISABLE ROW LEVEL SECURITY;
ALTER TABLE system_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE requisitions DISABLE ROW LEVEL SECURITY;
ALTER TABLE counts DISABLE ROW LEVEL SECURITY;
ALTER TABLE production_plans DISABLE ROW LEVEL SECURITY;
ALTER TABLE production_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_activity DISABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches DISABLE ROW LEVEL SECURITY;
