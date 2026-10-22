-- 0043: flex month billing.
--
-- Apply in the Supabase SQL editor. Until it is applied the column is absent,
-- the schema probe reports the capability off, and every company bills the
-- calendar month exactly as before.
--
-- flex_month
--
-- OFF (the default, and every existing company): a billing period is the
-- calendar month, 1st to last day, charged on the bill day of that month.
--
-- ON: a billing period runs from the customer's own bill day to the day
-- before the next one — bill day 20 gives 20 Oct to 19 Nov — and the charge
-- is raised on the day the period opens. The bill day is the customer's
-- customers.bill_date where they have one, else settings.bill_date, else the
-- 1st, resolved through lib/billing.ts#effectiveBillDay, which is the same
-- function the till and the payment path already use.
--
-- A customer billing on the 1st gets the calendar month either way, so a
-- company whose customers all bill on the 1st sees no change when it is on.
--
-- The cut-off day is untouched. It stays a few days after the bill day, which
-- under flex sits INSIDE the period as a grace window rather than floating in
-- the middle of a period it has no relation to.

alter table public.settings
  add column if not exists flex_month boolean not null default false;

comment on column public.settings.flex_month is
  'Billing periods run bill day to bill day rather than calendar month. See migration 0043.';
