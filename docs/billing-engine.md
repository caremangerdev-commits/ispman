# The daily billing engine

Migration `0024_billing_engine.sql`. A second pm2 process posts to the app once
an hour; the app decides, per company, what today's charges are and applies
them in one Postgres transaction. Per company it is off, dry run or live, and
it is off everywhere until someone switches it on.

What it does: sets a charge on `carried_balance` and names the period it is
for, one row per customer per period in `bill_charges`. What it never does:
touch radcheck or move an expiry. Expiries move on payment, nowhere else.

## Deploy order — DO THIS IN THIS ORDER

The code has to be running before the migration, because the migration
renames a column the old code's schema probe selects.

```sh
# 1. CODE. Pull, build, restart the app. Nothing changes yet: the engine's
#    probe reads "not applied" and every control stays hidden.
#    Since 6 Oct 2026 use deploy.sh, never a bare `npm run build`: building in
#    place deletes the running app's CSS/JS mid-build and takes the site down.
./deploy.sh

# 2. MIGRATION. Paste supabase/migrations/0024_billing_engine.sql into the
#    Supabase SQL editor and run it. Then the verify queries at its foot.
#    Every company comes out with billing_engine_mode = 'off'.

# 3. ENVIRONMENT. Add to .env.local:
#      BILLING_TICK_SECRET=<openssl rand -hex 32>
#      BILLING_ENGINE_ENABLED=true
#    then restart the app so the route sees them.
pm2 restart ispman --update-env

# 4. TICKER. One instance, fork mode, never cluster.
pm2 start worker/billing-ticker.mjs --name ispman-billing --cwd /PATH/TO/ispman
pm2 save
pm2 logs ispman-billing --lines 20      # "started; ... every 3600s"
```

Step 3 can wait: with the flag unset, the ticker gets a 503 every hour and
says so in its log, and nothing else happens. Step 4 can wait for the same
reason. Steps 1 and 2 cannot be swapped.

**What breaks if you run the migration first.** The old code's 0011 probe
selects `settings.default_billing_type`. The migration renames it. The probe
then fails with "column does not exist", the app reads `billing` as not
available, and every billing feature — balances, bill dates, Run Bills, the
payment form's billing columns — disappears from every page until the new
code is deployed. Nothing is lost, but the whole platform is degraded for the
gap. That is the email-migration mistake again, so: code first.

**What breaks if you deploy the code and never run the migration.** Nothing.
The new code probes for the 0024 columns, finds none, and hides the engine.
The old settings column goes on being ignored.

## Per-company controls

Settings → Billing → Billing Model & Engine. Company admin only, like the
rest of that page. (These fields were under General Settings → Billing
Defaults until 2026-10-03.)

- **Billing model.** Both charge the calendar month on the company's bill
  day; customers' own bill dates are not read. Postpaid charges the exact
  figure. Prepaid is calendar-month prepaid (migration 0028): the month to the
  nearest hundred, reduced by the hourly service pass to the days of service
  when a customer is cut off, recomputed at the till when they come back, and
  a new customer charged from connection day to month end at Provision. It
  applies to every prepaid company whose engine is live; there is no separate
  switch (8 Oct 2026). The old prepaid shape — each customer's bill date to
  the same date next month — is gone. One model per company; customers have
  no override.
- **Engine.** Off, dry run, live. Off does nothing. Dry run records what would
  be charged, daily, and charges nothing. Live charges.
- **Engine start date.** Required once the mode is not off. A charge date
  before it is never charged. **Set it after the last date the company was
  billed by hand or by Run Bills**, or the engine charges the period that was
  running when it was switched on.

## Going live

A company can be set to Live at any time; no dry-run history is required.
A dry run is optional: it previews every customer and amount on Billing Runs
without charging, which is worth reading before the first real charge date.

## Reading it

Billing → Billing Runs. One row per company per day the engine looked, with
counts; click a date for the charges (live) or the would-be charges (dry). The
top card shows what a tick would do right now.

A customer's page shows the engine's latest charge as "Last Billed", with the
period beside it.

Run Bills refuses for a company whose engine is live. The two would be two
writers on the same balance with two different guards.

## Kill switches

Either one is enough; both together is fine.

```sh
pm2 stop ispman-billing                  # no more ticks
# or: BILLING_ENGINE_ENABLED=false in .env.local, then
pm2 restart ispman --update-env          # the route refuses every tick with 503
```

Per-company: set the mode to Off on its settings page. Charges already made
stay; nothing is reversed by switching off.

## One tick, one company, by hand

```sh
curl -s -X POST -H "x-billing-tick-secret: $BILLING_TICK_SECRET" \
  "http://127.0.0.1:3000/api/billing/tick?company=30"
```

Same code path as the ticker, same rows. Useful right after going live to see
the first day land without waiting for the hour.

## Where the pieces are

| Piece | File |
|---|---|
| Period shapes and the verdict (pure) | `lib/billing-engine.ts` |
| The tick, the run log, the previews | `lib/data/billing-engine.ts` |
| The route the ticker calls | `app/api/billing/tick/route.ts` |
| The ticker | `worker/billing-ticker.mjs` |
| The service check shared with Run Bills | `lib/radius/service-state.ts` |
| The system identity and its log writer | `lib/audit.ts` (`logSystemEvent`) |
| The one Postgres function | `apply_bill_charges` in `0024_billing_engine.sql` |
| Prepaid month arithmetic (pure) | `lib/prepaid-calendar.ts` |
| The hourly service pass (prepaid) | `lib/data/prepaid-service.ts` |
| A month's charge changed, guarded | `set_month_charge` in `0028_prepaid_calendar.sql` |
| Read-only preview of the model for a company | `scripts/preview-prepaid-calendar.mjs` |

## What it deliberately does not do

Grace removal, the first cut-off skip, pro-rata joining (a customer who joins
after a charge date is charged from the next one; the till's first-period
rule covers the stretch between), charge kinds, multi-line bills, restating
history.
