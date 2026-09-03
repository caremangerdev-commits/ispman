import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Plus } from 'lucide-react'

import { CustomerDetail } from '@/components/customers/CustomerDetail'
import { NetworkHistory } from '@/components/customers/NetworkHistory'
import { TicketPriorityBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges'
import { listNetworkHistory } from '@/lib/data/network-events'
import {
  getCustomerAddonIds, listAdditionalServices, listMiscCategories, listServicePlans,
} from '@/lib/data/catalog'
import {
  getCustomer, getCustomerPayments, getCustomerTickets,
} from '@/lib/data/customers'
import { formatCurrency, fullName, timeAgo } from '@/lib/format'
import { can } from '@/lib/permissions'
import { getRadiusStatus } from '@/lib/radius/client'
import { radiusIdentity } from '@/lib/radius/format'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Customer · ISPMan' }

export default async function CustomerDetailPage({
  params,
}: PageProps<'/dashboard/customers/[id]'>) {
  const { id } = await params
  const customerId = Number(id)
  if (!Number.isInteger(customerId)) notFound()

  const { company, profile } = await requirePermission('view_customer_billing_history')
  const customer = await getCustomer(company.id, customerId)
  if (!customer) notFound()

  const [
    payments, tickets, radius, networkHistory, plans, addons, miscCats, selectedAddonIds,
  ] = await Promise.all([
      getCustomerPayments(company.id, customerId),
      getCustomerTickets(company.id, customerId),
      // MAC for DHCP, PPPoE username for PPPoE — radcheck and radacct are both
      // keyed on that identity, so looking a PPPoE customer up by MAC finds
      // nothing at all.
      getRadiusStatus(
        radiusIdentity({
          customerType: customer.customerType,
          macAddress: customer.mac_address,
          pppoeUsername: customer.pppoeUsername,
        }),
        { companyId: company.id, customerId: customer.id }
      ),
      listNetworkHistory(company.id, customerId, 10),
      listServicePlans(company.id),
      listAdditionalServices(company.id),
      listMiscCategories(company.id),
      getCustomerAddonIds(company.id, customerId),
    ])

  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount ?? 0), 0)

  return (
    <div className="space-y-4">
      <Link
        href="/dashboard/customers"
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to customers
      </Link>

      <CustomerDetail
        customer={{
          id: customer.id,
          first_name: customer.first_name,
          last_name: customer.last_name,
          email: customer.email,
          phone: customer.phone,
          address: customer.address,
          gps: customer.gps,
          mac_address: customer.mac_address,
          monthly_rate: customer.monthly_rate,
          balance: customer.balance,
          cut_off_date: customer.cut_off_date,
          billingAvailable: customer.billingAvailable,
          billingType: customer.billingType,
          bill_date: customer.bill_date,
          carried_balance: customer.carried_balance,
          last_billed_date: customer.last_billed_date,
          last_bill_date: customer.last_bill_date,
          date_added: customer.date_added,
          expiresAtIso: customer.expiresAt ? customer.expiresAt.toISOString() : null,
          daysUntilExpiry: customer.daysUntilExpiry,
          customerType: customer.customerType,
          pppoeUsername: customer.pppoeUsername,
          accessPoint: customer.accessPoint,
          expiryMode: customer.expiryMode,
          expiryModeEditable: customer.expiryModeEditable,
          catalogAvailable: customer.catalogAvailable,
          connectionType: customer.connectionType,
          customerCategory: customer.customerCategory,
          notes: customer.notes,
          miscCategoryId: customer.miscCategoryId,
          miscCategoryName: customer.miscCategoryName,
          servicePlanId: customer.servicePlanId,
          servicePlan: customer.servicePlan,
        }}
        radius={radius}
        role={profile.role}
        servicePlans={plans}
        additionalServices={addons}
        miscCategories={miscCats}
        selectedAddonIds={selectedAddonIds}
      />

      <NetworkHistory entries={networkHistory} />

      {/* Payment history */}
      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Payment History</h2>
          <p className="text-xs text-gray-500">
            {payments.length} {payments.length === 1 ? 'payment' : 'payments'}
          </p>
        </header>

        {payments.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-600">
            No payments recorded for this customer.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                  <th scope="col" className="px-5 py-2 font-semibold">Date</th>
                  <th scope="col" className="px-5 py-2 text-right font-semibold">Amount</th>
                  <th scope="col" className="px-5 py-2 text-right font-semibold">Months</th>
                  <th scope="col" className="px-5 py-2 font-semibold">Type</th>
                  <th scope="col" className="px-5 py-2 font-semibold">Agent</th>
                  <th scope="col" className="px-5 py-2 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {payments.map((p) => (
                  <tr key={p.id} className="transition hover:bg-gray-800/40">
                    <td className="px-5 py-2 text-gray-300">
                      {new Date(p.payment_date).toLocaleDateString('en-US', {
                        day: 'numeric', month: 'short', year: 'numeric',
                      })}
                    </td>
                    <td className="px-5 py-2 text-right font-medium tabular-nums text-gray-100">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-gray-400">
                      {p.months_paid ?? '—'}
                    </td>
                    <td className="px-5 py-2">
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-300">
                        {p.payment_type ?? 'other'}
                      </span>
                    </td>
                    <td className="px-5 py-2 text-gray-400">{p.agent ?? '—'}</td>
                    <td className="px-5 py-2 text-gray-500">{p.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-800 bg-gray-950/40">
                  <td className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Total Paid
                  </td>
                  <td className="px-5 py-2.5 text-right text-sm font-semibold tabular-nums text-white">
                    {formatCurrency(totalPaid)}
                  </td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* Support tickets */}
      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <header className="flex items-center justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Support Tickets</h2>
          <div className="flex items-center gap-3">
            <p className="text-xs text-gray-500">
              {tickets.length} {tickets.length === 1 ? 'ticket' : 'tickets'}
            </p>
            {/* Pre-fills this customer on the create form. */}
            {can(profile.role, 'create_ticket') ? (
              <Link
                href={'/dashboard/tickets/new?customer=' + customer.id}
                className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
              >
                <Plus className="h-3 w-3" aria-hidden />
                New Ticket
              </Link>
            ) : null}
          </div>
        </header>

        {tickets.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-600">
            No tickets for {fullName(customer)}.
          </p>
        ) : (
          <ul className="divide-y divide-gray-800">
            {tickets.map((t) => {
              return (
                <li key={t.id} className="flex items-center gap-3 px-5 py-2.5">
                  <Link
                    href={'/dashboard/tickets/' + t.id}
                    className="min-w-0 flex-1 truncate text-sm text-gray-200 transition hover:text-blue-400"
                  >
                    {t.title}
                  </Link>
                  <TicketPriorityBadge priority={t.priority} />
                  <TicketStatusBadge status={t.status} />
                  <span className="shrink-0 text-xs text-gray-500">{timeAgo(t.created_at)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
