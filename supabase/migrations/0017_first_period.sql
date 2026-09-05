-- ISPMan: per-company switches for the two first-period rules.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. lib/schema.ts#firstPeriod probes for ALL THREE columns below
-- — the two switches on `settings` and the two payments columns — and any one
-- of them missing disables the lot, so a half-applied 0017 cannot price a first
-- period without stamping what was due.
--
-- Until then the app behaves EXACTLY as it does today: the 21-day rule on (it
-- is unconditional in the current code), pro-rata off (it does not exist yet).
-- That asymmetry is deliberate — see the fallback note in lib/schema.ts.
--
-- READ THIS BEFORE APPLYING
-- Both columns default TRUE, so applying this migration TURNS PRO-RATA ON FOR
-- EVERY COMPANY AT ONCE. That is a change to what customers are charged for
-- their first payment, not a display change. If you would rather it be opt-in,
-- change the DEFAULT on prorata_first_payment_enabled to FALSE below BEFORE
-- running this — it is one word, and it is much easier than switching it back
-- off per company afterwards.
--
-- The 21-day rule's default of TRUE is different in kind: it preserves the
-- behaviour that is already live, so it changes nothing on apply.

-- ---------------------------------------------------------------------------
-- settings.first_expiry_rule_enabled — CHANGE A, the 21-day rule.
--
-- The rule itself already exists and is not being rebuilt: lib/expiry.ts
-- #firstExpiry, reached through lib/radius/operations.ts#provisionExpiry. A
-- customer's first expiry is the first cut-off day at least 21 days out, so
-- somebody switched on four days before their cut-off gets a short month plus
-- a full one rather than a stub they paid a full month for.
--
-- 21 IS FIXED IN CODE AND IS NOT A SETTING. It is the boundary between "a
-- period worth billing" and "a stub", not a company preference, and exposing it
-- would invite a tenant to set it to 3 and quietly recreate the problem the
-- rule exists to solve.
--
-- Switched OFF, a first provision walks to the plain next cut-off day, which is
-- what a reconnection does (lib/radius/operations.ts#reconnectExpiry).
--
-- PROVISIONING ONLY, either way. Renewals and reconnections never consult this.
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS first_expiry_rule_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ---------------------------------------------------------------------------
-- settings.prorata_first_payment_enabled — CHANGE B, pro-rata first payment.
--
-- daily = monthly_charge / 30
-- first payment = monthly_charge + (days beyond 30 x daily)
--
-- where `days` is the length of the first period: provisioning date to the
-- expiry that provisioning wrote. A customer connected on the 20th with a
-- cut-off of the 5th is buying 46 days and is charged for 46 days.
--
-- NEVER LESS THAN THE MONTHLY CHARGE. A first period SHORTER than 30 days is
-- charged the full rate; the difference is offered to the cashier as a discount
-- they may apply, and is never applied automatically. Any role may apply it,
-- and doing so writes a `first_period_discount` log row naming the agent — a
-- discretionary reduction in money owed is exactly the kind of decision that
-- has to be attributable afterwards.
--
-- 30 IS A DIVISOR, NOT A CALENDAR MONTH. The daily rate is the monthly charge
-- over 30 regardless of how long the actual month is, which is what makes the
-- arithmetic checkable at the counter with a phone calculator. Do not "fix"
-- this to use the real month length.
--
-- INDEPENDENT OF CHANGE A. Either may be on with the other off. With A off and
-- B on a first period can only ever be shorter than a month, so B degrades to
-- "full rate, discount offered" — which is coherent, and is why they are two
-- columns rather than one mode.
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS prorata_first_payment_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ---------------------------------------------------------------------------
-- payments.amount_due — what the customer was asked to settle.
--
-- THE RECEIPT RESTATES, IT DOES NOT RECOMPUTE. The printed receipt used to add
-- a "Monthly service" line to "Balance b/f" and total the two, which double
-- counted: the bill run puts the monthly charge INTO carried_balance
-- (app/actions/bulk.ts#billBatch), so the two were the same money printed
-- twice. The fix prints from what the payment stamped, and this is the field it
-- prints as "Balance due".
--
-- WHY NOT JUST carried_balance_before. For every payment that exists today
-- these are the same number, and if pro-rata never shipped this column would be
-- redundant. It is not, because a FIRST PERIOD is a charge that carried_balance
-- has never held: provisioning grants access to the end of that period without
-- billing it, and the bill run only charges periods that have closed. At the
-- first payment carried_balance_before reads 0 while the customer genuinely
-- owes for the days they are already using. A receipt printing
-- carried_balance_before would show "Balance due 0.00" against a payment of
-- 5,367.
--
-- So this is the amount due INCLUDING anything not in the carried balance, and
-- the receipt has one unconditional rule instead of a sum it has to know how to
-- assemble. Assembling it at print time is exactly the mistake being fixed.
--
-- NET OF ANY DISCOUNT, because that is what the customer was actually asked
-- for, and because it keeps the useful invariant: amount_due minus amount is
-- the change in the carried balance. A gross figure would not satisfy that.
-- The discount itself is stamped alongside it, below.
--
-- DELIBERATELY NOT A COPY OF carried_balance_before FOR REVERSALS. Nothing in
-- app/actions/payments.ts#updatePayment or #deletePayment reads this. Those
-- restate the carried balance from carried_balance_before/_after, which still
-- mean exactly what they meant before this column existed.
--
-- NULL means the payment predates this migration, or is an "other" payment,
-- which settles itself and has no balance to state. The receipt falls back to
-- carried_balance_before for the first case and prints its own category line
-- for the second, so neither needs backfilling — and neither could be
-- backfilled honestly.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS amount_due NUMERIC(10,2);

-- An amount owed is never negative. The carried balance carries its own >= 0
-- check (0011), a first-period charge is never below zero (the discount is
-- capped at the monthly rate by construction — see lib/billing.ts
-- #firstPeriodDiscount), so their sum cannot be either.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_amount_due_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_amount_due_check
  CHECK (amount_due IS NULL OR amount_due >= 0);

-- ---------------------------------------------------------------------------
-- payments.first_period_discount — the reduction a cashier chose to give.
--
-- SO THE RECEIPT CAN SHOW IT. A customer handed a receipt reading "Balance due
-- 3,033" cannot tell they were given anything, and neither can anyone going
-- through the paper afterwards. The log row (type first_period_discount) names
-- the agent and the figures, but nobody holding the receipt is reading the log.
--
-- WITH THIS, THE RECEIPT RESTATES BOTH ENDS instead of one:
--
--     Balance due             3,500.00   <- amount_due + this
--     Short period disc.       -467.00   <- this
--                            ---------
--     Total due               3,033.00   <- amount_due
--
-- The one addition is over two stamped numbers, not over a rate or a live
-- column, so a reprint years later prints what was agreed at the counter.
-- "Total due" comes back for this case ONLY: it was dropped from the service
-- receipt because a total over a single line restated it, which is not true
-- when there are two.
--
-- ZERO IS WRITTEN, NOT NULL, for every payment once this migration is applied —
-- the same reasoning as payments.credit_applied in 0015. A stamped 0 says "no
-- discount was given"; NULL says "this predates the column and nobody knows".
-- The receipt prints neither, but a later report can tell them apart.
--
-- NAMED FOR WHAT IT IS. The only discount this app has is the one on a short
-- first period (lib/billing.ts#firstPeriodDiscount). A general `discount`
-- column would promise a feature that does not exist and invite a second,
-- unrelated writer.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS first_period_discount NUMERIC(10,2);

-- A discount is a reduction, so it is recorded as a positive amount and
-- SUBTRACTED at the point of use. It can never exceed the monthly rate: it is
-- (30 - days) x rate/30 with days capped at 0 below.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_first_period_discount_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_first_period_discount_check
  CHECK (first_period_discount IS NULL OR first_period_discount >= 0);

-- ---------------------------------------------------------------------------
-- NO SCHEMA IS ADDED FOR "HAS THIS CUSTOMER PAID SINCE PROVISIONING"
--
-- Deliberately no activated_at column. The provisioning moment is already
-- recorded: app/actions/customers.ts#provisionCustomer writes a
-- `network_provision` row into `log` with the customer id and a timestamp, and
-- lib/data/first-period.ts reads it back. Adding a column would make a second
-- copy of a fact the log already holds, and the two would drift the first time
-- one was written without the other.
--
-- The three conditions are in lib/data/first-period.ts. The one worth repeating
-- here is why the ~1,285 migrated West Central and Ezmze subscribers can never
-- be caught by this: scripts/migrate-legacy-company.mjs writes NO log rows at
-- all, and bulk provisioning writes ONE `bulk_provision` row with a null
-- customer id (app/actions/bulk.ts#logBulkProvision) rather than one
-- `network_provision` row per customer. Neither produces the anchor, so neither
-- can produce a first period.
--
-- The consequence, accepted knowingly: a genuinely new customer who is BULK
-- provisioned gets no pro-rata either. Bulk provision means "these already have
-- service" in this codebase — the same reasoning already stops it applying the
-- 21-day rule (app/actions/bulk.ts#expiryForCustomer).
-- ---------------------------------------------------------------------------
