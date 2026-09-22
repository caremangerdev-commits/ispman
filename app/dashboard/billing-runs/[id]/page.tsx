import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { getBillRun, listRunCharges } from '@/lib/data/billing-engine'
import { formatCurrency, formatDateOnly, formatDateTime } from '@/lib/format'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Billing Run · ISPMan' }

const MODE_LABEL = { off: 'Off', dry_run: 'Dry run', live: 'Live' } as const

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="text-gray-500">{label}</dt>
      <dd className="tabular-nums text-gray-200">{value}</dd>
    </div>
  )
}

/**
 * One run: its counts, and the charges it made (live) or would have made
 * (dry run). The period is printed on every line so nobody has to infer it.
 */
export default async function BillingRunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const runId = Number(id)
  if (!Number.isInteger(runId)) notFound()

  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_all_payments')) {
    redirect('/dashboard?denied=view_all_payments')
  }
  const caps = await getSchemaCapabilities()
  if (!caps.billingEngine) notFound()

  const run = await getBillRun(company.id, runId)
  if (!run) notFound()

  const charges = run.mode === 'live' ? await listRunCharges(company.id, run.id) : []
  const preview = run.mode === 'dry_run' ? (run.preview ?? []) : []

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">
            {MODE_LABEL[run.mode]} run for {formatDateOnly(run.runDate)}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            {run.status === 'done' ? 'Finished ' + (run.finishedAt ? formatDateTime(run.finishedAt) : '') : null}
            {run.status === 'failed' ? 'Failed. ' + (run.error ?? '') : null}
            {run.status === 'running' ? 'Running since ' + formatDateTime(run.startedAt) : null}
            {run.attempts > 1 ? ' · attempt ' + run.attempts : ''}
          </p>
        </div>
        <Link
          href="/dashboard/billing-runs"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          All runs
        </Link>
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 rounded-xl border border-gray-800 bg-gray-900 p-5 sm:grid-cols-2">
        <Line label={run.mode === 'live' ? 'Charged' : 'Would charge'} value={run.charged.toLocaleString()} />
        <Line label="Total" value={formatCurrency(run.totalAmount)} />
        <Line label="Taken from standing credit" value={formatCurrency(run.creditApplied)} />
        <Line label="Considered" value={run.considered.toLocaleString()} />
        <Line label="Already charged for the period" value={run.skippedAlready.toLocaleString()} />
        <Line label="Not yet due" value={run.skippedNotDue.toLocaleString()} />
        <Line label="Before the engine start date" value={run.skippedBeforeStart.toLocaleString()} />
        <Line label="Joined after the charge date" value={run.skippedJoinedAfter.toLocaleString()} />
        <Line label="No monthly charge" value={run.skippedZeroRate.toLocaleString()} />
        <Line label="Disconnected" value={run.skippedNoService.toLocaleString()} />
        <Line label="Never provisioned" value={run.skippedUnprovisioned.toLocaleString()} />
      </dl>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">
            {run.mode === 'live' ? 'Charges' : 'Charges this dry run would have made'}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            The period is what the charge is for. It is not an expiry date and nothing here moved one.
          </p>
        </div>

        {run.mode === 'live' && charges.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">This run charged nobody.</p>
        ) : null}
        {run.mode === 'dry_run' && preview.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">This dry run would have charged nobody.</p>
        ) : null}

        {run.mode === 'live' && charges.length > 0 ? (
          <table className="w-full text-left text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Period</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">From credit</th>
                <th className="px-4 py-2 text-right font-medium">Balance before</th>
                <th className="px-4 py-2 text-right font-medium">Balance after</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-300">
              {charges.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2">
                    <Link href={'/dashboard/customers/' + c.customerId} className="text-blue-400 hover:underline">
                      {c.name}
                    </Link>
                    <span className="ml-1 text-gray-600">#{c.customerId}</span>
                  </td>
                  <td className="px-4 py-2">{formatDateOnly(c.periodStart)} to {formatDateOnly(c.periodEnd)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(c.amount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-500">{c.creditApplied ? formatCurrency(c.creditApplied) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-500">{formatCurrency(c.carriedBefore)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(c.carriedAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {run.mode === 'dry_run' && preview.length > 0 ? (
          <table className="w-full text-left text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Bill day</th>
                <th className="px-4 py-2 font-medium">Period</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Add-ons</th>
                <th className="px-4 py-2 text-right font-medium">From credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-300">
              {preview.map((p) => (
                <tr key={p.customer_id}>
                  <td className="px-4 py-2">
                    <Link href={'/dashboard/customers/' + p.customer_id} className="text-blue-400 hover:underline">
                      {p.name}
                    </Link>
                    <span className="ml-1 text-gray-600">#{p.customer_id}</span>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{p.bill_day}</td>
                  <td className="px-4 py-2">{formatDateOnly(p.period_start)} to {formatDateOnly(p.period_end)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(p.amount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-500">{p.addons ? formatCurrency(p.addons) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-500">{p.credit_applied ? formatCurrency(p.credit_applied) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}
