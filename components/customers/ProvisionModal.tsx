'use client'

import { Wifi } from 'lucide-react'
import { useState } from 'react'
import { createPortal, useFormStatus } from 'react-dom'

import { provisionCustomer } from '@/app/actions/customers'
import { Modal } from '@/components/settings/Modal'
import type { ProvisionPlan } from '@/lib/data/provision'
import { formatCurrencyExact, formatDateOnly } from '@/lib/format'
import { daysBetween } from '@/lib/prepaid-calendar'

function ConfirmButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Provisioning…' : 'Provision'}
    </button>
  )
}

/**
 * Provision, through a popup that offers exactly two first expiries: the next
 * cut-off day and the one after it (owner, 8 Oct 2026 — every press, every
 * company). The dates come from the server (lib/data/provision.ts) in the
 * company's own day, and provisionCustomer checks the posted one against the
 * same two, so nothing worked out in this browser decides anything.
 *
 * Under calendar-month prepaid it also says what the first charge will be.
 */
export function ProvisionModal({
  customerId,
  customerName,
  plan,
}: {
  customerId: number
  customerName: string
  plan: ProvisionPlan
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState(plan.preselect ?? '')

  // Portalled for the same reason as ExtendAccessModal: the trigger sits inside
  // the customer form, and a form inside a form is dropped by the browser.
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setPicked(plan.preselect ?? '')
          setOpen(true)
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500"
      >
        <Wifi className="h-3.5 w-3.5" aria-hidden />
        Provision
      </button>

      {open
        ? createPortal(
        <Modal title="Provision Customer" onClose={() => setOpen(false)}>
          <form action={provisionCustomer} className="space-y-4">
            <input type="hidden" name="id" value={customerId} />

            <div className="flex items-baseline justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2.5 text-sm">
              <span className="text-xs text-gray-500">Customer</span>
              <span className="font-medium text-gray-200">{customerName}</span>
            </div>

            {plan.choices ? (
              <fieldset className="space-y-2">
                <legend className="mb-1.5 block text-xs font-medium text-gray-400">
                  First expiry
                </legend>
                {plan.choices.map((date) => {
                  const days = daysBetween(plan.today, date)
                  return (
                    <label
                      key={date}
                      className={
                        'flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm transition ' +
                        (picked === date
                          ? 'border-amber-500/60 bg-amber-500/10 text-white'
                          : 'border-gray-800 bg-gray-950/60 text-gray-300 hover:border-gray-700')
                      }
                    >
                      <span className="flex items-center gap-2.5">
                        <input
                          type="radio"
                          name="first_expiry"
                          value={date}
                          required
                          checked={picked === date}
                          onChange={() => setPicked(date)}
                          className="accent-amber-500"
                        />
                        <span className="font-medium">{formatDateOnly(date)}</span>
                      </span>
                      <span className="text-xs text-gray-500">
                        {days} {days === 1 ? 'day' : 'days'} away
                      </span>
                    </label>
                  )
                })}
              </fieldset>
            ) : (
              <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {customerName} has no cut-off day on record, so there is no date to provision
                to. Set the cut-off day with Edit, then provision.
              </p>
            )}

            {plan.firstCharge && plan.choices ? (
              <div className="space-y-1 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2.5 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-gray-500">First charge</span>
                  <span className="font-semibold tabular-nums text-gray-100">
                    {formatCurrencyExact(plan.firstCharge.amount)}
                  </span>
                </div>
                <p className="text-xs text-gray-500">
                  {plan.firstCharge.label}, {plan.firstCharge.days} of {plan.firstCharge.monthDays} days
                  (today to the month&rsquo;s end). Added to the balance when the customer is provisioned.
                  The months after are charged in full on the bill date.
                </p>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
              >
                Cancel
              </button>
              <ConfirmButton disabled={!plan.choices || !picked} />
            </div>
          </form>
        </Modal>,
        document.body
      )
        : null}
    </>
  )
}
