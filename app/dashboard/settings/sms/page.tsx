import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { SmsSettingsForm } from '@/components/settings/SmsSettingsForm'
import { loadEnrichedCustomers } from '@/lib/data/customers'
import { getSmsDevice, getSmsSettings, stripSecret } from '@/lib/data/sms'
import { summarisePhones } from '@/lib/phone'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'
import { relayConfigured } from '@/lib/sms/relay'

export const metadata: Metadata = { title: 'SMS Notifications · ISPMan' }

/** Same rule as the nav, so the URL cannot be used to bypass the menu. */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'sms')) {
    redirect('/dashboard?denied=manage_company_settings')
  }
  return session
}

export default async function SmsSettingsPage() {
  const { company } = await guard()
  const caps = await getSchemaCapabilities()

  if (!caps.sms) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration required</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            SMS notifications need migration 0021. Ask your administrator to apply it.
            Until then nothing is queued and no message can be sent.
          </p>
        </div>
      </div>
    )
  }

  const [settings, device, customers] = await Promise.all([
    getSmsSettings(company.id),
    getSmsDevice(company.id),
    loadEnrichedCustomers(company.id),
  ])

  // Counted with the company's OWN overseas setting, so the number on the page
  // is the number this company can actually reach and not a platform average.
  const { sendable } = summarisePhones(customers, { allowForeign: settings.allowForeign })

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-gray-500">
        Text your customers from your own number, using a phone in your office. Nothing
        is sent until you pair a phone and switch a message type on.
      </p>

      {/* stripSecret, not the device row. A server component hands every field it
          passes to a client component to the browser in the HTML payload, and the
          relay password must never be one of them. */}
      <SmsSettingsForm
        settings={settings}
        device={stripSecret(device)}
        companyName={company.name}
        relayConfigured={relayConfigured()}
        reachableCount={sendable.length}
        totalCount={customers.length}
        deviceMinutesAgo={device?.lastSeenMinutesAgo ?? null}
      />
    </div>
  )
}
