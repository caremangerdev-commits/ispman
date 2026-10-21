import { BILL_TEMPLATE_LABELS } from '@/lib/bill/settings'
import { getGeneralSettings } from '@/lib/data/company'
import { getSchemaCapabilities } from '@/lib/schema'
import { taxIdLabel } from '@/lib/tax-id'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Plus } from 'lucide-react'

import { CustomerDetail } from '@/components/customers/CustomerDetail'
import { ChangeHistory } from '@/components/customers/ChangeHistory'
import { EmailBillButton } from '@/components/customers/EmailBillButton'
import { billEmailOffer } from '@/lib/sms/notify'
import { NetworkHistory } from '@/components/customers/NetworkHistory'
import { OneOffCharges } from '@/components/customers/OneOffCharges'
import { listCustomerCharges } from '@/lib/data/charges'
import { listPaymentCategories } from '@/lib/data/payment-categories'
import { TicketPriorityBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges'
import { lastBalanceAdjustment } from '@/lib/data/balance-adjustments'
import { lastChargeFor } from '@/lib/data/billing-engine'
import { listCustomerChanges } from '@/lib/data/customer-changes'
import { listNetworkHistory } from '@/lib/data/network-events'
import { provisionPlan } from '@/lib/data/provision'
import { canProvision } from '@/lib/status'
import {
  getCustomerAddonIds, listAdditionalServices, listMiscCategories, listServicePlans,
} from '@/lib/data/catalog'
import {
  getCustomer, getCustomerPayments, getCustomerTickets,
} from '@/lib/data/customers'
import { formatCurrency, fullName, instantToDateOnly, timeAgo } from '@/lib/format'
import { prepaidCalendarFor } from '@/lib/data/prepaid-calendar'
import { can } from '@/lib/permissions'
import { getRadiusStatus } from '@/lib/radius/client'
import { radiusIdentity } from '@/lib/radius/format'
import { requirePermission } from '@/lib/session'
import { withoutPrice } from '@/lib/types'

export const metadata: Metadata = { title: 'Customer · ISPMan' }

export default async function CustomerDetailPage({
  params,
}: PageProps<'/dashboard/customers/[id]'>) {
  const { id } = await params
  const customerId = Number(id)
  if (!Number.isInteger(customerId)) notFound()

  const { company, profile } = await requirePermission('view_customer')
  const customer = await getCustomer(company.id, customerId)
  if (!customer) notFound()

  // A CUSTOMER'S MONEY IS NOT LOADED FOR A ROLE THAT MAY NOT SEE IT — a
  // technician (lib/permissions.ts#view_customer_billing_history). Not loaded,
  // so it cannot be rendered, and cannot leak into the client component's
  // props either: CustomerDetail gets money={null}, and the payment history,
  // bill links and one-off charges are not on the page. The service state —
  // status, expiry, cut-off day, expiry rule — stays.
  const money = can(profile.role, 'view_customer_billing_history')
  const none = <T,>(empty: T) => Promise.resolve(empty)

  const [
    payments, tickets, radius, networkHistory, plans, addons, miscCats, selectedAddonIds,
    balanceAdjustment, changeHistory, settings, caps, lastCharge, charges, paymentCategories,
    calendar,
  ] = await Promise.all([
      money ? getCustomerPayments(company.id, customerId) : none([]),
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
      // Marks a carried balance that was set by hand rather than by the bill
      // run. Log-derived, so there is no column and no migration behind it.
      money ? lastBalanceAdjustment(company.id, customerId) : none(null),
      // The edit trail for this record. Log-derived like the two above, so
      // there is no column and no migration behind it either.
      listCustomerChanges(company.id, customerId, 10),
      // The company's own word for the tax id, and whether the columns exist.
      getGeneralSettings(company.id),
      getSchemaCapabilities(),
      // The engine's latest charge (migration 0024), for the Last Billed row.
      money ? lastChargeFor(company.id, customerId) : none(null),
      // One-off charges (0025), and the category list a new one is filed
      // under. Both empty until 0025 is applied, and the card then hides.
      money ? listCustomerCharges(company.id, customerId) : none([]),
      money ? listPaymentCategories(company.id) : none([]),
      // Whether the prepaid calendar model applies, which makes the expiry
      // rule (0039) inert — the same test the payment path makes.
      prepaidCalendarFor(company.id),
    ])

  // "Email bill" beside "Bill (PDF)": shown when the company has bill emails
  // on (0042), and disabled with the reason when this customer cannot get one.
  const billOffer = money
    ? await billEmailOffer(company.id, { email: customer.email, email_opted_out: customer.emailOptedOut })
    : { shown: false as const }

  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount ?? 0), 0)

  // The two dates Provision offers — read only when the button will show.
  const provision =
    can(profile.role, 'provision_customer') && canProvision(radius.status)
      ? await provisionPlan(company.id, customer.id)
      : null

  return (
    <div className="space-y-4">
      {/* A technician or cashier reaches a record by searching and has no
          customer list to go back to; the link would bounce them off an
          access-denied redirect. */}
      <Link
        href={can(profile.role, 'view_customer_list') ? '/dashboard/customers' : '/dashboard'}
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        {can(profile.role, 'view_customer_list') ? 'Back to customers' : 'Back to dashboard'}
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
          cut_off_date: customer.cut_off_date,
          taxId: customer.taxId,
          taxIdAvailable: caps.taxId,
          taxIdLabel: taxIdLabel(settings.taxIdLabel, settings.country),
          country: settings.country || null,
          accountNumber: customer.accountNumber,
          smsAvailable: customer.smsAvailable,
          smsOptedOut: customer.smsOptedOut,
          emailAvailable: customer.emailAvailable,
          emailOptedOut: customer.emailOptedOut,
          billingAvailable: customer.billingAvailable,
          date_added: customer.date_added,
          customerType: customer.customerType,
          pppoeUsername: customer.pppoeUsername,
          accessPoint: customer.accessPoint,
          expiryMode: customer.expiryMode,
          expiryModeEditable: customer.expiryModeEditable,
          expiryRule: customer.expiryRule,
          anniversaryDay: customer.anniversaryDay,
          expiryRuleAvailable: customer.expiryRuleAvailable,
          calendarModel: calendar.enabled,
          todayYmd: instantToDateOnly(new Date(), settings.timezone),
          catalogAvailable: customer.catalogAvailable,
          connectionType: customer.connectionType,
          customerCategory: customer.customerCategory,
          notes: customer.notes,
          miscCategoryId: customer.miscCategoryId,
          miscCategoryName: customer.miscCategoryName,
          servicePlanId: customer.servicePlanId,
          // Built field by field: the plan row also carries its price, and
          // passing it whole would send that to every role's browser.
          servicePlan: customer.servicePlan
            ? {
                id: customer.servicePlan.id,
                name: customer.servicePlan.name,
                speed_down_mbps: customer.servicePlan.speed_down_mbps,
                speed_up_mbps: customer.servicePlan.speed_up_mbps,
              }
            : null,
        }}
        money={
          money
            ? {
                monthly_rate: customer.monthly_rate,
                balance: customer.balance,
                carried_balance: customer.carried_balance,
                bill_date: customer.bill_date,
                last_billed_date: customer.last_billed_date,
                lastCharge: lastCharge
                  ? { chargedOn: lastCharge.chargedOn, periodStart: lastCharge.periodStart, periodEnd: lastCharge.periodEnd }
                  : null,
                balanceAdjustment,
                paymentCount: payments.length,
                paymentsValue: totalPaid,
              }
            : null
        }
        radius={radius}
        role={profile.role}
        // Without money: no plan catalogue (choosing a plan sets the rate), and
        // the active add-ons by name only.
        servicePlans={money ? plans : []}
        additionalServices={
          money
            ? addons
            : addons.filter((a) => selectedAddonIds.includes(a.id)).map(withoutPrice)
        }
        miscCategories={miscCats}
        selectedAddonIds={selectedAddonIds}
        provisionPlan={provision}
      />

      {/* Money owed that is not service. Beside the record rather than inside
          its billing card, because it does not decide access and must not
          read as part of the service balance. */}
      {caps.charges && money ? (
        <OneOffCharges
          customerId={customer.id}
          customerName={fullName(customer)}
          charges={charges}
          categories={paymentCategories}
          canManage={can(profile.role, 'manage_charges')}
        />
      ) : null}

      <NetworkHistory entries={networkHistory} />

      {/* Sits beside Network History because they answer the same kind of
          question — what has been done to this record, by whom, and when —
          from the two halves of the log that record it. */}
      {/* Without money, an edit to the rate or bill day is left out of the
          trail — it would be the figure the record does not show. */}
      <ChangeHistory entries={changeHistory} hideMoney={!money} />

      {/* Payment history, with the bill and statement links. Not rendered at
          all without money: there is no empty card saying something is hidden.
          The links' route refuses the role as well (api/customers/[id]/bill). */}
      {money ? (
      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Payment History</h2>
          <div className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-1">
            {/* The same PDF the customer downloads from the portal, from the
                same loader (lib/data/bill.ts). The company's template is
                "Bill"; the other two are there to print on request. */}
            <span className="text-xs text-gray-500">
              <a
                href={'/api/customers/' + customer.id + '/bill'}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-blue-400 hover:text-blue-300"
              >
                Bill (PDF)
              </a>
              {/* The same PDF, sent to the customer: the attachment is drawn by
                  the renderer behind the link above (lib/messaging/attachments.ts). */}
              {billOffer.shown ? (
                <>
                  {' · '}
                  <EmailBillButton customerId={customer.id} email={customer.email} blocked={billOffer.blocked} />
                </>
              ) : null}
              {' · '}
              {(['statement', 'ledger', 'receipt'] as const).map((t, i) => (
                <span key={t}>
                  {i > 0 ? ' · ' : ''}
                  <a
                    href={'/api/customers/' + customer.id + '/bill?template=' + t}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-gray-300"
                  >
                    {BILL_TEMPLATE_LABELS[t]}
                  </a>
                </span>
              ))}
            </span>
            <p className="text-xs text-gray-500">
              {payments.length} {payments.length === 1 ? 'payment' : 'payments'}
            </p>
          </div>
        </header>

        {payments.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-600">
            No payments recorded for this customer.
          </p>
        ) : (
          <>
          {/* Phone: the same payments as rows of prose rather than a 720px
              table scrolled through a 360px window. Date and amount lead,
              because those are what anyone querying a payment reads out. */}
          <ul className="divide-y divide-gray-800 lg:hidden">
            {payments.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-gray-300">
                    {new Date(p.payment_date).toLocaleDateString('en-US', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </span>
                  <span className="font-semibold tabular-nums text-gray-100">
                    {formatCurrency(p.amount)}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                  <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-300">
                    {p.payment_type ?? 'other'}
                  </span>
                  {p.months_paid ? <span>{p.months_paid} mo</span> : null}
                  <span className="text-gray-700">|</span>
                  <span>{p.agent ?? '—'}</span>
                </div>

                {p.notes ? (
                  <p className="mt-1 text-xs leading-snug text-gray-500">{p.notes}</p>
                ) : null}
              </li>
            ))}

            <li className="flex items-baseline justify-between gap-3 bg-gray-950/40 px-4 py-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Total Paid
              </span>
              <span className="text-sm font-semibold tabular-nums text-white">
                {formatCurrency(totalPaid)}
              </span>
            </li>
          </ul>

          <div className="hidden overflow-x-auto lg:block">
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
          </>
        )}
      </section>
      ) : null}

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
