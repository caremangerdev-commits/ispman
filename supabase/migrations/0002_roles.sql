-- ISPMan role-based permissions: schema changes.
--
-- Apply in the Supabase dashboard (SQL Editor), or:
--   supabase db execute --file supabase/migrations/0002_roles.sql
--
-- AFTER APPLYING: set HAS_SUPER_ADMIN_COLUMN = true in lib/session.ts so the
-- real column is read instead of being derived from the role.

-- ---------------------------------------------------------------------------
-- 1. Constrain `role` to the six known values.
--
-- The column is currently an unconstrained varchar, so a typo silently creates
-- a role nobody has permissions for. lib/permissions.ts#toRole already fails
-- closed on unknown values; this stops them being written in the first place.
-- ---------------------------------------------------------------------------
alter table public.users drop constraint if exists users_role_check;

-- Normalise any pre-existing values that the new constraint would reject.
-- The original seed used 'admin'; map it onto the new vocabulary.
update public.users set role = 'company_admin' where role = 'admin';
update public.users
   set role = 'technician'
 where role is null
    or role not in ('super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician');

alter table public.users add constraint users_role_check
  check (role in ('super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'));

-- ---------------------------------------------------------------------------
-- 2. Platform-level admin flag, separate from the per-company role.
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists is_super_admin boolean not null default false;

-- Keep the flag and the role consistent for anyone already marked super_admin.
update public.users set is_super_admin = true where role = 'super_admin';

-- ---------------------------------------------------------------------------
-- 3. RLS note.
--
-- 0001_rls_policies.sql scopes every table by company_id. A super admin is
-- explicitly cross-company, so once that migration is applied super-admin
-- reads must keep using the service-role client (as app/superadmin does),
-- or gain an additional policy such as:
--
--   create policy super_admin_select on public.companies
--     for select to authenticated
--     using (exists (
--       select 1 from public.users u
--       where u.email = (auth.jwt() ->> 'email') and u.is_super_admin
--     ));
--
-- Left commented deliberately — grant cross-tenant read only when you intend to.
-- ---------------------------------------------------------------------------
