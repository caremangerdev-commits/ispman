-- ISPMan: the anniversary expiry rule, per customer.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- Until it is applied every customer renews exactly as before (see
-- lib/schema.ts#anniversaryExpiry): the customer record shows the company rule
-- and offers no choice. Deploy order: code, then this file. Either is safe.
--
-- ---------------------------------------------------------------------------
-- THE RULE (lib/billing.ts#anniversaryExpiry is the one definition)
-- ---------------------------------------------------------------------------
--   'company'      What the company does today, unchanged: the walk to the
--                  customer's cut-off day, or the calendar-month landing when
--                  the prepaid model counts the payment.
--
--   'anniversary'  The same day of the following month as the payment.
--                  Pay on the 17th, run to the 17th next month.
--
--     * STILL ACTIVE: extend from the existing expiry, never from the payment
--       date, so paying early loses nothing. Holds 17 Nov, pays 10 Nov ->
--       17 Dec.
--     * ALREADY CUT OFF (or never connected): extend from the payment date,
--       which becomes the new anniversary. Cut off 5 Nov, pays 11 Nov ->
--       11 Dec.
--     * MONTH END: a day the next month does not have is clamped to its last
--       day — paid 31 Jan -> 28 Feb (29 in a leap year). The 31st is kept in
--       anniversary_day, so the month after goes back to 31 Mar rather than
--       drifting to the 28th for good.
--     * Several months paid at once move the whole distance at once.
--
-- CHANGING THE RULE NEVER MOVES AN EXPIRY. Switching a customer writes
-- expiry_rule and nothing else; the next payment is the first one the new rule
-- applies to. Till and online (gateway) payments are the same code path
-- (lib/payments/service-payment.ts#recordServicePayment), so they cannot
-- disagree.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS expiry_rule TEXT NOT NULL DEFAULT 'company',
  -- The day of the month the anniversary falls on, 1-31. Written by an
  -- anniversary payment; NULL until the first one. Only consulted to undo a
  -- month-end clamp (see above) — an expiry that is not the last day of its
  -- month always renews on its own day, so a manual correction to the 5th
  -- makes the 5th the anniversary.
  ADD COLUMN IF NOT EXISTS anniversary_day SMALLINT;

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_expiry_rule_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_expiry_rule_check
  CHECK (expiry_rule IN ('company', 'anniversary'));

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_anniversary_day_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_anniversary_day_check
  CHECK (anniversary_day IS NULL OR anniversary_day BETWEEN 1 AND 31);
