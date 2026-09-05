'use client'

import { Undo2 } from 'lucide-react'
import { useState } from 'react'
import { createPortal, useFormStatus } from 'react-dom'

import { correctExpiry } from '@/app/actions/customers'
import { dateOnlyToLocalDate } from '@/lib/format'
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
      className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Correcting…' : 'Correct Expiry'}
    </button>
  )
}

/**
 * Undo a mistaken extension by moving an expiry to an EARLIER date.
 *
 * The counterpart to ExtendAccessModal, and deliberately not folded into it.
 * Extend is routine CSR work with a guard behind it that refuses backwards
 * writes; this is a manager correcting a mistake, takes a written reason, and
 * routes to a different RADIUS function entirely
 * (lib/radius-db.ts#correctExpiryInRadius). Two buttons, because they are two
 * different acts — one grants access and the other takes it back.
 *
 * A PAST DATE IS ALLOWED HERE, unlike Extend. An extension that should never
 * have been granted may need the customer put back to an expiry that has
 * already passed. The date is only refused when it is not actually earlier than
 * the one on record, which the server re-checks against radcheck itself.
 */
export function CorrectExpiryModal({
  customerId,
  customerName,
  radiusExpiry,
  radiusExpiryDate,
}: {
  customerId: number
  customerName: string
  /** Raw registry Expiration value, for display. */
  radiusExpiry: string | null
  /** The same expiry as the calendar date it names, "YYYY-MM-DD". NOT an ISO
   *  instant — see ExtendAccessModal. */
  radiusExpiryDate: string | null
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')

  // Nested forms are invalid HTML and the browser drops the inner one, so the
  // dialog is portalled out of the customer form. `open` starts false, so this
  // never portals during SSR.
  const current = dateOnlyToLocalDate(radiusExpiryDate)
  const max = current ? toInputDate(new Date(current.getTime() - 86_400_000)) : undefined

  const notEarlier = Boolean(max) && value !== '' && value > (max as string)
  const ready = value !== '' && reason.trim() !== '' && !notEarlier

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-400 transition hover:bg-amber-500/20"
      >
        <Undo2 className="h-3.5 w-3.5" aria-hidden />
        Correct Expiry
      </button>

      {open
        ? createPortal(
          <Modal title="Correct Expiry Date" onClose={() => setOpen(false)}>
            <form action={correctExpiry} className="space-y-4">
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
                <label htmlFor="correct_expiry_date" className="block text-xs font-medium text-gray-400">
                  Corrected Expiry Date
                </label>
                <input
                  id="correct_expiry_date"
                  name="new_expiry"
                  type="date"
                  required
                  max={max}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className={
                    'w-full rounded-lg border bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:ring-2 ' +
                    (notEarlier
                      ? 'border-red-700 focus:border-red-500 focus:ring-red-500/30'
                      : 'border-gray-700 focus:border-amber-500 focus:ring-amber-500/30')
                  }
                />
                {notEarlier ? (
                  <p role="alert" className="text-xs text-red-400">
                    This only moves an expiry back. Use Extend Access to move one forward.
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="correct_expiry_reason" className="block text-xs font-medium text-gray-400">
                  Reason <span className="text-gray-600">(required)</span>
                </label>
                <textarea
                  id="correct_expiry_reason"
                  name="reason"
                  required
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Extended to 2027 by mistake — should have been one month."
                  className="w-full resize-y rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/30"
                />
                <p className="text-xs text-gray-500">
                  Recorded in the log with your name, the time, and both dates.
                </p>
              </div>

              <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/80">
                This shortens {customerName}&rsquo;s access in the network registry. If
                they are online now, their session may continue until it renews.
              </p>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
                >
                  Cancel
                </button>
                <span className={ready ? '' : 'pointer-events-none opacity-60'}>
                  <ConfirmButton />
                </span>
              </div>
            </form>
          </Modal>,
          document.body
        )
        : null}
    </>
  )
}
