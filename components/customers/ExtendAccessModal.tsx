'use client'

import { CalendarClock } from 'lucide-react'
import { useState } from 'react'
import { createPortal, useFormStatus } from 'react-dom'

import { extendCustomer } from '@/app/actions/customers'
import { Modal } from '@/components/settings/Modal'

/** Local YYYY-MM-DD — toISOString would shift the day in western timezones. */
function toInputDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function ConfirmButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Extending…' : 'Extend Access'}
    </button>
  )
}

/**
 * Extend a customer's access to an explicitly chosen date.
 *
 * The date is submitted as `new_expiry` and written straight to the radcheck
 * Expiration row by extendCustomer. Past dates are blocked here and re-checked
 * on the server, since picking one would disconnect the customer rather than
 * extend them.
 */
export function ExtendAccessModal({
  customerId,
  customerName,
  radiusExpiry,
  radiusExpiryIso,
}: {
  customerId: number
  customerName: string
  /** Raw registry Expiration value, for display. */
  radiusExpiry: string | null
  /** The same date as an ISO string, for arithmetic. */
  radiusExpiryIso: string | null
}) {
  const [open, setOpen] = useState(false)

  // The trigger sits inside the customer form, and this dialog contains a form
  // of its own — nested forms are invalid HTML and the browser drops the inner
  // one, so the dialog is portalled to document.body instead. No mounted guard
  // is needed: `open` starts false, so this never portals during SSR.
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const min = toInputDate(today)

  // Default to one month past the REGISTRY expiry, or a month from today.
  // currentExpiry (billing) is deliberately not used for this.
  const base = radiusExpiryIso ? new Date(radiusExpiryIso) : new Date()
  const suggested = new Date(base.getTime() < today.getTime() ? today : base)
  suggested.setMonth(suggested.getMonth() + 1)

  const [value, setValue] = useState(toInputDate(suggested))
  const past = value < min

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-lg bg-green-500/10 px-3 py-1.5 text-xs font-semibold text-green-400 transition hover:bg-green-500/20"
      >
        <CalendarClock className="h-3.5 w-3.5" aria-hidden />
        Extend
      </button>

      {open
        ? createPortal(
        <Modal title="Extend Customer Access" onClose={() => setOpen(false)}>
          <form action={extendCustomer} className="space-y-4">
            <input type="hidden" name="id" value={customerId} />

            <div className="space-y-2 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-gray-500">Customer</span>
                <span className="font-medium text-gray-200">{customerName}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-gray-500">Current expiry</span>
                <span className="font-mono text-gray-300">{radiusExpiry ?? '—'}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="new_expiry" className="block text-xs font-medium text-gray-400">
                New Expiry Date
              </label>
              <input
                id="new_expiry"
                name="new_expiry"
                type="date"
                required
                min={min}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className={
                  'w-full rounded-lg border bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:ring-2 ' +
                  (past
                    ? 'border-red-700 focus:border-red-500 focus:ring-red-500/30'
                    : 'border-gray-700 focus:border-blue-500 focus:ring-blue-500/30')
                }
              />
              {past ? (
                <p role="alert" className="text-xs text-red-400">
                  Pick today or later — a past date would disconnect {customerName}.
                </p>
              ) : null}
            </div>

            <p className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-xs text-gray-500">
              This updates the customer&rsquo;s access in the network registry. Their
              billing dates are only updated if that succeeds.
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
              >
                Cancel
              </button>
              <ConfirmButton />
            </div>
          </form>
        </Modal>,
        document.body
      )
        : null}
    </>
  )
}
