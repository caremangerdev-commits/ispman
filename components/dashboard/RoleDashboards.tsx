import Link from 'next/link'
import { Receipt, Search, Users, Wifi } from 'lucide-react'

import { EmptyState, Panel } from '@/components/dashboard/Panel'
import { formatCurrency, formatRelativeDate, fullName, timeAgo } from '@/lib/format'
import type {
  CashierDashboard as CashierData,
  CsrDashboard as CsrData,
  CustomerHit,
  MyTicket,
  TechnicianDashboard as TechData,
} from '@/lib/data/roleDashboards'

const PRIORITY: Record<string, string> = {
  high: 'bg-red-500/15 text-red-400',
  medium: 'bg-amber-500/15 text-amber-400',
  low: 'bg-green-500/15 text-green-400',
}

const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-blue-500/15 text-blue-400' },
  in_progress: { label: 'In Progress', cls: 'bg-amber-500/15 text-amber-400' },
  resolved: { label: 'Resolved', cls: 'bg-green-500/15 text-green-400' },
  closed: { label: 'Closed', cls: 'bg-gray-600/30 text-gray-400' },
}

function TicketList({ tickets }: { tickets: MyTicket[] }) {
  if (tickets.length === 0) return <EmptyState message="No tickets assigned to you." />
  return (
    <ul className="divide-y divide-gray-800">
      {tickets.map((t) => {
        const s = STATUS[t.status ?? ''] ?? { label: t.status ?? '—', cls: 'bg-gray-700/40 text-gray-400' }
        return (
          <li key={t.id} className="px-5 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-gray-200">{t.title}</p>
              <span className="shrink-0 text-xs text-gray-500">{timeAgo(t.created_at)}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="truncate text-xs text-gray-500">{fullName(t.customers)}</span>
              <span className={'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' + (PRIORITY[t.priority ?? ''] ?? 'bg-gray-700/40 text-gray-400')}>
                {t.priority ?? 'none'}
              </span>
              <span className={'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' + s.cls}>
                {s.label}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Plain GET form — no client JS needed. Roles without a customer-list page
 * search inline, so results render back into the same dashboard.
 */
function SearchForm({ defaultValue, placeholder }: { defaultValue: string; placeholder: string }) {
  return (
    <form method="get" className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden />
      <label htmlFor="q" className="sr-only">Search customers</label>
      <input
        id="q"
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-800 bg-gray-950 py-2 pl-9 pr-3 text-sm text-gray-200 placeholder:text-gray-600 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
      />
    </form>
  )
}

function HitList({ hits, showBalance }: { hits: CustomerHit[]; showBalance: boolean }) {
  if (hits.length === 0) return <EmptyState message="No customers matched that search." />
  return (
    <ul className="divide-y divide-gray-800">
      {hits.map((h) => (
        <li key={h.id} className="flex items-center gap-3 px-5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-200">{h.name}</p>
            <p className="truncate text-xs text-gray-500">
              {h.phone ?? '—'}
              <span className="ml-2 font-mono">{h.mac_address ?? '—'}</span>
            </p>
          </div>
          {showBalance ? (
            <span className={'shrink-0 text-sm tabular-nums ' + (Number(h.balance ?? 0) > 0 ? 'text-orange-400' : 'text-gray-400')}>
              {formatCurrency(h.balance)}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------

export function CsrDashboard({
  name, data, query, hits,
}: {
  name: string
  data: CsrData
  query: string
  hits: CustomerHit[]
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">Welcome back, {name}</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {data.myTickets.length} assigned to you · {data.openTicketCount} open company-wide
          </p>
        </div>
        <Link
          href="/dashboard/payments/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
        >
          <Receipt className="h-4 w-4" aria-hidden />
          Record Payment
        </Link>
      </div>

      <SearchForm defaultValue={query} placeholder="Search customers by name, phone or MAC..." />

      {query ? (
        <Panel title="Search Results" subtitle={hits.length + ' found'} href={'/dashboard/customers?q=' + encodeURIComponent(query)} linkLabel="Open in full list">
          <HitList hits={hits} showBalance />
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="My Tickets" subtitle="Assigned to me">
          <TicketList tickets={data.myTickets} />
        </Panel>

        <Panel title="Added Today" subtitle={data.addedToday.length + ' new'} href="/dashboard/customers" linkLabel="View All Customers">
          {data.addedToday.length === 0 ? (
            <EmptyState message="No customers added today." />
          ) : (
            <ul className="divide-y divide-gray-800">
              {data.addedToday.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-5 py-2.5">
                  <Users className="h-4 w-4 shrink-0 text-gray-600" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-200">{fullName(c)}</p>
                    <p className="truncate font-mono text-xs text-gray-500">{c.mac_address ?? '—'}</p>
                  </div>
                  <span className="shrink-0 text-xs text-gray-500">{c.phone}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function CashierDashboard({
  name, data, query, hits,
}: {
  name: string
  data: CashierData
  query: string
  hits: CustomerHit[]
}) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">Welcome back, {name}</h1>
        <p className="mt-0.5 text-sm text-gray-500">Collections desk</p>
      </div>

      <SearchForm defaultValue={query} placeholder="Search customer by name, phone or MAC..." />

      {query ? (
        <Panel title="Search Results" subtitle={hits.length + ' found'}>
          <HitList hits={hits} showBalance />
        </Panel>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Link
          href="/dashboard/payments/new"
          className="flex flex-col items-center justify-center gap-2 rounded-xl bg-blue-600 p-8 text-center transition hover:bg-blue-500 sm:col-span-2"
        >
          <Receipt className="h-8 w-8 text-white" aria-hidden />
          <span className="text-lg font-semibold text-white">Record Payment</span>
          <span className="text-xs text-blue-100">Take a payment from a customer</span>
        </Link>

        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <p className="text-xs font-medium text-gray-400">My Collections Today</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-white">
            {formatCurrency(data.collectedToday)}
          </p>
          <p className="mt-1 text-xs text-gray-600">
            {data.paymentCount} {data.paymentCount === 1 ? 'payment' : 'payments'} recorded
          </p>
        </div>
      </div>

      <Panel title="My Payments Today" subtitle={'Last ' + data.recentPayments.length} href="/dashboard/payments" linkLabel="View All Payments">
        {data.recentPayments.length === 0 ? (
          <EmptyState message="You have not recorded any payments today." />
        ) : (
          <ul className="divide-y divide-gray-800">
            {data.recentPayments.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-200">{fullName(p.customers)}</p>
                  <p className="text-xs text-gray-500">{formatRelativeDate(p.payment_date)}</p>
                </div>
                <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-300">
                  {p.payment_type ?? 'other'}
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-white">
                  {formatCurrency(p.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function TechnicianDashboard({
  name, data, query, hits,
}: {
  name: string
  data: TechData
  query: string
  hits: CustomerHit[]
}) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">Welcome back, {name}</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          {data.myTickets.length} assigned to you · {data.customersWithOpenTickets.length} customers with open issues
        </p>
      </div>

      <SearchForm defaultValue={query} placeholder="Search customer by name, phone or MAC..." />

      {query ? (
        <Panel title="Search Results" subtitle={hits.length + ' found'}>
          {/* showBalance deliberately false: technicians see no billing data. */}
          <HitList hits={hits} showBalance={false} />
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="My Tickets" subtitle="Assigned to me">
          <TicketList tickets={data.myTickets} />
        </Panel>

        <Panel title="Customers With Open Tickets" subtitle={data.customersWithOpenTickets.length + ' total'}>
          {data.customersWithOpenTickets.length === 0 ? (
            <EmptyState message="No open tickets right now." />
          ) : (
            <ul className="divide-y divide-gray-800">
              {data.customersWithOpenTickets.map((c) => (
                <li key={c.customerId} className="flex items-center gap-3 px-5 py-2.5">
                  <Wifi className="h-4 w-4 shrink-0 text-gray-600" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-200">{c.name}</p>
                    <p className="truncate font-mono text-xs text-gray-500">{c.macAddress ?? '—'}</p>
                  </div>
                  <span className="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-400">
                    {c.openTickets} open
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
