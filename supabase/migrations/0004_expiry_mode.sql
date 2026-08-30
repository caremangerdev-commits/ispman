-- ISPMan expiry mode: per-customer, with a company-wide default.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- Until it is applied the app degrades gracefully (see lib/schema.ts): the
-- expiry-mode toggle renders read-only showing the hardcoded 'from_expiry'
-- behaviour, and the payment page still calculates a new expiry that way.
--
--   from_expiry  = renew from the customer's current expiry date (standard:
--                  a late payer does not lose the days they already paid for)
--   from_payment = renew from today (flexible: the clock restarts on payment)

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS expiry_mode VARCHAR(20) DEFAULT 'from_expiry'
  CHECK (expiry_mode IN ('from_expiry', 'from_payment'));

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS default_expiry_mode VARCHAR(20) DEFAULT 'from_expiry';

-- ---------------------------------------------------------------------------
-- Additions beyond the supplied SQL.
-- ---------------------------------------------------------------------------

-- Existing rows predate the column default, so they come back NULL rather than
-- 'from_expiry'. Backfill both tables explicitly.
UPDATE customers SET expiry_mode = 'from_expiry' WHERE expiry_mode IS NULL;
UPDATE settings SET default_expiry_mode = 'from_expiry' WHERE default_expiry_mode IS NULL;

-- The customers column is constrained; mirror that on settings so an invalid
-- company default cannot be written either.
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_default_expiry_mode_check;
ALTER TABLE settings ADD CONSTRAINT settings_default_expiry_mode_check
  CHECK (default_expiry_mode IN ('from_expiry', 'from_payment'));
