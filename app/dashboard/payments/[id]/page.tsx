import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ArrowRight, Mail, MapPin, Phone } from 'lucide-react'

import { PaymentActions } from '@/components/payments/PaymentActions'
import { ReceiptButton } from '@/components/payments/ReceiptModal'
import { getPayment } from '@/lib/data/payments'
import { formatCurrency, fullName, timeAgo } from '@/lib/format'
import { can } from '@/lib/permissions'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Payment · ISPMan' }

const TYPE_STYLES: Record<string, string> = {
  cash: 'bg-emerald-500/10 text-emerald-400',
  card: 'bg-blue-500/10 text-blue-400',
  online: 'bg-violet-500/10 text-violet-400',
}

const fmtDateTime = (value: string) =>
  new Date(value).toLocaleString('en-US', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })

const fmtDate = (value: string) =>
  new Date(value).toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

export default async function PaymentDetailPage({
  params,
}: PageProps<'/dashboard/payments/[id]'>) {
  const { id } = await params
  const paymentId = Number(id)
  if (!Number.isInteger(paymentId)) notFound()

  // Same gate as the payments list: company_admin, manager, csr and cashier.
  const { company, profile } = await requirePermission('view_all_payments')

  const payment = await getPayment(company.id, paymentId)
  if (!payment) notFound()

  const customer = payment.customer
  const customerName = customer ? fullName(customer) : 'Unknown customer'
  const months = payment.months_paid ?? 1
  const perMonth = months > 0 ? payment.amount / months : payment.amount

  return (
    <div className="space-y-4">
      <Link
        href="/dashboard/payments"
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to payments
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">
            {formatCurrency(payment.amount)}
            <span className="ml-2 align-middle text-sm font-normal text-gray-500">
              Payment #{payment.id}
            </span>
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Collected from {customerName} on {fmtDate(payment.payment_date)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Reprint. Renders from the stored row, so it matches the receipt
              the customer was handed. */}
          <ReceiptButton
            paymentId={payment.id}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-2 text-sm font-semibold text-gray-200 transition hover:bg-gray-700"
          >
            Print Receipt
          </ReceiptButton>

          <PaymentActions
          payment={{
            id: payment.id,
            amount: payment.amount,
            months_paid: payment.months_paid,
            payment_type: payment.payment_type,
            payment_date: payment.payment_date,
            agent: payment.agent,
            notes: payment.notes,
            customerName,
          }}
            canEdit={can(profile.role, 'edit_payment')}
            canDelete={can(profile.role, 'delete_payment')}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Payment record */}
        <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900 lg:col-span-2">
          <header className="border-b border-gray-800 px-5 py-3">
            <h2 className="text-sm font-semibold text-white">Payment Details</h2>
          </header>

          <dl className="divide-y divide-gray-800">
            <Row label="Amount">
              <span className="text-base font-semibold tabular-nums text-white">
                {formatCurrency(payment.amount)}
              </span>
            </Row>

            <Row label="Payment Type">
              <span
                className={
                  'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                  (TYPE_STYLES[payment.payment_type ?? ''] ?? 'bg-gray-700/40 text-gray-400')
                }
              >
                {payment.payment_type ?? 'other'}
              </span>
            </Row>

            <Row label="Months Paid">
              <span className="tabular-nums text-gray-200">
                {months} {months === 1 ? 'month' : 'months'}
              </span>
              <span className="ml-2 text-xs text-gray-500">
                ({formatCurrency(perMonth)}/month)
              </span>
            </Row>

            <Row label="Payment Date">
              <span className="text-gray-200">{fmtDate(payment.payment_date)}</span>
              <span className="ml-2 text-xs text-gray-500">
                {timeAgo(payment.payment_date)}
              </span>
            </Row>

            <Row label="Agent">
              <span className="text-gray-200">{payment.agent ?? '—'}</span>
            </Row>

            <Row label="Notes">
              <span className="text-gray-300">{payment.notes || '—'}</span>
            </Row>

            <Row label="Recorded">
              <span className="text-gray-400">
                {payment.created_at ? fmtDateTime(payment.created_at) : '—'}
              </span>
            </Row>
          </dl>
        </section>

        {/* Customer */}
        <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
          <header className="border-b border-gray-800 px-5 py-3">
            <h2 className="text-sm font-semibold text-white">Customer</h2>
          </header>

          {customer ? (
            <div className="space-y-4 p-5">
              <div>
                <Link
                  href={'/dashboard/customers/' + customer.id}
                  className="text-base font-semibold text-white transition hover:text-blue-400"
                >
                  {customerName}
                </Link>
                {/* Status is not stored on the customer — it is read live from
                    the network registry, which is not worth a lookup on a
                    historical payment receipt. */}
              </div>

              <ul className="space-y-2 text-sm">
                <ContactRow icon={<Phone className="h-3.5 w-3.5" aria-hidden />} value={customer.phone} />
                <ContactRow icon={<Mail className="h-3.5 w-3.5" aria-hidden />} value={customer.email} />
                <ContactRow icon={<MapPin className="h-3.5 w-3.5" aria-hidden />} value={customer.address} />
              </ul>

              <div className="grid grid-cols-2 gap-3 border-t border-gray-800 pt-4">
                <div>
                  <p className="text-[11px] text-gray-500">Monthly Rate</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-gray-200">
                    {formatCurrency(customer.monthly_rate)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-500">Current Balance</p>
                  <p
                    className={
                      'mt-0.5 text-sm font-semibold tabular-nums ' +
                      (customer.balance > 0 ? 'text-orange-400' : 'text-gray-200')
                    }
                  >
                    {formatCurrency(customer.balance)}
                  </p>
                </div>
              </div>

              <Link
                href={'/dashboard/customers/' + customer.id}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 transition hover:text-blue-300"
              >
                View customer record
                <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            </div>
          ) : (
            <p className="px-5 py-10 text-center text-sm text-gray-600">
              The customer for this payment no longer exists.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3">
      <dt className="w-36 shrink-0 text-xs font-medium text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm">{children}</dd>
    </div>
  )
}

function ContactRow({ icon, value }: { icon: React.ReactNode; value: string | null }) {
  if (!value) return null
  return (
    <li className="flex items-center gap-2 text-gray-400">
      <span className="shrink-0 text-gray-600">{icon}</span>
      <span className="min-w-0 truncate">{value}</span>
    </li>
  )
}
