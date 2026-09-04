import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Eye, Plus } from 'lucide-react'

import { AddressFilter } from '@/components/customers/AddressFilter'
import { BulkActions } from '@/components/customers/BulkActions'
import { CustomerSearch } from '@/components/customers/CustomerSearch'
import { ExpiryHint, StatusBadge } from '@/components/customers/StatusBadge'
import { disconnectCustomer, reconnectCustomer } from '@/app/actions/customers'
import { requirePermission } from '@/lib/session'
import { FILTERS, listCustomers, type CustomerFilter } from '@/lib/data/customers'
import { daysUntilDateOnly, formatCurrency, formatDateOnly, fullName } from '@/lib/format'
import { can } from '@/lib/permissions'
import { canDisconnect, canReconnect } from '@/lib/status'


export const metadata: Metadata = { title: 'Customers · ISPMan' }

const PER_PAGE = 10

function isFilter(v: string | undefined): v is CustomerFilter {
  return !!v && FILTERS.some((f) => f.key === v)
}

/** Preserves the active query/filter when building pagination + tab links. */
function hrefWith(base: Record<string, string>, patch: Record<string, string | null>) {
  const p = new URLSearchParams(base)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) p.delete(k)
    else p.set(k, v)
  }
  const qs = p.toString()
  return '/dashboard/customers' + (qs ? '?' + qs : '')
}

export default async function CustomersPage({ searchParams }: PageProps<'/dashboard/customers'>) {
  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

  const query = one(sp.q) ?? ''
  const filterParam = one(sp.filter)
  const filter: CustomerFilter = isFilter(filterParam) ? filterParam : 'all'
  const address = (one(sp.address) ?? '').trim()
  const page = Math.max(1, Number(one(sp.page) ?? '1') || 1)

  const { company, profile } = await requirePermission('view_customer_list')
  const { rows, total, pageCount, counts, addresses, page: current } = await listCustomers({
    companyId: company.id,
    query,
    filter,
    address,
    page,
    perPage: PER_PAGE,
  })

  // Status arrives already merged onto each row by listCustomers(), which does
  // the registry lookup in one batched query.
  const role = profile.role
  const mayAdd = can(role, 'add_customer')
  const mayImport = can(role, 'import_customers')
  const mayNetwork = can(role, 'extend_disconnect_customer')

  const base: Record<string, string> = {}
  if (query) base.q = query
  if (filter !== 'all') base.filter = filter
  // Carried through the status tabs and the pager, so the two filters compose
  // rather than clearing each other.
  if (address) base.address = address

  // Handed to the network actions so they redirect back to this exact view —
  // same search, same filter, same page — rather than to the customer record.
  const returnTo = hrefWith(base, current > 1 ? { page: String(current) } : {})

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CustomerSearch initial={query} />

        <div className="flex flex-wrap items-center gap-2">
          {mayAdd ? (
            <Link
              href="/dashboard/customers/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add Customer
            </Link>
          ) : null}

          {/* Import, cut-off dates and provisioning live behind the overflow
              menu: all three are migration tools and all three need
              import_customers, so a CSR sees only Add Customer. */}
          {mayImport ? <BulkActions /> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The page title is in the header bar; this is just the count. */}
        <p className="text-sm text-gray-500">
          {total} {total === 1 ? 'customer' : 'customers'}
          {filter !== 'all' || query || address ? ' matching your filters' : ' in total'}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <AddressFilter addresses={addresses} selected={address} />

          {FILTERS.map((f) => {
            const active = f.key === filter
            return (
              <Link
                key={f.key}
                href={hrefWith(base, { filter: f.key === 'all' ? null : f.key, page: null })}
                aria-current={active ? 'page' : undefined}
                className={
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition ' +
                  (active
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200')
                }
              >
                {f.label}
                <span className={'ml-1.5 ' + (active ? 'text-blue-200' : 'text-gray-600')}>
                  {counts[f.key]}
                </span>
              </Link>
            )
          })}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Name</th>
                {/* Phone was here. It was dropped rather than adding an eighth
                    column to a table that already scrolls: it is on the customer
                    record, and nobody scans a list for a phone number. */}
                <th scope="col" className="px-4 py-2.5 font-semibold">Address</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">MAC Address</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Monthly Rate</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Expiry</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-800">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-600">
                    No customers match this search.
                  </td>
                </tr>
              )}

              {rows.map((c) => (
                <tr key={c.id} className="transition hover:bg-gray-800/40">
                  <td className="px-4 py-2.5">
                    <Link
                      href={'/dashboard/customers/' + c.id}
                      className="font-medium text-gray-200 transition hover:text-blue-400"
                    >
                      {fullName(c)}
                    </Link>
                  </td>
                  {/* Truncated, not wrapped: a long address must not make one
                      row twice the height of its neighbours. The title carries
                      the full value for anyone who needs it without leaving the
                      list. max-w with truncate needs the cell itself bounded,
                      hence the width on the td rather than only the span. */}
                  <td className="max-w-[14rem] px-4 py-2.5 text-gray-400">
                    <span className="block truncate" title={c.address ?? undefined}>
                      {c.address ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-400">
                    {c.mac_address ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-gray-200">
                    {formatCurrency(c.monthly_rate)}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={c.radiusStatus ?? 'unknown'} />
                  </td>
                  <td className="px-4 py-2.5">
                    {/* Network expiry, not the billing date: it is what the
                        status beside it is derived from. */}
                    {/* radiusExpiryDate, not radiusExpiry: the calendar date
                        radcheck holds, formatted by the same helper the detail
                        page uses so the two pages cannot disagree. */}
                    <div className="text-gray-300">{formatDateOnly(c.radiusExpiryDate)}</div>
                    <div className="text-[11px]">
                      <ExpiryHint days={daysUntilDateOnly(c.radiusExpiryDate)} />
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <Link
                        href={'/dashboard/customers/' + c.id}
                        className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                      >
                        <Eye className="h-3 w-3" aria-hidden />
                        View
                      </Link>

{/* The two network actions that need no further input. Provision
                          and Extend are not offered here: the first is a
                          deliberate first-time write and the second needs a
                          date, so both belong on the customer record.

                          return_to keeps the operator on this page instead of
                          bouncing them into a customer they only wanted to
                          reconnect in passing. */}
                      {mayNetwork && canReconnect(c.radiusStatus ?? 'unknown') ? (
                      <form action={reconnectCustomer}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="return_to" value={returnTo} />
                        <button
                          type="submit"
                          className="rounded-md bg-green-500/10 px-2 py-1 text-[11px] font-semibold text-green-400 transition hover:bg-green-500/20"
                        >
                          Reconnect
                        </button>
                      </form>
                      ) : null}

                      {mayNetwork && canDisconnect(c.radiusStatus ?? 'unknown') ? (
                      <form action={disconnectCustomer}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="return_to" value={returnTo} />
                        <button
                          type="submit"
                          className="rounded-md bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-400 transition hover:bg-red-500/20"
                        >
                          Disconnect
                        </button>
                      </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-gray-800 px-4 py-2.5">
            <p className="text-xs text-gray-500">
              Page {current} of {pageCount}
            </p>
            <div className="flex gap-1.5">
              <PageLink
                href={hrefWith(base, { page: String(current - 1) })}
                disabled={current <= 1}
                label="Previous"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                Prev
              </PageLink>
              <PageLink
                href={hrefWith(base, { page: String(current + 1) })}
                disabled={current >= pageCount}
                label="Next"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </PageLink>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PageLink({
  href,
  disabled,
  label,
  children,
}: {
  href: string
  disabled: boolean
  label: string
  children: React.ReactNode
}) {
  const cls =
    'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition'

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
