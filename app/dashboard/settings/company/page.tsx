import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { GeneralSettingsForm } from '@/components/settings/GeneralSettingsForm'
import {
  CURRENCIES, DATE_FORMATS, getGeneralSettings, TIMEZONES,
} from '@/lib/data/company'
import { currencySymbol } from '@/lib/format'
import { GENERAL_SETTINGS_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'General Settings · ISPMan' }

/**
 * Guarded with the same rule the nav uses (lib/settings-nav.ts), so a role that
 * cannot see the link cannot reach the page by typing the URL either.
 * This section is company_admin only — managers are excluded.
 */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'company')) {
    redirect('/dashboard?denied=manage_company_settings')
  }
  return session
}

export default async function GeneralSettingsPage() {
  const { company } = await guard()
  const [settings, caps] = await Promise.all([
    getGeneralSettings(company.id),
    getSchemaCapabilities(),
  ])

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Profile, regional, billing and network defaults for {company.name}.
      </p>

      {!caps.generalSettings ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration 0007 not applied</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            Date format, grace period, tax rate, expiry warning, DDNS hostname and network
            secret are disabled until their columns exist. {GENERAL_SETTINGS_HINT}
          </p>
        </div>
      ) : null}

      <GeneralSettingsForm
        settings={settings}
        currencies={CURRENCIES}
        timezones={TIMEZONES}
        dateFormats={DATE_FORMATS}
        expiryModeAvailable={caps.expiryMode}
        generalAvailable={caps.generalSettings}
        defaultRateAvailable={caps.defaultMonthlyRate}
        thresholdsAvailable={caps.billingThresholds}
        currencySymbol={currencySymbol(settings.currency)}
      />
    </div>
  )
}
