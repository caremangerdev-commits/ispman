--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- Safe before or after the deploy, and changes nothing on its own: the share
-- defaults to 0, which is exactly what every company does today — the operator
-- absorbs the whole card fee and the customer pays their bill and nothing more.
--
-- WHAT THIS IS FOR
-- JMEDIA asked to split the card processing fee with the customer, with the
-- customer agreeing before they pay. This stores the two numbers that takes,
-- and records what actually happened on each payment.
--
-- BEFORE ANY COMPANY TURNS IT ON: passing a card fee to the customer is a
-- surcharge. Dime's own Fee Saver calculator assumes merchants do it, but
-- Mastercard has said publicly in Jamaica that merchants are wrong to make
-- customers pay more for using a card, and acquiring agreements commonly ban
-- it outright. That is the operator's decision to take with their acquirer and
-- their lawyer, in writing. The platform stores a number; it does not bless it.
-- Hence the default of 0 and the hard requirement for a recorded agreement
-- before a surcharge can be charged at all (lib/payments/surcharge.ts).

-- ---------------------------------------------------------------------------
-- 1a. payment_gateways — THE RATE, because a rate belongs to an agreement.
--
-- Fygaro's terms are not Dime's. Putting one rate on the company would mean a
-- tenant who switches gateway keeps charging against the old provider's
-- numbers, which is wrong in a way nobody would notice until they reconciled
-- a bank statement. The rate travels with the keys it belongs to, and because
-- only one gateway is enabled at a time the live rate is never ambiguous.
--
-- WHY IT HAS TO BE STORED AT ALL. A surcharge is worked out BEFORE the
-- customer pays; the gateway only reports its fee afterwards, on the settled
-- transaction. So the operator enters it from their own agreement. NULL means
-- "not known", which means no surcharge is possible — the platform will not
-- guess a rate and charge a customer against the guess.
--
-- A GATEWAY FEE IS PERCENTAGE *AND* FIXED, and the fixed part is the one that
-- bites. Dime's published online rate is 3.7% + JMD 45.53 per transaction. On
-- a J$1,900 bill that fixed piece is another 2.4%; on a J$500 part-payment it
-- is 9%, and on a J$200 top-up it is nearly 23%. A percentage-only model would
-- under-charge the surcharge on every small payment and leave the operator
-- carrying a share they never agreed to — and these customers part-pay
-- constantly.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_gateways
  ADD COLUMN IF NOT EXISTS fee_rate NUMERIC(5, 3),
  ADD COLUMN IF NOT EXISTS fee_fixed NUMERIC(10, 2);

ALTER TABLE public.payment_gateways DROP CONSTRAINT IF EXISTS payment_gateways_fee_rate_check;
ALTER TABLE public.payment_gateways ADD CONSTRAINT payment_gateways_fee_rate_check
  CHECK (fee_rate IS NULL OR (fee_rate >= 0 AND fee_rate <= 20));

ALTER TABLE public.payment_gateways DROP CONSTRAINT IF EXISTS payment_gateways_fee_fixed_check;
ALTER TABLE public.payment_gateways ADD CONSTRAINT payment_gateways_fee_fixed_check
  CHECK (fee_fixed IS NULL OR (fee_fixed >= 0 AND fee_fixed <= 10000));

COMMENT ON COLUMN public.payment_gateways.fee_rate IS
  'This gateway''s percentage fee for this company, as its own agreement states it (Dime''s published online rate is 3.700). NULL = not known, and no surcharge can be charged. Capped at 20 so a typo cannot invent a punitive fee.';

COMMENT ON COLUMN public.payment_gateways.fee_fixed IS
  'This gateway''s fixed fee per transaction, in the company''s currency (Dime adds JMD 45.53 online). NULL reads as zero. This is the part that makes small part-payments expensive.';

-- ---------------------------------------------------------------------------
-- 1b. settings — THE SHARE, because that is policy, not an agreement.
--
-- "We pass half the card cost on" is a decision about customers, and it should
-- survive switching gateway rather than needing re-entering against whichever
-- provider happens to be live.
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS card_fee_customer_share INTEGER NOT NULL DEFAULT 0;

UPDATE public.settings SET card_fee_customer_share = 0 WHERE card_fee_customer_share IS NULL;

ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_card_fee_share_check;
ALTER TABLE public.settings ADD CONSTRAINT settings_card_fee_share_check
  CHECK (card_fee_customer_share >= 0 AND card_fee_customer_share <= 100);

COMMENT ON COLUMN public.settings.card_fee_customer_share IS
  'How much of the card fee the CUSTOMER pays, 0-100, whichever gateway is live. 0 = the operator absorbs all of it, which is what every company did before this column existed. 50 = split evenly. 100 = the customer carries the whole fee.';

-- ---------------------------------------------------------------------------
-- 2. gateway_payments — what the money actually did.
--
-- Three numbers, because without them nobody can reconcile a bank statement:
--   amount     what the customer was charged (already there)
--   surcharge  how much of that was the customer's share of the fee
--   fee        what the gateway actually took, as it reported it
--
-- The customer's service is bought with amount - surcharge. The operator's
-- bank receives amount - fee. Those are different numbers and both matter.
--
-- consented_at records WHEN the customer agreed to the surcharge. It exists so
-- the operator can show what was agreed and when, which is the whole point of
-- asking. No surcharge is charged without it.
-- ---------------------------------------------------------------------------
ALTER TABLE public.gateway_payments
  ADD COLUMN IF NOT EXISTS fee NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS surcharge NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ;

COMMENT ON COLUMN public.gateway_payments.fee IS
  'What the gateway took, as the gateway itself reported it. NOT a figure we worked out. NULL when the gateway did not say.';

COMMENT ON COLUMN public.gateway_payments.surcharge IS
  'How much of `amount` was the customer''s agreed share of the card fee. The customer''s account is credited amount - surcharge. NULL or 0 when the operator absorbed the whole fee.';

COMMENT ON COLUMN public.gateway_payments.consented_at IS
  'When the customer agreed to pay a share of the card fee, from the portal. NULL when no surcharge applied.';
