import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { BrandingCard } from '@/components/settings/BrandingCard'
import { GeneralSettingsForm } from '@/components/settings/GeneralSettingsForm'
import { brandFor, getBrandColor } from '@/lib/data/brand'
import {
  CURRENCIES, DATE_FORMATS, getGeneralSettings, TIMEZONES,
} from '@/lib/data/company'
import { getMessagingSettings } from '@/lib/data/sms'
import { currencySymbol } from '@/lib/format'
import { GENERAL_SETTINGS_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'
import { renderTemplate } from '@/lib/sms/templates'

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

/** A customer nobody has, for the Branding card's email preview. */
const SAMPLE_VALUES = {
  '{{name}}': 'Margaret Williams',
  '{{first_name}}': 'Margaret',
  '{{account}}': '10122',
  '{{amount}}': '4,500.00',
  '{{balance}}': '4,500.00',
  '{{expiry}}': '30 September 2026',
  '{{days}}': '3',
}

export default async function GeneralSettingsPage() {
  const { company } = await guard()
  const [settings, caps, brand, color, messaging] = await Promise.all([
    getGeneralSettings(company.id),
    getSchemaCapabilities(),
    brandFor(company.id),
    getBrandColor(company.id),
    getMessagingSettings(company.id),
  ])

  // The preview uses the company's OWN expiry warning wording, so a template
  // they have edited is what they see dressed in the shell.
  const sample = messaging.emailTemplates.expiry_warning
  const sampleValues = { ...SAMPLE_VALUES, '{{company}}': brand.name }

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
        firstPeriodAvailable={caps.firstPeriod}
        taxIdAvailable={caps.taxId}
        accountNumbersAvailable={caps.accountNumbers}
        billingEngineAvailable={caps.billingEngine}
        currencySymbol={currencySymbol(settings.currency)}
      />

      <BrandingCard
        available={caps.branding}
        companyName={brand.name}
        contact={brand.contact}
        // The stored file itself, inline: the bucket is private and stays
        // private, so the page is handed bytes rather than a link.
        logo={brand.logo
          ? {
              dataUri: 'data:image/png;base64,' + Buffer.from(brand.logo.png).toString('base64'),
              width: brand.logo.width,
              height: brand.logo.height,
            }
          : null}
        color={color}
        sampleSubject={renderTemplate(sample.subject, sampleValues)}
        sampleBody={renderTemplate(sample.body, sampleValues)}
      />
    </div>
  )
}
