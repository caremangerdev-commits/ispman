-- ISPMan: the daily billing engine.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- ===========================================================================
-- NOT YET APPLIED. FOR REVIEW. DEPLOY THE CODE BEFORE RUNNING THIS.
-- ===========================================================================
--
-- Part 1 RENAMES settings.default_billing_type. The code that ships before
-- this no longer selects that column in the 0011 probe (lib/schema.ts), so the
-- deployed app runs the same against either name. Old code against the renamed
-- column would read "billing not available" until redeployed; hence the order.
--
-- Everything the engine needs lands in this one file, in dependency order:
--
--   1. settings.billing_type            the company's billing model
--   2. settings.billing_engine_mode     off | dry_run | live, and the start date
--   3. bill_runs                        one row per company per company-local day
--   4. bill_charges                     one row per customer per period; THE GUARD
--   5. the Billing Engine user          the identity audit rows are filed under
--   6. apply_bill_charges()             the one function, one transaction per call
--
-- NOTHING IN HERE RUNS THE ENGINE. billing_engine_mode defaults to 'off' for
-- every company; the tick route does nothing for a company that is off. Going
-- to dry_run or live is a per-company decision made afterwards on the General
-- Settings page.
--
-- OUT OF SCOPE, ON PURPOSE: grace removal, the first cut-off skip, pro-rata
-- joining, charge kinds, multi-line bills, restating history. This file adds
-- nothing for any of them.

-- ---------------------------------------------------------------------------
-- 1. settings.billing_type — the company's billing model. ONE per company.
--
-- Finishes what 0011 half-built. That migration added two columns for this:
--   settings.default_billing_type   company-level, but named and used as "the
--                                   value to stamp on new customers"
--   customers.billing_type          per-customer, seeded from the above
-- Nothing branched on either (lib/billing.ts, "the retired split"). The
-- company column becomes THE setting: renamed, default postpaid, no
-- per-customer override.
--
-- customers.billing_type IS KEPT, UNREAD AND UNWRITTEN. 954 of Ezmze's rows
-- read 'postpaid' from the repair of 2026-09-04
-- (supabase/repairs/2026-09-04_last_billed_date_collision.sql); those values are
-- the record of that repair and stay consultable if something does not
-- reconcile later. The same reason last_bill_date is still there. The code
-- stops writing the column in the same deploy that precedes this file.
--
-- VALUES SET HERE, NOT LATER. Ezmze (27) and JMEDIA (30) are prepaid; every
-- other company is postpaid. Done in the same statement block as the rename so
-- there is no moment at which 1,048 prepaid customers read as postpaid.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'settings'
      AND column_name = 'default_billing_type'
  ) THEN
    ALTER TABLE settings RENAME COLUMN default_billing_type TO billing_type;
  END IF;
END $$;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS billing_type VARCHAR(10);
ALTER TABLE settings ALTER COLUMN billing_type SET DEFAULT 'postpaid';

UPDATE settings
   SET billing_type = CASE WHEN company_id IN (27, 30) THEN 'prepaid' ELSE 'postpaid' END;

ALTER TABLE settings ALTER COLUMN billing_type SET NOT NULL;
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_default_billing_type_check;
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_billing_type_check;
ALTER TABLE settings ADD CONSTRAINT settings_billing_type_check
  CHECK (billing_type IN ('prepaid', 'postpaid'));

COMMENT ON COLUMN settings.billing_type IS
  'The company billing model. postpaid: calendar month, charged on the company bill day while the month runs. prepaid: customer bill date to the same date next month, charged on the bill date, the month ahead. No per-customer override.';

COMMENT ON COLUMN customers.billing_type IS
  'RETIRED by 0024. Not read, not written. Kept because the 2026-09-04 repair left 954 Ezmze values in it that may need consulting. The company model is settings.billing_type.';

-- ---------------------------------------------------------------------------
-- 2. Per-company engine controls.
--
-- billing_engine_mode
--   off       the tick skips the company entirely. THE DEFAULT, so applying
--             this file changes nothing anywhere.
--   dry_run   the tick decides and records what it WOULD charge on the day's
--             bill_runs row (preview), and writes no charge and no balance.
--   live      the tick applies charges through apply_bill_charges().
--
-- billing_engine_start_date
--   A charge date before this is never charged. A company going live on the
--   22nd with a period that was charged by hand on the 20th sets this to the
--   21st and the engine cannot re-charge it. Required once the mode is not
--   off, enforced below.
-- ---------------------------------------------------------------------------
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS billing_engine_mode       VARCHAR(10) NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS billing_engine_start_date DATE;

UPDATE settings SET billing_engine_mode = 'off' WHERE billing_engine_mode IS NULL;

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_billing_engine_mode_check;
ALTER TABLE settings ADD CONSTRAINT settings_billing_engine_mode_check
  CHECK (billing_engine_mode IN ('off', 'dry_run', 'live'));

ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_billing_engine_start_check;
ALTER TABLE settings ADD CONSTRAINT settings_billing_engine_start_check
  CHECK (billing_engine_mode = 'off' OR billing_engine_start_date IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. bill_runs — one row per company per company-local day.
--
-- The ticker fires hourly; the tick upserts the day's row and leaves it alone
-- once it is 'done'. A 'failed' row (radcheck unreachable, say) is retried by
-- the next hour's tick, attempts climbing, until it is done or the day ends.
-- Most days charge nobody and say so: a row of zeros is how the page shows the
-- engine is alive.
--
-- `mode` is the company's mode AT THE TIME. `preview` holds a dry run's
-- would-be charges so a full dry cycle can be read back day by day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bill_runs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),

  -- The company-local calendar date the run is FOR. Never the server's date.
  run_date DATE NOT NULL,

  mode   VARCHAR(10) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'running',

  started_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP WITH TIME ZONE,
  attempts    INT NOT NULL DEFAULT 1,

  -- Counts, in the order the verdict is reached (lib/billing-engine.ts).
  considered           INT NOT NULL DEFAULT 0,
  charged              INT NOT NULL DEFAULT 0,
  total_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit_applied       NUMERIC(12,2) NOT NULL DEFAULT 0,
  skipped_not_due      INT NOT NULL DEFAULT 0,
  skipped_before_start INT NOT NULL DEFAULT 0,
  skipped_joined_after INT NOT NULL DEFAULT 0,
  skipped_zero_rate    INT NOT NULL DEFAULT 0,
  skipped_no_service   INT NOT NULL DEFAULT 0,
  skipped_unprovisioned INT NOT NULL DEFAULT 0,
  -- Reported by apply_bill_charges(): the index refused a duplicate.
  skipped_already      INT NOT NULL DEFAULT 0,

  error   TEXT,
  preview JSONB,

  CONSTRAINT bill_runs_mode_check   CHECK (mode IN ('dry_run', 'live')),
  CONSTRAINT bill_runs_status_check CHECK (status IN ('running', 'done', 'failed')),
  CONSTRAINT bill_runs_company_day_key UNIQUE (company_id, run_date)
);

CREATE INDEX IF NOT EXISTS bill_runs_company_date_idx
  ON bill_runs (company_id, run_date DESC);

-- ---------------------------------------------------------------------------
-- 4. bill_charges — one row per customer per period. THE GUARD.
--
-- period_start / period_end   THE PERIOD CHARGED FOR. Postpaid: first to last
--                             day of the calendar month. Prepaid: the bill
--                             date to the same date next month.
-- charged_on                  The company-local date the charge was applied.
--                             Distinct from the period on purpose: "charged
--                             late" is a real thing to be able to see.
--
-- NEITHER DATE IS AN EXPIRY. Nothing here reads or writes radcheck. Expiries
-- move on payment, nowhere else.
--
-- bill_charges_customer_period_key is what makes "one period per customer,
-- ever" true. It lives in Postgres, not in a WHERE clause: a second tick, a
-- second process, a script or a psql session cannot charge a period twice
-- because the insert fails. apply_bill_charges() treats that failure as
-- "already charged" and moves on.
--
-- Keyed on period_start alone, as 0014 argued: two runs disagreeing about the
-- END of a period must collide, not sit side by side.
--
-- amount is monthly_rate PLUS active add-ons at the moment of the charge — the
-- figure the payment page shows and the cashier collects. Run Bills
-- (app/actions/bulk.ts#billBatch) charges the bare rate; it is the outlier.
--
-- ON CUSTOMER DELETE: app/actions/customers.ts#deleteCustomer clears a
-- customer's dependents by hand before deleting the row, and MUST have
-- bill_charges added to that list in the same deploy, or deleting a billed
-- customer fails on this foreign key. That matches how payments are treated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bill_charges (
  id BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL REFERENCES companies(id),
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  run_id      BIGINT NOT NULL REFERENCES bill_runs(id),

  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  charged_on   DATE NOT NULL,

  amount                 NUMERIC(10,2) NOT NULL,
  credit_applied         NUMERIC(10,2) NOT NULL DEFAULT 0,
  carried_balance_before NUMERIC(10,2) NOT NULL,
  carried_balance_after  NUMERIC(10,2) NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT bill_charges_period_order_check CHECK (period_end > period_start),
  CONSTRAINT bill_charges_amount_check       CHECK (amount >= 0),
  CONSTRAINT bill_charges_credit_check       CHECK (credit_applied >= 0 AND credit_applied <= amount)
);

CREATE UNIQUE INDEX IF NOT EXISTS bill_charges_customer_period_key
  ON bill_charges (customer_id, period_start);

CREATE INDEX IF NOT EXISTS bill_charges_run_idx
  ON bill_charges (run_id);

CREATE INDEX IF NOT EXISTS bill_charges_company_period_idx
  ON bill_charges (company_id, period_start);

-- ---------------------------------------------------------------------------
-- RLS. Same shape as 0014 proposed for bills: a signed-in user may READ their
-- own company's rows. No insert/update/delete policy for `authenticated` — the
-- engine writes through the service role, which bypasses RLS, and nothing else
-- may write here.
-- ---------------------------------------------------------------------------
ALTER TABLE bill_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_charges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bill_runs_company_select ON bill_runs;
CREATE POLICY bill_runs_company_select
  ON bill_runs FOR SELECT TO authenticated
  USING (company_id = current_company_id());

DROP POLICY IF EXISTS bill_charges_company_select ON bill_charges;
CREATE POLICY bill_charges_company_select
  ON bill_charges FOR SELECT TO authenticated
  USING (company_id = current_company_id());

-- ---------------------------------------------------------------------------
-- 5. The system identity.
--
-- lib/audit.ts#logEvent files every row under the signed-in user. A tick has
-- no signed-in user, so the engine gets ONE `users` row of its own. It has no
-- Supabase auth account, so it cannot sign in; role 'technician' is the
-- narrowest the role check allows; it is filed under the platform owner's
-- company because users.company_id is NOT NULL and that is the one company
-- that is not a tenant. It will appear in that company's staff list, named
-- for what it is.
--
-- The code finds it by this email (lib/audit.ts#SYSTEM_BILLING_EMAIL) and
-- refuses to run the engine if the row is missing.
-- ---------------------------------------------------------------------------
INSERT INTO users (company_id, first_name, last_name, email, role, is_super_admin)
SELECT
  (SELECT company_id FROM users WHERE is_super_admin = TRUE ORDER BY id LIMIT 1),
  'Billing', 'Engine', 'billing-engine@system.ispman', 'technician', FALSE
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'billing-engine@system.ispman');

-- ---------------------------------------------------------------------------
-- 6. apply_bill_charges() — THE PROJECT'S FIRST WRITING FUNCTION.
--
-- One call applies one company's charges for one run, atomically. A function
-- call is one transaction: either every insert and every balance in the list
-- lands, or none does.
--
-- WHAT IT DOES NOT DO. No period arithmetic, no eligibility, no service check.
-- The TypeScript side (lib/billing-engine.ts) decided the list; the same code
-- shows the preview on the Billing Runs page, so the shapes exist once. This
-- function only APPLIES.
--
-- WHAT IT DOES, per element of p_charges [{customer_id, period_start,
-- period_end, amount}]:
--   1. locks the customer row (FOR UPDATE), scoped to p_company_id;
--   2. inserts the bill_charges row, ON CONFLICT (customer_id, period_start)
--      DO NOTHING — the unique index is the guard;
--   3. ONLY IF THE INSERT HAPPENED: draws account_credit down first (a
--      prepayment is spent before anything is owed, exactly as
--      lib/billing.ts#applyCredit does for Run Bills), adds the remainder to
--      carried_balance, and has stamped before/after on the charge row.
--   4. counts it.
--
-- The customer's balance and credit are READ INSIDE THE LOCK, never taken from
-- the caller: the list may be minutes old. The amount IS taken from the caller,
-- because rate-plus-add-ons is defined in one place in TypeScript and this
-- function must not grow a second definition of it.
--
-- Returns {inserted, already_charged, missing, total_amount, credit_applied}.
-- `missing` counts ids that were not this company's customers; they are
-- skipped, not an error, so one deleted customer cannot roll back a company.
--
-- SECURITY INVOKER, and EXECUTE granted to service_role only: the app calls it
-- through the admin client and nobody else can call it at all.
-- ---------------------------------------------------------------------------
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
    v_charge_id := NULL;

    IF v_customer IS NULL OR v_start IS NULL OR v_end IS NULL THEN
      RAISE EXCEPTION 'malformed charge element: %', c;
    END IF;
    IF v_amount IS NULL OR v_amount < 0 THEN
      RAISE EXCEPTION 'charge for customer % has amount %', v_customer, v_amount;
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
      amount, credit_applied, carried_balance_before, carried_balance_after
    )
    VALUES (
      p_company_id, v_customer, p_run_id, v_start, v_end, p_charged_on,
      v_amount, v_drawn, v_carried, v_after
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
--
--   SELECT company_id, billing_type, billing_engine_mode, billing_engine_start_date
--     FROM settings ORDER BY company_id;             -- 27 and 30 prepaid, all 'off'
--   SELECT * FROM bill_runs LIMIT 1;                  -- exists, empty
--   SELECT * FROM bill_charges LIMIT 1;               -- exists, empty
--   SELECT id, email, role, company_id FROM users WHERE email = 'billing-engine@system.ispman';
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'apply_bill_charges';  -- one row, prosecdef false
