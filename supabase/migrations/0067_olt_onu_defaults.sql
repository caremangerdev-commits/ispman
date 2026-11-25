-- 0067: how a company last set up new ONUs on each OLT.
--
-- Apply with ispman-migrate. Until it runs, the Authorize screen simply
-- starts from the usual defaults each time.
--
-- {mode, vlan, onuVlan, upProfile, downProfile}: copy / untagged / tagged,
-- the VLANs, and the speed profiles chosen. The Authorize screen opens with
-- these, so each company sets its own way once per OLT.

alter table public.olts add column if not exists onu_defaults JSONB;
