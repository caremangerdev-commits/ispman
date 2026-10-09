-- ISPMan: what a payment did to the expiry, so deleting it can put it back.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe before or after the code: the code
-- probes for these columns (lib/schema.ts, `paymentExpiry`) and, without them,
-- finds a payment's expiry change from its RADIUS log row instead.
--
-- WHY (owner, 9 Oct 2026). Deleting a payment restored the balance and left the
-- expiry where the payment had moved it. Re-entering the payment then counted
-- forward from it: one month's money, two months' access (Janel Dixion, Janice
-- Dennis, Orrett Daley, Britolia Dawkins). A deleted payment never happened, so
-- deleting it now puts the expiry back — which needs to know what it was.
--
-- WHAT THIS ADDS: the radcheck Expiration values the till's write replaced and
-- wrote, as stored (RADIUS clock text, "07 Nov 2026 13:00"). Both NULL when the
-- payment did not move the expiry. Written only by the till, on a write that
-- succeeded; never backfilled — older payments fall back to the log.

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS expiry_before TEXT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS expiry_after TEXT;

-- Verify afterwards:
--   SELECT expiry_before, expiry_after FROM payments LIMIT 1;   -> both columns exist
