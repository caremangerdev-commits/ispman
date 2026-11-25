-- 0070: what new ONUs get on each OLT, chosen by the company.
--
-- Apply with ispman-migrate. Until it runs, new ONUs are set up like the
-- working ONUs on their port, as before.
--
-- olts.onu_auto: {"use": "learn" | <onu_setups.id>, "ports": {"gpon-olt_1/1/3": "learn" | <id>}}
--   "learn" copies the ONUs already working on the same port; a number is
--   one of the company's saved setups. A port can differ from the OLT. Both
--   automatic authorizing and the Authorize screen start from this.

alter table public.olts add column if not exists onu_auto JSONB;
