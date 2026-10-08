-- ISPMan: drop the calendar-month prepaid switch.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR, AFTER the code that no longer reads the
-- column is deployed. Run before it, the old code's read of the switch fails
-- with 42703, which it treats as "model off" — safe, but the model would then
-- be off for Ezmze until the deploy lands.
--
-- WHY (owner, 8 Oct 2026): "The model is simply how prepaid works now." There
-- is no switch. Calendar-month prepaid applies to every prepaid company whose
-- billing engine is live (lib/data/prepaid-calendar.ts#prepaidCalendarFor).
-- Everything else 0028 added stays: the reconnection fee, service_ended_on,
-- the bill_charges columns, payments.service_breakdown and set_month_charge().

ALTER TABLE public.settings DROP COLUMN IF EXISTS prepaid_calendar_enabled;

-- Verify afterwards:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'settings'
--      AND column_name = 'prepaid_calendar_enabled';
--     -> no rows
