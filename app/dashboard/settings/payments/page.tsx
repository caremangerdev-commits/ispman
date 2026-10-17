import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { PaymentGatewayCard } from '@/components/settings/PaymentGatewayCard'
import { getGatewaySettings } from '@/lib/data/payment-gateways'
import { portalUrlForCompany } from '@/lib/data/portal'
import { externalHost } from '@/lib/portal/config'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'Online Payments · ISPMan' }

/** Same rule as the nav, so the URL cannot be used to bypass the menu. */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'payments')) {
    redirect('/dashboard?denied=manage_company_settings')
  }
  return session
}

export default async function OnlinePaymentsPage() {
  const { company } = await guard()
  const caps = await getSchemaCapabilities()

  // The webhook is reached by Fygaro's servers on the staff domain the operator
  // is viewing this on — behind Apache the real host is in X-Forwarded-Host.
  const h = await headers()
  const host = externalHost(h) ?? 'your-domain'
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const webhookUrl = proto + '://' + host + '/api/payments/fygaro/' + company.id + '/webhook'

  const [settings, portalUrl] = await Promise.all([
    caps.paymentGateways ? getGatewaySettings(company.id, 'fygaro') : Promise.resolve(null),
    portalUrlForCompany(company.id),
  ])
  // Where Fygaro brings the customer back after paying — the portal's own
  // confirmation page. Null when the portal domain or this company's slug is unset.
  const returnUrl = portalUrl ? portalUrl + '/pay/complete' : null

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-gray-500">
        Let {company.name}&apos;s customers pay by card from the portal. ISPMan records an online
        payment through the same flow as the till — same extension, same receipt — the moment
        Fygaro confirms it.
      </p>

      <PaymentGatewayCard
        available={caps.paymentGateways}
        settings={settings}
        webhookUrl={webhookUrl}
        returnUrl={returnUrl}
      />
    </div>
  )
}
