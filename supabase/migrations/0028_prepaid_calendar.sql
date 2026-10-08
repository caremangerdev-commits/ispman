-- ISPMan: calendar-month prepaid billing, behind a per-company switch.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe before or after the code: the code
-- reads these columns only once they exist, and nothing changes for any company
-- until settings.prepaid_calendar_enabled is turned on for it.
--
-- THE MODEL (owner, 7-8 Oct 2026; prepaid companies only, Ezmze first)
--   The period is the calendar month. The cut-off day is when an unpaid
--   customer is disconnected, not the end of the period. A customer pays only
--   for the days their service was on; days disconnected are free. A month's
--   figure is monthly rate x service days / days in that month, rounded to the
--   nearest hundred, once per month. See lib/prepaid-calendar.ts.
--
-- WHAT THIS ADDS
--   settings.prepaid_calendar_enabled   the switch. FALSE for every company.
--   settings.reconnection_fee           charged at the till to a disconnected
--                                       customer, never added to a balance.
--   customers.service_ended_on          the last day of service in the current
--                                       disconnection; NULL while on.
--   bill_charges                        a month's charge can now be reduced
--                                       (disconnection) or raised (return, first
--                                       connection), keeping the full-month
--                                       figure and the service days it rests on.
--   payments.service_breakdown          the per-month days and amounts the till
--                                       showed, so the receipt prints the same.
--   set_month_charge()                  the ONE way a month's charge is changed:
--                                       locked, guarded, balance moved with it.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS prepaid_calendar_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS reconnection_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_reconnection_fee_check;
ALTER TABLE public.settings
  ADD CONSTRAINT settings_reconnection_fee_check CHECK (reconnection_fee >= 0);

-- ---------------------------------------------------------------------------
-- 2. Customers: when the current disconnection began
-- ---------------------------------------------------------------------------
-- The last day the customer HAD service (the cut-off day counts as a service
-- day). Set by the hourly tick when it sees service end; cleared when service
-- resumes. NULL while the customer is on.
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS service_ended_on DATE;

-- ---------------------------------------------------------------------------
-- 3. bill_charges: a month's charge can move
-- ---------------------------------------------------------------------------
-- Rows written by the till or at connection belong to no engine run.
ALTER TABLE public.bill_charges ALTER COLUMN run_id DROP NOT NULL;

-- Who wrote the row: the engine's bill-date run, the till (a disconnected
-- customer's return), connection (a new customer's first month), or the
-- hourly service pass (a month first written by a disconnection).
ALTER TABLE public.bill_charges
  ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'engine';
ALTER TABLE public.bill_charges DROP CONSTRAINT IF EXISTS bill_charges_source_check;
ALTER TABLE public.bill_charges
  ADD CONSTRAINT bill_charges_source_check CHECK (source IN ('engine', 'till', 'provision', 'service'));

-- Days of service the amount rests on. NULL = the whole month.
ALTER TABLE public.bill_charges ADD COLUMN IF NOT EXISTS service_days INT;
-- The full-month figure, kept when the amount is changed.
ALTER TABLE public.bill_charges ADD COLUMN IF NOT EXISTS full_amount NUMERIC(10,2);
-- When the amount was last changed after the charge was raised.
ALTER TABLE public.bill_charges ADD COLUMN IF NOT EXISTS adjusted_at TIMESTAMP WITH TIME ZONE;

-- ---------------------------------------------------------------------------
-- 4. payments: what the till showed, for the receipt
-- ---------------------------------------------------------------------------
-- [{ "month": "2026-10", "days": 24, "amount": 2700, "kind": "current" }, ...]
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS service_breakdown JSONB;

-- ---------------------------------------------------------------------------
-- 5. set_month_charge(): change ONE month's charge for ONE customer
-- ---------------------------------------------------------------------------
-- Inserts the month's row if there is none, or changes its amount, and moves
-- the customer's balance by the difference — in one transaction, under a lock
-- on the customer row.
--
-- THE GUARD. The caller states the amount it read (p_expected_amount), or NULL
-- for "there was no row". If the row no longer matches, nothing is written and
-- {ok:false, reason:'changed'} comes back: a second tick, a till and a script
-- cannot change the same month on the strength of a stale read.
--
-- A CHARGE CUT BELOW WHAT WAS ALREADY PAID LEAVES THE DIFFERENCE AS CREDIT
-- (owner, 8 Oct 2026). Credit the engine had drawn into the charge goes back to
-- account_credit first; anything the balance would then go below zero by
-- becomes credit too.
--
-- p_touch_service: also set customers.service_ended_on to p_service_ended_on
-- (NULL clears it) in the same transaction — a disconnection and its reduction,
-- or a return and its charge, are one change.
CREATE OR REPLACE FUNCTION public.set_month_charge(
  p_company_id        BIGINT,
  p_customer_id       BIGINT,
  p_period_start      DATE,
  p_period_end        DATE,
  p_charged_on        DATE,
  p_amount            NUMERIC,
  p_service_days      INT,
  p_full_amount       NUMERIC,
  p_source            TEXT,
  p_expected_amount   NUMERIC,
  p_touch_service     BOOLEAN,
  p_service_ended_on  DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_carried      NUMERIC(10,2);
  v_credit       NUMERIC(10,2);
  v_row          bill_charges%ROWTYPE;
  v_found        BOOLEAN;
  v_amount       NUMERIC(10,2);
  v_old          NUMERIC(10,2);
  v_delta        NUMERIC(10,2);
  v_credit_back  NUMERIC(10,2) := 0;
  v_credit_add   NUMERIC(10,2) := 0;
  v_after        NUMERIC(10,2);
  v_id           BIGINT;
BEGIN
  v_amount := ROUND(p_amount, 2);
  IF v_amount IS NULL OR v_amount < 0 THEN
    RAISE EXCEPTION 'month charge for customer % has amount %', p_customer_id, p_amount;
  END IF;

  SELECT COALESCE(carried_balance, 0), COALESCE(account_credit, 0)
    INTO v_carried, v_credit
    FROM customers
   WHERE id = p_customer_id AND company_id = p_company_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'customer not found');
  END IF;

  SELECT * INTO v_row
    FROM bill_charges
   WHERE customer_id = p_customer_id AND period_start = p_period_start AND company_id = p_company_id
     FOR UPDATE;
  v_found := FOUND;

  IF v_found THEN
    IF p_expected_amount IS NULL OR v_row.amount <> ROUND(p_expected_amount, 2) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'changed', 'amount', v_row.amount);
    END IF;
    v_old := v_row.amount;
  ELSE
    IF p_expected_amount IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'changed', 'amount', NULL);
    END IF;
    v_old := 0;
  END IF;

  v_delta := v_amount - v_old;

  IF v_found THEN
    -- Credit drawn into this charge beyond its new amount goes back.
    IF v_row.credit_applied > v_amount THEN
      v_credit_back := v_row.credit_applied - v_amount;
    END IF;
    UPDATE bill_charges
       SET amount         = v_amount,
           service_days   = p_service_days,
           full_amount    = COALESCE(p_full_amount, full_amount, v_row.amount),
           credit_applied = LEAST(credit_applied, v_amount),
           adjusted_at    = NOW()
     WHERE id = v_row.id;
    v_id := v_row.id;
  END IF;

  -- The balance: what the charge moved, less what came back as credit.
  v_after := v_carried + v_delta + v_credit_back;
  IF v_after < 0 THEN
    v_credit_add := -v_after;
    v_after := 0;
  END IF;

  IF NOT v_found THEN
    INSERT INTO bill_charges (
      company_id, customer_id, run_id, period_start, period_end, charged_on,
      amount, credit_applied, carried_balance_before, carried_balance_after,
      source, service_days, full_amount, adjusted_at
    )
    VALUES (
      p_company_id, p_customer_id, NULL, p_period_start, p_period_end, p_charged_on,
      v_amount, 0, v_carried, v_after,
      p_source, p_service_days, p_full_amount, NULL
    )
    RETURNING id INTO v_id;
  END IF;

  UPDATE customers
     SET carried_balance  = v_after,
         account_credit   = v_credit + v_credit_back + v_credit_add,
         service_ended_on = CASE WHEN p_touch_service THEN p_service_ended_on ELSE service_ended_on END
   WHERE id = p_customer_id AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'ok', true,
    'charge_id', v_id,
    'old_amount', v_old,
    'new_amount', v_amount,
    'delta', v_delta,
    'carried_before', v_carried,
    'carried_after', v_after,
    'credit_before', v_credit,
    'credit_after', v_credit + v_credit_back + v_credit_add
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_month_charge(BIGINT, BIGINT, DATE, DATE, DATE, NUMERIC, INT, NUMERIC, TEXT, NUMERIC, BOOLEAN, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_month_charge(BIGINT, BIGINT, DATE, DATE, DATE, NUMERIC, INT, NUMERIC, TEXT, NUMERIC, BOOLEAN, DATE) FROM anon;
REVOKE ALL ON FUNCTION public.set_month_charge(BIGINT, BIGINT, DATE, DATE, DATE, NUMERIC, INT, NUMERIC, TEXT, NUMERIC, BOOLEAN, DATE) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_month_charge(BIGINT, BIGINT, DATE, DATE, DATE, NUMERIC, INT, NUMERIC, TEXT, NUMERIC, BOOLEAN, DATE) TO service_role;

-- ---------------------------------------------------------------------------
-- Verify afterwards. Expected results in comments.
-- ---------------------------------------------------------------------------
--   SELECT company_id, prepaid_calendar_enabled, reconnection_fee FROM settings ORDER BY company_id;
--     -> every row false / 0
--   SELECT count(*) FROM customers WHERE service_ended_on IS NOT NULL;
--     -> 0
--   SELECT source, count(*) FROM bill_charges GROUP BY source;
--     -> engine | (every existing row)
