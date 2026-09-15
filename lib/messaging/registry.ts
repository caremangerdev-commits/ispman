import 'server-only'

import type { ChannelAdapter } from '@/lib/messaging/adapter'
import { emailAdapter } from '@/lib/messaging/adapters/email'
import { smsAdapter } from '@/lib/messaging/adapters/sms'
import { CHANNELS, type Channel } from '@/lib/messaging/routes'

/**
 * Every channel the platform can send on. A THIRD CHANNEL IS ONE LINE HERE
 * plus its adapter file; the queue, dispatcher, routing, batches and pages
 * iterate this and never name a channel themselves.
 */
const ADAPTERS: Record<Channel, ChannelAdapter> = {
  sms: smsAdapter as ChannelAdapter,
  email: emailAdapter as ChannelAdapter,
}

export function adapterFor(channel: Channel): ChannelAdapter {
  return ADAPTERS[channel]
}

/** In CHANNELS order. */
export function allAdapters(): ChannelAdapter[] {
  return CHANNELS.map((c) => ADAPTERS[c])
}
