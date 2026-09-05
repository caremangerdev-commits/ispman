'use client'

import { Scale } from 'lucide-react'
import { useState } from 'react'
import { createPortal, useFormStatus } from 'react-dom'

import { adjustCarriedBalance } from '@/app/actions/customers'
import { formatCurrency } from '@/lib/format'
import { Modal } from '@/components/settings/Modal'

function ConfirmButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Adjusting…' : 'Adjust Balance'}
    </button>
  )
}

/**
 * Correct a carried balance by hand, with a reason.
 *
 * The case this exists for: a customer changes plan after being billed, so the
 * balance still carries the old rate's charge. Nothing recalculates a period
 * already billed — a bill run only adds and a payment only subtracts — so
 * without this the only fix was editing the row in the SQL editor, which leaves
 * no trace.
 *
 * NOT A PAYMENT, and deliberately styled so it cannot be mistaken for one. No
 * money changes hands, no receipt is produced and nothing is added to
 * collections. It writes what the customer owes and says who decided that.
 */
export function AdjustBalanceModal({
  customerId,
  customerName,
  currentBalance,
}: {
  customerId: number
  customerName: string
  currentBalance: number
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(String(currentBalance))
  const [reason, setReason] = useState('')

  const parsed = Number(value)
  const valid = value !== '' && Number.isFinite(parsed) && parsed >= 0
  const unchanged = valid && Math.round(parsed * 100) === Math.round(currentBalance * 100)
  const ready = valid && !unchanged && reason.trim() !== ''

  const delta = valid ? parsed - currentBalance : 0

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-400 transition hover:bg-amber-500/20"
      >
        <Scale className="h-3.5 w-3.5" aria-hidden />
        Adjust Balance
      </button>

      {open
        ? createPortal(
          <Modal title="Adjust Carried Balance" onClose={() => setOpen(false)}>
            <form action={adjustCarriedBalance} className="space-y-4">
              <input type="hidden" name="id" value={customerId} />

              <div className="space-y-2 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2.5 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-gray-500">Customer</span>
                  <span className="font-medium text-gray-200">{customerName}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-gray-500">Current balance</span>
                  <span className="font-mono text-gray-300">
                    {formatCurrency(currentBalance)}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="adjust_balance_value" className="block text-xs font-medium text-gray-400">
                  Corrected Balance
                </label>
                <input
                  id="adjust_balance_value"
                  name="carried_balance"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className={
                    'w-full rounded-lg border bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:ring-2 ' +
                    (valid && !unchanged
                      ? 'border-gray-700 focus:border-amber-500 focus:ring-amber-500/30'
                      : 'border-red-700 focus:border-red-500 focus:ring-red-500/30')
                  }
                />
                {!valid ? (
                  <p role="alert" className="text-xs text-red-400">
                    Enter an amount of zero or more.
                  </p>
                ) : unchanged ? (
                  <p role="alert" className="text-xs text-red-400">
                    That is already the balance — nothing to adjust.
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">
                    {delta > 0
                      ? formatCurrency(delta) + ' more will be owed.'
                      : formatCurrency(-delta) + ' less will be owed.'}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="adjust_balance_reason" className="block text-xs font-medium text-gray-400">
                  Reason <span className="text-gray-600">(required)</span>
                </label>
                <textarea
                  id="adjust_balance_reason"
                  name="reason"
                  required
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Downgraded to the 2,500 plan on 3 Sep — September was billed at the old 3,500 rate."
                  className="w-full resize-y rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/30"
                />
                <p className="text-xs text-gray-500">
                  Recorded in the log with your name, the time, and both values.
                </p>
              </div>

              <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/80">
                This is not a payment. No money is recorded as received and no
                receipt is produced &mdash; it only changes what {customerName} owes.
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
