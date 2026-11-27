'use client'

import { BadgePercent } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createPortal } from 'react-dom'

import { addCustomerCredit } from '@/app/actions/credits'
import { useMoney } from '@/components/money/Currency'
import { Modal, settingsInput } from '@/components/settings/Modal'

function daysBetween(start: string, end: string): number {
  const a = Date.parse(start + 'T00:00:00Z')
  const b = Date.parse(end + 'T00:00:00Z')
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 86_400_000) + 1 : 0
}

function daysInMonth(ymd: string): number {
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(5, 7))
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * A credit or discount for a stated period, e.g. 7 days without service. It
 * lowers what the customer owes and prints on their next bill as its own line
 * with the dates, rather than disappearing into "previous balance" the way a
 * balance adjustment does.
 */
export function AddCreditModal({
  customerId,
  customerName,
  monthlyCharge,
}: {
  customerId: number
  customerName: string
  /** What a month costs, to work a credit out from the days. Zero hides that. */
  monthlyCharge: number
}) {
  const { moneyExact } = useMoney()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('No service')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [amount, setAmount] = useState('')
  const [on, setOn] = useState(() => new Date().toLocaleDateString('en-CA'))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const days = start && end ? daysBetween(start, end) : 0
  const suggested = days && monthlyCharge > 0 ? Math.round((monthlyCharge * days * 100) / daysInMonth(start)) / 100 : 0
  // Text, not a number box, so "1,200" and "J$1200" can be typed; see AdjustBalanceModal.
  const value = Number(amount.replace(/[^0-9.]/g, '')) || 0
  const ready = amount !== '' && value > 0 && reason.trim() !== '' && (!start === !end) && (!start || days > 0)

  const save = async () => {
    setBusy(true)
    setNote(null)
    try {
      const res = await addCustomerCredit({
        customerId,
        amount: value,
        reason,
        periodStart: start || null,
        periodEnd: end || null,
        creditedOn: on || null,
      })
      if (res.ok) {
        setNote({ ok: true, text: res.message })
        router.refresh()
      } else setNote({ ok: false, text: res.error })
    } catch {
      setNote({ ok: false, text: 'Could not reach ISPMan. Reload the page and try again.' })
    }
    setBusy(false)
  }

  const label = 'block text-xs font-medium text-gray-400'

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setNote(null)
          setOpen(true)
        }}
        className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-500/20"
      >
        <BadgePercent className="h-3.5 w-3.5" aria-hidden />
        Give Credit
      </button>

      {open
        ? createPortal(
          <Modal title={'Give ' + customerName + ' a credit'} onClose={() => setOpen(false)}>
            {note?.ok ? (
              <div className="space-y-4">
                <p className="rounded-lg bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">{note.text}</p>
                <div className="flex justify-end">
                  <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-700">
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="credit_reason" className={label}>What it is for (prints on the bill)</label>
                  <input id="credit_reason" value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} className={settingsInput} />
                  <p className="text-[11px] text-gray-500">e.g. No service, Outage credit, Loyalty discount.</p>
                </div>

                <div>
                  <p className={label}>Days it covers (leave empty for a discount with no dates)</p>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    <input type="date" aria-label="First day" value={start} onChange={(e) => setStart(e.target.value)} className={settingsInput} />
                    <input type="date" aria-label="Last day" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} className={settingsInput} />
                  </div>
                  {days > 0 ? (
                    <p className="mt-1.5 text-xs text-gray-400">
                      {days} day{days === 1 ? '' : 's'}.
                      {suggested > 0 ? (
                        <>
                          {' '}At {moneyExact(monthlyCharge)} a month that is {moneyExact(suggested)}.{' '}
                          <button type="button" onClick={() => setAmount(suggested.toFixed(2))} className="font-semibold text-emerald-400 hover:underline">
                            Use this amount
                          </button>
                        </>
                      ) : null}
                    </p>
                  ) : start && end ? (
                    <p className="mt-1.5 text-xs text-red-400">The last day is before the first day.</p>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <label htmlFor="credit_amount" className={label}>Amount off</label>
                    <input id="credit_amount" type="text" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} className={settingsInput} />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="credit_on" className={label}>Date on the account</label>
                    <input id="credit_on" type="date" value={on} onChange={(e) => setOn(e.target.value)} className={settingsInput} />
                  </div>
                </div>

                <p className="text-xs text-gray-500">
                  Takes the amount off what {customerName} owes, and shows on the bill as its own line with the dates. Not a payment: no receipt is made.
                </p>

                {note && !note.ok ? <p className="rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">{note.text}</p> : null}

                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-700">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!ready || busy}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? 'Saving…' : 'Give Credit'}
                  </button>
                </div>
              </div>
            )}
          </Modal>,
          document.body
        )
        : null}
    </>
  )
}
