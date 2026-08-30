-- ISPMan customer groups + connection types.
--
-- RUN THIS BEFORE USING THE NEW CUSTOMER FEATURES.
-- Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- Until it is applied the app degrades gracefully (see lib/schema.ts): the
-- group and connection-type fields hide themselves rather than erroring, and
-- Settings -> Customer Groups shows a "migration required" notice.

CREATE TABLE IF NOT EXISTS customer_groups (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS group_id BIGINT REFERENCES customer_groups(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type VARCHAR(20) DEFAULT 'dhcp' CHECK (customer_type IN ('dhcp', 'pppoe', 'hotspot'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pppoe_username VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pppoe_password VARCHAR(100);

INSERT INTO customer_groups (company_id, name, description)
SELECT id, 'Zone A', 'North zone customers' FROM companies WHERE name = 'Demo ISP Jamaica'
UNION ALL
SELECT id, 'Zone B', 'South zone customers' FROM companies WHERE name = 'Demo ISP Jamaica'
UNION ALL
SELECT id, 'Residential', 'Home customers' FROM companies WHERE name = 'Demo ISP Jamaica'
UNION ALL
SELECT id, 'Business', 'Business customers' FROM companies WHERE name = 'Demo ISP Jamaica';

-- ---------------------------------------------------------------------------
-- Additions beyond the supplied SQL, needed for this to work in the app.
-- ---------------------------------------------------------------------------

-- The Add Customer form has an "Access Point" field, but no column existed for
-- it in the schema or in the supplied SQL — without this the input would be
-- silently discarded on save.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS access_point VARCHAR(100);

-- PPPoE customers authenticate by username, not MAC, but mac_address is
-- currently NOT NULL — so a PPPoE customer literally cannot be inserted.
-- Until this runs, the app keeps requiring a MAC for every connection type.
ALTER TABLE customers ALTER COLUMN mac_address DROP NOT NULL;

-- 0001 enabled RLS on every table and denies anything without a policy, so a
-- new table is invisible to the app until it gets the same tenant scoping.
ALTER TABLE public.customer_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_select ON public.customer_groups;
CREATE POLICY tenant_select ON public.customer_groups
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS tenant_insert ON public.customer_groups;
CREATE POLICY tenant_insert ON public.customer_groups
  FOR INSERT TO authenticated
  WITH CHECK (company_id = public.current_company_id());

DROP POLICY IF EXISTS tenant_update ON public.customer_groups;
CREATE POLICY tenant_update ON public.customer_groups
  FOR UPDATE TO authenticated
  USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

DROP POLICY IF EXISTS tenant_delete ON public.customer_groups;
CREATE POLICY tenant_delete ON public.customer_groups
  FOR DELETE TO authenticated
  USING (company_id = public.current_company_id());

-- A group name should be unique within a company, not across the platform.
CREATE UNIQUE INDEX IF NOT EXISTS customer_groups_company_name_key
  ON public.customer_groups (company_id, lower(name));

-- Deleting a group must not delete its customers; leave them ungrouped.
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_group_id_fkey;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES public.customer_groups(id) ON DELETE SET NULL;

-- Existing rows predate the column default, so backfill them explicitly.
UPDATE public.customers SET customer_type = 'dhcp' WHERE customer_type IS NULL;

-- Lookup indexes for the group filter and the global search.
CREATE INDEX IF NOT EXISTS customers_group_id_idx ON public.customers (group_id);
CREATE INDEX IF NOT EXISTS customers_company_type_idx ON public.customers (company_id, customer_type);
