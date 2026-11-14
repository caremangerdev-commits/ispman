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

/**
 * One card per gateway, in the order they are offered. A company takes payments
 * through one at a time — saving one with the switch on turns the other off
 * (lib/data/payment-gateways.ts#saveGatewayCredentials) and keeps its keys, so
 * moving between them is a tick rather than a re-setup.
 */
const PROVIDERS = ['fygaro', 'dime'] as const

export default async function OnlinePaymentsPage() {
  const { company } = await guard()
  const caps = await getSchemaCapabilities()

  // The webhook is reached by the provider's servers on the staff domain the
  // operator is viewing this on — behind Apache the real host is in
  // X-Forwarded-Host.
  const h = await headers()
  const host = externalHost(h) ?? 'your-domain'
  // HTTPS UNLESS WE ARE PLAINLY IN DEV.
  //
  // X-Forwarded-Proto arrives as "http" from this Apache even on the TLS
  // vhost, so trusting it printed an http:// webhook URL for an operator to
  // paste into their gateway. Dime refuses a non-HTTPS endpoint outright and
  // Fygaro would be posting payment notifications in clear. The scheme a
  // gateway must call us on is a property of the deployment, not of whatever
  // header happened to survive the proxy, so only a local host gets http.
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
  const proto = local ? (h.get('x-forwarded-proto') ?? 'http') : 'https'
  const webhookUrlFor = (provider: string) =>
    proto + '://' + host + '/api/payments/' + provider + '/' + company.id + '/webhook'

  const [saved, portalUrl] = await Promise.all([
    Promise.all(
      PROVIDERS.map((p) =>
        caps.paymentGateways ? getGatewaySettings(company.id, p) : Promise.resolve(null)
      )
    ),
    portalUrlForCompany(company.id),
  ])
  // Where the customer is brought back after paying — the portal's own
  // confirmation page. Null when the portal domain or this company's slug is unset.
  const returnUrl = portalUrl ? portalUrl + '/pay/complete' : null

  const live = PROVIDERS.find((p, i) => saved[i]?.enabled) ?? null

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-gray-500">
        Let {company.name}&apos;s customers pay by card from the portal. ISPMan records an online
        payment through the same flow as the till — same extension, same receipt — the moment the
        gateway confirms it.
      </p>

      <p className="text-xs text-gray-600">
        {live
          ? 'Taking payments through ' + (live === 'dime' ? 'Dime Pay' : 'Fygaro') + '.'
          : 'No gateway is on, so the portal shows no pay button.'}
      </p>

      {PROVIDERS.map((provider, i) => (
        <PaymentGatewayCard
          key={provider}
          provider={provider}
          available={caps.paymentGateways}
          settings={saved[i]}
          webhookUrl={webhookUrlFor(provider)}
          returnUrl={returnUrl}
        />
      ))}
    </div>
  )
}
