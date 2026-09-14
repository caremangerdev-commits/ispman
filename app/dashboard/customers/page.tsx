import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Eye, Plus } from 'lucide-react'

import { AddressFilter } from '@/components/customers/AddressFilter'
import { BulkActions } from '@/components/customers/BulkActions'
import { CustomerFilterBar } from '@/components/customers/CustomerFilterBar'
import { CustomerSearch } from '@/components/customers/CustomerSearch'
import { ExpiryHint, StatusBadge } from '@/components/customers/StatusBadge'
import { disconnectCustomer, reconnectCustomer } from '@/app/actions/customers'
import { requirePermission } from '@/lib/session'
import { filtersFromParams, filtersToParams, hasAnyFilter } from '@/lib/customer-filter'
import { listMiscCategories, listServicePlans } from '@/lib/data/catalog'
import { FILTERS, listCustomers, type CustomerFilter } from '@/lib/data/customers'
import {
  CURRENCY_SYMBOL, daysUntilDateOnly, formatCurrency, formatDateOnly, fullName,
} from '@/lib/format'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { CUSTOMER_STATUSES, canDisconnect, canReconnect, type CustomerStatus } from '@/lib/status'


export const metadata: Metadata = { title: 'Customers · ISPMan' }

const PER_PAGE = 10

function isStatus(v: string): v is CustomerStatus {
  return (CUSTOMER_STATUSES as string[]).includes(v)
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

  const page = Math.max(1, Number(one(sp.page) ?? '1') || 1)

  const { company, profile } = await requirePermission('view_customer_list')

  // ONE definition of what the filters mean, shared with the messaging page —
  // see lib/customer-filter.ts. Nothing here decides what `?owing=5000` selects.
  const filters = filtersFromParams(
    (k) => one(sp[k as keyof typeof sp]),
    isStatus
  )
  const query = filters.query
  const filter: CustomerFilter = filters.status
  const address = filters.address

  const caps = await getSchemaCapabilities()
  const [list, miscCategories, servicePlans] = await Promise.all([
    listCustomers({ companyId: company.id, filters, page, perPage: PER_PAGE }),
    caps.catalog ? listMiscCategories(company.id) : Promise.resolve([]),
    caps.catalog ? listServicePlans(company.id) : Promise.resolve([]),
  ])
  const {
    rows, total, pageCount, counts, addresses, accessPoints, cutOffDates,
    hasBothConnectionTypes, page: current,
  } = list

  // Status arrives already merged onto each row by listCustomers(), which does
  // the registry lookup in one batched query.
  const role = profile.role
  const mayAdd = can(role, 'add_customer')
  const mayImport = can(role, 'import_customers')
  const mayNetwork = can(role, 'extend_disconnect_customer')

  // Every active filter, carried through the status tabs and the pager so they
  // compose rather than clearing each other. Built by the same module that
  // reads them back, so a parameter cannot be written under one name and looked
  // for under another.
  const base = filtersToParams(filters)

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
              import_customers, so a CSR sees only Add Customer. The filters go
              along for Set Access Point, which acts on the filtered list. */}
          {mayImport ? <BulkActions filters={filters} /> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The page title is in the header bar; this is just the count. */}
        <p className="text-sm text-gray-500">
          {total} {total === 1 ? 'customer' : 'customers'}
          {hasAnyFilter(filters) ? ' matching your filters' : ' in total'}
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

      {/* A second row rather than more controls in the first: the status tabs
          carry counts and need the width. These four narrow the same set and
          compose with everything above them. */}
      <CustomerFilterBar
        miscCategories={miscCategories.map((c) => ({ id: c.id, name: c.name }))}
        servicePlans={servicePlans.map((p) => ({ id: p.id, name: p.name }))}
        accessPoints={accessPoints}
        cutOffDates={cutOffDates}
        hasBothConnectionTypes={hasBothConnectionTypes}
        selected={{
          category: base.category ?? '',
          plan: base.plan ?? '',
          ap: base.ap ?? '',
          cutoff: base.cutoff ?? '',
          conn: base.conn ?? '',
          expiring: base.expiring ?? '',
          owing: base.owing ?? '',
        }}
        currencySymbol={CURRENCY_SYMBOL}
      />

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        {/* ---------------- Phone: one card per customer ----------------
            The table below is `min-w-[860px]`, which through a 360px window is
            two and a half screens of sideways dragging per row — and the Name
            column, the only one you are looking for, scrolls out of view on the
            way to Actions. Same `rows`, same helpers, same server actions: this
            is a second RENDERING, not a second query or a second idea of what a
            customer is. */}
        <ul className="divide-y divide-gray-800 lg:hidden">
          {rows.length === 0 ? (
            <li className="px-4 py-12 text-center text-gray-600">
              No customers match this search.
            </li>
          ) : null}

          {rows.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <Link
                href={'/dashboard/customers/' + c.id}
                className="-mx-2 block rounded-lg px-2 py-1 transition active:bg-gray-800/60"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-gray-100">{fullName(c)}</span>
                    {c.account_number ? (
                      <span className="mt-0.5 block font-mono text-[11px] text-gray-500">
                        {c.account_number}
                      </span>
                    ) : null}
                  </span>
                  <StatusBadge status={c.radiusStatus ?? 'unknown'} />
                </span>

                <span className="mt-1.5 block truncate text-xs text-gray-400">
                  {c.address ?? '—'}
                </span>

                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
                  <Balance carried={c.carried_balance} credit={c.account_credit} />
                  <span className="text-gray-700">|</span>
                  <span className="text-gray-400">{formatDateOnly(c.radiusExpiryDate)}</span>
                  <ExpiryHint days={daysUntilDateOnly(c.radiusExpiryDate)} />
                </span>
              </Link>

              {mayNetwork ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <NetworkActions id={c.id} status={c.radiusStatus ?? 'unknown'} returnTo={returnTo} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Name</th>
                {/* Phone was here. It was dropped rather than adding an eighth
                    column to a table that already scrolls: it is on the customer
                    record, and nobody scans a list for a phone number. */}
                <th scope="col" className="px-4 py-2.5 font-semibold">Address</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">MAC Address</th>
                {/* Balance, not the monthly rate. The rate is static and is on
                    the record; the balance is what someone scanning a list is
                    looking for, and the Owing filter above narrows by it. */}
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Balance</th>
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
                    {/* Under the name, because that is where the eye already is
                        when two customers share one — which is the whole reason
                        account numbers exist here. Rendered only once 0020 is
                        applied; before that there is nothing to show and no
                        empty line appears. */}
                    {c.account_number ? (
                      <span className="mt-0.5 block font-mono text-[11px] text-gray-500">
                        {c.account_number}
                      </span>
                    ) : null}
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
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    <Balance carried={c.carried_balance} credit={c.account_credit} />
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
                        className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2.5 py-1.5 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                      >
                        <Eye className="h-3 w-3" aria-hidden />
                        View
                      </Link>

                      {mayNetwork ? (
                        <NetworkActions
                          id={c.id}
                          status={c.radiusStatus ?? 'unknown'}
                          returnTo={returnTo}
                        />
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

/**
 * The two network actions that need no further input.
 *
 * Defined once and rendered by both the phone card list and the desktop table,
 * so the two views cannot drift into disagreeing about when a Disconnect is
 * offered — or, worse, about what `return_to` should be.
 *
 * Provision and Extend are not offered here: the first is a deliberate
 * first-time write and the second needs a date, so both belong on the customer
 * record. `return_to` keeps the operator on this page instead of bouncing them
 * into a customer they only wanted to reconnect in passing.
 *
 * At most one of the two ever renders: canDisconnect is `active` alone and
 * canReconnect is everything else, so there is no adjacent pair of buttons
 * where one restores service and the other cuts it.
 */
function NetworkActions({
  id,
  status,
  returnTo,
}: {
  id: number
  status: CustomerStatus
  returnTo: string
}) {
  // min-h-11 is the phone target; lg:min-h-0 hands the desk its compact row back.
  const cls =
    'inline-flex min-h-11 items-center rounded-md px-3 py-1.5 text-xs font-semibold transition lg:min-h-0 lg:px-2.5 lg:text-[11px]'

  if (canReconnect(status)) {
    return (
      <form action={reconnectCustomer}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="return_to" value={returnTo} />
        <button
          type="submit"
          className={cls + ' bg-green-500/10 text-green-400 hover:bg-green-500/20'}
        >
          Reconnect
        </button>
      </form>
    )
  }

  if (canDisconnect(status)) {
    return (
      <form action={disconnectCustomer}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="return_to" value={returnTo} />
        <button
          type="submit"
          className={cls + ' bg-red-500/10 text-red-400 hover:bg-red-500/20'}
        >
          Disconnect
        </button>
      </form>
    )
  }

  return null
}

/**
 * What the customer owes, as the list shows it.
 *
 * The carried balance, which is the amount due (lib/billing.ts) and the figure
 * the dashboard's Outstanding Balance sums. Orange when something is owed,
 * muted when square. A customer holding credit and owing nothing shows the
 * credit instead, marked as such, so a prepaid customer does not read as
 * merely "0" — that is the difference between "paid up" and "paid ahead".
 */
function Balance({ carried, credit }: { carried: number; credit: number }) {
  if (carried > 0) {
    return <span className="tabular-nums font-medium text-orange-400">{formatCurrency(carried)}</span>
  }
  if (credit > 0) {
    return (
      <span className="tabular-nums text-green-400" title="Credit on account">
        {formatCurrency(credit)} cr
      </span>
    )
  }
  return <span className="tabular-nums text-gray-500">{formatCurrency(0)}</span>
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
