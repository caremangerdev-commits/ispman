import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { BillSettingsForm } from '@/components/settings/BillSettingsForm'
import { getBillSettings } from '@/lib/data/bill-settings'
import { getEnabledGateway } from '@/lib/data/payment-gateways'
import { currencySymbol } from '@/lib/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'
import { tenantClient } from '@/lib/supabase/tenant'

export const metadata: Metadata = { title: 'Bills · ISPMan' }

/** Guarded with the nav's rule (lib/settings-nav.ts), like every settings page. */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'bills')) {
    redirect('/dashboard?denied=manage_company_settings')
  }
  return session
}

export default async function BillSettingsPage() {
  const { company } = await guard()
  const caps = await getSchemaCapabilities()
  const [settings, companyRes, gateway] = await Promise.all([
    getBillSettings(company.id),
    tenantClient().from('companies').select('address').eq('id', company.id).maybeSingle(),
    caps.paymentGateways ? getEnabledGateway(company.id).catch(() => null) : Promise.resolve(null),
  ])
  const contactAddress = ((companyRes.data as { address?: string | null } | null)?.address ?? '').trim() || null

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        What {company.name}&apos;s bills look like and what they say about the company.
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
        defaultSymbol={currencySymbol(settings.currency)}
        hasLetterhead={Boolean(settings.letterheadPath)}
        onlineAvailable={gateway !== null}
      />
    </div>
  )
}
