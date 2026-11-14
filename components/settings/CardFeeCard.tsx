'use client'

import { useActionState, useId, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { saveCardFeeShare, type GatewayFormResult } from '@/app/actions/payment-gateways'
import { settingsInput } from '@/components/settings/Modal'
import { splitCardFee } from '@/lib/payments/surcharge'

/**
 * How much of the card fee the customer carries — one company-wide policy,
 * costed against whichever gateway is currently live.
 *
 * THE WORKED EXAMPLE IS THE POINT OF THIS CARD. "50%" means nothing on its own:
 * the fee is a percentage plus a fixed amount, charged on a total that already
 * includes the surcharge, so the number an operator pictures and the number
 * their customer is charged are rarely the same. Showing both, live, on a real
 * amount, is the difference between an informed decision and a nasty surprise
 * at the till.
 *
 * It also shows a small part-payment, because that is where the fixed fee
 * bites and nobody thinks to check: the same settings that add 6% to a full
 * month's bill can add 27% to a J$200 top-up, and the people topping up J$200
 * are the ones who can least afford it.
 */

export type CardFeeCardProps = {
  available: boolean
  /** 0–100. How much of the fee the customer carries. */
  share: number
  /** The live gateway's own rates, or null when none is on or none has rates. */
  live: { label: string; rate: number | null; fixed: number | null } | null
  currencySymbol: string
  /** A realistic amount to cost out — the company's default monthly rate. */
  sampleBill: number
}

function Save({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save'}
    </button>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={'text-xs ' + (strong ? 'text-gray-300' : 'text-gray-500')}>{label}</span>
      <span
        className={
          'font-mono text-sm tabular-nums ' + (strong ? 'font-semibold text-white' : 'text-gray-300')
        }
      >
        {value}
      </span>
    </div>
  )
}

export function CardFeeCard({ available, share, live, currencySymbol, sampleBill }: CardFeeCardProps) {
  const [state, action] = useActionState<GatewayFormResult | null, FormData>(saveCardFeeShare, null)
  const uid = useId()
  const [pct, setPct] = useState(String(share ?? 0))
  const [amount, setAmount] = useState(String(sampleBill || 1900))

  const money = (n: number) =>
    currencySymbol + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const quote = useMemo(() => {
    const customerShare = Math.min(100, Math.max(0, Number(pct) || 0))
    const bill = Math.max(0, Number(amount) || 0)
    if (!live || live.rate === null) return null
    const fee = { rate: live.rate, fixed: live.fixed ?? 0, customerShare }
    return {
      full: splitCardFee(bill, fee),
      small: splitCardFee(200, fee),
      customerShare,
    }
  }, [pct, amount, live])

  const noRate = !live || live.rate === null

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="text-sm font-semibold text-white">Card fee</h2>
      <p className="mt-1 text-xs text-gray-500">
        Every card payment costs you a fee. By default you absorb it and the customer pays exactly
        their bill. You can instead ask them to carry some of it — they are shown the amount and
        have to agree before paying.
      </p>

      <form action={action} autoComplete="off" className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={'share-' + uid} className="block text-xs font-medium text-gray-400">
            The customer pays this much of the fee
          </label>
          <div className="relative w-32">
            <input
              id={'share-' + uid}
              name="card_fee_customer_share"
              type="number"
              min="0"
              max="100"
              step="1"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              disabled={!available}
              className={settingsInput + ' pr-7 font-mono'}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
              %
            </span>
          </div>
          <p className="text-[11px] text-gray-600">
            0 means you absorb all of it and the customer pays only their bill — how it works today.
            100 means they carry the whole fee and you bank the full bill.
          </p>
        </div>

        {/* ---- The worked example ---- */}
        <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-gray-400">What that means</p>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-600">on a bill of</span>
              <input
                type="number"
                min="0"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label="Example bill amount"
                className={settingsInput + ' w-28 py-1 font-mono text-xs'}
              />
            </div>
          </div>

          {noRate ? (
            <p className="mt-3 text-[11px] text-amber-300/90">
              {live
                ? 'Enter ' + live.label + '’s percentage and fixed fee above, and this will show exactly what a customer would be charged.'
                : 'Turn on a gateway and enter its fees above, and this will show exactly what a customer would be charged.'}
            </p>
          ) : quote ? (
            <>
              <p className="mt-1 text-[11px] text-gray-600">Based on your {live!.label} rates.</p>
              <div className="mt-3 divide-y divide-gray-800/70">
                <Row label="Their bill" value={money(quote.full.bill)} />
                <Row label={live!.label + ' fee'} value={money(quote.full.expectedFee)} />
                <Row
                  label="Customer is charged"
                  value={money(quote.full.total)}
                  strong
                />
                <Row
                  label="…of which card fee"
                  value={quote.full.surcharge > 0 ? money(quote.full.surcharge) : '—'}
                />
                <Row
                  label="You carry"
                  value={money(Math.max(0, quote.full.expectedFee - quote.full.surcharge))}
                />
                <Row label="You bank" value={money(quote.full.expectedNet)} strong />
              </div>

              {quote.customerShare > 0 ? (
                <p className="mt-3 rounded border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200/90">
                  A {money(200)} part-payment on these settings: the customer is charged{' '}
                  <span className="font-mono">{money(quote.small.total)}</span> —{' '}
                  {money(quote.small.surcharge)} on top, or{' '}
                  {((quote.small.surcharge / 200) * 100).toFixed(0)}%. The fixed fee lands the same
                  whatever the payment, so small top-ups carry the most.
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        {/* ---- The bit that is not a technical decision ---- */}
        <div className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-red-200/90">
            <span className="font-semibold">Before you set this above 0.</span> Charging a customer
            more for paying by card is a surcharge. Dime&apos;s own calculator assumes merchants do
            it, but Mastercard has said publicly in Jamaica that merchants are wrong to make
            customers pay more for using a card, and card agreements commonly forbid it. Confirm
            with whoever holds your merchant account, in writing, first. Some providers allow a cash
            discount where they will not allow a card surcharge.
          </p>
        </div>

        {state ? (
          <p
            role="alert"
            className={
              'rounded-lg border px-3 py-2 text-xs ' +
              (state.ok
                ? 'border-green-900/60 bg-green-950/40 text-green-300'
                : 'border-red-900/60 bg-red-950/50 text-red-300')
            }
          >
            {state.ok ? state.message : state.error}
          </p>
        ) : null}

        <Save disabled={!available} />
      </form>
    </section>
  )
}
