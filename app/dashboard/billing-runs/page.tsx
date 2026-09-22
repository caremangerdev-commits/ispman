import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  engineSettingsFor, listBillRuns, previewCompanyNow, type BillRunRow,
} from '@/lib/data/billing-engine'
import { formatCurrency, formatDateOnly, timeAgo } from '@/lib/format'
import { can } from '@/lib/permissions'
import { BILLING_ENGINE_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Billing Runs · ISPMan' }

/** Never cached: the "if a tick ran now" preview reads radcheck. */
export const dynamic = 'force-dynamic'

const MODE_LABEL = { off: 'Off', dry_run: 'Dry run', live: 'Live' } as const
const TYPE_LABEL = { prepaid: 'Prepaid', postpaid: 'Postpaid' } as const

function StatusPill({ status }: { status: BillRunRow['status'] }) {
  const cls =
    status === 'done' ? 'bg-green-500/10 text-green-400'
    : status === 'failed' ? 'bg-red-500/10 text-red-400'
    : 'bg-amber-500/10 text-amber-400'
  return (
    <span className={'rounded-md px-1.5 py-0.5 text-[11px] font-medium ' + cls}>
      {status}
    </span>
  )
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className={'text-sm font-semibold tabular-nums ' + (muted ? 'text-gray-400' : 'text-gray-100')}>{value}</p>
    </div>
  )
}

/**
 * The daily billing engine's run log for this company: one row per day the
 * engine looked at the company, and what a tick would do right now.
 *
 * Behind view_all_payments, the same line as the payments book: what a
 * company was charged is money, and reading it is the same right as reading
 * what it collected.
 */
export default async function BillingRunsPage() {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_all_payments')) {
    redirect('/dashboard?denied=view_all_payments')
  }

  const caps = await getSchemaCapabilities()
  if (!caps.billingEngine) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-6">
        <p className="text-sm font-semibold text-amber-300">The billing engine is not set up yet.</p>
        <p className="mt-1.5 text-sm text-amber-400/80">{BILLING_ENGINE_HINT}</p>
        <p className="mt-3 text-xs text-gray-500">Run Bills works as before in the meantime.</p>
      </div>
    )
  }

  const [settings, runs] = await Promise.all([
    engineSettingsFor(company.id),
    listBillRuns(company.id),
  ])

  // The preview reads radcheck, which may be unreachable from here. That is a
  // message on the page, not a page that fails to load.
  let preview: Awaited<ReturnType<typeof previewCompanyNow>> = null
  let previewError: string | null = null
  try {
    preview = await previewCompanyNow(company.id)
  } catch (err) {
    previewError = (err as Error).message
  }

  const mode = settings?.mode ?? 'off'

  return (
    <div className="space-y-5">
      {/* ---- what this company is on ---- */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Billing engine for {company.name}</h2>
            <p className="mt-1 text-xs text-gray-500">
              {TYPE_LABEL[settings?.billingType ?? 'postpaid']} billing
              {settings?.billingType === 'prepaid'
                ? ': each customer’s bill date to the same date next month, charged on the bill date, the month ahead.'
                : ': the calendar month, charged on the company bill day while the month runs.'}
              {' '}The engine sets the charge and names the period. It never moves an expiry.
            </p>
          </div>
          <Link
            href="/dashboard/settings/company"
            className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
          >
            Settings
          </Link>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Mode" value={MODE_LABEL[mode]} muted={mode === 'off'} />
          <Stat label="Start date" value={settings?.startDate ? formatDateOnly(settings.startDate) : '—'} muted={!settings?.startDate} />
          <Stat label="Runs recorded" value={runs.length.toLocaleString()} />
          <Stat label="Last run" value={runs[0] ? formatDateOnly(runs[0].runDate) : '—'} muted={!runs[0]} />
        </div>
        {mode === 'off' ? (
          <p className="mt-3 text-xs text-gray-500">
            The engine is off for this company. Nothing below changes until the mode is set to dry run
            on the settings page.
          </p>
        ) : null}
      </div>

      {/* ---- if a tick ran now ---- */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="text-sm font-semibold text-white">If a tick ran now</h2>
        {previewError ? (
          <p className="mt-2 text-xs text-amber-300/80">
            Could not preview: {previewError}
          </p>
        ) : preview ? (
          <>
            <p className="mt-1 text-xs text-gray-500">
              Today is {formatDateOnly(preview.decision.today)} in the company&apos;s zone.
              {mode === 'off' ? ' The engine is off, so this is what it WOULD do if it were on.' : ''}
              {mode === 'dry_run' ? ' Dry run: this would be recorded and nothing charged.' : ''}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Would charge" value={preview.decision.charges.length.toLocaleString()} />
              <Stat label="Total" value={formatCurrency(preview.decision.totalAmount)} />
              <Stat label="From credit" value={formatCurrency(preview.decision.creditApplied)} muted={preview.decision.creditApplied === 0} />
              <Stat label="Considered" value={preview.decision.considered.toLocaleString()} muted />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
              {([
                ['Already charged', preview.decision.counts.already],
                ['Not yet due', preview.decision.counts.not_due],
                ['Before start date', preview.decision.counts.before_start],
                ['Joined after charge date', preview.decision.counts.joined_after],
                ['No monthly charge', preview.decision.counts.zero_rate],
                ['Disconnected', preview.decision.counts.no_service],
                ['Never provisioned', preview.decision.counts.unprovisioned],
              ] as const).map(([label, n]) => (
                <div key={label} className="flex items-baseline justify-between gap-2">
                  <dt className="text-gray-500">{label}</dt>
                  <dd className="tabular-nums text-gray-300">{n.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </div>

      {/* ---- the log ---- */}
      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Runs</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            One row per day the engine looked at this company, newest first. A dry run records what it
            would have charged; a live run records what it did.
          </p>
        </div>
        {runs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">No runs yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Mode</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Charged</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">From credit</th>
                <th className="px-4 py-2 text-right font-medium">Already</th>
                <th className="px-4 py-2 text-right font-medium">Not due</th>
                <th className="px-4 py-2 text-right font-medium">Skipped</th>
                <th className="px-4 py-2 font-medium">Finished</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-300">
              {runs.map((r) => {
                const skipped =
                  r.skippedBeforeStart + r.skippedJoinedAfter + r.skippedZeroRate +
                  r.skippedNoService + r.skippedUnprovisioned
                return (
                  <tr key={r.id} className="hover:bg-gray-800/40">
                    <td className="px-4 py-2">
                      <Link href={'/dashboard/billing-runs/' + r.id} className="font-medium text-blue-400 hover:underline">
                        {formatDateOnly(r.runDate)}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{MODE_LABEL[r.mode]}</td>
                    <td className="px-4 py-2">
                      <StatusPill status={r.status} />
                      {r.attempts > 1 ? <span className="ml-1 text-gray-600">×{r.attempts}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.charged.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(r.totalAmount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-500">{r.creditApplied ? formatCurrency(r.creditApplied) : '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-500">{r.skippedAlready.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-500">{r.skippedNotDue.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-500">{skipped.toLocaleString()}</td>
                    <td className="px-4 py-2 text-gray-500">
                      {r.finishedAt ? timeAgo(r.finishedAt) : '—'}
                      {r.error ? <span className="ml-1 text-red-400" title={r.error}>error</span> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
