'use client'

import { ACCOUNT_PREFIX_MAX } from '@/lib/account-number'
import { COUNTRIES, TAX_ID_MAX, taxIdLabel } from '@/lib/tax-id'
import { Eye, EyeOff } from 'lucide-react'
import { useActionState, useState } from 'react'

import { saveCompanyProfile, type CompanyResult } from '@/app/actions/company'
import { Card, Field, SaveButton, Toggle } from '@/components/settings/form-parts'
import { settingsInput } from '@/components/settings/Modal'
import type { GeneralSettings } from '@/lib/data/company'

/**
 * Settings > General: who the company is, where it is, and its network.
 *
 * Billing fields (the billing model and engine, bill and cut-off days, grace,
 * first-period rules, tax, the default rate, the thresholds) moved to
 * Settings > Billing on 2026-10-03 — see BillingSettingsForm.
 */
export function GeneralSettingsForm({
  settings,
  currencies,
  timezones,
  dateFormats,
  generalAvailable,
  taxIdAvailable,
  accountNumbersAvailable,
}: {
  settings: GeneralSettings
  currencies: readonly string[]
  timezones: readonly { value: string; label: string }[]
  dateFormats: readonly string[]
  generalAvailable: boolean
  /** Migration 0019 — hides the country and label fields until applied. */
  taxIdAvailable: boolean
  /** Migration 0020 — hides the prefix field until applied. */
  accountNumbersAvailable: boolean
}) {
  const [state, action] = useActionState<CompanyResult | null, FormData>(saveCompanyProfile, null)

  const [sms, setSms] = useState(settings.smsEnabled)
  const [emailOn, setEmailOn] = useState(settings.emailEnabled)
  const [showSecret, setShowSecret] = useState(false)

  // What the tax id field is called right now, shown as the placeholder and in
  // the hint so the operator can see what leaving the override blank gives.
  const [country, setCountry] = useState(settings.country)
  const resolvedTaxLabel = taxIdLabel(settings.taxIdLabel, country)

  const lockedHint = generalAvailable ? undefined : 'Needs migration 0007.'

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

          {/* Country, and what it implies. Setting it names the tax id field
              correctly and is the ONLY thing that lets its format be checked —
              until a country is stated the field accepts anything, deliberately
              and permanently. See lib/tax-id.ts. */}
          {taxIdAvailable ? (
            <>
              <Field
                label="Country"
                htmlFor="country"
                hint="Names the tax ID field. Leave blank to accept any format."
              >
                <select
                  id="country"
                  name="country"
                  defaultValue={settings.country}
                  onChange={(e) => setCountry(e.target.value)}
                  className={settingsInput}
                >
                  <option value="">Not stated</option>
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
              </Field>

              <Field
                label="Tax ID label"
                htmlFor="tax_id_label"
                hint={'Blank uses your country’s: currently ' + resolvedTaxLabel + '.'}
              >
                <input
                  id="tax_id_label"
                  name="tax_id_label"
                  maxLength={TAX_ID_MAX}
                  defaultValue={settings.taxIdLabel}
                  placeholder={resolvedTaxLabel}
                  className={settingsInput}
                />
              </Field>
            </>
          ) : null}

          {/* Applies to numbers issued from here on. Existing account numbers
              are stored whole and are never renamed — see migration 0020. */}
          {accountNumbersAvailable ? (
            <Field
              label="Account number prefix"
              htmlFor="account_number_prefix"
              hint="Optional. Two or three letters, e.g. EZ or VCL. Applies to new customers only; existing numbers keep the form they were issued in."
            >
              <input
                id="account_number_prefix"
                name="account_number_prefix"
                maxLength={ACCOUNT_PREFIX_MAX}
                defaultValue={settings.accountNumberPrefix}
                placeholder="none"
                className={settingsInput}
              />
            </Field>
          ) : null}

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

        {/* ---- 3. Notifications & Network ---- */}
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
