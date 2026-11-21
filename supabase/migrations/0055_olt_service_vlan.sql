-- 0055: the VLAN an OLT carries newly authorised ONUs on.
--
-- Apply with ispman-migrate. Safe before or after the deploy: without the
-- column, authorising asks for the VLAN each time and does not remember it.
--
-- An ONU with VLAN switched off sends plain traffic. The OLT still needs a
-- VLAN internally to carry that traffic to its uplink, and adds it as the
-- traffic arrives. Which VLAN is a property of the OLT's own setup — it has to
-- be the one its uplink port hands out untagged — so it is stored against the
-- OLT, chosen once, and offered as the default every time after.

alter table public.olts
  add column if not exists service_vlan integer;

alter table public.olts drop constraint if exists olts_service_vlan_check;
alter table public.olts add constraint olts_service_vlan_check
  check (service_vlan is null or (service_vlan between 1 and 4094));

comment on column public.olts.service_vlan is
  'The VLAN newly authorised ONUs are carried on inside the OLT. The ONUs themselves stay untagged.';
