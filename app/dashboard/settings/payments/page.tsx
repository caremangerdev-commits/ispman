import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { CardFeeCard } from '@/components/settings/CardFeeCard'
import { PaymentGatewayCard } from '@/components/settings/PaymentGatewayCard'
import { getBillSettings } from '@/lib/data/bill-settings'
import {
  cardFeeShare, gatewayWebhookStatus, getEnabledGateway, getGatewaySettings, sampleBillFor,
} from '@/lib/data/payment-gateways'
import { portalUrlForCompany } from '@/lib/data/portal'
import { gatewayFor } from '@/lib/payments/gateways'
import { webhookUrlFor } from '@/lib/payments/webhook-url'
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
  // X-Forwarded-Host. lib/payments/webhook-url.ts is the one definition, so
  // the address shown here is the address the save action registers.
  const h = await headers()

  // Asked of each provider in parallel with everything else: one slow gateway
  // should cost this page its own 8 seconds, not stack with the rest.
  const [saved, webhookStates, portalUrl, share, live, bill, sampleBill] = await Promise.all([
    Promise.all(
      PROVIDERS.map((p) =>
        caps.paymentGateways ? getGatewaySettings(company.id, p) : Promise.resolve(null)
      )
    ),
    Promise.all(
      PROVIDERS.map((p) =>
        caps.paymentGateways
          ? gatewayWebhookStatus(company.id, p, webhookUrlFor(h, p, company.id)).catch(() => null)
          : Promise.resolve(null)
      )
    ),
    portalUrlForCompany(company.id),
    caps.paymentGateways ? cardFeeShare(company.id) : Promise.resolve(0),
    caps.paymentGateways ? getEnabledGateway(company.id).catch(() => null) : Promise.resolve(null),
    getBillSettings(company.id),
    sampleBillFor(company.id),
  ])
  // Where the customer is brought back after paying — the portal's own
  // confirmation page. Null when the portal domain or this company's slug is unset.
  const returnUrl = portalUrl ? portalUrl + '/pay/complete' : null

  const liveProvider = PROVIDERS.find((p, i) => saved[i]?.enabled) ?? null

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-gray-500">
        Let {company.name}&apos;s customers pay by card from the portal. ISPMan records an online
        payment through the same flow as the till — same extension, same receipt — the moment the
        gateway confirms it.
      </p>

      <p className="text-xs text-gray-600">
        {liveProvider
          ? 'Taking payments through ' + (liveProvider === 'dime' ? 'Dime Pay' : 'Fygaro') + '.'
          : 'No gateway is on, so the portal shows no pay button.'}
      </p>

      {/* The step-by-step guide, where someone staring at these boxes will
          actually look for it rather than in an email they were sent once. */}
      <a
        href="https://ispman.online/help/dime-pay/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 transition hover:text-blue-300"
      >
        Read the step-by-step guide to setting this up
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
          <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>

      {PROVIDERS.map((provider, i) => (
        <PaymentGatewayCard
          key={provider}
          provider={provider}
          available={caps.paymentGateways}
          settings={saved[i]}
          webhookUrl={webhookUrlFor(h, provider, company.id)}
          webhookStatus={webhookStates[i]}
          returnUrl={returnUrl}
        />
      ))}

      <CardFeeCard
        available={caps.paymentGateways}
        share={share}
        live={
          live
            ? {
                label: gatewayFor(live.provider)?.label ?? live.provider,
                rate: live.feeRate,
                fixed: live.feeFixed,
              }
            : null
        }
        currencySymbol={bill.currencySymbol}
        sampleBill={sampleBill}
      />
    </div>
  )
}
