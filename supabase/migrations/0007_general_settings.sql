-- ISPMan general settings + removal of customer groups.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- WARNING: the first two statements are destructive and irreversible. Dropping
-- customer_groups discards the Zone A / Zone B / Residential / Business
-- assignments currently held on customers.group_id. Misc Categories covers
-- similar ground, so this is presumed intentional.

-- ---------------------------------------------------------------------------
-- 1. Remove customer groups.
-- ---------------------------------------------------------------------------
ALTER TABLE customers DROP COLUMN IF EXISTS group_id;
DROP TABLE IF EXISTS customer_groups CASCADE;

-- ---------------------------------------------------------------------------
-- 2. General settings columns.
--
-- Note: timezone, sms_enabled, email_enabled and currency already exist on
-- `settings`, so those four are no-ops. Kept for completeness / idempotency.
-- ---------------------------------------------------------------------------
ALTER TABLE settings ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/Jamaica';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS date_format VARCHAR(20) DEFAULT 'DD/MM/YYYY';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS grace_period_days INT DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,2) DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS expiry_warning_days INT DEFAULT 3;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ddns_hostname VARCHAR(255);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS radius_secret VARCHAR(100);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'JMD';

-- ---------------------------------------------------------------------------
-- 3. Backfill.
--
-- A DEFAULT only applies to rows inserted afterwards, so every existing
-- settings row would read NULL for the new columns. This bit us on 0004 —
-- fill them explicitly.
-- ---------------------------------------------------------------------------
UPDATE settings SET timezone            = 'America/Jamaica' WHERE timezone IS NULL;
UPDATE settings SET date_format         = 'DD/MM/YYYY'      WHERE date_format IS NULL;
UPDATE settings SET grace_period_days   = 0                 WHERE grace_period_days IS NULL;
UPDATE settings SET tax_rate            = 0                 WHERE tax_rate IS NULL;
UPDATE settings SET sms_enabled         = FALSE             WHERE sms_enabled IS NULL;
UPDATE settings SET email_enabled       = FALSE             WHERE email_enabled IS NULL;
UPDATE settings SET expiry_warning_days = 3                 WHERE expiry_warning_days IS NULL;
UPDATE settings SET currency            = 'JMD'             WHERE currency IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Guarantee every company has a settings row.
--
-- Written as NOT EXISTS rather than NOT IN: if any settings.company_id were
-- NULL, `id NOT IN (SELECT company_id ...)` evaluates to NULL for every row
-- and the INSERT would silently do nothing.
--
-- ON CONFLICT DO NOTHING is retained, but note it only has an effect if a
-- unique constraint exists on settings.company_id — there is none today, so
-- the NOT EXISTS guard is what actually prevents duplicates.
-- ---------------------------------------------------------------------------
INSERT INTO settings (company_id, cut_off_date, bill_date)
SELECT c.id, 5, 25
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM settings s WHERE s.company_id = c.id
)
ON CONFLICT DO NOTHING;

-- Recommended follow-up: one settings row per company is an invariant the app
-- relies on. Uncomment to enforce it (fails if duplicates already exist).
-- CREATE UNIQUE INDEX IF NOT EXISTS settings_company_id_key ON settings (company_id);
