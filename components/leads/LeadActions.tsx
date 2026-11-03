'use client'

import { useRouter } from 'next/navigation'
import { CircleCheck, TriangleAlert } from 'lucide-react'
import { useState, useTransition } from 'react'

import { convertLead, markLeadLost, type LeadResult } from '@/app/actions/leads'
import { useMoney } from '@/components/money/Currency'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@/lib/data/checkoff'

const inputBase =
  'w-full rounded-lg border bg-gray-800 px-3 py-2.5 text-base text-white placeholder:text-gray-500 outline-none transition focus:ring-2'
const inputOk = ' border-gray-700 focus:border-blue-500 focus:ring-blue-500/30'
const inputBad = ' border-red-700 focus:border-red-500 focus:ring-red-500/30'

/**
 * Turning a prospect into a customer, or closing them off.
 *
 * THE MONEY BOX IS THE POINT OF THIS SCREEN. A rep agreed a price at a gate
 * and may be holding cash for it. Until it is typed in here it exists nowhere
 * — not in the payments book, not in their checkoff, not in the day's total —
 * and money that exists nowhere is money that goes missing. So it is the first
 * field, pre-filled with the full installation fee, and the rep only changes
 * it if they took less.
 *
 * Zero is a perfectly ordinary answer: plenty of sales are signed with nothing
 * handed over and the office collects on the day of the install.
 */
export function LeadActions({
  leadId,
  installFee,
  canConvert,
  canMarkLost,
}: {
  leadId: number
  installFee: number
  canConvert: boolean
  canMarkLost: boolean
}) {
  const router = useRouter()
  const { symbol, money } = useMoney()
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<LeadResult | null>(null)
  const [mode, setMode] = useState<'idle' | 'convert' | 'lost'>('idle')

  const errors = (result && !result.ok && result.fieldErrors) || {}

  function submit(action: (fd: FormData) => Promise<LeadResult>, fd: FormData) {
    fd.set('lead_id', String(leadId))
    startTransition(async () => {
      const r = await action(fd)
      setResult(r)
      // The record changed underneath this page either way, so re-read it —
      // a success turns the card into the customer link, a failure may have
      // written part of it (see convertLead) and the page must show the truth.
      if (r.ok) setMode('idle')
      router.refresh()
    })
  }

  if (result && result.ok) {
    return (
      <div className="rounded-xl border border-green-900 bg-green-950/40 p-4">
        <p className="flex items-start gap-2 text-sm font-semibold text-green-300">
          <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {result.message}
        </p>
        {result.customerId ? (
          <a
            href={'/dashboard/customers/' + result.customerId}
            className="mt-3 inline-block rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            Open their account
          </a>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {result && !result.ok && result.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {result.error}
        </p>
      ) : null}

      {mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          {canConvert ? (
            <button
              type="button"
              onClick={() => setMode('convert')}
              className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
            >
              They signed up
            </button>
          ) : null}
          {canMarkLost ? (
            <button
              type="button"
              onClick={() => setMode('lost')}
              className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
            >
              Not interested
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === 'convert' ? (
        <form
          action={(fd) => submit(convertLead, fd)}
          className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4"
        >
          <div>
            <h3 className="text-sm font-semibold text-white">Make them a customer</h3>
            <p className="mt-0.5 text-[11px] text-gray-500">
              An account is created and the installation fee is put on it. No
              monthly billing starts until their MAC is added.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="amount_paid" className="block text-xs font-medium text-gray-400">
              Money taken at the door ({symbol})
            </label>
            <input
              id="amount_paid"
              name="amount_paid"
              type="number"
              inputMode="decimal"
              min="0"
              max={installFee}
              step="1"
              defaultValue={installFee > 0 ? String(installFee) : '0'}
              className={inputBase + (errors.amount_paid ? inputBad : inputOk)}
            />
            {errors.amount_paid ? (
              <p role="alert" className="text-xs text-red-400">{errors.amount_paid}</p>
            ) : (
              <p className="text-[11px] text-gray-600">
                {installFee > 0
                  ? 'The installation is ' + money(installFee) +
                    '. Set this to 0 if nothing was handed over.'
                  : 'No installation fee was quoted, so nothing can be taken against it.'}
              </p>
            )}
          </div>

          {installFee > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="payment_method" className="block text-xs font-medium text-gray-400">
                  How
                </label>
                <select
                  id="payment_method"
                  name="payment_method"
                  defaultValue="cash"
                  className={inputBase + inputOk}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="reference" className="block text-xs font-medium text-gray-400">
                  Reference <span className="text-gray-500">(optional)</span>
                </label>
                <input
                  id="reference"
                  name="reference"
                  type="text"
                  autoComplete="off"
                  maxLength={64}
                  placeholder="If they transferred it"
                  className={inputBase + inputOk}
                />
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? 'Working…' : 'Create the account'}
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {mode === 'lost' ? (
        <form
          action={(fd) => submit(markLeadLost, fd)}
          className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4"
        >
          <div>
            <h3 className="text-sm font-semibold text-white">Mark as not interested</h3>
            <p className="mt-0.5 text-[11px] text-gray-500">
              The record stays. A door knocked is worth knowing about even when
              the answer was no.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="lost_reason" className="block text-xs font-medium text-gray-400">
              Why <span className="text-gray-500">(optional)</span>
            </label>
            <textarea
              id="lost_reason"
              name="lost_reason"
              rows={2}
              placeholder="Already with someone else, too far from the tower…"
              className={inputBase + inputOk}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-gray-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-600 disabled:opacity-60"
            >
              {pending ? 'Saving…' : 'Mark not interested'}
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
