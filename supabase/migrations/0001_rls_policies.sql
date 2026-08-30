-- ISPMan row level security policies.
--
-- CONTEXT: RLS is already enabled on the application tables, but no policies
-- exist, so the `authenticated` role reads back zero rows. That is why the
-- dashboard currently reads through the service role (see lib/supabase/tenant.ts).
--
-- Apply this in the Supabase dashboard (SQL Editor), or with:
--   supabase db execute --file supabase/migrations/0001_rls_policies.sql
--
-- Afterwards, switch the reads in lib/data/dashboard.ts and lib/auth/context.ts
-- back to the cookie-bound client in lib/supabase/server.ts and delete
-- lib/supabase/tenant.ts. The queries need no changes - they are already scoped
-- by company_id; RLS simply becomes a backstop rather than the only guard.

-- ---------------------------------------------------------------------------
-- Which company does the caller belong to?
--
-- SECURITY DEFINER so the lookup itself is not subject to the policies below,
-- which would otherwise recurse when evaluating a policy on `users`.
-- ---------------------------------------------------------------------------
create or replace function public.current_company_id()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select u.company_id
  from public.users u
  where u.email = (auth.jwt() ->> 'email')
  limit 1
$$;

revoke all on function public.current_company_id() from public;
grant execute on function public.current_company_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Tenant isolation: a signed-in user sees only their own company's rows.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tenant_tables text[] := array[
    'users', 'customers', 'payments', 'support_tickets', 'services',
    'settings', 'subscriptions', 'checkoff', 'notifications_queue',
    'log', 'network_infrastructure'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists tenant_select on public.%I', t);
    execute format(
      'create policy tenant_select on public.%I for select to authenticated
         using (company_id = public.current_company_id())', t);

    execute format('drop policy if exists tenant_insert on public.%I', t);
    execute format(
      'create policy tenant_insert on public.%I for insert to authenticated
         with check (company_id = public.current_company_id())', t);

    execute format('drop policy if exists tenant_update on public.%I', t);
    execute format(
      'create policy tenant_update on public.%I for update to authenticated
         using (company_id = public.current_company_id())
         with check (company_id = public.current_company_id())', t);

    execute format('drop policy if exists tenant_delete on public.%I', t);
    execute format(
      'create policy tenant_delete on public.%I for delete to authenticated
         using (company_id = public.current_company_id())', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- `companies` keys on `id`, not `company_id`, so it needs its own policies.
-- Read-only for ordinary users; company edits should go through an admin path.
-- ---------------------------------------------------------------------------
alter table public.companies enable row level security;

drop policy if exists tenant_select on public.companies;
create policy tenant_select on public.companies
  for select to authenticated
  using (id = public.current_company_id());

drop policy if exists tenant_update on public.companies;
create policy tenant_update on public.companies
  for update to authenticated
  using (id = public.current_company_id())
  with check (id = public.current_company_id());
