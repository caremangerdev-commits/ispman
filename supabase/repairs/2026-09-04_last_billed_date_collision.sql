-- ===========================================================================
-- REPAIR: last_billed_date overwritten by the payment path — company 27
--
-- CAUSE
--   app/actions/payments.ts wrote `last_billed_date = <payment date>` on every
--   postpaid payment, overwriting the period-end stamp Bill All had written.
--   app/actions/bulk.ts#billedInPeriod reads that value as "already billed for
--   the month it falls in", so the 1 October run would have skipped all 71 of
--   these customers: a month of service with no bill raised.
--
--   The code no longer writes the column at all — only billBatch does. This
--   script repairs the rows the old code already damaged.
--
-- RUN THIS BY HAND IN THE SUPABASE SQL EDITOR. Nothing applies it for you, and
-- it deliberately does NOT live in supabase/migrations/ — it is a one-off data
-- repair scoped to a single company, not a schema change.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- STEP 1 — DIAGNOSE. Read-only. Run this first and read the answer.
--
-- The repair value below depends on WHICH PERIOD the run actually billed, and
-- that cannot be inferred from the damaged rows: the payment date overwrote the
-- only evidence they held. These two queries settle it.
-- ---------------------------------------------------------------------------

-- 1a. The bill run logs its own period. This is the decisive record — the
--     details string spells out both the period and the stamp it wrote, e.g.
--     "Bulk bill for August 2026: ... Last billed date set to 2026-08-31".
select created_at, details
from   log
where  company_id = 27
  and  type = 'bulk_bill'
order  by created_at desc
limit  5;

-- 1b. Corroboration: what postpaid customers who did NOT pay on 2026-09-03 are
--     still holding. Those rows were never touched by the payment path, so they
--     still carry the stamp the bill run wrote.
select last_billed_date, count(*) as customers
from   customers
where  company_id = 27
  and  billing_type = 'postpaid'
group  by last_billed_date
order  by last_billed_date;


-- ---------------------------------------------------------------------------
-- STEP 2 — PREVIEW. Read-only. Confirm the count is 71 before writing.
--
-- `last_billed_date = 2026-09-03` is provably payment residue: resolvePeriod()
-- builds every period end as the LAST DAY OF A MONTH, so Bill All cannot ever
-- have written the 3rd. Nothing legitimate is caught by this predicate.
-- ---------------------------------------------------------------------------
select count(*) as rows_to_repair
from   customers
where  company_id = 27
  and  billing_type = 'postpaid'
  and  last_billed_date = date '2026-09-03';


-- ---------------------------------------------------------------------------
-- STEP 3 — REPAIR.
--
-- >>> SET THIS TO WHAT STEP 1 TOLD YOU. <<<
--   date '2026-09-30'  — the run billed SEPTEMBER 2026   (as briefed)
--   date '2026-08-31'  — the run billed AUGUST 2026      (what bill_date = 1
--                        in arrears implies: a run on 1 Sep bills the month
--                        that just ended)
--
-- Getting this backwards is not cosmetic. Stamping 2026-09-30 on customers who
-- were really billed for August makes the 1 October run skip them for September
-- — the exact failure this repair exists to prevent. Stamping 2026-08-31 on
-- customers really billed for September double-bills them.
--
-- RETURNING prints every row it touched, so the write is its own receipt.
-- Re-running is a no-op: the WHERE clause no longer matches once it has run.
-- ---------------------------------------------------------------------------
update customers
set    last_billed_date = date '2026-09-30'   -- <<< the value from STEP 1
where  company_id = 27
  and  billing_type = 'postpaid'
  and  last_billed_date = date '2026-09-03'
returning id, first_name, last_name, last_billed_date;


-- ---------------------------------------------------------------------------
-- STEP 4 — VERIFY. Expect zero rows.
-- ---------------------------------------------------------------------------
select count(*) as residue_remaining
from   customers
where  company_id = 27
  and  billing_type = 'postpaid'
  and  last_billed_date = date '2026-09-03';
