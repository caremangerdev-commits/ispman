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
  connectionMonth,
}: {
  settings: GeneralSettings
  expiryModeAvailable: boolean
  /** Migration 0007 — grace period and tax rate. */
  generalAvailable: boolean
  /** Migration 0008 — the default monthly rate. */
  defaultRateAvailable: boolean
  /** migration 0012 — the three billing policy thresholds. */
  thresholdsAvailable: boolean
  /** migration 0017 — the 21-day rule the Provision popup starts on. */
  firstPeriodAvailable: boolean
  currencySymbol: string
  /** Migration 0024 — hides the billing model and engine controls until applied. */
  billingEngineAvailable: boolean
  /** Migration 0028 — the reconnection fee. */
  prepaidCalendar: PrepaidCalendar
  /** Migration 0032 — whether the connection month is charged. */
  connectionMonth: { available: boolean; on: boolean }
}) {
  const [state, action] = useActionState<CompanyResult | null, FormData>(saveBillingSettings, null)

  const [mode, setMode] = useState<ExpiryMode>(settings.defaultExpiryMode)
  // Migration 0024: the company's billing model and the engine's mode. State
  // so the help text follows the choice before it is saved.
  const [billingType, setBillingType] = useState<CompanyBillingType>(settings.billingType)
  const [engineMode, setEngineMode] = useState<EngineMode>(settings.billingEngineMode)
  const [firstExpiryRule, setFirstExpiryRule] = useState(settings.firstExpiryRuleEnabled)
  // Migration 0032: the connection month, per company, prepaid and postpaid.
  const [chargeConnection, setChargeConnection] = useState(connectionMonth.on)

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
              Applies once the engine is Live and its start date has come: until then this company is
              not billed by ISPMan, and its balances are raised by hand.
            </p>
          ) : null}
        </Card>

        {/* ---- 2c. Reconnection fee (migration 0028) — prepaid and postpaid ---- */}
        <Card title="Reconnection Fee">
          {!prepaidCalendar.available ? (
            <p className="text-[11px] text-amber-400/90">Needs migration 0028.</p>
          ) : null}
          <Field
            label="Reconnection Fee"
            htmlFor="reconnection_fee"
            hint="Offered at the till when a disconnected customer pays, prepaid or postpaid. Ticked by default; staff may leave it off. Never added to a balance. 0 means no fee."
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

        {/* ---- 3. New customers (migrations 0017, 0032) ---- */}
        <Card title="New Customers">
          {!connectionMonth.available ? (
            <p className="text-[11px] text-amber-400/90">Needs migration 0032.</p>
          ) : null}
          <Toggle
            name="charge_connection_month"
            label="Charge the connection month"
            checked={chargeConnection}
            onChange={setChargeConnection}
            disabled={!connectionMonth.available}
          />
          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-gray-500">
            <li>
              On: a customer connected partway through a month is charged for that month from their
              connection day to its end, at the daily rate, rounded to the nearest hundred.{' '}
              {billingType === 'prepaid'
                ? 'Charged when they are provisioned.'
                : 'Charged on the next bill day.'}
            </li>
            <li>Off: nothing is charged for the connection month. They start on the 1st of the next month.</li>
            <li>Either way it is a month charge like any other: on their balance and at the till. There is no separate first period.</li>
          </ul>

          <Toggle
            name="first_expiry_rule_enabled"
            label="Provision starts on a cut-off day at least 21 days away"
            checked={firstExpiryRule}
            onChange={setFirstExpiryRule}
            disabled={!firstPeriodAvailable}
          />
          <p className="text-[11px] text-gray-600">
            Which of the two cut-off dates the Provision popup starts on. It changes no charge.
            {firstPeriodHint ? ' ' + firstPeriodHint : ''}
          </p>
        </Card>

        {/* ---- 4. Rates. The tax rate moved to Settings > Bill Design on
            2026-10-19: rates are tax-inclusive, so the rate only ever prints,
            and it sits beside the switch that says whether it does. ---- */}
        <Card title="Rates">
          <p className="text-[11px] text-gray-600">
            Tax rate and the tax line are under{' '}
            <a href="/dashboard/settings/bill-design" className="text-blue-400 hover:text-blue-300">Bill Design</a>.
          </p>

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
