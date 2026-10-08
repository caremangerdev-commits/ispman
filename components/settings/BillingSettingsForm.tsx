'use client'

import { useActionState, useState } from 'react'

import { saveBillingSettings, type CompanyResult } from '@/app/actions/company'
import { Card, Field, SaveButton, Toggle } from '@/components/settings/form-parts'
import { settingsInput } from '@/components/settings/Modal'
import type { GeneralSettings } from '@/lib/data/company'
import type { PrepaidCalendar } from '@/lib/data/prepaid-calendar'
import type { CompanyBillingType, EngineMode } from '@/lib/billing-engine'
import { EXPIRY_MODES, EXPIRY_MODE_HELP, EXPIRY_MODE_LABELS, type ExpiryMode } from '@/lib/types'

/** What each billing model means, in the words the engine applies. */
const BILLING_TYPE_HELP: Record<CompanyBillingType, string> = {
  postpaid:
    'The calendar month, 1st to last day, charged on the company bill day while the month is ' +
    'still running. The bill day is only the day the charge goes out; customers’ own bill ' +
    'dates are ignored.',
  prepaid:
    'The calendar month, charged on the company bill day, to the nearest hundred. The cut-off ' +
    'day is when an unpaid customer is disconnected; a disconnected customer pays only for the ' +
    'days their service was on.',
}

const ENGINE_MODE_LABELS: Record<EngineMode, string> = {
  off: 'Off',
  dry_run: 'Dry run',
  live: 'Live',
}

const ENGINE_MODE_HELP: Record<EngineMode, string> = {
  off: 'The engine does nothing for this company. Run Bills works as before.',
  dry_run:
    'Every day the engine records what it WOULD charge on Billing Runs and charges nothing.',
  live:
    'The engine charges carried balances on each charge date and Run Bills is disabled for ' +
    'this company. It never touches expiry dates or the network.',
}

/**
 * Settings > Billing: everything that decides how and when a customer is
 * charged. These fields lived in General Settings until 2026-10-03; the markup,
 * the help text and the columns they write are unchanged, only the page moved.
 */
export function BillingSettingsForm({
  settings,
  expiryModeAvailable,
  generalAvailable,
  defaultRateAvailable,
  thresholdsAvailable,
  firstPeriodAvailable,
  currencySymbol,
  billingEngineAvailable,
  prepaidCalendar,
}: {
  settings: GeneralSettings
  expiryModeAvailable: boolean
  /** Migration 0007 — grace period and tax rate. */
  generalAvailable: boolean
  /** Migration 0008 — the default monthly rate. */
  defaultRateAvailable: boolean
  /** migration 0012 — the three billing policy thresholds. */
  thresholdsAvailable: boolean
  /** migration 0017 — the two first-period rules. */
  firstPeriodAvailable: boolean
  currencySymbol: string
  /** Migration 0024 — hides the billing model and engine controls until applied. */
  billingEngineAvailable: boolean
  /** Migration 0028 — the reconnection fee. */
  prepaidCalendar: PrepaidCalendar
}) {
  const [state, action] = useActionState<CompanyResult | null, FormData>(saveBillingSettings, null)

  const [mode, setMode] = useState<ExpiryMode>(settings.defaultExpiryMode)
  // Migration 0024: the company's billing model and the engine's mode. State
  // so the help text follows the choice before it is saved.
  const [billingType, setBillingType] = useState<CompanyBillingType>(settings.billingType)
  const [engineMode, setEngineMode] = useState<EngineMode>(settings.billingEngineMode)
  const [firstExpiryRule, setFirstExpiryRule] = useState(settings.firstExpiryRuleEnabled)
  const [prorata, setProrata] = useState(settings.prorataFirstPaymentEnabled)
  // Calendar-month prepaid applies to a prepaid company whose engine is live
  // (lib/data/prepaid-calendar.ts#prepaidCalendarFor). There, the first-period
  // rules are replaced: a new customer's first month is charged from
  // connection day to month end.
  const prepaidModel = billingType === 'prepaid' && engineMode === 'live'
  const firstPeriodReplaced = prepaidModel

  const lockedHint = generalAvailable ? undefined : 'Needs migration 0007.'
  const thresholdHint = thresholdsAvailable ? undefined : 'Needs migration 0012.'
  const firstPeriodHint = firstPeriodAvailable ? undefined : 'Needs migration 0017.'
  const lockedInput = (available: boolean) =>
    settingsInput + (available ? '' : ' cursor-not-allowed opacity-50')

  return (
    <form action={action} className="space-y-4">
      {state ? (
        <p
          role="alert"
          className={
            'rounded-lg border px-3 py-2 text-sm ' +
            (state.ok
              ? 'border-green-900/60 bg-green-950/40 text-green-300'
              : 'border-red-900/60 bg-red-950/50 text-red-300')
          }
        >
          {state.ok ? 'Settings saved.' : state.error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- 1. Billing Defaults ---- */}
        <Card title="Billing Defaults">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Default Cut Off Date" htmlFor="cut_off_date" hint="Day 1-28">
              <input id="cut_off_date" name="cut_off_date" type="number" min="1" max="28" defaultValue={settings.cutOffDate ?? 5} className={settingsInput} />
            </Field>
            {/* Writes settings.bill_date, which seeds customers.bill_date for
                new and imported postpaid customers. It was labelled "Default
                Bill Due Date", which read as the unrelated and unused
                customers.bill_due_date column. */}
            <Field label="Default Bill Date" htmlFor="bill_date" hint="Day 1-28">
              <input id="bill_date" name="bill_date" type="number" min="1" max="28" defaultValue={settings.billDate ?? 25} className={settingsInput} />
            </Field>
          </div>

          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-gray-400">Default Expiry Mode</span>
            <input type="hidden" name="default_expiry_mode" value={mode} />
            <div className="flex gap-2" role="group" aria-label="Default expiry mode">
              {EXPIRY_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  disabled={!expiryModeAvailable}
                  className={
                    'flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ' +
                    (mode === m
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200')
                  }
                >
                  {EXPIRY_MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-600">{EXPIRY_MODE_HELP[mode]}</p>
          </div>

          <Field
            label="Grace Period Days"
            htmlFor="grace_period_days"
            hint={lockedHint ?? 'Days after expiry before disconnection'}
          >
            <input
              id="grace_period_days"
              name="grace_period_days"
              type="number"
              min="0"
              max="30"
              defaultValue={settings.gracePeriodDays}
              disabled={!generalAvailable}
              className={settingsInput + (generalAvailable ? '' : ' cursor-not-allowed opacity-50')}
            />
          </Field>
        </Card>

        {/* ---- 2. Billing model and the daily engine (migration 0024) ---- */}
        {billingEngineAvailable ? (
          <Card title="Billing Model &amp; Engine">
            <p className="text-[11px] leading-relaxed text-gray-600">
              One model for the whole company; customers have no override. The engine sets the
              charge and names the period. It never moves an expiry: expiries move on payment.
            </p>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-gray-400">Billing Model</span>
              <input type="hidden" name="billing_type" value={billingType} />
              <div className="flex gap-2" role="group" aria-label="Billing model">
                {(['postpaid', 'prepaid'] as CompanyBillingType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setBillingType(t)}
                    aria-pressed={billingType === t}
                    className={
                      'flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ' +
                      (billingType === t
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200')
                    }
                  >
                    {t === 'postpaid' ? 'Postpaid' : 'Prepaid'}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-600">{BILLING_TYPE_HELP[billingType]}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Engine" htmlFor="billing_engine_mode" hint={ENGINE_MODE_HELP[engineMode]}>
                <select
                  id="billing_engine_mode"
                  name="billing_engine_mode"
                  value={engineMode}
                  onChange={(e) => setEngineMode(e.target.value as EngineMode)}
                  className={settingsInput}
                >
                  {(['off', 'dry_run', 'live'] as EngineMode[]).map((m) => (
                    <option key={m} value={m}>{ENGINE_MODE_LABELS[m]}</option>
                  ))}
                </select>
              </Field>
              <Field
                label="Engine Start Date"
                htmlFor="billing_engine_start_date"
                hint="Charge dates before this are never charged. Set it after the last date this company was billed by hand."
              >
                <input
                  id="billing_engine_start_date"
                  name="billing_engine_start_date"
                  type="date"
                  defaultValue={settings.billingEngineStartDate ?? ''}
                  className={settingsInput}
                />
              </Field>
            </div>
          </Card>
        ) : null}

        {/* ---- 2b. Prepaid (migration 0028) ---- */}
        <Card title="Prepaid">
          {!prepaidCalendar.available ? (
            <p className="text-[11px] text-amber-400/90">Needs migration 0028.</p>
          ) : null}
          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-gray-500">
            <li>The period is the calendar month. The cut-off day is when an unpaid customer is disconnected.</li>
            <li>Customers pay only for days their service was on: a disconnected customer&apos;s month is reduced to the days they had, and nothing more is charged while they stay off.</li>
            <li>Each month is worked out by the day and rounded to the nearest hundred. Months paid ahead are full months.</li>
            <li>New customers are charged from their connection day to the month&apos;s end.</li>
          </ul>
          {billingType !== 'prepaid' ? (
            <p className="text-[11px] text-amber-400/90">
              This company is postpaid, so none of this applies.
            </p>
          ) : engineMode !== 'live' ? (
            <p className="text-[11px] text-amber-400/90">
              Applies once the engine is Live: until then this company is not billed by ISPMan, and
              its balances are raised by hand.
            </p>
          ) : null}

          <Field
            label="Reconnection Fee"
            htmlFor="reconnection_fee"
            hint="Offered at the till when a disconnected customer pays. Never added to a balance. 0 means no fee."
          >
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
                {currencySymbol}
              </span>
              <input
                id="reconnection_fee"
                name="reconnection_fee"
                type="number"
                min="0"
                step="0.01"
                defaultValue={prepaidCalendar.reconnectionFee}
                disabled={!prepaidCalendar.available}
                className={lockedInput(prepaidCalendar.available) + ' pl-10'}
              />
            </div>
          </Field>
        </Card>

        {/* ---- 3. First period (migration 0017) ---- */}
        <Card title="First Period">
          <p className="text-[11px] text-gray-600">
            How a customer’s very first period is dated and priced. Neither rule
            ever applies to a renewal or a reconnection.
            {firstPeriodHint ? ' ' + firstPeriodHint : ''}
          </p>
          {firstPeriodReplaced ? (
            <p className="text-[11px] text-amber-400/90">
              Replaced for this prepaid company: a new customer is charged from connection day to the
              month&apos;s end. Customers provisioned before 8 Oct 2026 who have not paid yet still
              finish on these rules.
            </p>
          ) : null}

          <Toggle
            name="first_expiry_rule_enabled"
            label="21-day first expiry"
            checked={firstExpiryRule}
            onChange={setFirstExpiryRule}
            disabled={!firstPeriodAvailable}
          />
          <p className="text-[11px] text-gray-600">
            A new customer’s first expiry is the first cut-off day at least 21 days
            away, so nobody switched on days before their cut-off pays a full month
            for a stub. Off, they run to the plain next cut-off day.
          </p>

          <Toggle
            name="prorata_first_payment_enabled"
            label="Pro-rata first payment"
            checked={prorata}
            onChange={setProrata}
            disabled={!firstPeriodAvailable}
          />
          <p className="text-[11px] text-gray-600">
            The first payment is charged for the days it actually buys: the monthly
            rate plus a daily rate for every day beyond 30. A first period SHORTER
            than 30 days is still charged the full rate — the till offers the
            difference as a discount the cashier may apply, and it is never
            automatic.
          </p>
        </Card>

        {/* ---- 4. Rates and tax ---- */}
        <Card title="Rates &amp; Tax">
          <Field
            label="Tax Rate %"
            htmlFor="tax_rate"
            hint={lockedHint ?? 'e.g. 15 for 15% GCT/VAT, 0 for no tax'}
          >
            <input
              id="tax_rate"
              name="tax_rate"
              type="number"
              min="0"
              max="100"
              step="0.01"
              defaultValue={settings.taxRate}
              disabled={!generalAvailable}
              className={settingsInput + (generalAvailable ? '' : ' cursor-not-allowed opacity-50')}
            />
          </Field>

          <Field
            label="Default Monthly Rate"
            htmlFor="default_monthly_rate"
            hint={
              defaultRateAvailable
                ? 'Pre-fills the monthly rate when adding a new customer'
                : 'Needs migration 0008.'
            }
          >
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
                {currencySymbol}
              </span>
              <input
                id="default_monthly_rate"
                name="default_monthly_rate"
                type="number"
                min="0"
                step="1"
                defaultValue={settings.defaultMonthlyRate}
                disabled={!defaultRateAvailable}
                className={
                  settingsInput + ' pl-10' +
                  (defaultRateAvailable ? '' : ' cursor-not-allowed opacity-50')
                }
              />
            </div>
          </Field>
        </Card>

        {/* ---- 5. Policy thresholds ----
            Stored for the collections and billing-run work that will read them;
            the payment flow does not consult them yet, so changing one has no
            effect on what a cashier sees today. */}
        <Card title="Thresholds">
          <Field
            label="Late Credit Threshold"
            htmlFor="late_credit_threshold"
            hint={thresholdHint ?? 'Days late before a payment stops earning credit'}
          >
            <input
              id="late_credit_threshold"
              name="late_credit_threshold"
              type="number"
              min="0"
              max="90"
              defaultValue={settings.lateCreditThreshold}
              disabled={!thresholdsAvailable}
              className={lockedInput(thresholdsAvailable)}
            />
          </Field>

          <Field
            label="Min Payment Threshold %"
            htmlFor="min_payment_threshold"
            hint={thresholdHint ?? 'Smallest share of the amount due that counts as a payment'}
          >
            <input
              id="min_payment_threshold"
              name="min_payment_threshold"
              type="number"
              min="0"
              max="100"
              step="0.01"
              defaultValue={settings.minPaymentThreshold}
              disabled={!thresholdsAvailable}
              className={lockedInput(thresholdsAvailable)}
            />
          </Field>

          <Field
            label="Max Carried Balance"
            htmlFor="max_carried_balance"
            hint={thresholdHint ?? 'Months of carried balance a customer may accumulate'}
          >
            <input
              id="max_carried_balance"
              name="max_carried_balance"
              type="number"
              min="0"
              max="12"
              defaultValue={settings.maxCarriedBalance}
              disabled={!thresholdsAvailable}
              className={lockedInput(thresholdsAvailable)}
            />
          </Field>
        </Card>
      </div>

      <SaveButton />
    </form>
  )
}
