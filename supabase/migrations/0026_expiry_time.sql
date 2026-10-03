-- ISPMan: the time of day a company's access ends on its expiry day.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe to run before or after the code
-- that reads it: lib/data/company.ts#getExpiryClock treats a missing column as
-- "no setting", and the app then writes midnight as it always did.
--
-- WHAT THIS DOES. radcheck holds wall-clock text with no zone ("08 Oct 2026
-- 00:00") and FreeRADIUS reads it on the NAS box's clock, which is UTC. Midnight
-- is therefore 7:00 PM the evening before in Jamaica. This column is the time of
-- day access ends, on the COMPANY'S OWN clock (settings.timezone). The app
-- converts it for radcheck: 08:00 in America/Jamaica (UTC-5, no daylight saving)
-- is written 13:00. A company in another zone gets its own hour, worked out per
-- date, so the setting stays right if a company's zone or daylight saving differ.
--
-- DEFAULT 08:00, FOR EVERY COMPANY. That is the owner's decision (2026-10-03):
-- all companies end at 8:00 AM local on the cut-off day.
--
-- WHAT IT DOES NOT DO. It moves no existing expiry. Existing expiries move with
-- scripts/expiry-time-all-companies.mjs, run separately and after this.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS expiry_time text NOT NULL DEFAULT '08:00';

-- 24-hour HH:MM, so a typo cannot reach the code that parses it.
ALTER TABLE public.settings
  DROP CONSTRAINT IF EXISTS settings_expiry_time_check;
ALTER TABLE public.settings
  ADD CONSTRAINT settings_expiry_time_check
  CHECK (expiry_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- ---------------------------------------------------------------------------
-- Verify afterwards. Expected results in comments.
-- ---------------------------------------------------------------------------
--   SELECT company_id, expiry_time, timezone FROM settings ORDER BY company_id;
--     -> every row 08:00 (all ten companies are America/Jamaica today)
