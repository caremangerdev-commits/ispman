'use client'

import { Search } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'

import {
  PAYMENT_METHOD_LABELS, type CollectionSummary, type PaymentMethod,
} from '@/lib/data/checkoff'
import { currencySymbol } from '@/lib/format'

const METHOD_STYLES: Partial<Record<PaymentMethod, string>> = {
  cash: 'bg-emerald-500/10 text-emerald-400',
  card: 'bg-blue-500/10 text-blue-400',
  bank_transfer: 'bg-indigo-500/10 text-indigo-400',
  cheque: 'bg-cyan-500/10 text-cyan-400',
  paypal: 'bg-sky-500/10 text-sky-400',
  cashapp: 'bg-green-500/10 text-green-400',
  zelle: 'bg-violet-500/10 text-violet-400',
  wire_transfer: 'bg-amber-500/10 text-amber-400',
  online: 'bg-fuchsia-500/10 text-fuchsia-400',
  other: 'bg-gray-600/30 text-gray-400',
}

function money(symbol: string, value: number) {
  return symbol + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}

/**
 * The agent's running totals since their last checkoff.
 *
 * Split from the payments list below it so the record-payment page can stack
 * them as full-width bands — lookup, then totals, then history — rather than
 * putting one tall column beside one short one.
 */
export function CollectionStats({
  summary,
  currency,
  migrationHint,
}: {
  summary: CollectionSummary
  currency: string
  migrationHint?: string
}) {
  const symbol = currencySymbol(currency)

  if (!summary.available) {
    return (
      <p className="rounded-xl border border-amber-900/50 bg-amber-950/20 px-5 py-4 text-sm text-amber-400/90">
        {migrationHint ?? 'Checkoff is not set up on this system yet.'}
      </p>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Total Since Checkoff" value={money(symbol, summary.sinceCheckoffTotal)} accent />
      <Stat label="Total Today" value={money(symbol, summary.todayTotal)} />
      <Stat label="Customers Since Checkoff" value={String(summary.sinceCheckoffCustomers)} />
      <Stat label="Customers Today" value={String(summary.todayCustomers)} />
    </div>
  )
}

/**
 * The agent's un-checked-off payments.
 *
 * Filtering happens in the browser over the already-loaded set: it is one
 * agent's outstanding payments, so it is small, and searching should not cost
 * a round trip. The totals above deliberately ignore the filter.
 */
export function CollectionsList({
  summary,
  currency,
  timezone,
}: {
  summary: CollectionSummary
  currency: string
  timezone: string
}) {
  const [query, setQuery] = useState('')
  const symbol = currencySymbol(currency)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return summary.payments
    return summary.payments.filter((p) => p.customerName.toLowerCase().includes(needle))
  }, [query, summary.payments])

  if (!summary.available) return null

  const stamp = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso))

  return (
    <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 px-5 py-3.5">
        <div>
          <h2 className="text-sm font-semibold text-white">My Collections</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {summary.payments.length} payment{summary.payments.length === 1 ? '' : 's'} since your
            last checkoff
          </p>
        </div>

        <div className="relative w-full sm:w-64">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500"
            aria-hidden
          />
          <label htmlFor="collections-search" className="sr-only">Search my payments</label>
          <input
            id="collections-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search my payments..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800 py-2 pl-9 pr-3 text-sm text-white placeholder:text-gray-500 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
          />
        </div>
      </header>

      {summary.payments.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-gray-600">
          No payments recorded since last checkoff
        </p>
      ) : visible.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-gray-600">
          No payments match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-gray-900">
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-5 py-2 font-semibold">Customer</th>
                <th scope="col" className="px-5 py-2 font-semibold">Method</th>
                <th scope="col" className="px-5 py-2 font-semibold">Time</th>
                <th scope="col" className="px-5 py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {visible.map((p) => (
                <tr key={p.id} className="transition hover:bg-gray-800/40">
                  <td className="px-5 py-2.5">
                    {p.customerId ? (
                      <Link
                        href={'/dashboard/customers/' + p.customerId}
                        className="font-medium text-gray-200 transition hover:text-blue-400"
                      >
                        {p.customerName}
                      </Link>
                    ) : (
                      <span className="font-medium text-gray-300">{p.customerName}</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    <span
                      className={
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                        (METHOD_STYLES[p.method] ?? 'bg-gray-700/40 text-gray-400')
                      }
                    >
                      {PAYMENT_METHOD_LABELS[p.method]}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-gray-500">{stamp(p.payment_date)}</td>
                  <td className="px-5 py-2.5 text-right font-semibold tabular-nums text-white">
                    {money(symbol, p.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
      <p className="text-[11px] font-medium text-gray-500">{label}</p>
      <p
        className={
          'mt-1 text-2xl font-semibold tabular-nums tracking-tight ' +
          (accent ? 'text-emerald-400' : 'text-white')
        }
      >
        {value}
      </p>
    </div>
  )
}
