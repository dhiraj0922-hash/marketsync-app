-- Migration: Driver Registry and Delivery Runs Hardening

-- 1. Ensure indexes exist for case-insensitive lookup and efficient join matching
CREATE INDEX IF NOT EXISTS idx_drivers_email_lower ON drivers (lower(email));
CREATE INDEX IF NOT EXISTS idx_delivery_runs_driver_id ON delivery_runs(driver_id);
CREATE INDEX IF NOT EXISTS idx_delivery_tickets_run_id ON delivery_tickets(run_id);

-- 2. Ensure case-insensitive uniqueness on driver email (using a unique index to be safe against schema locks)
CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_email_unique ON drivers (lower(email));
