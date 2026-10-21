'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { emailCustomerBill, type EmailBillResult } from '@/app/actions/bills'

function Send({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="font-medium text-blue-400 transition hover:text-blue-300 disabled:cursor-not-allowed disabled:text-gray-600"
    >
      {pending ? 'Queuing…' : 'Email bill'}
    </button>
  )
}

/**
 * "Email bill" beside "Bill (PDF)" in the record's Payment History: sends the
 * customer that same PDF, by email, through the company's messaging.
 *
 * Rendered only when the company has switched bill emails on. `blocked` is the
 * reason it cannot go — no address, opted out, email not ready — said beside a
 * disabled control rather than discovered after a click.
 */
export function EmailBillButton({
  customerId,
  email,
  blocked,
}: {
  customerId: number
  email: string | null
  blocked: string | null
}) {
  const [state, action] = useActionState<EmailBillResult | null, FormData>(emailCustomerBill, null)

  return (
    <form action={action} className="inline">
      <input type="hidden" name="customer_id" value={customerId} />
      <span title={blocked ?? (email ? 'Send the bill to ' + email : undefined)}>
        <Send disabled={blocked !== null} />
      </span>
      {blocked ? (
        <span className="ml-1.5 text-gray-600">
          ({blocked.charAt(0).toLowerCase() + blocked.slice(1).replace(/\.$/, '')})
        </span>
      ) : null}
      {state ? (
        <span role="status" className={'ml-2 ' + (state.ok ? 'text-green-400' : 'text-red-400')}>
          {state.ok ? state.message : state.error}
        </span>
      ) : null}
    </form>
  )
}
