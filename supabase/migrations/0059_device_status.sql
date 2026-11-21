-- 0059: whether each device on the network is answering.
--
-- Apply with ispman-migrate. Safe before or after the deploy: until these
-- columns exist devices are listed as before, with no status.
--
-- The server cannot reach a radio on a private address, but the router beside
-- it can. Every few minutes ISPMan asks each connected router to ping the
-- devices it knows about, and keeps the answer here.
--
-- misses counts passes in a row with no answer. A device is only called down
-- after two, because one lost ping on a radio link is ordinary.

alter table public.network_devices
  add column if not exists status    TEXT,
  add column if not exists status_at TIMESTAMPTZ,
  add column if not exists seen_at   TIMESTAMPTZ,
  add column if not exists misses    INTEGER NOT NULL DEFAULT 0;

alter table public.network_devices drop constraint if exists network_devices_status_check;
alter table public.network_devices add constraint network_devices_status_check
  check (status is null or status in ('up', 'down'));
