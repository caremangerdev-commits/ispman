'use client'

import Papa from 'papaparse'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, CalendarCog, CheckCircle2, Download, Loader2, MoreHorizontal,
  Upload, Zap,
} from 'lucide-react'

import { Modal, settingsInput } from '@/components/settings/Modal'
import {
  loadCutOffPlan, loadProvisionPlan, logBulkProvision, provisionBatch,
  setAllCutOffDates,
  type CutOffPlan, type ProvisionOutcome, type ProvisionPlanResult, type ProvisionTarget,
} from '@/app/actions/bulk'

/**
 * The two company-wide actions on the customer list.
 *
 * Both are destructive at a scale that cannot be undone by hand, so both make
 * the operator type the number of records they are about to touch. The number
 * is read fresh when the modal opens and checked again on the server, so
 * agreeing to "312 customers" cannot be applied to a different 312.
 */

/**
 * Customers per provisionBatch() call.
 *
 * Each customer is a transaction against the NAS over the network, so a batch
 * is a few seconds of work. Small batches keep the progress bar moving and
 * keep any single request short; the server refuses anything over 100.
 */
const BATCH = 25

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
  const [open, setOpen] = useState<'cutoff' | 'provision' | null>(null)
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
        </div>
      ) : null}

      {open === 'cutoff' ? <CutOffModal onClose={() => setOpen(null)} /> : null}
      {open === 'provision' ? <ProvisionModal onClose={() => setOpen(null)} /> : null}
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
  expiry: string
}

function ProvisionModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [plan, setPlan] = useState<ProvisionPlanResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expiry, setExpiry] = useState('')
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

  const todayYmd = (() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  })()
  const expiryInPast = expiryValid && expiry < todayYmd

  const run = useCallback(async () => {
    if (!plan) return
    setRunning(true)
    setError(null)
    setProgress({ done: 0, total: ready.length })

    const outcomes: ProvisionOutcome[] = []

    try {
      for (let i = 0; i < ready.length; i += BATCH) {
        const slice = ready.slice(i, i + BATCH)
        const result = await provisionBatch({
          ids: slice.map((c: ProvisionTarget) => c.id),
          expiry,
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
      expiry,
    }

    try {
      await logBulkProvision({
        provisioned: collected.provisioned.length,
        skippedNoIdentity: collected.skippedNoIdentity.length,
        skippedAlready: collected.skippedAlready.length,
        failed: collected.failed.length,
        expiry,
      })
    } catch {
      // The audit row is the least important thing that just happened.
    }

    setSummary(collected)
    setRunning(false)
    router.refresh()
  }, [plan, ready, expiry, router])

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

    const csv = Papa.unparse({
      fields: ['Customer ID', 'Name', 'Result', 'Reason'],
      data: all.map((o) => [o.id, o.name, label[o.result], o.error ?? reason[o.result]]),
    })

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'provision-all-' + summary.expiry + '.csv'
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

          <p className="text-[11px] text-gray-600">
            Expiry written: {prettyDate(summary.expiry)}. Cut off dates were not touched.
          </p>

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

          <div className="space-y-1.5">
            <label htmlFor="bulk-provision-expiry" className="block text-xs font-medium text-gray-400">
              Expiry date
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="bulk-provision-expiry"
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className={settingsInput + ' w-44'}
              />
              {expiryValid ? (
                <span className="text-xs text-gray-500">{prettyDate(expiry)}</span>
              ) : null}
            </div>
            <p className="text-[11px] text-gray-600">
              Defaults to the next cut off day. Every customer gets this same date.
            </p>
            {expiryInPast ? (
              <p className="flex items-start gap-1.5 text-xs text-amber-300/90">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                That date is in the past, so these customers will be provisioned already expired.
              </p>
            ) : null}
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
              disabled={!confirmed || !expiryValid}
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
