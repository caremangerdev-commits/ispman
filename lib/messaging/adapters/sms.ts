import 'server-only'

import { getSmsDevice, type MessagingSettings } from '@/lib/data/sms'
import type { ChannelAdapter, RecipientSource, RecipientVerdict } from '@/lib/messaging/adapter'
import { classifyPhone, PHONE_SKIP_REASON, sendablePhone } from '@/lib/phone'
import {
  getMessageState, relayConfigured, sendMessage, type RelayCredentials,
} from '@/lib/sms/relay'

/**
 * SMS through the SMSGate relay — the first channel, now as an adapter.
 *
 * Everything provider-specific stays where it was: lib/sms/relay.ts is the
 * HTTP client, sms_devices holds the pairing, lib/phone.ts decides what a
 * usable number is. This file is the seam between those and the channel-
 * neutral queue, and it holds nothing the dispatcher used to do inline.
 */

type SmsContext = { creds: RelayCredentials }

const SIX_HOURS = 6 * 60 * 60

export const smsAdapter: ChannelAdapter<SmsContext> = {
  channel: 'sms',
  label: 'SMS',
  supportsAttachments: false,
  supportsHtml: false,

  configured: () => relayConfigured(),

  async tenantReady(companyId, settings) {
    if (!relayConfigured()) return { ready: false, reason: 'This server has no SMS relay configured.' }
    if (!settings.smsEnabled) return { ready: false, reason: 'SMS is switched off for this company.' }
    const device = await getSmsDevice(companyId)
    if (!device?.apiUsername || !device?.apiPassword) {
      return { ready: false, reason: 'No phone is paired for this company.' }
    }
    return {
      ready: true,
      context: {
        creds: {
          username: device.apiUsername,
          password: device.apiPassword,
          deviceId: device.deviceId,
          simNumber: device.simNumber,
        },
      },
    }
  },

  recipientFor(customer: RecipientSource, settings: MessagingSettings): RecipientVerdict {
    if (customer.sms_opted_out) return { ok: false, reason: 'Opted out of SMS' }
    const e164 = sendablePhone(customer.phone, { allowForeign: settings.allowForeign })
    if (e164) return { ok: true, address: e164 }
    const kind = classifyPhone(customer.phone).kind
    return { ok: false, reason: kind === 'jamaica' ? 'Phone number cannot be used' : PHONE_SKIP_REASON[kind] }
  },

  throttleSeconds: (settings) => settings.throttleSeconds,

  async send(context, message) {
    return sendMessage(context.creds, {
      id: String(message.id),
      text: message.body,
      phone: message.recipient,
      // 100+ bypasses the relay's own rate limiting. ONLY for a receipt, so a
      // customer at a counter is not queued behind a blast — never for bulk.
      priority: message.urgent ? 100 : 0,
      // A notice that could not be delivered today is not worth delivering
      // tomorrow.
      ttlSeconds: SIX_HOURS,
    })
  },

  async deliveryState(context, providerId) {
    const state = await getMessageState(context.creds, providerId)
    if (!state?.state) return { state: 'unknown', error: null }
    const s = state.state.toLowerCase()
    if (s === 'delivered') return { state: 'delivered', error: null }
    if (s === 'failed') {
      return { state: 'failed', error: 'Phone could not send: ' + (state.error ?? 'no reason given by the relay') }
    }
    return { state: 'pending', error: null }
  },
}
