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
-- OFF for every company until each owner says — EXCEPT Ezmze (27), whose
-- Provision already charges the connection month: the owner does not want it
-- changing silently at a live company.
--
-- THE CONNECTION DAY. customers.connected_on: the day the customer was first
-- provisioned, in the company's own zone. The engine counts a customer as
-- joined on it rather than on the day the record was created — a record made
-- on 20 Sep and connected on 5 Oct joined on 5 Oct. Written by Provision from
-- now on; filled here for existing customers from their earliest
-- network_provision log row. NULL for customers never provisioned in ISPMan
-- (moved over from a legacy system already on the network): the engine falls
-- back to date_added for them, as before.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS charge_connection_month BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.settings SET charge_connection_month = TRUE WHERE company_id = 27;

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
   AND c.connected_on IS NULL;

-- Verify afterwards:
--   SELECT company_id, charge_connection_month FROM settings ORDER BY company_id;
--     -> true for 27 only
--   SELECT count(*) FILTER (WHERE connected_on IS NOT NULL), count(*) FROM customers;
--   SELECT id, date_added, connected_on FROM customers WHERE id IN (5777, 503, 504, 6011);
--     -> 2026-09-19, 2026-09-05, 2026-09-16, 2026-10-09
