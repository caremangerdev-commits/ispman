-- 0040: customer rows are readable directly only by the roles that may browse
-- the customer list.
--
-- Apply in the Supabase dashboard (SQL Editor). Safe before or after the
-- deploy: the app never reads or writes customers as the signed-in user, so
-- nothing it does changes. What changes is what a signed-in user can get by
-- going around it.
--
-- ---------------------------------------------------------------------------
-- THE HOLE
--
-- 0001 gave every tenant table one rule: any signed-in staff user may select,
-- insert, update and delete any row of their own company. The app itself reads
-- everything through the service role and decides per role in the server
-- (lib/supabase/tenant.ts, lib/permissions.ts) — but the browser holds the
-- anon key and the user's own session, so anyone signed in can ask PostgREST
-- directly, from the console:
--
--     createClient().from('customers').select('*')
--
-- A technician has no customer list anywhere in the app (view_customer_list),
-- and this hands them the whole book anyway, one request, every column. The
-- same rows came out through embeds — support_tickets?select=*,customers(*).
--
-- THE RULE
--
-- customers' four policies additionally require that the caller holds a role
-- with view_customer_list in lib/permissions.ts: super_admin, company_admin,
-- manager, csr. Technician and cashier read customers only through the server,
-- which gives them a search, never the list (lib/search.ts#isSearchQuery: two
-- characters, twenty matches, no paging). A customer embedded in another
-- table's rows comes back null for them, because PostgREST embeds obey the
-- embedded table's policies.
--
-- KEEP THE ROLE LIST IN STEP WITH view_customer_list IN lib/permissions.ts.
-- Widening that permission without this function denies the new role nothing
-- in the app (which does not use these policies) but leaves it unable to read
-- directly; narrowing it without this function leaves the direct door open.
--
-- NOT COVERED HERE, deliberately: the other tenant tables still carry 0001's
-- company-only rule — payments, log, support_tickets and the rest are readable
-- directly by every staff role in the company. The customer LIST is what this
-- closes; see the note in the commit that added it.
-- ---------------------------------------------------------------------------

-- The role of the caller's row IN THE COMPANY current_company_id() resolved,
-- so the two can never be answered from two different users rows that happen
-- to share an email. SECURITY DEFINER for the same reason as
-- current_company_id(): a lookup on users from inside a policy must not be
-- subject to users' own policies.
create or replace function public.current_user_browses_customers()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users u
    where u.email = (auth.jwt() ->> 'email')
      and u.company_id = public.current_company_id()
      and (
        u.role in ('super_admin', 'company_admin', 'manager', 'csr')
        or coalesce(u.is_super_admin, false)
      )
  )
$$;

revoke all on function public.current_user_browses_customers() from public;
grant execute on function public.current_user_browses_customers() to authenticated;

-- Wrapped in (select ...) so each is evaluated once per statement, not once
-- per row.
drop policy if exists tenant_select on public.customers;
create policy tenant_select on public.customers
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.current_user_browses_customers())
  );

drop policy if exists tenant_insert on public.customers;
create policy tenant_insert on public.customers
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.current_user_browses_customers())
  );

drop policy if exists tenant_update on public.customers;
create policy tenant_update on public.customers
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.current_user_browses_customers())
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.current_user_browses_customers())
  );

drop policy if exists tenant_delete on public.customers;
create policy tenant_delete on public.customers
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.current_user_browses_customers())
  );
