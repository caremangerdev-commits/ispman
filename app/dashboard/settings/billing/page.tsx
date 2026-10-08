import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { BillingSettingsForm } from '@/components/settings/BillingSettingsForm'
import { getGeneralSettings } from '@/lib/data/company'
import { prepaidCalendarFor } from '@/lib/data/prepaid-calendar'
import { currencySymbol } from '@/lib/format'
import { GENERAL_SETTINGS_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'Billing · ISPMan' }

/**
 * Guarded with the same rule the nav uses (lib/settings-nav.ts), so a role that
 * cannot see the link cannot reach the page by typing the URL either. Same
 * permission as General Settings: company_admin and above, managers excluded.
 */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'billing')) {
    redirect('/dashboard?denied=manage_company_settings')
  }
  return session
}

export default async function BillingSettingsPage() {
  const { company } = await guard()
  const [settings, caps, prepaid] = await Promise.all([
    getGeneralSettings(company.id),
    getSchemaCapabilities(),
    prepaidCalendarFor(company.id),
  ])

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        How and when {company.name} charges its customers.
      </p>

      {!caps.generalSettings ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration 0007 not applied</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            Grace period and tax rate are disabled until their columns exist.{' '}
            {GENERAL_SETTINGS_HINT}
          </p>
        </div>
      ) : null}

      <BillingSettingsForm
        settings={settings}
        expiryModeAvailable={caps.expiryMode}
        generalAvailable={caps.generalSettings}
        defaultRateAvailable={caps.defaultMonthlyRate}
        thresholdsAvailable={caps.billingThresholds}
        firstPeriodAvailable={caps.firstPeriod}
        billingEngineAvailable={caps.billingEngine}
        currencySymbol={currencySymbol(settings.currency)}
        prepaidCalendar={prepaid}
      />
    </div>
  )
}
