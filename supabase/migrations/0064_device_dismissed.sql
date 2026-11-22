-- 0064: devices a person removed, so discovery does not add them back.
--
-- Apply with ispman-migrate. Safe before or after the deploy.
--
-- From 0064 on, the network's own radios, switches and routers that the
-- routers can see are added automatically, like customers' radios already
-- were. Something a person then removes — a neighbour's radio on a shared
-- link, a test unit — is remembered here by MAC and left out from then on.

create table if not exists public.network_device_dismissed (
  company_id  BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  mac         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, mac)
);

alter table public.network_device_dismissed enable row level security;
drop policy if exists network_device_dismissed_company on public.network_device_dismissed;
create policy network_device_dismissed_company on public.network_device_dismissed
  for all to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
