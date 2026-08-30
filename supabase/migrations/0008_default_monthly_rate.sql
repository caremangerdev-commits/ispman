-- ISPMan: company-wide default monthly rate.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- Pre-fills the Monthly Rate field when adding a customer. Until it is applied
-- the General Settings field renders disabled and the Add Customer form simply
-- starts with an empty rate (see lib/schema.ts).

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS default_monthly_rate DECIMAL(10,2) DEFAULT 0;

-- A DEFAULT does not apply to rows that already exist, so backfill explicitly.
UPDATE settings SET default_monthly_rate = 0 WHERE default_monthly_rate IS NULL;

-- Addition beyond the supplied SQL: a negative default would silently produce
-- negative rates on every new customer.
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_default_monthly_rate_check;
ALTER TABLE settings ADD CONSTRAINT settings_default_monthly_rate_check
  CHECK (default_monthly_rate >= 0);
