import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { BillSettingsForm } from '@/components/settings/BillSettingsForm'
import { getBillSettings } from '@/lib/data/bill-settings'
import { getEnabledGateway } from '@/lib/data/payment-gateways'
import { getMessagingSettings } from '@/lib/data/sms'
import { instantToDateOnly } from '@/lib/format'
import { adapterFor } from '@/lib/messaging/registry'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'
import { tenantClient } from '@/lib/supabase/tenant'

export const metadata: Metadata = { title: 'Bill Design · ISPMan' }

/**
 * Settings > Bill Design — was Settings > Bills, at /dashboard/settings/bills,
 * which next.config.ts redirects here. Renamed because "Bills" read like a list
 * of bills; this page is about how the bill looks and what only it says.
 *
 * Guarded with the nav's rule (lib/settings-nav.ts), like every settings page.
 */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'bill-design')) {
    redirect('/dashboard?denied=manage_company_settings')
  }
  return session
}

export default async function BillDesignPage() {
  const { company } = await guard()
  const caps = await getSchemaCapabilities()
  const [settings, companyRes, gateway, messaging, tzRes] = await Promise.all([
    getBillSettings(company.id),
    tenantClient().from('companies').select('address').eq('id', company.id).maybeSingle(),
    caps.paymentGateways ? getEnabledGateway(company.id).catch(() => null) : Promise.resolve(null),
    getMessagingSettings(company.id),
    tenantClient().from('settings').select('timezone').eq('company_id', company.id).maybeSingle(),
  ])
  const contactAddress = ((companyRes.data as { address?: string | null } | null)?.address ?? '').trim() || null
  const timezone = (tzRes.data as { timezone?: string | null } | null)?.timezone || 'America/Jamaica'

  // Whether email can go at all for this company, asked of the email adapter:
  // the bill switch does nothing while email itself is off.
  const emailReady = messaging.channelsAvailable
    ? await adapterFor('email').tenantReady(company.id, messaging)
    : { ready: false as const, reason: 'Email needs migration 0022.' }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        How {company.name}&apos;s bills look and what only a bill says. Your logo, colour and letterhead are
        under General Settings, because the portal and emails use them too.
      </p>

      {!caps.billDocuments ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration 0038 not applied</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            Until it is, every bill is the Statement with no tax line, and these settings cannot be saved.
            The samples below still show what your bills look like today.
          </p>
        </div>
      ) : null}

      <BillSettingsForm
        settings={settings}
        available={caps.billDocuments}
        taxRateAvailable={caps.generalSettings}
        contactAddress={contactAddress}
        invoicePrefixAvailable={caps.invoicePrefix}
        exampleMonth={instantToDateOnly(new Date(), timezone).slice(0, 7).replace('-', '')}
        hasLetterhead={Boolean(settings.letterheadPath)}
        onlineAvailable={gateway !== null}
        emailBills={{
          available: caps.emailBills,
          on: messaging.billEmail,
          emailBlocked: emailReady.ready ? null : emailReady.reason,
        }}
      />
    </div>
  )
}
