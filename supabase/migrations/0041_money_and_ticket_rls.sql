-- 0041: a technician cannot reach a customer's money, or the supervisory half
-- of a ticket, by going around the app. Plus internal notes on tickets.
--
-- Apply in the Supabase dashboard (SQL Editor), AFTER 0040 — this file checks
-- and stops if 0040 is missing. Safe before or after the deploy: the app reads
-- and writes every table below through the service role and decides per role
-- in the server (lib/permissions.ts), so nothing it does changes. What changes
-- is what a signed-in user can get by asking the database directly — from the
-- browser console, with the anon key and their own session:
--
--     createClient().from('payments').select('*')
--
-- ---------------------------------------------------------------------------
-- 1. MONEY
--
-- From 21 Oct 2026 a technician sees no customer's money anywhere in the app:
-- no payment history, balance, credit, rate, prices, statements or bills
-- (lib/permissions.ts#view_customer_billing_history). Before this file, the
-- same signed-in technician could read all of it directly — every payment the
-- company ever took, every bill charge, every SMS receipt — because 0001 gave
-- each table one rule: any staff user of the company may select, insert,
-- update and delete.
--
-- The tables below now additionally require a role that may read the money
-- BOOK — the whole table, which is what a direct read is: super_admin,
-- company_admin, manager. The same line as view_all_payments in
-- lib/permissions.ts, and for the reason 0040 gives for customers: a direct
-- read has no search box and no per-customer gate, so it is a browse, and
-- only the roles that browse the payments book in the app may make it. CSR and
-- cashier keep everything the app shows them — through the server, which is
-- the only way the app reads these tables anyway.
--
--   payments, gateway_payments   money received
--   payment_gateways             the online gateway's credentials. Its HMAC
--                                secret was readable — and writable — by any
--                                staff login, which is enough to sign a fake
--                                "paid" webhook or point checkout elsewhere.
--   bills, bill_runs,            what customers were charged
--   bill_charges,
--   customer_charges
--   checkoff, checkoff_records   collections handed over
--   log                          the audit trail: payment, charge and balance
--                                rows name amounts
--   sms_outbox                   texts sent to customers, receipts included
--   notifications_queue          the staff bell: "<name> paid J$… online"
--
-- customers itself — carried_balance, account_credit, monthly_rate — is 0040's:
-- it already limits direct reads of customers to the customer-list roles,
-- which exclude technician.
--
-- Done by ANDing the check onto each table's existing policies rather than
-- replacing them, because they differ: bill_runs and bill_charges allow SELECT
-- only (the engine writes them through the service role), checkoff_records and
-- customer_charges have one FOR ALL policy, the rest four tenant_* policies.
-- Every policy keeps its name, its command and its company rule.
--
-- 2. TICKETS
--
-- A technician opens tickets, talks on them and resolves their own; they do
-- not reassign, reprioritise, reopen, re-file or delete (lib/permissions.ts,
-- lib/ticket-rules.ts). The server actions enforce that. Directly, a
-- technician could still UPDATE support_tickets (assigned_to, priority,
-- status, customer_id), DELETE any ticket or message, or INSERT a message in
-- someone else's name. Now support_tickets and ticket_messages accept
-- INSERT, UPDATE and DELETE only from the office roles; a technician keeps
-- SELECT, which shows them nothing the ticket pages do not.
--
-- 3. INTERNAL NOTES
--
-- ticket_messages.internal: a staff note on a ticket the customer never sees.
-- The portal's read filters it out in the query
-- (lib/data/tickets.ts#listTicketMessages); until this column exists the app
-- offers no notes, so none can land in a customer's thread.
--
-- KEEP THE ROLE LISTS IN STEP WITH lib/permissions.ts: view_all_payments for
-- section 1, reply_ticket minus technician (= edit_ticket) for section 2.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.current_user_browses_customers()') is null then
    raise exception '0041 needs 0040 first: apply supabase/migrations/0040_customers_browse_rls.sql, then this file.';
  end if;
end
$$;

-- True when the caller's users row IN THE COMPANY current_company_id()
-- resolved holds one of `roles` — the same lookup as 0040's function, so the
-- company and the role are always answered from one row. is_super_admin counts
-- as 'super_admin'. SECURITY DEFINER for the reason current_company_id() is:
-- a policy's lookup on users must not be subject to users' own policies.
create or replace function public.current_user_role_in(roles text[])
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
        u.role = any (roles)
        or (coalesce(u.is_super_admin, false) and 'super_admin' = any (roles))
      )
  )
$$;

revoke all on function public.current_user_role_in(text[]) from public;
grant execute on function public.current_user_role_in(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Money tables: every existing policy gains the money-book check.
-- Wrapped in (select ...) so it is evaluated once per statement. Skips a
-- table that does not exist on this database, and a policy already carrying
-- the check, so the file can be run twice.
-- ---------------------------------------------------------------------------
do $$
declare
  money_tables text[] := array[
    'payments', 'gateway_payments', 'payment_gateways',
    'bills', 'bill_runs', 'bill_charges', 'customer_charges',
    'checkoff', 'checkoff_records',
    'log', 'sms_outbox', 'notifications_queue'
  ];
  gate text := '(select public.current_user_role_in(array[''super_admin'', ''company_admin'', ''manager'']))';
  r record;
begin
  for r in
    select tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public' and tablename = any (money_tables)
  loop
    if r.qual is not null and position('current_user_role_in' in r.qual) = 0 then
      execute format('alter policy %I on public.%I using ((%s) and %s)',
        r.policyname, r.tablename, r.qual, gate);
    end if;
    if r.with_check is not null and position('current_user_role_in' in r.with_check) = 0 then
      execute format('alter policy %I on public.%I with check ((%s) and %s)',
        r.policyname, r.tablename, r.with_check, gate);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Ticket writes: office roles only. SELECT is left as it is.
-- ---------------------------------------------------------------------------
do $$
declare
  ticket_tables text[] := array['support_tickets', 'ticket_messages'];
  gate text := '(select public.current_user_role_in(array[''super_admin'', ''company_admin'', ''manager'', ''csr'', ''cashier'']))';
  r record;
begin
  -- A FOR ALL policy cannot be split into "read yes, write no" by altering
  -- it. 0001 and 0037 created none on these tables; stop rather than guess if
  -- one has appeared since.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = any (ticket_tables) and cmd = 'ALL'
  ) then
    raise exception '0041: a FOR ALL policy exists on support_tickets or ticket_messages — review it before applying this file.';
  end if;

  for r in
    select tablename, policyname, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and tablename = any (ticket_tables)
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  loop
    if r.qual is not null and position('current_user_role_in' in r.qual) = 0 then
      execute format('alter policy %I on public.%I using ((%s) and %s)',
        r.policyname, r.tablename, r.qual, gate);
    end if;
    if r.with_check is not null and position('current_user_role_in' in r.with_check) = 0 then
      execute format('alter policy %I on public.%I with check ((%s) and %s)',
        r.policyname, r.tablename, r.with_check, gate);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Internal notes.
-- ---------------------------------------------------------------------------
alter table public.ticket_messages
  add column if not exists internal boolean not null default false;

-- ---------------------------------------------------------------------------
-- Check afterwards. Every row for the money tables should mention
-- current_user_role_in in `using` (and in `with check` where there is one);
-- for the two ticket tables, every row except the SELECT one.
--
--   select tablename, policyname, cmd, qual as using, with_check
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('payments', 'gateway_payments', 'payment_gateways',
--       'bills', 'bill_runs', 'bill_charges', 'customer_charges', 'checkoff',
--       'checkoff_records', 'log', 'sms_outbox', 'notifications_queue',
--       'support_tickets', 'ticket_messages')
--   order by tablename, cmd;
-- ---------------------------------------------------------------------------
