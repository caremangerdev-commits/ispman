-- ISPMan: which date a bill gives as "Due by".
--
--   service_end  the day the customer's service runs out (what every bill has
--                printed until now): pay by then or be cut off.
--   bill_day     the company's bill day: the bill is due the day it is made,
--                and the customer keeps service until the cut-off as before.
--
-- Ezmze bills on the 1st and wants the 1st on the bill, not the 8th its
-- service dates run to (27 Nov 2026). Everyone else keeps what they had.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS bill_due_on TEXT NOT NULL DEFAULT 'service_end';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settings_bill_due_on_check') THEN
    ALTER TABLE public.settings
      ADD CONSTRAINT settings_bill_due_on_check CHECK (bill_due_on IN ('service_end', 'bill_day'));
  END IF;
END $$;

-- Ezmze Company Ltd., as asked.
UPDATE public.settings SET bill_due_on = 'bill_day' WHERE company_id = 27;
