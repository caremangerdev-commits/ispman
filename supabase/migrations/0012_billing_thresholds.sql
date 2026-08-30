-- ISPMan: billing policy thresholds.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. Migration 0011 added `settings.default_billing_type`, but
-- not the three policy thresholds the Billing settings tab asks for. Until this
-- runs those three fields render disabled (see lib/schema.ts#billingThresholds)
-- and the rest of the billing settings save normally.
--
-- These are policy values only: nothing in the payment flow reads them yet.
-- They are stored so the collections and billing-run work that needs them has
-- somewhere to read from, and so an administrator can set them once.

ALTER TABLE settings
  -- Days a customer may be late before their payment stops earning credit.
  ADD COLUMN IF NOT EXISTS late_credit_threshold INT           DEFAULT 7,
  -- Smallest share of the amount due that counts as a payment, as a percent.
  ADD COLUMN IF NOT EXISTS min_payment_threshold NUMERIC(5,2)  DEFAULT 50,
  -- How many months of carried balance a customer may accumulate.
  ADD COLUMN IF NOT EXISTS max_carried_balance   INT           DEFAULT 2;

-- A DEFAULT does not apply to rows that already exist; backfill explicitly.
UPDATE settings SET late_credit_threshold = 7  WHERE late_credit_threshold IS NULL;
UPDATE settings SET min_payment_threshold = 50 WHERE min_payment_threshold IS NULL;
UPDATE settings SET max_carried_balance   = 2  WHERE max_carried_balance   IS NULL;

-- Ranges match what the settings form allows, so a value written by hand in the
-- SQL editor cannot put the form into a state it will not accept back.
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_late_credit_threshold_check;
ALTER TABLE settings ADD CONSTRAINT settings_late_credit_threshold_check
  CHECK (late_credit_threshold >= 0 AND late_credit_threshold <= 90);

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_min_payment_threshold_check;
ALTER TABLE settings ADD CONSTRAINT settings_min_payment_threshold_check
  CHECK (min_payment_threshold >= 0 AND min_payment_threshold <= 100);

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_max_carried_balance_check;
ALTER TABLE settings ADD CONSTRAINT settings_max_carried_balance_check
  CHECK (max_carried_balance >= 0 AND max_carried_balance <= 12);
