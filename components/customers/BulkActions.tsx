'use client'

import Papa from 'papaparse'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarCog, CalendarClock, CheckCircle2, Download, Loader2,
  MoreHorizontal, Receipt, Upload, Zap,
} from 'lucide-react'

import { Modal, settingsInput } from '@/components/settings/Modal'
import { formatCurrency } from '@/lib/format'
import {
  billBatch, loadBillAllPlan, loadBillDatePlan, loadCutOffPlan, loadProvisionPlan,
  logBulkBill, logBulkProvision, provisionBatch, setAllBillDates, setAllCutOffDates,
  type BillAllPlan, type BillDatePlan, type BillOutcome, type BillTarget,
  type CutOffPlan, type ProvisionOutcome, type ProvisionPlanResult, type ProvisionTarget,
} from '@/app/actions/bulk'

/**
 * The company-wide actions on the customer list.
 *
 * Every one is destructive at a scale that cannot be undone by hand, so every
 * one makes the operator type the number of records they are about to touch.
 * The number is read fresh when the modal opens and checked again on the
 * server, so agreeing to "312 customers" cannot be applied to a different 312.
 */

/**
 * Customers per provisionBatch() call.
 *
 * Each customer is a transaction against the NAS over the network, so a batch
 * is a few seconds of work. Small batches keep the progress bar moving and
 * keep any single request short; the server refuses anything over 100.
 */
const BATCH = 25

/**
 * Customers per billBatch() call.
 *
 * Larger than BATCH because these are Postgres writes rather than round trips
 * to a NAS, but still bounded: the run has to stay resumable and the progress
 * bar has to move. The server refuses anything over 100.
 */
const BILL_BATCH = 50

const primaryBtn =
  'inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50'

const ghostBtn =
  'inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3.5 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50'

const menuItem =
  'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-gray-300 transition hover:bg-gray-800 hover:text-white'

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
      {children}
    </p>
  )
}

function Loading() {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-gray-500">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Counting customers…
    </p>
  )
}

/** "7 Sep 2026" — matches how the rest of the app writes a date. */
function prettyDate(value: string): string {
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return value
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

/**
 * The overflow menu beside Add Customer.
 *
 * These three are one-off migration tools, not daily work: a CSR adds
 * customers at the counter all day and never touches any of them. Sitting them
 * as peer buttons next to Add Customer gave four equally-weighted actions and
 * made the two destructive ones the easiest things on the page to hit by
 * accident. Behind a menu they are still one click away for the manager who
 * wants them.
 */
export function BulkActions() {
  const [open, setOpen] = useState<'cutoff' | 'provision' | 'bill' | 'billdate' | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return

    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More customer tools"
        onClick={() => setMenuOpen((v) => !v)}
        className={
          'inline-flex items-center rounded-lg px-2.5 py-2 text-sm font-semibold transition ' +
          (menuOpen ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700')
        }
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>

      {menuOpen ? (
        <div
          role="menu"
          aria-label="Customer tools"
          className="absolute right-0 z-30 mt-1 w-60 overflow-hidden rounded-lg border border-gray-800 bg-gray-900 py-1 shadow-xl"
        >
          <p className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
            Migration tools
          </p>

          <Link
            role="menuitem"
            href="/dashboard/customers/import"
            onClick={() => setMenuOpen(false)}
            className={menuItem}
          >
            <Upload className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
            Import CSV
          </Link>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              setOpen('cutoff')
            }}
            className={menuItem}
          >
            <CalendarCog className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
            Set Cut Off Dates
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              setOpen('provision')
            }}
            className={menuItem}
          >
            <Zap className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
            Provision All
          </button>

          {/* Separate group on purpose. The tools above are one-off migration
              work; these two are recurring billing operations that a manager
              runs deliberately, month after month. */}
          <p className="border-t border-gray-800 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
            Billing
          </p>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              setOpen('bill')
            }}
            className={menuItem}
          >
            <Receipt className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
            Bill All
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false)
              setOpen('billdate')
            }}
            className={menuItem}
          >
            <CalendarClock className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
            Set Bill Dates
          </button>
        </div>
      ) : null}

      {open === 'cutoff' ? <CutOffModal onClose={() => setOpen(null)} /> : null}
      {open === 'provision' ? <ProvisionModal onClose={() => setOpen(null)} /> : null}
      {open === 'bill' ? <BillAllModal onClose={() => setOpen(null)} /> : null}
      {open === 'billdate' ? <BillDateModal onClose={() => setOpen(null)} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Set all cut off dates
// ---------------------------------------------------------------------------

function CutOffModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [plan, setPlan] = useState<CutOffPlan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [day, setDay] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    loadCutOffPlan()
      .then((result) => {
        if (!live) return
        setPlan(result)
        setDay(result.currentDay ? String(result.currentDay) : '')
      })
      .catch((err: Error) => live && setLoadError(err.message))
    return () => {
      live = false
    }
  }, [])

  const count = plan?.customerCount ?? 0
  const dayValue = Number(day)
  const dayValid = Number.isInteger(dayValue) && dayValue >= 1 && dayValue <= 28
  const confirmed = confirm.trim() === String(count) && count > 0

  async function submit() {
    if (!dayValid || !confirmed) return
    setSaving(true)
    setError(null)
    try {
      const result = await setAllCutOffDates({ day: dayValue, confirmCount: count })
      if (result.ok) {
        setDone(result.updated)
        router.refresh()
      } else {
        setError(result.error)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Set cut off day for ALL customers" onClose={onClose}>
      {loadError ? <ErrorNote>{loadError}</ErrorNote> : null}

      {!plan && !loadError ? <Loading /> : null}

      {done !== null ? (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm text-gray-200">
            <CheckCircle2 className="h-4 w-4 text-green-400" aria-hidden />
            Cut off day set to {dayValue} for {done.toLocaleString()}{' '}
            {done === 1 ? 'customer' : 'customers'}.
          </p>
          <button type="button" onClick={onClose} className={primaryBtn}>
            Done
          </button>
        </div>
      ) : plan ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="bulk-cutoff-day" className="block text-xs font-medium text-gray-400">
              Day of month
            </label>
            <input
              id="bulk-cutoff-day"
              type="number"
              min={1}
              max={28}
              inputMode="numeric"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className={settingsInput + ' w-24 tabular-nums'}
            />
            {day && !dayValid ? (
              <p className="text-xs text-red-400">
                Must be a day between 1 and 28, so it exists in every month.
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-gray-800 bg-gray-800/40 px-3 py-2.5 text-sm">
            <p className="text-gray-200">
              This will change{' '}
              <strong className="font-semibold">{count.toLocaleString()}</strong>{' '}
              {count === 1 ? 'customer' : 'customers'}.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              It does NOT change anyone&apos;s current expiry date. Nobody goes online or offline
              because of this.
            </p>
          </div>

          {count === 0 ? (
            <ErrorNote>There are no customers to update.</ErrorNote>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="bulk-cutoff-confirm" className="block text-xs font-medium text-gray-400">
                Type &quot;{count}&quot; to confirm
              </label>
              <input
                id="bulk-cutoff-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                className={settingsInput + ' w-32 tabular-nums'}
              />
            </div>
          )}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex items-center gap-2 border-t border-gray-800 pt-4">
            <button
              type="button"
              onClick={submit}
              disabled={!dayValid || !confirmed || saving}
              className={primaryBtn}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {saving ? 'Updating…' : 'Set cut off day'}
            </button>
            <button type="button" onClick={onClose} disabled={saving} className={ghostBtn}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Provision all
// ---------------------------------------------------------------------------

type ProvisionSummary = {
  provisioned: ProvisionOutcome[]
  skippedNoIdentity: ProvisionOutcome[]
  skippedAlready: ProvisionOutcome[]
  failed: ProvisionOutcome[]
  /** The single date when that box was ticked, otherwise null. */
  singleExpiry: string | null
  /** The distinct dates actually written, from the outcomes themselves. */
  dates: { expiry: string; count: number }[]
}

/** Distinct dates and their counts, earliest first — mirrors the server's own. */
function groupByExpiry(rows: { expiry?: string }[]): { expiry: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!r.expiry) continue
    counts.set(r.expiry, (counts.get(r.expiry) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([expiry, count]) => ({ expiry, count }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry))
}

/**
 * The table of dates a per-customer run would write, or did write.
 *
 * This is the whole point of the change: the operator is agreeing to a spread
 * of dates, not one, so they have to be able to see the spread before they
 * confirm it. Scrolls rather than truncates — a company with forty cut-off days
 * needs all forty visible, not the first six and an ellipsis.
 */
function ExpiryBreakdown({ rows }: { rows: { expiry: string; count: number }[] }) {
  const total = rows.reduce((sum, r) => sum + r.count, 0)

  return (
    <div className="overflow-hidden rounded-lg border border-gray-800">
      <div className="max-h-44 overflow-y-auto">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-[10px] uppercase tracking-wider text-gray-500">
              <th scope="col" className="px-3 py-1.5 font-semibold">Expiry</th>
              <th scope="col" className="px-3 py-1.5 text-right font-semibold">Customers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rows.map((r) => (
              <tr key={r.expiry}>
                <td className="px-3 py-1.5 text-gray-200">{prettyDate(r.expiry)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-gray-400">
                  {r.count.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-gray-800 bg-gray-900/60 px-3 py-1.5 text-[11px] text-gray-500">
        {rows.length.toLocaleString()} {rows.length === 1 ? 'date' : 'different dates'} ·{' '}
        {total.toLocaleString()} {total === 1 ? 'customer' : 'customers'}
      </p>
    </div>
  )
}

function ProvisionModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [plan, setPlan] = useState<ProvisionPlanResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expiry, setExpiry] = useState('')
  /**
   * Off by default: each customer keeps their own cut-off day. Ticking it
   * reveals the date field and restores the one-date-for-everyone behaviour.
   */
  const [useOneDate, setUseOneDate] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ProvisionSummary | null>(null)

  useEffect(() => {
    let live = true
    loadProvisionPlan()
      .then((result) => {
        if (!live) return
        setPlan(result)
        setExpiry(result.defaultExpiry)
      })
      .catch((err: Error) => live && setLoadError(err.message))
    return () => {
      live = false
    }
  }, [])

  const ready = useMemo(() => plan?.ready ?? [], [plan])
  const confirmed = confirm.trim() === String(ready.length) && ready.length > 0
  const expiryValid = /^\d{4}-\d{2}-\d{2}$/.test(expiry)

  // Only the single-date path can be invalid: the per-customer dates are
  // computed by the server from each customer's own cut-off day.
  const canRun = confirmed && (!useOneDate || expiryValid)

  const todayYmd = (() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  })()
  const expiryInPast = useOneDate && expiryValid && expiry < todayYmd

  const run = useCallback(async () => {
    if (!plan) return
    setRunning(true)
    setError(null)
    setProgress({ done: 0, total: ready.length })

    // Which RULE to apply, never the per-customer dates themselves — the server
    // derives those from the rows, so what gets written cannot be steered from
    // here.
    const choice = useOneDate
      ? ({ mode: 'single', date: expiry } as const)
      : ({ mode: 'per_cut_off' } as const)

    const outcomes: ProvisionOutcome[] = []

    try {
      for (let i = 0; i < ready.length; i += BATCH) {
        const slice = ready.slice(i, i + BATCH)
        const result = await provisionBatch({
          ids: slice.map((c: ProvisionTarget) => c.id),
          expiry: choice,
        })
        outcomes.push(...result.outcomes)
        setProgress({ done: i + slice.length, total: ready.length })
      }
    } catch (err) {
      // The run stopped part way. Everything already written stays written, and
      // what it managed is still reported — re-running is safe because each
      // batch re-checks radcheck before writing.
      setError(
        'The run stopped: ' + (err as Error).message +
        ' Customers provisioned before this point were saved. Re-running is safe — ' +
        'anyone already done will be skipped.'
      )
    }

    const collected: ProvisionSummary = {
      provisioned: outcomes.filter((o) => o.result === 'provisioned'),
      // Customers with no identity never reach a batch, so the plan's own list
      // is the real count; the batch category only catches a row that lost its
      // MAC between the preview and the write.
      skippedNoIdentity: [
        ...plan.noIdentity.map((c) => ({ ...c, result: 'skipped_no_identity' as const })),
        ...outcomes.filter((o) => o.result === 'skipped_no_identity'),
      ],
      skippedAlready: outcomes.filter((o) => o.result === 'skipped_already'),
      failed: outcomes.filter((o) => o.result === 'failed'),
      singleExpiry: useOneDate ? expiry : null,
      // Read back off the outcomes rather than off the preview, so the summary
      // reports what was actually written.
      dates: groupByExpiry(outcomes.filter((o) => o.result === 'provisioned')),
    }

    try {
      await logBulkProvision({
        provisioned: collected.provisioned.length,
        skippedNoIdentity: collected.skippedNoIdentity.length,
        skippedAlready: collected.skippedAlready.length,
        failed: collected.failed.length,
        singleExpiry: collected.singleExpiry,
        dates: collected.dates,
      })
    } catch {
      // The audit row is the least important thing that just happened.
    }

    setSummary(collected)
    setRunning(false)
    router.refresh()
  }, [plan, ready, expiry, useOneDate, router])

  function download() {
    if (!summary) return
    const label: Record<ProvisionOutcome['result'], string> = {
      provisioned: 'Provisioned',
      skipped_no_identity: 'Skipped',
      skipped_already: 'Skipped',
      failed: 'Failed',
    }
    const reason: Record<ProvisionOutcome['result'], string> = {
      provisioned: '',
      skipped_no_identity: 'no MAC address',
      skipped_already: 'already provisioned',
      failed: '',
    }

    const all = [
      ...summary.provisioned, ...summary.skippedNoIdentity,
      ...summary.skippedAlready, ...summary.failed,
    ]

    // Expiry is per customer now, so it belongs on the row rather than only in
    // the file name.
    const csv = Papa.unparse({
      fields: ['Customer ID', 'Name', 'Result', 'Expiry', 'Reason'],
      data: all.map((o) => [
        o.id, o.name, label[o.result], o.expiry ?? '', o.error ?? reason[o.result],
      ]),
    })

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download =
      'provision-all-' + (summary.singleExpiry ?? 'by-cut-off-day') + '.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Modal title="Provision all unprovisioned customers" onClose={onClose}>
      {loadError ? <ErrorNote>{loadError}</ErrorNote> : null}
      {!plan && !loadError ? <Loading /> : null}

      {plan && !plan.configured ? (
        <div className="space-y-4">
          <ErrorNote>
            The RADIUS database is not configured on this system, so nothing can be provisioned.
          </ErrorNote>
          <button type="button" onClick={onClose} className={ghostBtn}>
            Close
          </button>
        </div>
      ) : null}

      {/* ---------------- result ---------------- */}
      {summary ? (
        <div className="space-y-4">
          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <dl className="space-y-1.5 text-sm">
            <Row
              icon="good"
              label="Provisioned"
              value={summary.provisioned.length + ' customers'}
            />
            <Row
              label="Skipped"
              value={summary.skippedNoIdentity.length + ' — no MAC address'}
            />
            <Row
              label="Skipped"
              value={summary.skippedAlready.length + ' — already provisioned'}
            />
            <Row
              icon={summary.failed.length > 0 ? 'bad' : undefined}
              label="Failed"
              value={String(summary.failed.length)}
            />
          </dl>

          {summary.failed.length > 0 ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-gray-800 p-2 text-xs">
              {summary.failed.map((f) => (
                <li key={f.id} className="text-gray-400">
                  <span className="text-gray-500">#{f.id}</span> {f.name}: {f.error}
                </li>
              ))}
            </ul>
          ) : null}

          {summary.singleExpiry ? (
            <p className="text-[11px] text-gray-600">
              Expiry written: {prettyDate(summary.singleExpiry)}. Cut off dates were not touched.
            </p>
          ) : summary.dates.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[11px] text-gray-600">
                Expiry dates written, from each customer&apos;s own cut off day. Cut off dates
                themselves were not touched.
              </p>
              <ExpiryBreakdown rows={summary.dates} />
            </div>
          ) : (
            <p className="text-[11px] text-gray-600">
              Nothing was written, so no expiry dates changed.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-gray-800 pt-4">
            <button type="button" onClick={download} className={ghostBtn}>
              <Download className="h-4 w-4" aria-hidden />
              Download list
            </button>
            <button type="button" onClick={onClose} className={primaryBtn}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------------- running ---------------- */}
      {running && !summary ? (
        <div className="space-y-2 py-2">
          <div className="h-2 overflow-hidden rounded-full bg-gray-800">
            <div
              className="h-full rounded-full bg-blue-600 transition-[width] duration-300"
              style={{
                width:
                  progress.total > 0
                    ? Math.round((progress.done / progress.total) * 100) + '%'
                    : '0%',
              }}
            />
          </div>
          <p className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {progress.done.toLocaleString()} of {progress.total.toLocaleString()} customers written.
            Leave this open until it finishes.
          </p>
        </div>
      ) : null}

      {/* ---------------- confirm ---------------- */}
      {plan && plan.configured && !summary && !running ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-gray-800 bg-gray-800/40 px-3 py-2.5 text-sm">
            <p className="text-gray-200">
              <strong className="font-semibold">{ready.length.toLocaleString()}</strong> ready to
              provision
            </p>
            <p className="mt-0.5 text-gray-400">
              {plan.noIdentity.length.toLocaleString()} skipped — no MAC address
            </p>
            {plan.alreadyProvisioned.length > 0 ? (
              <p className="mt-0.5 text-xs text-gray-500">
                {plan.alreadyProvisioned.length.toLocaleString()} already provisioned and left alone.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium text-gray-400">
                {useOneDate ? 'Expiry date' : 'Expiry dates'}
              </span>
              {!useOneDate && plan.breakdown.length > 0 ? (
                <span className="text-[11px] text-gray-600">
                  Each customer&apos;s own cut off day
                </span>
              ) : null}
            </div>

            {useOneDate ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="bulk-provision-expiry"
                    type="date"
                    aria-label="Expiry date for every customer"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className={settingsInput + ' w-44'}
                  />
                  {expiryValid ? (
                    <span className="text-xs text-gray-500">{prettyDate(expiry)}</span>
                  ) : null}
                </div>
                <p className="text-[11px] text-gray-600">
                  Defaults to the company cut off day. Every customer gets this same date.
                </p>
                {expiryInPast ? (
                  <p className="flex items-start gap-1.5 text-xs text-amber-300/90">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    That date is in the past, so these customers will be provisioned already
                    expired.
                  </p>
                ) : null}
              </div>
            ) : plan.breakdown.length > 0 ? (
              <div className="space-y-1.5">
                <ExpiryBreakdown rows={plan.breakdown} />
                <p className="text-[11px] text-gray-600">
                  Each customer expires on the next occurrence of their own cut off day.
                  {plan.withoutCutOff > 0 ? (
                    <>
                      {' '}
                      {plan.withoutCutOff.toLocaleString()}{' '}
                      {plan.withoutCutOff === 1 ? 'customer has' : 'customers have'} no cut off day
                      set and will use the company day, {prettyDate(plan.defaultExpiry)}.
                    </>
                  ) : null}
                </p>
              </div>
            ) : null}

            <label className="flex items-center gap-2 pt-0.5 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={useOneDate}
                onChange={(e) => setUseOneDate(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-700 bg-gray-800 accent-blue-600"
              />
              Use one date for everyone
            </label>
          </div>

          {ready.length === 0 ? (
            <ErrorNote>There is nobody to provision.</ErrorNote>
          ) : (
            <div className="space-y-1.5">
              <label
                htmlFor="bulk-provision-confirm"
                className="block text-xs font-medium text-gray-400"
              >
                Type &quot;{ready.length}&quot; to confirm
              </label>
              <input
                id="bulk-provision-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                className={settingsInput + ' w-32 tabular-nums'}
              />
            </div>
          )}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex items-center gap-2 border-t border-gray-800 pt-4">
            <button
              type="button"
              onClick={run}
              disabled={!canRun}
              className={primaryBtn}
            >
              Provision {ready.length.toLocaleString()}{' '}
              {ready.length === 1 ? 'customer' : 'customers'}
            </button>
            <button type="button" onClick={onClose} className={ghostBtn}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Set all bill dates
// ---------------------------------------------------------------------------

/**
 * Deliberately the same shape as CutOffModal, because it is the same kind of
 * change: one day of the month written to one column on every customer.
 */
function BillDateModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [plan, setPlan] = useState<BillDatePlan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [day, setDay] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    loadBillDatePlan()
      .then((result) => {
        if (!live) return
        setPlan(result)
        setDay(result.currentDay ? String(result.currentDay) : '')
      })
      .catch((err: Error) => live && setLoadError(err.message))
    return () => {
      live = false
    }
  }, [])

  const count = plan?.customerCount ?? 0
  const dayValue = Number(day)
  const dayValid = Number.isInteger(dayValue) && dayValue >= 1 && dayValue <= 28
  const confirmed = confirm.trim() === String(count) && count > 0

  async function submit() {
    if (!dayValid || !confirmed) return
    setSaving(true)
    setError(null)
    try {
      const result = await setAllBillDates({ day: dayValue, confirmCount: count })
      if (result.ok) {
        setDone(result.updated)
        router.refresh()
      } else {
        setError(result.error)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Set bill day for ALL customers" onClose={onClose}>
      {loadError ? <ErrorNote>{loadError}</ErrorNote> : null}
      {!plan && !loadError ? <Loading /> : null}

      {plan && !plan.available ? (
        <div className="space-y-4">
          <ErrorNote>
            Postpaid billing has not been enabled on this database yet, so there is no bill date
            column to set. Apply migration 0011_postpaid_billing.sql first.
          </ErrorNote>
          <button type="button" onClick={onClose} className={ghostBtn}>
            Close
          </button>
        </div>
      ) : null}

      {done !== null ? (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm text-gray-200">
            <CheckCircle2 className="h-4 w-4 text-green-400" aria-hidden />
            Bill day set to {dayValue} for {done.toLocaleString()}{' '}
            {done === 1 ? 'customer' : 'customers'}.
          </p>
          <button type="button" onClick={onClose} className={primaryBtn}>
            Done
          </button>
        </div>
      ) : plan && plan.available ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="bulk-billdate-day" className="block text-xs font-medium text-gray-400">
              Day of month
            </label>
            <input
              id="bulk-billdate-day"
              type="number"
              min={1}
              max={28}
              inputMode="numeric"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className={settingsInput + ' w-24 tabular-nums'}
            />
            {day && !dayValid ? (
              <p className="text-xs text-red-400">
                Must be a day between 1 and 28, so it exists in every month.
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-gray-800 bg-gray-800/40 px-3 py-2.5 text-sm">
            <p className="text-gray-200">
              This will change{' '}
              <strong className="font-semibold">{count.toLocaleString()}</strong>{' '}
              {count === 1 ? 'customer' : 'customers'}.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              It writes the bill day and nothing else. No balances move, no expiry dates change,
              and nobody&apos;s billing type is switched. On a prepaid customer the value simply
              sits unused.
            </p>
          </div>

          {count === 0 ? (
            <ErrorNote>There are no customers to update.</ErrorNote>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="bulk-billdate-confirm" className="block text-xs font-medium text-gray-400">
                Type &quot;{count}&quot; to confirm
              </label>
              <input
                id="bulk-billdate-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                className={settingsInput + ' w-32 tabular-nums'}
              />
            </div>
          )}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex items-center gap-2 border-t border-gray-800 pt-4">
            <button
              type="button"
              onClick={submit}
              disabled={!dayValid || !confirmed || saving}
              className={primaryBtn}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {saving ? 'Updating…' : 'Set bill day'}
            </button>
            <button type="button" onClick={onClose} disabled={saving} className={ghostBtn}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Bill all
// ---------------------------------------------------------------------------

type BillSummary = {
  periodLabel: string
  billed: number
  totalAmount: number
  skippedAlready: number
  skippedZeroRate: number
  failed: BillOutcome[]
}

/**
 * The thirteen months up to and including this one, newest first.
 *
 * A fixed list rather than a free date field: the period is the thing that
 * decides whether a run is a duplicate, so it should not be possible to typo it
 * into a month nobody meant. Future months are absent because this company
 * bills in arrears — there is nothing yet to charge for.
 */
function recentMonths(): { key: string; label: string }[] {
  const now = new Date()
  const out: { key: string; label: string }[] = []
  for (let back = 0; back < 13; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1)
    out.push({
      key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
      label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    })
  }
  return out
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium tabular-nums text-gray-200">{value}</dd>
    </div>
  )
}

/**
 * Bill All.
 *
 * The dangerous one. Running it twice for the same period would double every
 * carried balance in the company with nothing in the data to say it happened,
 * so the count of customers ALREADY billed for the chosen period is loaded and
 * shown before the confirm field is reachable — and the server refuses those
 * rows again at write time regardless of what this preview said.
 *
 * The period defaults to LAST month, not this one: this company bills in
 * arrears, so the bill raised at the start of September is September's bill for
 * August's service.
 */
function BillAllModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const months = useMemo(() => recentMonths(), [])
  // months[0] is the current month; months[1] is the month just ended.
  const [period, setPeriod] = useState(months[1]?.key ?? months[0].key)
  const [plan, setPlan] = useState<BillAllPlan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<BillSummary | null>(null)

  useEffect(() => {
    let live = true
    loadBillAllPlan(period)
      .then((result) => live && setPlan(result))
      .catch((err: Error) => live && setLoadError(err.message))
    return () => {
      live = false
    }
  }, [period])

  /**
   * Clearing the old plan happens HERE, not in the effect above.
   *
   * The counts and the typed confirmation belong to one period. Leaving the
   * previous month's numbers on screen while the new month loads would let
   * somebody confirm a figure that was never true of the period they just
   * chose — which is exactly the mistake this modal exists to prevent.
   */
  function choosePeriod(next: string) {
    setPeriod(next)
    setPlan(null)
    setLoadError(null)
    setConfirm('')
  }

  const targets = useMemo(() => plan?.targets ?? [], [plan])
  const confirmed = confirm.trim() === String(targets.length) && targets.length > 0

  const run = useCallback(async () => {
    if (!plan) return
    setRunning(true)
    setError(null)
    setProgress({ done: 0, total: targets.length })

    const outcomes: BillOutcome[] = []

    try {
      for (let i = 0; i < targets.length; i += BILL_BATCH) {
        const slice = targets.slice(i, i + BILL_BATCH)
        const result = await billBatch({
          period: plan.period.key,
          ids: slice.map((t: BillTarget) => t.id),
        })
        outcomes.push(...result.outcomes)
        setProgress({ done: i + slice.length, total: targets.length })
      }
    } catch (err) {
      // Everything already written stays written. Re-running for the same
      // period is safe: those rows now carry the period's last_billed_date and
      // the server skips them.
      setError(
        'The run stopped: ' + (err as Error).message +
        ' Customers billed before this point were saved. Re-running for the same period is ' +
        'safe — anyone already billed will be skipped.'
      )
    }

    const billed = outcomes.filter((o) => o.result === 'billed')

    // The plan's own counts are added in: customers already billed, or on a
    // zero rate, never entered a batch, so the outcomes alone would under-report
    // them. The batch categories catch rows that changed after the preview.
    const collected: BillSummary = {
      periodLabel: plan.period.label,
      billed: billed.length,
      totalAmount: billed.reduce((sum, o) => sum + (o.amount ?? 0), 0),
      skippedAlready:
        plan.alreadyBilled + outcomes.filter((o) => o.result === 'skipped_already').length,
      skippedZeroRate:
        plan.zeroRate + outcomes.filter((o) => o.result === 'skipped_zero_rate').length,
      failed: outcomes.filter((o) => o.result === 'failed'),
    }

    try {
      await logBulkBill({
        period: plan.period.key,
        billed: collected.billed,
        totalAmount: collected.totalAmount,
        skippedAlready: collected.skippedAlready,
        skippedZeroRate: collected.skippedZeroRate,
        failed: collected.failed.length,
      })
    } catch {
      // The audit row is the least important thing that just happened.
    }

    setSummary(collected)
    setRunning(false)
    router.refresh()
  }, [plan, targets, router])

  return (
    <Modal title="Bill all postpaid customers" onClose={onClose}>
      {loadError ? <ErrorNote>{loadError}</ErrorNote> : null}
      {!plan && !loadError && !summary ? <Loading /> : null}

      {plan && !plan.available ? (
        <div className="space-y-4">
          <ErrorNote>
            Postpaid billing has not been enabled on this database yet, so there is nothing to
            bill. Apply migration 0011_postpaid_billing.sql first.
          </ErrorNote>
          <button type="button" onClick={onClose} className={ghostBtn}>
            Close
          </button>
        </div>
      ) : null}

      {/* ---------------- result ---------------- */}
      {summary ? (
        <div className="space-y-4">
          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <dl className="space-y-1.5 text-sm">
            <Row
              icon="good"
              label="Billed"
              value={
                summary.billed.toLocaleString() +
                (summary.billed === 1 ? ' customer' : ' customers') +
                ' · ' + formatCurrency(summary.totalAmount)
              }
            />
            <Row
              label="Skipped"
              value={summary.skippedAlready.toLocaleString() + ' — already billed for this period'}
            />
            <Row
              label="Skipped"
              value={summary.skippedZeroRate.toLocaleString() + ' — no monthly rate'}
            />
            <Row
              icon={summary.failed.length > 0 ? 'bad' : undefined}
              label="Failed"
              value={String(summary.failed.length)}
            />
          </dl>

          {summary.failed.length > 0 ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-gray-800 p-2 text-xs">
              {summary.failed.map((f) => (
                <li key={f.id} className="text-gray-400">
                  <span className="text-gray-500">#{f.id}</span> {f.name}: {f.error}
                </li>
              ))}
            </ul>
          ) : null}

          <p className="text-[11px] text-gray-600">
            Billed for {summary.periodLabel}. Carried balances only — no expiry dates, network
            records or payments were changed. Running this again for {summary.periodLabel} will
            skip everyone billed just now.
          </p>

          <div className="flex items-center gap-2 border-t border-gray-800 pt-4">
            <button type="button" onClick={onClose} className={primaryBtn}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------------- running ---------------- */}
      {running && !summary ? (
        <div className="space-y-2 py-2">
          <div className="h-2 overflow-hidden rounded-full bg-gray-800">
            <div
              className="h-full rounded-full bg-blue-600 transition-[width] duration-300"
              style={{
                width:
                  progress.total > 0
                    ? Math.round((progress.done / progress.total) * 100) + '%'
                    : '0%',
              }}
            />
          </div>
          <p className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {progress.done.toLocaleString()} of {progress.total.toLocaleString()} customers billed.
            Leave this open until it finishes.
          </p>
        </div>
      ) : null}

      {/* ---------------- confirm ---------------- */}
      {plan && plan.available && !summary && !running ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="bulk-bill-period" className="block text-xs font-medium text-gray-400">
              Period
            </label>
            <select
              id="bulk-bill-period"
              value={period}
              onChange={(e) => choosePeriod(e.target.value)}
              className={settingsInput + ' w-52'}
            >
              {months.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-gray-600">
              The month being billed for, not the month you are running this in. Defaults to the
              month just ended.
            </p>
          </div>

          <dl className="space-y-1.5 rounded-lg border border-gray-800 bg-gray-800/40 px-3 py-2.5 text-sm">
            <SummaryLine
              label="Customers"
              value={plan.postpaidCount.toLocaleString() + ' postpaid'}
            />
            <SummaryLine label="Already billed" value={plan.alreadyBilled.toLocaleString()} />
            {plan.zeroRate > 0 ? (
              <SummaryLine
                label="No monthly rate"
                value={plan.zeroRate.toLocaleString() + ' — skipped'}
              />
            ) : null}
            <SummaryLine label="Will be billed" value={targets.length.toLocaleString()} />
            <SummaryLine label="Total to bill" value={formatCurrency(plan.totalAmount)} />
          </dl>

          <p className="text-xs text-gray-500">
            Each customer&apos;s monthly rate is added to their carried balance. This does NOT
            change anyone&apos;s expiry date, and nobody goes offline because of it.
          </p>

          {plan.alreadyBilled > 0 ? (
            <p className="flex items-start gap-1.5 text-xs text-amber-300/90">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {plan.alreadyBilled.toLocaleString()}{' '}
              {plan.alreadyBilled === 1 ? 'customer has' : 'customers have'} already been billed for{' '}
              {plan.period.label} and will be left alone. Billing them twice cannot be detected
              afterwards, so they are excluded rather than warned about.
            </p>
          ) : null}

          {targets.length === 0 ? (
            <ErrorNote>
              {plan.postpaidCount === 0
                ? 'There are no postpaid customers to bill.'
                : 'There is nobody left to bill for ' + plan.period.label + '.'}
            </ErrorNote>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="bulk-bill-confirm" className="block text-xs font-medium text-gray-400">
                Type &quot;{targets.length}&quot; to confirm
              </label>
              <input
                id="bulk-bill-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                className={settingsInput + ' w-32 tabular-nums'}
              />
            </div>
          )}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex items-center gap-2 border-t border-gray-800 pt-4">
            <button type="button" onClick={run} disabled={!confirmed} className={primaryBtn}>
              Bill {targets.length.toLocaleString()}{' '}
              {targets.length === 1 ? 'customer' : 'customers'}
            </button>
            <button type="button" onClick={onClose} className={ghostBtn}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

function Row({
  icon, label, value,
}: {
  icon?: 'good' | 'bad'
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2">
      {icon === 'good' ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" aria-hidden />
      ) : icon === 'bad' ? (
        <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden />
      )}
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-200">{value}</dd>
    </div>
  )
}
