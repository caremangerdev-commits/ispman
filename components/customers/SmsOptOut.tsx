'use client'

import { BellOff, BellRing, MailX, Mail } from 'lucide-react'
import { useState, useTransition } from 'react'

import { setOptOut } from '@/app/actions/sms'
import { CHANNEL_LABELS, type Channel } from '@/lib/messaging/routes'

/**
 * The customer's own choice about being messaged, PER CHANNEL.
 *
 * OUTRANKS EVERY COMPANY SWITCH. A tenant with a channel on, credentials in
 * place and every message type enabled still sends nothing on that channel to
 * a customer who has opted out of it — see lib/messaging/adapters, where each
 * adapter's recipientFor() checks its own opt-out first.
 *
 * Deliberately not part of the edit form. It is not a field a member of staff
 * fills in from a spreadsheet; it is a request a customer made, and it should
 * take one click to honour on the phone while they are asking.
 */
export function ChannelOptOut({
  customerId, channel, optedOut, canEdit,
}: {
  customerId: number
  channel: Channel
  optedOut: boolean
  canEdit: boolean
}) {
  const [on, setOn] = useState(optedOut)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const noun = channel === 'sms' ? 'text messages' : 'emails'
  const OnIcon = channel === 'sms' ? BellOff : MailX
  const OffIcon = channel === 'sms' ? BellRing : Mail

  function toggle() {
    const next = !on
    setError(null)
    // Optimistic, then reverted if the write fails — the alternative is a
    // control that appears not to respond while the round trip happens.
    setOn(next)
    start(async () => {
      const res = await setOptOut(customerId, channel, next)
      if (!res.ok) {
        setOn(!next)
        setError(res.error)
      }
    })
  }

  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5">
      <div className="flex items-start gap-2">
        {on
          ? <OnIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
          : <OffIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden />}
        <div>
          <p className="text-xs font-medium text-gray-400">{CHANNEL_LABELS[channel]} notifications</p>
          <p className="mt-0.5 text-[11px] text-gray-600">
            {on
              ? 'This customer has asked not to receive ' + noun + '.'
              : 'This customer can receive ' + noun + '.'}
          </p>
          {error ? <p className="mt-0.5 text-[11px] text-red-400">{error}</p> : null}
        </div>
      </div>

      {canEdit ? (
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          className={
            'shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50 ' +
            (on
              ? 'border-gray-800 bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              : 'border-amber-900/60 text-amber-400 hover:bg-amber-950/40')
          }
        >
          {pending ? '…' : on ? 'Allow ' + CHANNEL_LABELS[channel] : 'Opt out'}
        </button>
      ) : null}
    </div>
  )
}

/** The SMS toggle under its original name, for the existing caller. */
export function SmsOptOut(props: { customerId: number; optedOut: boolean; canEdit: boolean }) {
  return <ChannelOptOut channel="sms" {...props} />
}
