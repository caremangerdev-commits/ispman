-- 0057: which customer a device belongs to.
--
-- Apply with ispman-migrate. Safe before or after the deploy: until these
-- columns exist the customer page shows no Devices row and the ONU list shows
-- no customer names.
--
-- A customer's ONU or radio is a device like any other, so it lives in
-- network_devices (0056) with the customer it serves beside it. One list
-- answers both "what is at this customer's house" and "whose is this ONU".
--
-- MOST LINKS ARE MADE WITHOUT ANYONE TYPING. An OLT knows which customer
-- router sits behind each ONU, and a customer radio that logs in to the
-- network itself has the customer's MAC address. linked_by records whether a
-- person made the link or ISPMan worked it out, because a link a person made
-- is never replaced by a guess.

alter table public.network_devices
  add column if not exists customer_id BIGINT REFERENCES public.customers(id) ON DELETE SET NULL,
  add column if not exists serial      TEXT,
  add column if not exists olt_id      BIGINT REFERENCES public.olts(id) ON DELETE SET NULL,
  -- Where the ONU sits on its OLT, e.g. gpon-onu_1/1/3:12.
  add column if not exists onu_ref     TEXT,
  add column if not exists linked_by   TEXT;

alter table public.network_devices drop constraint if exists network_devices_linked_by_check;
alter table public.network_devices add constraint network_devices_linked_by_check
  check (linked_by is null or linked_by in ('auto', 'manual'));

create index if not exists network_devices_customer_idx
  on public.network_devices (company_id, customer_id);
-- One row per ONU serial number per company, for the same reason as the MAC
-- index: the same ONU is read off the OLT again and again.
create unique index if not exists network_devices_serial_idx
  on public.network_devices (company_id, serial);
