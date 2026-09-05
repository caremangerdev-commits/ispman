'use client'

import Papa from 'papaparse'
import Link from 'next/link'
import { useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, FileSpreadsheet,
  Loader2, Upload, X,
} from 'lucide-react'

import {
  createImportPlans, findExistingMacs, importCustomerBatch, logCustomerImport,
  type NewPlanInput, type RowFailure,
} from '@/app/actions/import'
import { formatCurrency } from '@/lib/format'
import {
  BATCH_SIZE, classifyRow, extractRow, guessMapping, isImportable,
  matchExistingPlan, MAX_ROWS, resolveRow, splitFullName, summariseCutOffDays,
  summarisePlans,
  withMacConflicts, FIELD_LABELS, FIELD_TARGETS,
  type FieldTarget, type RawRow, type ResolvedRow,
} from '@/lib/import/csv'
import type { ServicePlan } from '@/lib/types'

// ---------------------------------------------------------------------------
// Shared bits of chrome
// ---------------------------------------------------------------------------

const selectCls =
  'rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'

const primaryBtn =
  'inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50'

const ghostBtn =
  'inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3.5 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50'

function Card({
  title, subtitle, children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {subtitle ? <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Notice({ tone, children }: { tone: 'error' | 'warn' | 'info'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-900/60 bg-red-950/40 text-red-300'
      : tone === 'warn'
        ? 'border-amber-900/50 bg-amber-950/30 text-amber-300/90'
        : 'border-gray-800 bg-gray-800/40 text-gray-400'
  return (
    <p role={tone === 'error' ? 'alert' : undefined} className={'rounded-lg border px-3 py-2 text-xs ' + cls}>
      {children}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Wizard state
// ---------------------------------------------------------------------------

/** Step 3 only exists when a service plan column is mapped; nav skips it. */
type Step = 1 | 2 | 3 | 4 | 5

type Parsed = {
  fileName: string
  headers: string[]
  /** Data rows only, in file order. Index i is file line i + 2. */
  rows: string[][]
}

type PlanChoice = {
  mode: 'existing' | 'new'
  existingId: number | null
  /** Editable when creating; the file's spelling is the starting point. */
  name: string
  /** Kept as a string so the field can be cleared while typing. */
  price: string
}

/**
 * Only what the operator changed.
 *
 * The default for each plan — matched or new, its name and its suggested price
 * — is derived from the file every render, so re-mapping a column immediately
 * re-scans the plans without a stale copy of an earlier scan hanging around.
 * Storing overrides rather than whole choices keeps that derivation the source
 * of truth and means no effect has to reconcile the two.
 */
type PlanEdits = Record<string, Partial<PlanChoice>>

type ImportOutcome = {
  imported: number
  plansCreated: number
  skipped: number
  failures: RowFailure[]
}

export function ImportWizard({
  existingPlans,
  catalogAvailable,
}: {
  existingPlans: ServicePlan[]
  catalogAvailable: boolean
}) {
  const [step, setStep] = useState<Step>(1)
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [mapping, setMapping] = useState<FieldTarget[]>([])
  const [planEdits, setPlanEdits] = useState<PlanEdits>({})

  const [existingMacs, setExistingMacs] = useState<ReadonlySet<string>>(new Set())
  const [checkingMacs, setCheckingMacs] = useState(false)
  const [macCheckError, setMacCheckError] = useState<string | null>(null)

  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)

  const fileInput = useRef<HTMLInputElement>(null)

  // --- what the mapping enables ------------------------------------------
  const mapped = useMemo(() => new Set(mapping), [mapping])
  const hasFullName = mapped.has('full_name')
  const hasNameParts = mapped.has('first_name') && mapped.has('last_name')
  const nameMapped = hasFullName || hasNameParts
  const macMapped = mapped.has('mac_address')
  const rateMapped = mapped.has('monthly_rate')
  const planMapped = mapped.has('service_plan')
  const cutOffMapped = mapped.has('cut_off_day')
  const dateAddedMapped = mapped.has('date_added')

  // --- the file, read through the mapping ---------------------------------
  const scan = useMemo(() => {
    const raws: RawRow[] = []
    const rows: ResolvedRow[] = []
    let blank = 0
    let sectionHeaders = 0

    if (parsed) {
      parsed.rows.forEach((cells, i) => {
        const kind = classifyRow(cells, mapping)
        if (kind === 'blank') {
          blank += 1
          return
        }
        if (kind === 'section_header') {
          sectionHeaders += 1
          return
        }
        const raw = extractRow(cells, mapping)
        raws.push(raw)
        // The header is line 1, so the first data row is line 2 — the number
        // the operator sees when they open the file in a spreadsheet.
        rows.push(resolveRow(i + 2, raw, { macMapped, rateMapped, cutOffMapped, dateAddedMapped }))
      })
    }

    return { raws, rows, blank, sectionHeaders }
  }, [parsed, mapping, macMapped, rateMapped, cutOffMapped, dateAddedMapped])

  // withMacConflicts preserves order, so index i still matches scan.raws[i].
  const rows = useMemo(
    () => withMacConflicts(scan.rows, existingMacs),
    [scan.rows, existingMacs]
  )

  const importable = useMemo(
    () => rows.map((row, i) => ({ row, raw: scan.raws[i] })).filter((e) => isImportable(e.row)),
    [rows, scan.raws]
  )
  const exceptions = useMemo(() => rows.filter((r) => r.reasons.length > 0), [rows])
  const notImported = useMemo(() => rows.filter((r) => !isImportable(r)), [rows])

  // --- step 2: three splits from their own data ---------------------------
  const examples = useMemo(() => {
    if (!parsed || !hasFullName) return []
    const column = mapping.indexOf('full_name')
    const out: { raw: string; first: string; last: string }[] = []
    for (const cells of parsed.rows) {
      if (out.length === 3) break
      if (classifyRow(cells, mapping) !== 'customer') continue
      const value = (cells[column] ?? '').trim()
      if (!value) continue
      const parts = splitFullName(value)
      if (!parts.last) continue
      out.push({ raw: value, ...parts })
    }
    return out
  }, [parsed, mapping, hasFullName])

  // --- step 3: the plans in the file --------------------------------------
  // Built from the rows that will actually be written, so a count reads as the
  // number of customers the plan is about to have — and a plan mentioned only
  // on unimportable rows is never created for nobody.
  const planSummaries = useMemo(
    () => (planMapped ? summarisePlans(importable.map((e) => e.row)) : []),
    [planMapped, importable]
  )

  // --- step 4: the cut off days in the file -------------------------------
  // Over the rows that will actually be written, so the counts add up to the
  // number of customers about to be created.
  const cutOffDays = useMemo(
    () => (cutOffMapped ? summariseCutOffDays(importable.map((e) => e.row)) : []),
    [cutOffMapped, importable]
  )

  const planChoices = useMemo(() => {
    const out: Record<string, PlanChoice> = {}
    for (const plan of planSummaries) {
      const match = matchExistingPlan(plan.key, existingPlans)
      out[plan.key] = {
        mode: match ? 'existing' : 'new',
        existingId: match?.id ?? null,
        name: plan.name,
        price: plan.commonRate === null ? '' : String(plan.commonRate),
        ...planEdits[plan.key],
      }
    }
    return out
  }, [planSummaries, existingPlans, planEdits])

  const editPlan = (key: string, patch: Partial<PlanChoice>) =>
    setPlanEdits((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))

  const plansToCreate = useMemo<NewPlanInput[]>(
    () =>
      planSummaries
        .filter((p) => planChoices[p.key]?.mode === 'new')
        .map((p) => {
          const choice = planChoices[p.key]
          return {
            key: p.key,
            name: choice.name.trim() || p.name,
            monthlyPrice: Number(choice.price) || 0,
          }
        }),
    [planSummaries, planChoices]
  )

  const planNameProblem = plansToCreate.some((p) => !p.name)

  // --- upload -------------------------------------------------------------
  function reset() {
    setParsed(null)
    setMapping([])
    setPlanEdits({})
    setExistingMacs(new Set())
    setMacCheckError(null)
    setUploadError(null)
    setRunError(null)
    setOutcome(null)
    setProgress({ done: 0, total: 0 })
    setStep(1)
    if (fileInput.current) fileInput.current.value = ''
  }

  function onFile(file: File | undefined) {
    setUploadError(null)
    setParsed(null)
    if (!file) return

    if (!/\.csv$/i.test(file.name)) {
      setUploadError('That is not a .csv file. Export the sheet as CSV and try again.')
      return
    }

    // Parsed with header:false so the row numbers reported later line up with
    // the file: results.data[i] is line i + 2, whatever the headers look like.
    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: false,
      complete: (results) => {
        const table = results.data.map((row) => (Array.isArray(row) ? row.map((c) => c ?? '') : []))

        // A trailing newline shows up as one empty row; dropping it from the
        // end only affects the count, never the numbering of the rows above.
        while (table.length && table[table.length - 1].every((c) => !String(c).trim())) {
          table.pop()
        }

        if (table.length === 0) {
          setUploadError('That file is empty.')
          return
        }

        const headers = table[0].map((h, i) =>
          // Strip a UTF-8 BOM off the first header, or the column reads "﻿Name".
          (i === 0 ? String(h).replace(/^﻿/, '') : String(h)).trim()
        )
        const body = table.slice(1)

        if (body.length === 0) {
          setUploadError('That file has a header row but no customers under it.')
          return
        }

        if (body.length > MAX_ROWS) {
          setUploadError(
            'That file has ' + body.length.toLocaleString() + ' rows, and this importer takes ' +
            MAX_ROWS.toLocaleString() + ' at a time. Split the file and import it in parts.'
          )
          return
        }

        setParsed({ fileName: file.name, headers, rows: body })
        setMapping(guessMapping(headers))
      },
      error: (error) => setUploadError('That file could not be read: ' + error.message),
    })
  }

  // --- moving between steps ------------------------------------------------
  /**
   * Entering the preview is where the MACs in the file are checked against the
   * ones already on record — the one question the browser cannot answer alone.
   */
  async function goToPreview() {
    setMacCheckError(null)

    if (macMapped) {
      const macs = [...new Set(scan.rows.map((r) => r.mac).filter((m): m is string => !!m))]
      if (macs.length > 0) {
        setCheckingMacs(true)
        try {
          setExistingMacs(new Set(await findExistingMacs(macs)))
        } catch (error) {
          setExistingMacs(new Set())
          setMacCheckError(
            'Existing MAC addresses could not be checked, so that exception is not listed below: ' +
            (error as Error).message
          )
        } finally {
          setCheckingMacs(false)
        }
      }
    }

    setStep(4)
  }

  function back() {
    if (step === 4) setStep(planMapped ? 3 : 2)
    else if (step === 3) setStep(2)
    else if (step === 2) reset()
  }

  // --- the import itself ---------------------------------------------------
  async function runImport() {
    if (!parsed) return

    setStep(5)
    setRunning(true)
    setRunError(null)
    setProgress({ done: 0, total: importable.length })

    try {
      // Plans first: a customer row cannot reference an id that does not exist.
      const planResult = await createImportPlans(plansToCreate)
      if (!planResult.ok) {
        setRunError(planResult.error + ' Nothing was imported.')
        setRunning(false)
        return
      }

      const planIds: Record<string, number> = { ...planResult.ids }
      for (const plan of planSummaries) {
        const choice = planChoices[plan.key]
        if (choice?.mode === 'existing' && choice.existingId) planIds[plan.key] = choice.existingId
      }

      let imported = 0
      const failures: RowFailure[] = []

      for (let i = 0; i < importable.length; i += BATCH_SIZE) {
        const slice = importable.slice(i, i + BATCH_SIZE)
        const result = await importCustomerBatch({
          rows: slice.map((e) => ({ rowNumber: e.row.rowNumber, raw: e.raw })),
          options: { macMapped, rateMapped, cutOffMapped, dateAddedMapped },
          planIds,
        })

        imported += result.inserted
        failures.push(...result.failures)
        setProgress({ done: i + slice.length, total: importable.length })
      }

      const skipped = notImported.length + failures.length
      await logCustomerImport({ fileName: parsed.fileName, imported, skipped })
      setOutcome({ imported, plansCreated: planResult.created, skipped, failures })
    } catch (error) {
      setRunError(
        'The import stopped: ' + (error as Error).message +
        ' Customers written before this point were saved — check the customer list before retrying.'
      )
    } finally {
      setRunning(false)
    }
  }

  // --- the exception list, as a file ---------------------------------------
  function downloadExceptions() {
    const failedRows = new Map(outcome?.failures.map((f) => [f.rowNumber, f.error]) ?? [])

    const listed = rows.filter((r) => r.reasons.length > 0 || failedRows.has(r.rowNumber))
    const csv = Papa.unparse({
      fields: ['Row', 'Name', 'Reason', 'Imported'],
      data: listed.map((r) => {
        const failure = failedRows.get(r.rowNumber)
        const reasons: string[] = [...r.reasons]
        if (failure) reasons.push('not written: ' + failure)
        return [
          r.rowNumber,
          [r.first_name, r.last_name].filter(Boolean).join(' '),
          reasons.join('; '),
          isImportable(r) && !failure ? 'Yes' : 'No',
        ]
      }),
    })

    const base = (parsed?.fileName ?? 'import').replace(/\.csv$/i, '')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = base + '-exceptions.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const stepList: { n: Step; label: string }[] = [
    { n: 1, label: 'Upload' },
    { n: 2, label: 'Map columns' },
    ...(planMapped ? [{ n: 3 as Step, label: 'Service plans' }] : []),
    { n: 4, label: 'Preview' },
    { n: 5, label: 'Import' },
  ]

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-2 text-xs">
        {stepList.map((s, i) => (
          <li key={s.n} className="flex items-center gap-2">
            {i > 0 ? <span className="text-gray-700">/</span> : null}
            <span
              aria-current={s.n === step ? 'step' : undefined}
              className={
                'rounded-md px-2 py-1 font-medium ' +
                (s.n === step
                  ? 'bg-blue-600 text-white'
                  : s.n < step
                    ? 'bg-gray-800 text-gray-400'
                    : 'text-gray-600')
              }
            >
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {/* ---------------------------------------------------------------- */}
      {step === 1 ? (
        <Card
          title="Upload a CSV file"
          subtitle="Any column layout. You will match the columns up on the next screen."
        >
          <div className="space-y-3">
            <label
              htmlFor="import-file"
              className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-gray-700 bg-gray-800/40 px-4 py-10 text-center transition hover:border-blue-600 hover:bg-gray-800/70"
            >
              <Upload className="h-6 w-6 text-gray-500" aria-hidden />
              <span className="text-sm font-semibold text-gray-300">Choose a .csv file</span>
              <span className="text-xs text-gray-500">
                Up to {MAX_ROWS.toLocaleString()} rows. Nothing is saved until you confirm the preview.
              </span>
            </label>
            <input
              ref={fileInput}
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => onFile(e.target.files?.[0])}
            />

            {uploadError ? <Notice tone="error">{uploadError}</Notice> : null}

            {parsed ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-800/40 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <FileSpreadsheet className="h-4 w-4 shrink-0 text-blue-400" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-200">{parsed.fileName}</p>
                    <p className="text-xs text-gray-500">
                      {parsed.rows.length.toLocaleString()}{' '}
                      {parsed.rows.length === 1 ? 'row' : 'rows'} ·{' '}
                      {parsed.headers.length} {parsed.headers.length === 1 ? 'column' : 'columns'}
                    </p>
                  </div>
                </div>
                <button type="button" onClick={() => setStep(2)} className={primaryBtn}>
                  Map the columns
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === 2 && parsed ? (
        <>
          <Card
            title="Match each column to a field"
            subtitle="Guessed from the headings. Correct anything that is wrong — the guesses are only a starting point."
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                    <th scope="col" className="py-2 pr-4 font-semibold">Column in your file</th>
                    <th scope="col" className="py-2 pr-4 font-semibold">First value</th>
                    <th scope="col" className="py-2 font-semibold">Import as</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {parsed.headers.map((header, i) => (
                    <tr key={i}>
                      <td className="py-2 pr-4 align-middle">
                        <span className="font-medium text-gray-200">
                          {header || <span className="text-gray-600">(no heading)</span>}
                        </span>
                      </td>
                      <td className="max-w-[220px] truncate py-2 pr-4 align-middle font-mono text-xs text-gray-500">
                        {parsed.rows.find((r) => (r[i] ?? '').trim())?.[i]?.trim() || '—'}
                      </td>
                      <td className="py-2 align-middle">
                        <select
                          aria-label={'Import "' + (header || 'column ' + (i + 1)) + '" as'}
                          className={selectCls}
                          value={mapping[i] ?? 'ignore'}
                          onChange={(e) => {
                            const next = [...mapping]
                            next[i] = e.target.value as FieldTarget
                            setMapping(next)
                          }}
                        >
                          {FIELD_TARGETS.map((target) => (
                            <option key={target} value={target}>
                              {FIELD_LABELS[target]}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {hasFullName ? (
            <Card
              title="How the full name will be split"
              subtitle="The last word becomes the surname; a trailing number is dropped. Three rows from your own file:"
            >
              {examples.length === 0 ? (
                <Notice tone="warn">
                  No usable names were found in that column. Check you picked the right one.
                </Notice>
              ) : (
                <ul className="space-y-2">
                  {examples.map((example, i) => (
                    <li
                      key={i}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-gray-800/40 px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs text-gray-400">{example.raw}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-gray-600" aria-hidden />
                      <span className="text-gray-300">
                        <span className="text-gray-500">first</span>{' '}
                        {example.first || <span className="text-gray-600">(empty)</span>}
                      </span>
                      <span className="text-gray-300">
                        <span className="text-gray-500">last</span> {example.last}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[11px] text-gray-600">
                A one-word name is kept as the surname with an empty first name. It is a name, not a
                missing one, and it imports.
              </p>
            </Card>
          ) : null}

          <div className="space-y-3">
            {!nameMapped ? (
              <Notice tone="warn">
                Pick a name column before continuing — either <strong>Full name</strong>, or both{' '}
                <strong>First name</strong> and <strong>Last name</strong>. Everything else is optional.
              </Notice>
            ) : null}

            {planMapped && !catalogAvailable ? (
              <Notice tone="warn">
                Service plans are not set up on this system yet, so the plan column cannot be used.
                Set it to Ignore, or ask your administrator to enable the catalogue.
              </Notice>
            ) : null}

            {mapping.filter((m) => m !== 'ignore').length < 2 ? (
              <Notice tone="info">
                With only one column mapped, section headers such as a location name typed across a
                row cannot be told apart from a customer, so they will import as customers. Mapping a
                second column lets them be spotted and skipped.
              </Notice>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <button type="button" onClick={back} className={ghostBtn}>
                <ArrowLeft className="h-4 w-4" aria-hidden />
                Choose another file
              </button>
              <button
                type="button"
                disabled={!nameMapped || (planMapped && !catalogAvailable) || checkingMacs}
                onClick={() => (planMapped ? setStep(3) : goToPreview())}
                className={primaryBtn}
              >
                {checkingMacs ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ArrowRight className="h-4 w-4" aria-hidden />
                )}
                {planMapped ? 'Review service plans' : 'Preview the import'}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === 3 && parsed ? (
        <>
          <Card
            title="Service plans found in the file"
            subtitle="Each plan is matched against the ones you already have, ignoring case, spaces and punctuation."
          >
            {planSummaries.length === 0 ? (
              <Notice tone="info">
                No plan names were found in that column. Every customer will import without a plan.
              </Notice>
            ) : (
              <div className="space-y-2.5">
                {planSummaries.map((plan) => {
                  const choice = planChoices[plan.key]
                  if (!choice) return null
                  const match = matchExistingPlan(plan.key, existingPlans)

                  return (
                    <div
                      key={plan.key}
                      className="rounded-lg border border-gray-800 bg-gray-800/40 p-3"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="font-medium text-gray-200">{plan.name}</p>
                        <p className="text-xs text-gray-500">
                          {plan.customerCount}{' '}
                          {plan.customerCount === 1 ? 'customer' : 'customers'} · most common rate{' '}
                          <span className="tabular-nums text-gray-300">
                            {plan.commonRate === null ? 'none' : formatCurrency(plan.commonRate)}
                          </span>
                        </p>
                      </div>

                      {match ? (
                        <p className="mt-1 text-xs text-green-400">matches {match.name}</p>
                      ) : (
                        <p className="mt-1 text-xs text-amber-300/90">no match — will be created</p>
                      )}

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <select
                          aria-label={'Plan for ' + plan.name}
                          className={selectCls}
                          value={choice.mode === 'existing' ? String(choice.existingId) : 'new'}
                          onChange={(e) => {
                            const value = e.target.value
                            editPlan(
                              plan.key,
                              value === 'new'
                                ? { mode: 'new', existingId: null }
                                : { mode: 'existing', existingId: Number(value) }
                            )
                          }}
                        >
                          <option value="new">Create new plan</option>
                          {existingPlans.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>

                        {choice.mode === 'new' ? (
                          <>
                            <input
                              aria-label={'New plan name for ' + plan.name}
                              className={selectCls + ' w-44'}
                              value={choice.name}
                              placeholder="Plan name"
                              onChange={(e) => editPlan(plan.key, { name: e.target.value })}
                            />
                            <input
                              aria-label={'Monthly price for ' + plan.name}
                              className={selectCls + ' w-32 tabular-nums'}
                              value={choice.price}
                              inputMode="decimal"
                              placeholder="Monthly price"
                              onChange={(e) => editPlan(plan.key, { price: e.target.value })}
                            />
                          </>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <p className="mt-4 text-[11px] text-gray-600">
              Speeds are not in the file, so new plans are created at 0/0 Mbps and will read that way
              until you set them in Settings → Service Plans.
            </p>
            <p className="mt-1.5 text-[11px] text-gray-600">
              The plan is only a label. Every customer keeps the monthly rate from their own row,
              whatever the plan is priced at.
            </p>
          </Card>

          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={back} className={ghostBtn}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to columns
            </button>
            <button
              type="button"
              disabled={planNameProblem || checkingMacs}
              onClick={goToPreview}
              className={primaryBtn}
            >
              {checkingMacs ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ArrowRight className="h-4 w-4" aria-hidden />
              )}
              Preview the import
            </button>
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === 4 && parsed ? (
        <>
          <Card title="Nothing has been saved yet" subtitle="This is what confirming will do.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure value={importable.length} label="customers ready to import" tone="good" />
              <Figure value={exceptions.length} label="rows need attention" tone={exceptions.length ? 'warn' : 'plain'} />
              <Figure value={plansToCreate.length} label="service plans will be created" tone="plain" />
            </div>

            {scan.blank + scan.sectionHeaders > 0 ? (
              <p className="mt-3 text-[11px] text-gray-600">
                {scan.blank > 0 ? scan.blank + ' blank ' + (scan.blank === 1 ? 'row' : 'rows') : ''}
                {scan.blank > 0 && scan.sectionHeaders > 0 ? ' and ' : ''}
                {scan.sectionHeaders > 0
                  ? scan.sectionHeaders + ' section ' + (scan.sectionHeaders === 1 ? 'header' : 'headers')
                  : ''}{' '}
                skipped — they are not customers and are not listed below.
              </p>
            ) : null}

            {notImported.length > 0 ? (
              <p className="mt-3 text-xs text-amber-300/90">
                {notImported.length} of them {notImported.length === 1 ? 'has' : 'have'} no name and
                cannot be imported. Everything else on the list below still imports.
              </p>
            ) : null}

            {macCheckError ? (
              <div className="mt-3">
                <Notice tone="warn">{macCheckError}</Notice>
              </div>
            ) : null}
          </Card>

          {cutOffMapped ? (
            <Card
              title="Cut off days found"
              subtitle="Check this looks like the file you expected — one day repeated down the column usually means the wrong column is mapped."
            >
              <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800">
                {cutOffDays.map((entry) => (
                  <li
                    key={entry.day ?? 'default'}
                    className="flex items-baseline gap-4 px-3 py-1.5 text-sm"
                  >
                    <span className="w-8 shrink-0 tabular-nums font-medium text-gray-200">
                      {entry.day ?? '—'}
                    </span>
                    <span className="text-gray-400">
                      {entry.count.toLocaleString()}{' '}
                      {entry.day === null
                        ? 'using company default'
                        : entry.count === 1
                          ? 'customer'
                          : 'customers'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-gray-600">
                A blank cell takes the company setting and is not flagged. A cell that had
                something in it but not a day from 1 to 28 falls back the same way and IS listed
                below.
              </p>
            </Card>
          ) : null}

          <Card
            title={'Rows needing attention (' + exceptions.length + ')'}
            subtitle="Everything here imports except rows with no name. A customer with no MAC address imports and stays unprovisioned."
          >
            {exceptions.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-600">
                Nothing to flag — every row is complete.
              </p>
            ) : (
              <>
                <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-800">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-gray-900">
                      <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                        <th scope="col" className="px-3 py-2 font-semibold">Row</th>
                        <th scope="col" className="px-3 py-2 font-semibold">Name</th>
                        <th scope="col" className="px-3 py-2 font-semibold">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {exceptions.map((row) => (
                        <tr key={row.rowNumber}>
                          <td className="px-3 py-1.5 tabular-nums text-gray-500">{row.rowNumber}</td>
                          <td className="px-3 py-1.5 text-gray-300">
                            {[row.first_name, row.last_name].filter(Boolean).join(' ') || (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-gray-400">
                            {row.reasons.join(', ')}
                            {!isImportable(row) ? (
                              <span className="ml-1.5 font-semibold text-red-400">not imported</span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <button type="button" onClick={downloadExceptions} className={ghostBtn + ' mt-3'}>
                  <Download className="h-4 w-4" aria-hidden />
                  Download this list as CSV
                </button>
              </>
            )}
          </Card>

          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={back} className={ghostBtn}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back
            </button>
            <button
              type="button"
              disabled={importable.length === 0}
              onClick={runImport}
              className={primaryBtn}
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Import {importable.length.toLocaleString()}{' '}
              {importable.length === 1 ? 'customer' : 'customers'}
            </button>
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {step === 5 ? (
        <Card
          title={outcome ? 'Import finished' : runError ? 'Import stopped' : 'Importing…'}
          subtitle={parsed?.fileName}
        >
          {running || (!outcome && !runError) ? (
            <div className="space-y-2">
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
                {progress.done.toLocaleString()} of {progress.total.toLocaleString()} rows
                processed. Leave this page open until it finishes.
              </p>
            </div>
          ) : null}

          {runError ? <Notice tone="error">{runError}</Notice> : null}

          {outcome ? (
            <div className="space-y-4">
              <dl className="space-y-1.5 text-sm">
                <Line label="Imported" value={outcome.imported + ' customers'} tone="good" />
                <Line
                  label="Created"
                  value={
                    outcome.plansCreated +
                    (outcome.plansCreated === 1 ? ' service plan' : ' service plans')
                  }
                />
                <Line
                  label="Skipped"
                  value={outcome.skipped + (outcome.skipped === 1 ? ' row' : ' rows')}
                  tone={outcome.skipped > 0 ? 'warn' : undefined}
                />
              </dl>

              {outcome.failures.length > 0 ? (
                <div className="space-y-2">
                  <Notice tone="error">
                    {outcome.failures.length}{' '}
                    {outcome.failures.length === 1 ? 'row was' : 'rows were'} refused by the database
                    and {outcome.failures.length === 1 ? 'is' : 'are'} listed below. Nothing was
                    dropped silently.
                  </Notice>
                  <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-800 p-2 text-xs">
                    {outcome.failures.map((failure) => (
                      <li key={failure.rowNumber} className="text-gray-400">
                        <span className="tabular-nums text-gray-500">Row {failure.rowNumber}</span>{' '}
                        — {failure.name}: {failure.error}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {exceptions.length > 0 || outcome.failures.length > 0 ? (
                <button type="button" onClick={downloadExceptions} className={ghostBtn}>
                  <Download className="h-4 w-4" aria-hidden />
                  Download list
                </button>
              ) : null}

              <p className="text-[11px] text-gray-600">
                Every imported customer is unprovisioned. Nothing was written to RADIUS — put them on
                the network from their record, or from the customer list, when you are ready.
              </p>

              <div className="flex flex-wrap gap-2 border-t border-gray-800 pt-4">
                <Link href="/dashboard/customers" className={primaryBtn}>
                  View customers
                </Link>
                <button type="button" onClick={reset} className={ghostBtn}>
                  Import another file
                </button>
              </div>
            </div>
          ) : null}

          {runError && !outcome ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/dashboard/customers" className={ghostBtn}>
                View customers
              </Link>
              <button type="button" onClick={reset} className={ghostBtn}>
                Start over
              </button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}

function Figure({
  value, label, tone,
}: {
  value: number
  label: string
  tone: 'good' | 'warn' | 'plain'
}) {
  const cls =
    tone === 'good' ? 'text-green-400' : tone === 'warn' ? 'text-amber-400' : 'text-gray-200'
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-800/40 px-3 py-3">
      <p className={'text-2xl font-semibold tabular-nums ' + cls}>{value.toLocaleString()}</p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
    </div>
  )
}

function Line({
  label, value, tone,
}: {
  label: string
  value: string
  tone?: 'good' | 'warn'
}) {
  return (
    <div className="flex items-center gap-2">
      {tone === 'good' ? (
        <CheckCircle2 className="h-4 w-4 text-green-400" aria-hidden />
      ) : tone === 'warn' ? (
        <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden />
      ) : (
        <X className="h-4 w-4 text-transparent" aria-hidden />
      )}
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-200">{value}</dd>
    </div>
  )
}
