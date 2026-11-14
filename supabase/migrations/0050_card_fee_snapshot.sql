-- The fee terms a payment was charged under, frozen onto the payment.
--
-- WHY. 0049 put the rate on payment_gateways and the customer's share on
-- settings, and stores the resulting surcharge and the gateway's reported fee
-- on each gateway_payments row. That is enough to show a customer what they
-- paid, and not enough to answer "why that figure?" six months later: the
-- moment a company edits its rate or moves its share, every past payment
-- becomes un-derivable, because the only record of the old terms was the
-- settings row that just changed.
--
-- So the terms travel with the payment. These three columns are written at
-- claim time from what was quoted at checkout, never re-read from settings,
-- and they are what a reconciliation report works from.
--
-- NULL on every payment taken before this, and on every payment where the
-- company absorbed the fee — there were no terms to record.

ALTER TABLE public.gateway_payments
  ADD COLUMN IF NOT EXISTS fee_rate NUMERIC(5, 3),
  ADD COLUMN IF NOT EXISTS fee_fixed NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS fee_share INTEGER;

DO $$
BEGIN
  ALTER TABLE public.gateway_payments
    ADD CONSTRAINT gateway_payments_fee_rate_sane
    CHECK (fee_rate IS NULL OR (fee_rate >= 0 AND fee_rate <= 20));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.gateway_payments
    ADD CONSTRAINT gateway_payments_fee_fixed_sane
    CHECK (fee_fixed IS NULL OR (fee_fixed >= 0 AND fee_fixed <= 10000));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.gateway_payments
    ADD CONSTRAINT gateway_payments_fee_share_sane
    CHECK (fee_share IS NULL OR (fee_share >= 0 AND fee_share <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.gateway_payments.fee_rate IS
  'The gateway percentage in force when this payment was quoted. Snapshot: never re-read from payment_gateways.';
COMMENT ON COLUMN public.gateway_payments.fee_fixed IS
  'The gateway fixed fee in force when this payment was quoted.';
COMMENT ON COLUMN public.gateway_payments.fee_share IS
  'The share of the fee, 0-100, the customer agreed to carry on this payment.';
