-- ISPMan: postpaid billing.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- ALREADY APPLIED to the development project — this file is the checked-in
-- record of it, written after the fact so other environments can be brought to
-- the same shape. Every statement is idempotent, so re-running it is safe.
--
-- Until it is applied the app reads as prepaid-only: lib/schema.ts probes for
-- these columns, the Billing Type controls render disabled, and recording a
-- payment keeps its existing prepaid behaviour.

-- ---------------------------------------------------------------------------
-- 1. Customers: how they are billed, and what they still owe.
--
-- carried_balance is deliberately separate from the existing `balance` column.
-- `balance` is the running account balance the rest of the app already shows;
-- carried_balance is specifically the shortfall from the last bill that gets
-- added to the next one, which is what the payment flow reasons about.
-- ---------------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS billing_type     VARCHAR(10)   DEFAULT 'prepaid',
  ADD COLUMN IF NOT EXISTS carried_balance  NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS account_credit   NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bill_date        INT,
  ADD COLUMN IF NOT EXISTS last_billed_date DATE;

-- A DEFAULT does not apply to rows that already exist. 0004 and 0007 were both
-- bitten by this; backfill explicitly.
UPDATE customers SET billing_type    = 'prepaid' WHERE billing_type IS NULL;
UPDATE customers SET carried_balance = 0         WHERE carried_balance IS NULL;
UPDATE customers SET account_credit  = 0         WHERE account_credit IS NULL;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_billing_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_billing_type_check
  CHECK (billing_type IN ('prepaid', 'postpaid'));

-- bill_date is a day of month. Unlike cut_off_date (capped at 28 elsewhere in
-- this app) it accepts 1-31, because the spec asks for a full day-of-month
-- input; lib/billing.ts#postpaidExpiry clamps 29-31 to the length of the
-- target month so a February bill date cannot roll into March.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_bill_date_check;
ALTER TABLE customers ADD CONSTRAINT customers_bill_date_check
  CHECK (bill_date IS NULL OR (bill_date >= 1 AND bill_date <= 31));

-- Neither balance may go negative: overpayment belongs in account_credit.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_carried_balance_check;
ALTER TABLE customers ADD CONSTRAINT customers_carried_balance_check
  CHECK (carried_balance >= 0);

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_account_credit_check;
ALTER TABLE customers ADD CONSTRAINT customers_account_credit_check
  CHECK (account_credit >= 0);

-- ---------------------------------------------------------------------------
-- 2. Payments: what the payment covered, and what it decided about access.
--
-- All nullable. Rows written before this migration have none of these, and a
-- prepaid payment leaves the billing period pair empty because it does not
-- bill for a period already used.
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS billing_period_start   DATE,
  ADD COLUMN IF NOT EXISTS billing_period_end     DATE,
  ADD COLUMN IF NOT EXISTS access_granted_until   DATE,
  ADD COLUMN IF NOT EXISTS carried_balance_before NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS carried_balance_after  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS access_decision        VARCHAR(20);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_access_decision_check;
ALTER TABLE payments ADD CONSTRAINT payments_access_decision_check
  CHECK (
    access_decision IS NULL
    OR access_decision IN ('full_period', 'proportional', 'date_selected')
  );

-- ---------------------------------------------------------------------------
-- 3. Settings: the company-wide default for new customers.
-- ---------------------------------------------------------------------------
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS default_billing_type VARCHAR(10) DEFAULT 'prepaid';

UPDATE settings SET default_billing_type = 'prepaid' WHERE default_billing_type IS NULL;

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_default_billing_type_check;
ALTER TABLE settings ADD CONSTRAINT settings_default_billing_type_check
  CHECK (default_billing_type IN ('prepaid', 'postpaid'));

-- ---------------------------------------------------------------------------
-- 4. Index.
--
-- The postpaid billing run selects customers by type and bill day; without this
-- it is a full scan of the customer table per company.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS customers_billing_type_bill_date_idx
  ON customers (company_id, billing_type, bill_date);
