import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus } from 'lucide-react'

import { TicketFilters } from '@/components/tickets/TicketFilters'
import { TicketPriorityBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges'
import { listAgents } from '@/lib/data/checkoff'
import { listTickets } from '@/lib/data/tickets'
import { fullName } from '@/lib/format'
import { can } from '@/lib/permissions'
import { requirePermission } from '@/lib/session'
import { TICKET_OPEN_STATUSES, TICKET_STATUSES, type TicketStatus } from '@/lib/tickets'

export const metadata: Metadata = { title: 'Tickets · ISPMan' }

const dateFmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Which statuses the list should show.
 *
 * Absent means the default (open and in progress). Present but empty means the
 * operator explicitly asked for every status, which is why this cannot just
 * fall back on a falsy check.
 */
function statusesFrom(raw: string | undefined): TicketStatus[] {
  if (raw === undefined) return TICKET_OPEN_STATUSES
  if (raw === '') return []
  return TICKET_STATUSES.includes(raw as TicketStatus) ? [raw as TicketStatus] : TICKET_OPEN_STATUSES
}

export default async function TicketsPage({ searchParams }: PageProps<'/dashboard/tickets'>) {
  const { company, profile } = await requirePermission('view_support_tickets')

  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

  const statuses = statusesFrom(one(sp.status))
  const assignee = one(sp.assignee) ?? ''

  const [tickets, agents] = await Promise.all([
    listTickets({ companyId: company.id, statuses, assignee }),
    listAgents(company.id),
  ])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TicketFilters agents={agents} />

        {can(profile.role, 'create_ticket') ? (
          <Link
            href="/dashboard/tickets/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New Ticket
          </Link>
        ) : null}
      </div>

      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Support Tickets</h2>
          <p className="text-xs text-gray-500">
            {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'}
          </p>
        </header>

        {tickets.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-gray-600">
            No tickets match this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                  <th scope="col" className="px-4 py-2.5 font-semibold">Title</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Customer</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Priority</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Assigned To</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Created</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-800">
                {tickets.map((t) => (
                  <tr key={t.id} className="transition hover:bg-gray-800/40">
                    <td className="px-4 py-2.5">
                      <Link
                        href={'/dashboard/tickets/' + t.id}
                        className="font-medium text-gray-200 transition hover:text-blue-400"
                      >
                        {t.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {t.customer_id ? (
                        <Link
                          href={'/dashboard/customers/' + t.customer_id}
                          className="transition hover:text-blue-400"
                        >
                          {fullName(t.customers)}
                        </Link>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <TicketStatusBadge status={t.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      <TicketPriorityBadge priority={t.priority} />
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {t.assignee
                        ? [t.assignee.first_name, t.assignee.last_name].filter(Boolean).join(' ') ||
                          t.assignee.email
                        : <span className="text-gray-600">Unassigned</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">{dateFmt(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
