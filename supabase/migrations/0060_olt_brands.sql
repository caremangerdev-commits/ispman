-- 0060: let an OLT be any brand ISPMan has a module for.
--
-- Apply with ispman-migrate. Until it is applied, only ZTE OLTs can be saved:
-- 0054 allowed that one brand, and the Huawei, V-SOL, C-Data and GCOM modules
-- added since were being turned away by the database when someone tried to
-- add one.
--
-- The list is repeated here because the database is the last line: an OLT row
-- with a brand no module answers for could never be read.

alter table public.olts drop constraint if exists olts_brand_check;
alter table public.olts add constraint olts_brand_check
  check (brand in ('zte', 'huawei', 'vsol', 'cdata', 'gcom'));
