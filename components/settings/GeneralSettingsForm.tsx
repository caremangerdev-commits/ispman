'use client'

import { Eye, EyeOff } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { saveCompanyProfile, type CompanyResult } from '@/app/actions/company'
import { settingsInput } from '@/components/settings/Modal'
import type { GeneralSettings } from '@/lib/data/company'
import {
  type BillingType,
} from '@/lib/billing'
import { EXPIRY_MODES, EXPIRY_MODE_HELP, EXPIRY_MODE_LABELS, type ExpiryMode } from '@/lib/types'

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save Settings'}
    </button>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="mb-4 text-sm font-semibold text-white">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function Field({
  label, htmlFor, hint, children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-gray-400">{label}</label>
      {children}
      {hint ? <p className="text-[11px] text-gray-600">{hint}</p> : null}
    </div>
  )
}

/** On/off switch backed by a hidden input so it posts with the form. */
function Toggle({
  name, label, checked, onChange, disabled,
}: {
  name: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-gray-400">{label}</span>
      <input type="hidden" name={name} value={String(checked)} />
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={
          'relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ' +
          (checked ? 'bg-blue-600' : 'bg-gray-700')
        }
      >
        <span
          className={
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ' +
            (checked ? 'left-[22px]' : 'left-0.5')
          }
        />
      </button>
    </div>
  )
}

export function GeneralSettingsForm({
  settings,
  currencies,
  timezones,
  dateFormats,
  expiryModeAvailable,
  generalAvailable,
  defaultRateAvailable,
  thresholdsAvailable,
  currencySymbol,
}: {
  settings: GeneralSettings
  currencies: readonly string[]
  timezones: readonly { value: string; label: string }[]
  dateFormats: readonly string[]
  expiryModeAvailable: boolean
  generalAvailable: boolean
  defaultRateAvailable: boolean
  /** migration 0011 — the default billing type for new customers. */
  /** migration 0012 — the three billing policy thresholds. */
  thresholdsAvailable: boolean
  currencySymbol: string
}) {
  const [state, action] = useActionState<CompanyResult | null, FormData>(saveCompanyProfile, null)

  const [mode, setMode] = useState<ExpiryMode>(settings.defaultExpiryMode)
  // Not state any more: there is no control to change it. See lib/billing.ts.
  const billingType: BillingType = settings.defaultBillingType
  const [sms, setSms] = useState(settings.smsEnabled)
  const [emailOn, setEmailOn] = useState(settings.emailEnabled)
  const [showSecret, setShowSecret] = useState(false)

  const lockedHint = generalAvailable ? undefined : 'Needs migration 0007.'
  const thresholdHint = thresholdsAvailable ? undefined : 'Needs migration 0012.'
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
        {/* ---- 1. Company Profile ---- */}
        <Card title="Company Profile">
          <Field label="Company Name" htmlFor="name">
            <input id="name" name="name" required defaultValue={settings.name} className={settingsInput} />
          </Field>
          <Field label="Email" htmlFor="email">
            <input id="email" name="email" type="email" defaultValue={settings.email ?? ''} className={settingsInput} />
          </Field>
          <Field label="Phone" htmlFor="phone">
            <input id="phone" name="phone" defaultValue={settings.phone ?? ''} className={settingsInput} />
          </Field>
          <Field label="Address" htmlFor="address">
            <textarea
              id="address"
              name="address"
              rows={3}
              defaultValue={settings.address ?? ''}
              className={settingsInput + ' resize-y'}
            />
          </Field>
        </Card>

        {/* ---- 2. Regional Settings ---- */}
        <Card title="Regional Settings">
          <Field label="Timezone" htmlFor="timezone">
            <select id="timezone" name="timezone" defaultValue={settings.timezone} className={settingsInput}>
              {timezones.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Currency" htmlFor="currency">
            <select id="currency" name="currency" defaultValue={settings.currency} className={settingsInput}>
              {currencies.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>

          <Field label="Date Format" htmlFor="date_format" hint={lockedHint}>
            <select
              id="date_format"
              name="date_format"
              defaultValue={settings.dateFormat}
              disabled={!generalAvailable}
              className={settingsInput + (generalAvailable ? '' : ' cursor-not-allowed opacity-50')}
            >
              {dateFormats.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </Field>
        </Card>

        {/* ---- 3. Billing Defaults ---- */}
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

          {/* No Default Billing Type control. One billing model — see
              lib/billing.ts. The setting column is still posted so the save
              action and the settings row are unchanged. */}
          <input type="hidden" name="default_billing_type" value={billingType} />

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

          {/* Policy thresholds. Stored for the collections and billing-run work
              that will read them; the payment flow does not consult them yet,
              so changing one has no effect on what a cashier sees today. */}
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

        {/* ---- 4. Notifications & Network ---- */}
        <Card title="Notifications &amp; Network">
          <Toggle name="sms_enabled" label="SMS Notifications" checked={sms} onChange={setSms} />
          <Toggle name="email_enabled" label="Email Notifications" checked={emailOn} onChange={setEmailOn} />

          <Field
            label="Expiry Warning Days"
            htmlFor="expiry_warning_days"
            hint={lockedHint ?? 'Days before expiry to send warning'}
          >
            <input
              id="expiry_warning_days"
              name="expiry_warning_days"
              type="number"
              min="1"
              max="14"
              defaultValue={settings.expiryWarningDays}
              disabled={!generalAvailable}
              className={settingsInput + (generalAvailable ? '' : ' cursor-not-allowed opacity-50')}
            />
          </Field>

          <Field label="DDNS Hostname" htmlFor="ddns_hostname" hint={lockedHint}>
            <input
              id="ddns_hostname"
              name="ddns_hostname"
              defaultValue={settings.ddnsHostname ?? ''}
              placeholder="e.g. myisp.ddns.net"
              disabled={!generalAvailable}
              className={settingsInput + (generalAvailable ? '' : ' cursor-not-allowed opacity-50')}
            />
          </Field>

          <Field label="Network Shared Secret" htmlFor="radius_secret" hint={lockedHint}>
            <div className="relative">
              <input
                id="radius_secret"
                name="radius_secret"
                type={showSecret ? 'text' : 'password'}
                defaultValue={settings.radiusSecret ?? ''}
                autoComplete="new-password"
                disabled={!generalAvailable}
                className={settingsInput + ' pr-9' + (generalAvailable ? '' : ' cursor-not-allowed opacity-50')}
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-500 transition hover:text-gray-300"
              >
                {showSecret ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          </Field>
        </Card>
      </div>

      <SaveButton />
    </form>
  )
}
