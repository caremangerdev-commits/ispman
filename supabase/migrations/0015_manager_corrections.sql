-- ISPMan: reversible prepayment credit.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. Payment corrections probe for this column and skip the
-- credit reversal until it exists (see lib/schema.ts#creditReversal), so
-- applying this is what turns the reversal on. Nothing below drops or rewrites
-- existing data.
--
-- The other two manager corrections that shipped with this one need no schema:
-- the expiry correction writes to radcheck, and the balance adjustment is
-- marked by reading the `log` table rather than by a column on customers.

-- ---------------------------------------------------------------------------
-- Payments: how much prepayment credit this payment created.
--
-- THE REVERSAL RECORD. app/actions/payments.ts#updatePayment and #deletePayment
-- could move `carried_balance` back but had no way to take back the
-- `account_credit` a prepayment created, because the amount was computed at the
-- till (lib/billing.ts#prepaymentCredit) and then forgotten. Correcting a
-- prepayment therefore left the credit standing and handed out free months.
--
-- NULLABLE ON PURPOSE, AND NULL IS NOT ZERO. Rows written before this migration
-- created credit that was never recorded, so their true value is unknown. A
-- correction to one of those must skip the reversal and say so rather than
-- assume nothing was created and silently under-reverse. Rows written after it
-- always carry a number, including 0 for an ordinary payment that created none.
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS credit_applied NUMERIC(10,2);

-- Credit created is never negative: a payment short of the balance creates none
-- and leaves a carried balance instead. Mirrors customers_account_credit_check
-- from migration 0011.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_credit_applied_check;
ALTER TABLE payments ADD CONSTRAINT payments_credit_applied_check
  CHECK (credit_applied IS NULL OR credit_applied >= 0);
