-- ISPMan: the "Due by" choice from 0073, put the way ISPs here bill.
--
-- The owner's model (27 Nov 2026): a month's service is due on the 1st and
-- runs to the last day of that month; the days after it, up to the cut-off
-- day (the 5th at West Central, the 8th at Ezmze), are grace, and the
-- customer's service date already includes them. So the due date is the 1st
-- of the month the service date falls in, whatever the bill day. 0073 called
-- this 'bill_day', which is only the same thing for a company billing on the
-- 1st.

ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_bill_due_on_check;
UPDATE public.settings SET bill_due_on = 'month_start' WHERE bill_due_on = 'bill_day';
ALTER TABLE public.settings
  ADD CONSTRAINT settings_bill_due_on_check CHECK (bill_due_on IN ('service_end', 'month_start'));

-- West Central Networks, as the owner asked: due the 1st, grace to the 5th.
UPDATE public.settings SET bill_due_on = 'month_start' WHERE company_id = 26;
