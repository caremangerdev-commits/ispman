import 'server-only'

import { getSmsDevice } from '@/lib/data/sms'
import { sendablePhone } from '@/lib/phone'
import { relayConfigured, sendMessage } from '@/lib/sms/relay'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Sends ONE SMS straight to a customer, the way the login code goes out —
 * bypassing the routed outbox and its per-kind templates. For notifications
 * that are off by default and have no editable template: ticket replies and
 * outage notices (migration 0037).
 *
 * NEVER THROWS. Returns true only when the relay accepted the message. Every
 * gate is checked here so a caller cannot forget one: the SMS master switch,
 * the per-feature switch (which defaults OFF), the customer's opt-out, the
 * company's foreign-number policy, and a paired device.
 */
export async function sendDirectSms(opts: {
  companyId: number
  customerId: number
  text: string
  /** The settings column that turns this kind of message on, e.g. 'notify_outage_enabled'. */
  gateColumn: 'notify_ticket_reply_enabled' | 'notify_outage_enabled'
  /** Relay idempotency key, so a retried send is not delivered twice. */
  idemKey: string
}): Promise<boolean> {
  try {
    const caps = await getSchemaCapabilities()
    if (!caps.sms || !caps.portalTier2 || !relayConfigured()) return false

    const db = tenantClient()
    const { data: s } = await db
      .from('settings')
      .select('sms_enabled, sms_allow_foreign, ' + opts.gateColumn)
      .eq('company_id', opts.companyId)
      .maybeSingle()
    const settings = s as Record<string, boolean | null> | null
    if (!settings?.sms_enabled || !settings[opts.gateColumn]) return false

    const { data: c } = await db
      .from('customers')
      .select('phone, sms_opted_out')
      .eq('company_id', opts.companyId)
      .eq('id', opts.customerId)
      .maybeSingle()
    const customer = c as { phone: string | null; sms_opted_out: boolean | null } | null
    if (!customer || customer.sms_opted_out) return false

    const e164 = sendablePhone(customer.phone, { allowForeign: Boolean(settings.sms_allow_foreign) })
    if (!e164) return false

    const device = await getSmsDevice(opts.companyId)
    if (!device || !device.apiUsername || !device.apiPassword) return false

    const res = await sendMessage(
      {
        username: device.apiUsername,
        password: device.apiPassword,
        deviceId: device.deviceId,
        simNumber: device.simNumber,
      },
      { id: opts.idemKey, text: opts.text, phone: e164 }
    )
    return res.ok
  } catch (err) {
    console.error('[sms] direct send failed:', (err as Error).message)
    return false
  }
}
