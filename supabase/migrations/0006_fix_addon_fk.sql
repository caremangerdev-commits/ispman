-- Corrects a foreign key defect introduced by 0005.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- WHAT IS WRONG
-- `customer_additional_services.company_id` references `customers(id)` instead
-- of `companies(id)`. Confirmed from the live schema:
--
--   insert ... -> 23503 "Key (company_id)=(11) is not present in table customers"
--
-- Two consequences:
--   1. A row can only be inserted when the company id coincidentally matches an
--      existing customer id, so the junction table is effectively unusable.
--   2. The RLS policy compares `company_id = current_company_id()` — a column
--      constrained to customer ids against a company id — so tenant scoping on
--      this table is not doing what it appears to.
--
-- Until this runs, the seed skips the add-on links and the customer detail page
-- reports add-ons as unavailable rather than writing bad rows.

ALTER TABLE public.customer_additional_services
  DROP CONSTRAINT IF EXISTS customer_additional_services_company_id_fkey;

ALTER TABLE public.customer_additional_services
  ADD CONSTRAINT customer_additional_services_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES public.companies(id);

-- ---------------------------------------------------------------------------
-- Policy hardening.
--
-- 0005 created its policies without a TO clause, which defaults to PUBLIC and
-- therefore includes the anon role. current_company_id() returns NULL for anon
-- so nothing actually leaks, but every other table in this schema scopes to
-- `authenticated` explicitly — make these match rather than rely on that.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS misc_categories_company ON public.misc_categories;
CREATE POLICY misc_categories_company ON public.misc_categories
  FOR ALL TO authenticated
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

DROP POLICY IF EXISTS service_plans_company ON public.service_plans;
CREATE POLICY service_plans_company ON public.service_plans
  FOR ALL TO authenticated
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

DROP POLICY IF EXISTS additional_services_company ON public.additional_services;
CREATE POLICY additional_services_company ON public.additional_services
  FOR ALL TO authenticated
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

DROP POLICY IF EXISTS customer_additional_services_company ON public.customer_additional_services;
CREATE POLICY customer_additional_services_company ON public.customer_additional_services
  FOR ALL TO authenticated
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- Deleting a plan or category must not delete customers.
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_service_plan_fk;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_service_plan_id_fkey;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_service_plan_id_fkey
  FOREIGN KEY (service_plan_id) REFERENCES public.service_plans(id) ON DELETE SET NULL;

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_misc_category_fk;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_misc_category_id_fkey;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_misc_category_id_fkey
  FOREIGN KEY (misc_category_id) REFERENCES public.misc_categories(id) ON DELETE SET NULL;

-- Removing an add-on from the catalogue should clear its subscriptions.
ALTER TABLE public.customer_additional_services
  DROP CONSTRAINT IF EXISTS customer_additional_services_additional_service_id_fkey;
ALTER TABLE public.customer_additional_services
  ADD CONSTRAINT customer_additional_services_additional_service_id_fkey
  FOREIGN KEY (additional_service_id) REFERENCES public.additional_services(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS cas_customer_idx
  ON public.customer_additional_services (customer_id);
CREATE INDEX IF NOT EXISTS cas_service_idx
  ON public.customer_additional_services (additional_service_id);
