import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'

import { PaymentFilters } from '@/components/payments/PaymentFilters'
import { ReceiptButton } from '@/components/payments/ReceiptModal'
import { listPayments } from '@/lib/data/payments'
import {
  PAYMENT_METHOD_LABELS, listAgents,
} from '@/lib/data/checkoff'
import { getSchemaCapabilities } from '@/lib/schema'
import { formatCurrency, formatRelativeDate } from '@/lib/format'
import { can } from '@/lib/permissions'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Payments · ISPMan' }

const PER_PAGE = 15

const TYPE_STYLES: Record<string, string> = {
  cash: 'bg-emerald-500/10 text-emerald-400',
  card: 'bg-blue-500/10 text-blue-400',
  online: 'bg-violet-500/10 text-violet-400',
}

function hrefWith(base: Record<string, string>, patch: Record<string, string | null>) {
  const p = new URLSearchParams(base)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) p.delete(k)
    else p.set(k, v)
  }
  const qs = p.toString()
  return '/dashboard/payments' + (qs ? '?' + qs : '')
}

export default async function PaymentsPage({ searchParams }: PageProps<'/dashboard/payments'>) {
  // company_admin, manager, csr and cashier hold view_all_payments; technician
  // does not, so this guard matches the required access list exactly.
  const { company, profile } = await requirePermission('view_all_payments')

  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

  const from = one(sp.from) ?? ''
  const to = one(sp.to) ?? ''
  const type = one(sp.type) ?? ''
  const query = one(sp.q) ?? ''
  const agent = one(sp.agent) ?? ''
  const checked = one(sp.checked) ?? ''
  const page = Math.max(1, Number(one(sp.page) ?? '1') || 1)

  const [result, caps, agentList] = await Promise.all([
    listPayments({
      companyId: company.id,
      from, to, type, query, agent, checked, page, perPage: PER_PAGE,
    }),
    getSchemaCapabilities(),
    listAgents(company.id),
  ])

  const agentNames = [...new Set(agentList.map((a) => a.name))].sort()

  const base: Record<string, string> = {}
  if (from) base.from = from
  if (to) base.to = to
  if (type) base.type = type
  if (query) base.q = query
  if (agent) base.agent = agent
  if (checked) base.checked = checked

  const filtered = Boolean(from || to || type || query || agent || checked)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">Payments</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {result.total} {result.total === 1 ? 'payment' : 'payments'}
            {filtered ? ' matching your filters' : ' recorded'}
          </p>
        </div>

        {can(profile.role, 'record_payment') ? (
          <Link
            href="/dashboard/payments/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Record Payment
          </Link>
        ) : null}
      </div>

      {/* Summary — computed across the whole filtered set, not just this page. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Summary label="Total Collected" value={formatCurrency(result.totalCollected)} />
        <Summary label="Number of Payments" value={String(result.total)} />
        <Summary label="Average Payment" value={formatCurrency(result.averagePayment)} />
      </div>

      <PaymentFilters
        from={from} to={to} type={type} query={query}
        agent={agent} checked={checked}
        agents={agentNames} checkoffAvailable={caps.checkoff}
      />

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Date / Time</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Customer</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Amount</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Months</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Method</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Agent</th>
                {caps.checkoff ? (
                  <th scope="col" className="px-4 py-2.5 font-semibold">Checked Off</th>
                ) : null}
                <th scope="col" className="px-4 py-2.5 font-semibold">Notes</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                  <span className="sr-only">Receipt</span>
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-800">
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={caps.checkoff ? 9 : 8} className="px-4 py-12 text-center text-gray-600">
                    No payments match these filters.
                  </td>
                </tr>
              ) : null}

              {result.rows.map((p) => (
                <tr key={p.id} className="transition hover:bg-gray-800/40">
                  <td className="px-4 py-2.5">
                    {/* The date opens the payment; the customer cell opens the
                        customer, so the row offers both without nesting links. */}
                    <Link
                      href={'/dashboard/payments/' + p.id}
                      className="block font-medium text-gray-300 transition hover:text-blue-400"
                    >
                      {new Date(p.payment_date).toLocaleString('en-US', {
                        day: 'numeric', month: 'short', year: 'numeric',
                        hour: 'numeric', minute: '2-digit', hour12: true,
                      })}
                    </Link>
                    <span className="text-[11px] text-gray-600">
                      {formatRelativeDate(p.payment_date)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {p.customerId ? (
                      <Link
                        href={'/dashboard/customers/' + p.customerId}
                        className="font-medium text-gray-200 transition hover:text-blue-400"
                      >
                        {p.customerName}
                      </Link>
                    ) : (
                      <span className="text-gray-400">{p.customerName}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-medium tabular-nums text-gray-100">
                    {formatCurrency(p.amount)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">
                    {p.months_paid ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                        (TYPE_STYLES[p.method] ?? 'bg-gray-700/40 text-gray-400')
                      }
                    >
                      {PAYMENT_METHOD_LABELS[p.method]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-400">{p.agent ?? '—'}</td>
                  {caps.checkoff ? (
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                          (p.checkedOff
                            ? 'bg-green-500/15 text-green-400'
                            : 'bg-amber-500/15 text-amber-400')
                        }
                      >
                        {p.checkedOff ? 'Checked off' : 'Outstanding'}
                      </span>
                    </td>
                  ) : null}
                  <td className="px-4 py-2.5 text-gray-500">{p.notes ?? '—'}</td>
                  {/* Reprints the original receipt from the stored row — see
                      lib/data/receipts.ts. Nothing is recalculated, so this is
                      identical to the copy handed over at the till. */}
                  <td className="px-4 py-2.5 text-right">
                    <ReceiptButton paymentId={p.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {result.pageCount > 1 ? (
          <div className="flex items-center justify-between border-t border-gray-800 px-4 py-2.5">
            <p className="text-xs text-gray-500">
              Page {result.page} of {result.pageCount}
            </p>
            <div className="flex gap-1.5">
              <PageLink
                href={hrefWith(base, { page: String(result.page - 1) })}
                disabled={result.page <= 1}
                label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                Prev
              </PageLink>
              <PageLink
                href={hrefWith(base, { page: String(result.page + 1) })}
                disabled={result.page >= result.pageCount}
                label="Next page"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </PageLink>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <p className="text-xs font-medium text-gray-400">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight text-white">{value}</p>
    </div>
  )
}

function PageLink({
  href, disabled, label, children,
}: {
  href: string
  disabled: boolean
  label: string
  children: React.ReactNode
}) {
  const cls = 'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition'
  if (disabled) {
    return (
      <span aria-disabled className={cls + ' cursor-not-allowed bg-gray-900 text-gray-700'}>
        {children}
      </span>
    )
  }
  return (
    <Link href={href} aria-label={label} className={cls + ' bg-gray-800 text-gray-300 hover:bg-gray-700'}>
      {children}
    </Link>
  )
}
