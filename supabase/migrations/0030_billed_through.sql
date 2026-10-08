-- ISPMan: the hand-over from hand billing to the engine — "billed through".
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe before or after the code: the code
-- probes for customers.billed_through (lib/schema.ts, `handover`) and reads
-- and writes none of this until it exists. Nothing changes for any customer
-- until billed_through is set for them, which only the hand-over script does.
--
-- WHY (owner, 8 Oct 2026). JMEDIA joins calendar-month prepaid with its engine
-- live from 1 November. Its customers were charged by hand by bill-date periods
-- (4 Oct to 4 Nov, 20 Oct to 20 Nov). November is charged only for the days
-- after each customer's current period; full calendar months from December.
--
-- WHAT THIS ADDS
--   customers.billed_through   the last day already charged before the engine
--                              took the customer over. The engine charges only
--                              days after it: nothing for a month wholly
--                              inside it, the days after it for the month it
--                              ends in, full months after. NULL for everybody
--                              the engine has always billed.
--   bill_runs.skipped_covered  customers whose month was wholly covered.
--   apply_bill_charges()       writes service_days and full_amount when a
--                              charge element carries them (a part month), so
--                              the hourly service pass and the till reduce and
--                              recompute it from the right number of days.

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS billed_through DATE;

ALTER TABLE public.bill_runs
  ADD COLUMN IF NOT EXISTS skipped_covered INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.apply_bill_charges(
  p_company_id BIGINT,
  p_run_id     BIGINT,
  p_charged_on DATE,
  p_charges    JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  c            JSONB;
  v_customer   BIGINT;
  v_start      DATE;
  v_end        DATE;
  v_amount     NUMERIC(10,2);
  v_days       INT;
  v_full       NUMERIC(10,2);
  v_carried    NUMERIC(10,2);
  v_credit     NUMERIC(10,2);
  v_drawn      NUMERIC(10,2);
  v_after      NUMERIC(10,2);
  v_charge_id  BIGINT;
  v_inserted   INT := 0;
  v_existing   INT := 0;
  v_missing    INT := 0;
  v_total      NUMERIC(12,2) := 0;
  v_credit_sum NUMERIC(12,2) := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bill_runs WHERE id = p_run_id AND company_id = p_company_id) THEN
    RAISE EXCEPTION 'bill run % does not belong to company %', p_run_id, p_company_id;
  END IF;

  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_charges, '[]'::jsonb)) LOOP
    v_customer  := (c->>'customer_id')::BIGINT;
    v_start     := (c->>'period_start')::DATE;
    v_end       := (c->>'period_end')::DATE;
    v_amount    := ROUND((c->>'amount')::NUMERIC, 2);
    -- A part month: the days the amount rests on and the full-month figure.
    -- Absent for a whole month, which stays NULL as before.
    v_days      := (c->>'service_days')::INT;
    v_full      := ROUND((c->>'full_amount')::NUMERIC, 2);
    v_charge_id := NULL;

    IF v_customer IS NULL OR v_start IS NULL OR v_end IS NULL THEN
      RAISE EXCEPTION 'malformed charge element: %', c;
    END IF;
    IF v_amount IS NULL OR v_amount < 0 THEN
      RAISE EXCEPTION 'charge for customer % has amount %', v_customer, v_amount;
    END IF;
    IF v_days IS NOT NULL AND v_days < 0 THEN
      RAISE EXCEPTION 'charge for customer % has service_days %', v_customer, v_days;
    END IF;

    -- 1. The lock. Scoped to the company so a list cannot reach another tenant.
    SELECT COALESCE(carried_balance, 0), COALESCE(account_credit, 0)
      INTO v_carried, v_credit
      FROM customers
     WHERE id = v_customer AND company_id = p_company_id
       FOR UPDATE;

    IF NOT FOUND THEN
      v_missing := v_missing + 1;
      CONTINUE;
    END IF;

    -- Prepayment first, then the balance. Neither column can go negative:
    -- the draw is capped at the credit held and at the charge.
    v_drawn := LEAST(GREATEST(v_credit, 0), v_amount);
    v_after := v_carried + (v_amount - v_drawn);

    -- 2. The guard. A duplicate period returns no id and changes nothing.
    INSERT INTO bill_charges (
      company_id, customer_id, run_id, period_start, period_end, charged_on,
      amount, credit_applied, carried_balance_before, carried_balance_after,
      service_days, full_amount
    )
    VALUES (
      p_company_id, v_customer, p_run_id, v_start, v_end, p_charged_on,
      v_amount, v_drawn, v_carried, v_after,
      v_days, v_full
    )
    ON CONFLICT (customer_id, period_start) DO NOTHING
    RETURNING id INTO v_charge_id;

    IF v_charge_id IS NULL THEN
      v_existing := v_existing + 1;
      CONTINUE;
    END IF;

    -- 3. The balance, only because the charge row exists.
    UPDATE customers
       SET carried_balance = v_after,
           account_credit  = v_credit - v_drawn
     WHERE id = v_customer AND company_id = p_company_id;

    -- 4. Count it.
    v_inserted   := v_inserted + 1;
    v_total      := v_total + v_amount;
    v_credit_sum := v_credit_sum + v_drawn;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted',       v_inserted,
    'already_charged', v_existing,
    'missing',        v_missing,
    'total_amount',   v_total,
    'credit_applied', v_credit_sum
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_bill_charges(BIGINT, BIGINT, DATE, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_bill_charges(BIGINT, BIGINT, DATE, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.apply_bill_charges(BIGINT, BIGINT, DATE, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_bill_charges(BIGINT, BIGINT, DATE, JSONB) TO service_role;

-- Verify afterwards:
--   SELECT count(*) FROM customers WHERE billed_through IS NOT NULL;   -> 0 until the hand-over script runs
--   SELECT skipped_covered FROM bill_runs LIMIT 1;                     -> exists
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'apply_bill_charges';  -> one row, prosecdef false
