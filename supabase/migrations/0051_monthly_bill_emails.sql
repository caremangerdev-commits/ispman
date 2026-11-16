-- 0051: a company may have its bills emailed out every month, automatically.
--
-- Apply in the Supabase dashboard (SQL Editor). Safe before or after the
-- deploy: until this column exists the dispatcher sends no monthly bills and
-- Settings > Bill Design shows the switch as not set up.
--
-- ---------------------------------------------------------------------------
-- notify_bill_monthly_enabled
--
-- A SECOND SWITCH, DELIBERATELY NOT A REUSE OF 0042's. notify_bill_enabled
-- means "staff may press Email bill on a customer record" — one message, sent
-- by a person who is looking at that customer. Reading it as permission to
-- post a thousand bills unprompted would change what every company that
-- already turned it on has agreed to, on the morning of their bill date, with
-- no warning. A company that wants the monthly send says so here.
--
-- It depends on 0042's switch rather than standing alone: the monthly send is
-- the same email, the same PDF and the same route, so a company that has not
-- allowed bill emails at all cannot be sending them on a schedule. The form
-- enforces that; this column only records the answer.
--
-- Off by default, like every notification added since 0037.
--
-- WHAT DECIDES WHEN. The company's own bill_date and timezone, already here
-- and already what the billing engine runs on. The dispatcher
-- (lib/sms/dispatch.ts#sweepMonthlyBills) queues one bill per customer on that
-- date, and for three days after it in case the worker was down — a window,
-- because losing a month's bills to a stopped process is the failure this
-- feature exists to prevent, and nobody would notice until a customer asked.
--
-- WHAT STOPS A SECOND COPY. The unique index on (company_id, channel,
-- dedupe_key) that every other notification already relies on, with the month
-- in the key: billmail:YYYY-MM:<customer id>. Not a "has this run" flag, which
-- would have to be right about timing on a dispatcher that ticks constantly.
-- ---------------------------------------------------------------------------

alter table public.settings
  add column if not exists notify_bill_monthly_enabled boolean not null default false;

comment on column public.settings.notify_bill_monthly_enabled is
  'Email every customer their bill on the company''s bill_date, and for 3 days after. '
  'Requires notify_bill_enabled. Once per customer per month, enforced by the outbox '
  'dedupe key billmail:YYYY-MM:<customer id>.';
