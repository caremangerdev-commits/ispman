-- ISPMan: the connection month — a per-company setting — and each customer's
-- connection day.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe before or after the code: the code
-- probes for these columns (lib/schema.ts, `connectionMonth`) and, without
-- them, keeps doing exactly what it did before.
--
-- THE SETTING (owner, 11 Oct 2026). settings.charge_connection_month, prepaid
-- and postpaid alike:
--   ON   a customer connected mid-month is charged for the connection month,
--        connection day to month end, at the daily rate (rounded to the
--        nearest hundred). Prepaid charges it at Provision; postpaid on the
--        next bill day.
--   OFF  no charge for the connection month; they start on the 1st of the
--        following month.
-- OFF for every company until each owner says — EXCEPT:
--   Ezmze (27), whose Provision already charges the connection month: the
--   owner does not want it changing silently at a live company.
--   West Central (26), Vernon (31), Smartcomm Bogue (32): ON (owner, 11 Oct
--   2026 — "80 customers paying nothing for October is not what I want").
--   Each of the three gets a connection_month_changed log row, as the
--   Settings page writes, under the super admin.
--
-- THE CONNECTION DAY. customers.connected_on: the day the customer was first
-- provisioned, in the company's own zone. The engine counts a customer as
-- joined on it rather than on the day the record was created — a record made
-- on 20 Sep and connected on 5 Oct joined on 5 Oct. Written by Provision from
-- now on; filled here for existing customers from their earliest
-- network_provision log row. NULL for customers never provisioned in ISPMan
-- (moved over from a legacy system already on the network): the engine falls
-- back to date_added for them, as before.
--
-- AND NULL FOR A MIGRATED CUSTOMER WHO WAS PROVISIONED HERE: that was a new
-- device, not a new connection. 23 customers at the three postpaid companies
-- on the books for months or years — Denvil Anderson (Vernon, since 2023),
-- Patricia Salmon (West Central, since 2025) — were first provisioned in
-- ISPMan in October, and would otherwise be counted as connected then and
-- billed October from that day, or not at all with the setting off. Told
-- apart as scripts/fill-bill-date-from-legacy.mjs does: a migrated row keeps
-- its LEGACY signup date, before the day the record was made; an app-made
-- row's date_added is the day it was made (a day's slack for the zone).
-- Compared as text so a blank date_added cannot abort the migration. Every
-- Ezmze customer provisioned here is app-made, so its backfill is unchanged.
-- Provision applies the same test (app/actions/customers.ts#recordConnectionDay).

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS charge_connection_month BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.settings SET charge_connection_month = TRUE WHERE company_id IN (26, 27, 31, 32);

INSERT INTO public.log (company_id, user_id, type, details)
SELECT s.company_id, u.id, 'connection_month_changed',
       'Connection month CHARGED from now: a customer connected partway through a month is charged from the connection day to month end' ||
       ' | by=' || u.email || ' | reason=owner, 11 Oct 2026 (migration 0032) | via=super_admin:#' || u.id
  FROM public.settings s
  CROSS JOIN public.users u
 WHERE s.company_id IN (26, 31, 32)
   AND u.email = 'superadmin@ispman.com'
   AND NOT EXISTS (
         SELECT 1 FROM public.log l
          WHERE l.company_id = s.company_id AND l.type = 'connection_month_changed');

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS connected_on DATE;

UPDATE public.customers c
   SET connected_on = first.day
  FROM (
    SELECT l.customer_id,
           (MIN(l.created_at) AT TIME ZONE COALESCE(MAX(s.timezone), 'America/Jamaica'))::date AS day
      FROM public.log l
      LEFT JOIN public.settings s ON s.company_id = l.company_id
     WHERE l.type = 'network_provision'
       AND l.customer_id IS NOT NULL
     GROUP BY l.customer_id
  ) AS first
 WHERE c.id = first.customer_id
   AND c.connected_on IS NULL
   AND NOT (
         COALESCE(c.date_added::text, '') <> ''
     AND left(c.date_added::text, 10) < to_char((c.created_at AT TIME ZONE 'UTC')::date - 1, 'YYYY-MM-DD')
   );

-- Verify afterwards:
--   SELECT company_id, charge_connection_month FROM settings ORDER BY company_id;
--     -> true for 26, 27, 31, 32 only
--   SELECT company_id, details FROM log WHERE type = 'connection_month_changed' ORDER BY company_id;
--     -> one row each for 26, 31, 32
--   SELECT id, connected_on FROM customers WHERE id IN (2189, 1949);
--     -> both NULL (migrated; first provisioned here on 1 Oct)
--   SELECT count(*) FILTER (WHERE connected_on IS NOT NULL), count(*) FROM customers;
--   SELECT id, date_added, connected_on FROM customers WHERE id IN (5777, 503, 504, 6011);
--     -> 2026-09-19, 2026-09-05, 2026-09-16, 2026-10-09
