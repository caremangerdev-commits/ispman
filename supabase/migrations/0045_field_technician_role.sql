-- A technician who also collects money.
--
-- Identical to 'technician' except that it may see a customer's billing
-- history and record a payment. It exists because removing technician from
-- those two on 21 Oct 2026 was right for a technician and wrong for the people
-- who do both jobs: install in the morning, take cash at the gate in the
-- afternoon.
--
-- A SEPARATE ROLE rather than giving the rights back to 'technician', because
-- that role is shared by every tenant on the platform. Ten technicians exist
-- across five companies, and widening the role would open customer balances
-- inside other operators' businesses without them asking for it. This way the
-- access is granted one person at a time.
--
-- WHY A MIGRATION IS NEEDED AT ALL: 0002_roles.sql put a CHECK constraint on
-- users.role listing the six roles by name. Without widening it, saving a user
-- as 'field_technician' fails in the database, whatever the app allows.
--
-- The role list in the app is lib/permissions.ts. Keep the two in step.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'super_admin',
    'company_admin',
    'manager',
    'csr',
    'cashier',
    'technician',
    'field_technician'
  ));

-- NOTHING IS MIGRATED ONTO THE NEW ROLE. Every existing technician stays a
-- technician: who collects money is a decision per person, made in the app by
-- whoever runs that company, not something a migration should decide for five
-- tenants at once.

-- Verify afterwards:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.users'::regclass AND contype = 'c';
--   -> the list above, including field_technician
