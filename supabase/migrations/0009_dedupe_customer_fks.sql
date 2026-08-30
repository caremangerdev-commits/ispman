-- Removes duplicate foreign keys between customers and the 0005 catalogue.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- WHAT WENT WRONG
-- Migration 0006 tried to replace two foreign keys so they would cascade
-- correctly:
--
--   ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_service_plan_id_fkey;
--   ALTER TABLE customers ADD  CONSTRAINT customers_service_plan_id_fkey ...
--
-- but the constraints created by 0005 were actually named
-- `customers_service_plan_fk` and `customers_misc_category_fk`. The DROPs
-- matched nothing, so the ADDs produced a second FK on each column:
--
--   customers_service_plan_fk        + customers_service_plan_id_fkey
--   customers_misc_category_fk       + customers_misc_category_id_fkey
--
-- PostgREST then cannot resolve `select=...,service_plans(...)` and fails with
-- PGRST201 "more than one relationship was found", which broke the customer
-- detail page.
--
-- THE FIX
-- Drop the originals and keep the 0006 versions, which carry the
-- ON DELETE SET NULL behaviour that deleting a plan or category relies on.
-- lib/data/customers.ts names these constraints explicitly in its embed, so
-- the surviving names must stay as they are.

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_service_plan_fk;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_misc_category_fk;

-- Make sure the surviving constraints exist with the intended behaviour, in
-- case 0006 was only partially applied.
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_service_plan_id_fkey;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_service_plan_id_fkey
  FOREIGN KEY (service_plan_id) REFERENCES public.service_plans(id) ON DELETE SET NULL;

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_misc_category_id_fkey;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_misc_category_id_fkey
  FOREIGN KEY (misc_category_id) REFERENCES public.misc_categories(id) ON DELETE SET NULL;

-- Verify afterwards — each column should report exactly one row:
--
--   SELECT conname, conrelid::regclass, confrelid::regclass
--   FROM pg_constraint
--   WHERE conrelid = 'public.customers'::regclass AND contype = 'f'
--   ORDER BY conname;
