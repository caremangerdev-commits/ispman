-- ISPMan: the time of day a company's expiries are written at.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe to run before or after the code
-- that reads it: lib/data/company.ts#getExpiryTime treats a missing column as
-- '00:00', which is what every company has always had.
--
-- WHAT THIS DOES. radcheck holds wall-clock text with no zone ("08 Oct 2026
-- 00:00") and FreeRADIUS reads it on the NAS box's clock, which is UTC. Midnight
-- is therefore 7:00 PM the evening before in Jamaica. A company can now choose
-- the time its expiries land on. The value is the RADIUS machine's own clock,
-- not the company's: 8:00 AM Jamaica (UTC-5, no daylight saving) is '13:00'.
--
-- WHAT IT DOES NOT DO. It moves no existing expiry. A company that never sets it
-- keeps '00:00' and nothing changes for it. Moving Ezmze's live expiries onto
-- 13:00 is scripts/ezmze-expiry-time.mjs, run separately and after this.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS expiry_time text NOT NULL DEFAULT '00:00';

-- 24-hour HH:MM, so a typo cannot reach the code that parses it.
ALTER TABLE public.settings
  DROP CONSTRAINT IF EXISTS settings_expiry_time_check;
ALTER TABLE public.settings
  ADD CONSTRAINT settings_expiry_time_check
  CHECK (expiry_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- Ezmze (company 27): access ends at 8:00 AM Jamaica time = 13:00 on the RADIUS clock.
UPDATE public.settings SET expiry_time = '13:00' WHERE company_id = 27;

-- ---------------------------------------------------------------------------
-- Verify afterwards. Expected results in comments.
-- ---------------------------------------------------------------------------
--   SELECT company_id, expiry_time FROM settings WHERE expiry_time <> '00:00';
--     -> one row: 27 | 13:00
--
--   SELECT count(*) FROM settings WHERE expiry_time = '00:00';
--     -> every other company
