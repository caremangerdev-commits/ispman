import 'server-only'

import { logSystemEvent, systemActor, type SystemActor } from '@/lib/audit'
import {
  engineVerdict, toChargeElements, toCompanyBillingType, toEngineMode,
  type ChargeElement, type CompanyBillingType, type EngineDecision, type EngineMode,
  type EngineVerdict,
} from '@/lib/billing-engine'
import { readBillableCustomers, type BillableCustomer } from '@/lib/data/bulk'
import { formatCurrency, instantToDateOnly } from '@/lib/format'
import { serviceStateFor, type ServiceState } from '@/lib/radius/service-state'
import { getSchemaCapabilities } from '@/lib/schema'
import { fetchAllRows } from '@/lib/supabase/paging'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The daily billing engine, server side: reads, the tick, and the run log.
 * Migration 0024.
 *
 * THE ARITHMETIC IS NOT HERE. lib/billing-engine.ts decides periods and
 * verdicts and is client-safe so the Billing Runs page can preview with the
 * same code; apply_bill_charges() in Postgres applies the result atomically.
 * This module is the plumbing between the two: it reads the rows, asks
 * radcheck who had service, calls the function, and records what happened on
 * bill_runs.
 *
 * HOW IT RUNS. worker/billing-ticker.mjs POSTs to /api/billing/tick every
 * hour; the route calls runBillingTick(). For each company whose mode is not
 * off, the tick upserts that company's bill_runs row FOR TODAY IN THE
 * COMPANY'S OWN ZONE and leaves it alone once it is done, so the hourly
 * cadence costs nothing after the first successful hour and a failed hour is
 * retried by the next.
 *
 * THE ENGINE NEVER WRITES radcheck. It reads it, to skip anyone whose access
 * had expired (lib/radius/service-state.ts), and that is the whole of its
 * contact with the network. Expiries move on payment, nowhere else.
 */

/** A 'running' row older than this belongs to a tick that died; it is retried. */
const STALE_RUN_MS = 30 * 60_000

/** How many customer ids go in one `in()` filter. Keeps the URL short. */
const ID_CHUNK = 200

export type EngineSettings = {
  billingType: CompanyBillingType
  mode: EngineMode
  /** `YYYY-MM-DD` or null. Required by the schema once the mode is not off. */
  startDate: string | null
}

export type EngineCompany = EngineSettings & {
  id: number
  name: string
  timezone: string
  /** `settings.bill_date`. Postpaid's charge day; prepaid's fallback. */
  companyBillDay: number | null
}

/**
 * The engine settings for one company, or null when migration 0024 is not
 * applied. Null is "no engine", which every caller treats as off.
 */
export async function engineSettingsFor(companyId: number): Promise<EngineSettings | null> {
  const caps = await getSchemaCapabilities()
  if (!caps.billingEngine) return null

  const { data, error } = await tenantClient()
    .from('settings')
    .select('billing_type, billing_engine_mode, billing_engine_start_date')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error('Could not read the billing engine settings: ' + error.message)

  const s = data as {
    billing_type: string | null
    billing_engine_mode: string | null
    billing_engine_start_date: string | null
  } | null
  return {
    billingType: toCompanyBillingType(s?.billing_type),
    mode: toEngineMode(s?.billing_engine_mode),
    startDate: s?.billing_engine_start_date ?? null,
  }
}

/**
 * Whether the engine is LIVE for a company. Run Bills refuses when it is:
 * two writers on carried_balance with two different guards is how a month gets
 * charged twice. False when the engine does not exist.
 */
export async function isEngineLive(companyId: number): Promise<boolean> {
  return (await engineSettingsFor(companyId))?.mode === 'live'
}

/** Every company with its engine settings. The tick's worklist. */
export async function listEngineCompanies(): Promise<EngineCompany[]> {
  const db = tenantClient()
  const [companiesRes, settingsRes] = await Promise.all([
    db.from('companies').select('id, name').order('id'),
    db
      .from('settings')
      .select('company_id, timezone, bill_date, billing_type, billing_engine_mode, billing_engine_start_date'),
  ])
  if (companiesRes.error) throw new Error('Could not list companies: ' + companiesRes.error.message)
  if (settingsRes.error) throw new Error('Could not read settings: ' + settingsRes.error.message)

  const settings = new Map(
    ((settingsRes.data ?? []) as {
      company_id: number
      timezone: string | null
      bill_date: number | null
      billing_type: string | null
      billing_engine_mode: string | null
      billing_engine_start_date: string | null
    }[]).map((s) => [s.company_id, s])
  )

  return ((companiesRes.data ?? []) as { id: number; name: string }[]).map((c) => {
    const s = settings.get(c.id)
    return {
      id: c.id,
      name: c.name,
      timezone: s?.timezone || 'America/Jamaica',
      companyBillDay: s?.bill_date ?? null,
      billingType: toCompanyBillingType(s?.billing_type),
      mode: toEngineMode(s?.billing_engine_mode),
      startDate: s?.billing_engine_start_date ?? null,
    }
  })
}

async function engineCompany(companyId: number): Promise<EngineCompany | null> {
  return (await listEngineCompanies()).find((c) => c.id === companyId) ?? null
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export type EngineLine = {
  customer: BillableCustomer & {
    /** monthly_rate plus active add-ons — what the cashier collects. */
    monthlyCharge: number
    addons: number
  }
  decision: EngineDecision
  service: ServiceState | undefined
  /** A bill_charges row already exists for this customer and period. */
  already: boolean
}

export type CompanyDecision = {
  today: string
  lines: EngineLine[]
  considered: number
  counts: Record<EngineVerdict | 'already', number>
  /** The elements apply_bill_charges() will be handed: 'charge' and not already. */
  charges: ChargeElement[]
  totalAmount: number
  /** What the charges would draw from standing credit, from the rows as read. */
  creditApplied: number
}

/** Add-ons per customer, summed the way app/actions/payments.ts sums them. */
async function addonTotals(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const caps = await getSchemaCapabilities()
  if (!caps.catalog || ids.length === 0) return out

  const db = tenantClient()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const { data, error } = await db
      .from('customer_additional_services')
      .select('customer_id, additional_services(monthly_price)')
      .in('customer_id', chunk)
    if (error) throw new Error('Could not read add-ons: ' + error.message)
    for (const row of (data ?? []) as unknown as {
      customer_id: number
      additional_services: { monthly_price: number | string | null } | null
    }[]) {
      out.set(row.customer_id, (out.get(row.customer_id) ?? 0) + Number(row.additional_services?.monthly_price ?? 0))
    }
  }
  return out
}

/** The (customer, period_start) pairs bill_charges already holds, as keys. */
async function alreadyCharged(companyId: number, periodStarts: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (periodStarts.length === 0) return out
  const db = tenantClient()
  const rows = await fetchAllRows(
    (from, to) =>
      db
        .from('bill_charges')
        .select('customer_id, period_start')
        .eq('company_id', companyId)
        .in('period_start', periodStarts)
        .order('id')
        .range(from, to),
    'bill_charges'
  )
  for (const r of rows as { customer_id: number; period_start: string }[]) {
    out.add(r.customer_id + '|' + r.period_start)
  }
  return out
}

/**
 * What the engine would do for one company today. Reads radcheck and THROWS
 * if it cannot: the rule in lib/radius/service-state.ts. Used by the tick and
 * by the Billing Runs page's "if a tick ran now" preview alike.
 */
export async function decideCompany(company: EngineCompany, today: string): Promise<CompanyDecision> {
  const base = await readBillableCustomers(company.id)
  const addons = await addonTotals(base.map((c) => c.id))
  const service = await serviceStateFor(base, 'the billing engine')

  const decided = base.map((c) => {
    const customer = { ...c, addons: addons.get(c.id) ?? 0, monthlyCharge: c.monthlyRate + (addons.get(c.id) ?? 0) }
    const decision = engineVerdict({
      billingType: company.billingType,
      today,
      startDate: company.startDate,
      companyBillDay: company.companyBillDay,
      customer: { id: c.id, billDate: c.billDate, dateAdded: c.dateAdded, monthlyCharge: customer.monthlyCharge },
      service: service.get(c.id),
    })
    return { customer, decision, service: service.get(c.id) }
  })

  const starts = [...new Set(decided.filter((d) => d.decision.verdict === 'charge').map((d) => d.decision.period.start))]
  const existing = await alreadyCharged(company.id, starts)

  const counts: CompanyDecision['counts'] = {
    charge: 0, not_due: 0, before_start: 0, joined_after: 0,
    zero_rate: 0, no_service: 0, unprovisioned: 0, already: 0,
  }
  const lines: EngineLine[] = []
  let creditApplied = 0
  for (const d of decided) {
    const already = d.decision.verdict === 'charge' && existing.has(d.customer.id + '|' + d.decision.period.start)
    if (already) counts.already++
    else counts[d.decision.verdict]++
    if (d.decision.verdict === 'charge' && !already) {
      creditApplied += Math.min(Math.max(d.customer.accountCredit, 0), d.decision.amount)
    }
    lines.push({ ...d, already })
  }

  const charges = toChargeElements(lines.filter((l) => !l.already))
  return {
    today,
    lines,
    considered: base.length,
    counts,
    charges,
    totalAmount: round2(charges.reduce((s, c) => s + c.amount, 0)),
    creditApplied: round2(creditApplied),
  }
}

/** For the page: what a tick would do for this company right now. */
export async function previewCompanyNow(companyId: number): Promise<{ company: EngineCompany; decision: CompanyDecision } | null> {
  const caps = await getSchemaCapabilities()
  if (!caps.billingEngine) return null
  const company = await engineCompany(companyId)
  if (!company) return null
  const today = instantToDateOnly(new Date(), company.timezone)
  return { company, decision: await decideCompany(company, today) }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export type TickCompanySummary = {
  companyId: number
  companyName: string
  runDate: string
  mode: EngineMode
  status: 'done' | 'failed' | 'skipped'
  /** Why nothing was run: 'done', 'in progress'. Null when it ran. */
  skipped: string | null
  runId: number | null
  charged: number
  totalAmount: number
  creditApplied: number
  error: string | null
}

type RunRow = {
  id: number
  mode: string
  status: string
  started_at: string
  attempts: number
}

/** What apply_bill_charges() returns. */
type ApplyResult = {
  inserted: number
  already_charged: number
  missing: number
  total_amount: number
  credit_applied: number
}

/**
 * One tick: every company whose mode is not off, or just `only`.
 *
 * REFUSES OUTRIGHT, before touching any company, when migration 0024 is not
 * applied or the Billing Engine user is missing. Both are configuration, not
 * a company's fault, and a tick that ran half the book on a misconfigured
 * system is worse than one that did nothing and said why.
 */
export async function runBillingTick(only?: number): Promise<TickCompanySummary[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.billingEngine) {
    throw new Error('Migration 0024_billing_engine.sql is not applied. Nothing was run.')
  }
  const actor = await systemActor()
  if (!actor) {
    throw new Error('The Billing Engine user is missing (migration 0024 creates it). Nothing was run.')
  }

  const companies = (await listEngineCompanies()).filter(
    (c) => c.mode !== 'off' && (only === undefined || c.id === only)
  )

  const out: TickCompanySummary[] = []
  for (const company of companies) {
    try {
      out.push(await runCompany(company, actor))
    } catch (err) {
      // Reached only when the failure happened before the day's row existed;
      // runCompany records anything later on the row itself.
      const message = (err as Error).message
      console.error('[billing] %s: %s', company.name, message)
      out.push({
        companyId: company.id, companyName: company.name,
        runDate: instantToDateOnly(new Date(), company.timezone), mode: company.mode,
        status: 'failed', skipped: null, runId: null,
        charged: 0, totalAmount: 0, creditApplied: 0, error: message,
      })
    }
  }
  return out
}

async function runCompany(company: EngineCompany, actor: SystemActor): Promise<TickCompanySummary> {
  const db = tenantClient()
  const today = instantToDateOnly(new Date(), company.timezone)
  const summary = (
    patch: Partial<TickCompanySummary>
  ): TickCompanySummary => ({
    companyId: company.id, companyName: company.name, runDate: today, mode: company.mode,
    status: 'done', skipped: null, runId: null, charged: 0, totalAmount: 0, creditApplied: 0,
    error: null, ...patch,
  })

  // --- The day's row --------------------------------------------------------
  const { data: existingRaw, error: readError } = await db
    .from('bill_runs')
    .select('id, mode, status, started_at, attempts')
    .eq('company_id', company.id)
    .eq('run_date', today)
    .maybeSingle()
  if (readError) throw new Error('Could not read bill_runs: ' + readError.message)
  const existing = existingRaw as RunRow | null

  let runId: number
  if (existing) {
    // Done as the same mode: the day is finished. Done as a DRY RUN while the
    // company is now LIVE: the dry row is superseded and the day runs again
    // for real — otherwise switching to live would always lose its first day.
    if (existing.status === 'done' && existing.mode === company.mode) {
      return summary({ status: 'skipped', skipped: 'done', runId: existing.id })
    }
    if (
      existing.status === 'running' &&
      Date.now() - new Date(existing.started_at).getTime() < STALE_RUN_MS
    ) {
      return summary({ status: 'skipped', skipped: 'in progress', runId: existing.id })
    }
    const { error } = await db
      .from('bill_runs')
      .update({
        mode: company.mode, status: 'running', started_at: new Date().toISOString(),
        finished_at: null, attempts: existing.attempts + 1, error: null,
      })
      .eq('id', existing.id)
    if (error) throw new Error('Could not reopen the bill run: ' + error.message)
    runId = existing.id
  } else {
    const { data, error } = await db
      .from('bill_runs')
      .insert({ company_id: company.id, run_date: today, mode: company.mode, status: 'running' })
      .select('id')
      .single()
    if (error) throw new Error('Could not open the bill run: ' + error.message)
    runId = (data as { id: number }).id
  }

  // --- Decide, then apply or preview ---------------------------------------
  try {
    const decision = await decideCompany(company, today)
    const counters = {
      considered: decision.considered,
      skipped_not_due: decision.counts.not_due,
      skipped_before_start: decision.counts.before_start,
      skipped_joined_after: decision.counts.joined_after,
      skipped_zero_rate: decision.counts.zero_rate,
      skipped_no_service: decision.counts.no_service,
      skipped_unprovisioned: decision.counts.unprovisioned,
    }

    if (company.mode === 'dry_run') {
      const preview = decision.lines
        .filter((l) => l.decision.verdict === 'charge' && !l.already)
        .map((l) => ({
          customer_id: l.customer.id,
          name: l.customer.name,
          amount: l.decision.amount,
          addons: l.customer.addons,
          period_start: l.decision.period.start,
          period_end: l.decision.period.end,
          bill_day: l.decision.billDay,
          credit_applied: round2(Math.min(Math.max(l.customer.accountCredit, 0), l.decision.amount)),
        }))
      const { error } = await db
        .from('bill_runs')
        .update({
          ...counters,
          charged: preview.length,
          total_amount: decision.totalAmount,
          credit_applied: decision.creditApplied,
          skipped_already: decision.counts.already,
          preview,
          status: 'done',
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId)
      if (error) throw new Error('Could not record the dry run: ' + error.message)
      return summary({
        runId, charged: preview.length, totalAmount: decision.totalAmount, creditApplied: decision.creditApplied,
      })
    }

    // LIVE. One call, one transaction, the index as the guard.
    const { data: applied, error: applyError } = await db.rpc('apply_bill_charges', {
      p_company_id: company.id,
      p_run_id: runId,
      p_charged_on: today,
      p_charges: decision.charges,
    })
    if (applyError) throw new Error('apply_bill_charges failed: ' + applyError.message)
    const result = applied as ApplyResult

    const { error } = await db
      .from('bill_runs')
      .update({
        ...counters,
        charged: result.inserted,
        total_amount: result.total_amount,
        credit_applied: result.credit_applied,
        skipped_already: decision.counts.already + result.already_charged,
        preview: null,
        status: 'done',
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)
    if (error) {
      // The charges landed; only the record of the run failed. Said loudly and
      // left 'running' so the next tick's stale check re-attempts the update
      // (the function then reports every charge as already_charged).
      throw new Error('Charges applied but the run row could not be updated: ' + error.message)
    }

    if (result.inserted > 0) {
      const shape = company.billingType === 'prepaid'
        ? 'each from their bill date to the same date next month'
        : 'the calendar month'
      await logSystemEvent({
        companyId: company.id,
        process: 'billing',
        actor,
        type: 'billing_run',
        tag: '[billing]',
        details:
          'Billing engine run #' + runId + ' on ' + today + ': ' + result.inserted +
          (result.inserted === 1 ? ' customer' : ' customers') + ' charged ' +
          formatCurrency(result.total_amount) + ' in total for ' + shape +
          (result.credit_applied > 0 ? ', ' + formatCurrency(result.credit_applied) + ' taken from standing credit' : '') +
          '. Skipped ' + (decision.counts.already + result.already_charged) + ' already charged for the period, ' +
          decision.counts.not_due + ' not yet due, ' +
          decision.counts.before_start + ' before the engine start date, ' +
          decision.counts.joined_after + ' who joined after the charge date, ' +
          decision.counts.zero_rate + ' with no monthly charge, ' +
          decision.counts.no_service + ' disconnected, ' +
          decision.counts.unprovisioned + ' never provisioned. ' +
          'No expiry dates, network records or payments were changed.',
      })
    }

    return summary({
      runId, charged: result.inserted, totalAmount: Number(result.total_amount), creditApplied: Number(result.credit_applied),
    })
  } catch (err) {
    const message = (err as Error).message
    console.error('[billing] %s %s: %s', company.name, today, message)
    await db
      .from('bill_runs')
      .update({ status: 'failed', error: message.slice(0, 2000), finished_at: new Date().toISOString() })
      .eq('id', runId)
    return summary({ status: 'failed', runId, error: message })
  }
}

// ---------------------------------------------------------------------------
// Reads for the Billing Runs page and the customer record
// ---------------------------------------------------------------------------

export type BillRunRow = {
  id: number
  runDate: string
  mode: EngineMode
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt: string | null
  attempts: number
  considered: number
  charged: number
  totalAmount: number
  creditApplied: number
  skippedNotDue: number
  skippedBeforeStart: number
  skippedJoinedAfter: number
  skippedZeroRate: number
  skippedNoService: number
  skippedUnprovisioned: number
  skippedAlready: number
  error: string | null
  preview: PreviewLine[] | null
}

export type PreviewLine = {
  customer_id: number
  name: string
  amount: number
  addons: number
  period_start: string
  period_end: string
  bill_day: number
  credit_applied: number
}

const RUN_COLUMNS =
  'id, run_date, mode, status, started_at, finished_at, attempts, considered, charged, ' +
  'total_amount, credit_applied, skipped_not_due, skipped_before_start, skipped_joined_after, ' +
  'skipped_zero_rate, skipped_no_service, skipped_unprovisioned, skipped_already, error, preview'

function toRun(r: Record<string, unknown>): BillRunRow {
  return {
    id: r.id as number,
    runDate: r.run_date as string,
    mode: toEngineMode(r.mode as string),
    status: (r.status as BillRunRow['status']) ?? 'done',
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    attempts: Number(r.attempts ?? 1),
    considered: Number(r.considered ?? 0),
    charged: Number(r.charged ?? 0),
    totalAmount: Number(r.total_amount ?? 0),
    creditApplied: Number(r.credit_applied ?? 0),
    skippedNotDue: Number(r.skipped_not_due ?? 0),
    skippedBeforeStart: Number(r.skipped_before_start ?? 0),
    skippedJoinedAfter: Number(r.skipped_joined_after ?? 0),
    skippedZeroRate: Number(r.skipped_zero_rate ?? 0),
    skippedNoService: Number(r.skipped_no_service ?? 0),
    skippedUnprovisioned: Number(r.skipped_unprovisioned ?? 0),
    skippedAlready: Number(r.skipped_already ?? 0),
    error: (r.error as string | null) ?? null,
    preview: Array.isArray(r.preview) ? (r.preview as PreviewLine[]) : null,
  }
}

export async function listBillRuns(companyId: number, limit = 90): Promise<BillRunRow[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.billingEngine) return []
  const { data, error } = await tenantClient()
    .from('bill_runs')
    .select(RUN_COLUMNS)
    .eq('company_id', companyId)
    .order('run_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)
  if (error) throw new Error('Could not list billing runs: ' + error.message)
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toRun)
}

export async function getBillRun(companyId: number, id: number): Promise<BillRunRow | null> {
  const caps = await getSchemaCapabilities()
  if (!caps.billingEngine) return null
  const { data, error } = await tenantClient()
    .from('bill_runs')
    .select(RUN_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error('Could not load the billing run: ' + error.message)
  return data ? toRun(data as unknown as Record<string, unknown>) : null
}

export type ChargeRow = {
  id: number
  customerId: number
  name: string
  periodStart: string
  periodEnd: string
  chargedOn: string
  amount: number
  creditApplied: number
  carriedBefore: number
  carriedAfter: number
}

export async function listRunCharges(companyId: number, runId: number): Promise<ChargeRow[]> {
  const db = tenantClient()
  const rows = await fetchAllRows(
    (from, to) =>
      db
        .from('bill_charges')
        .select(
          'id, customer_id, period_start, period_end, charged_on, amount, credit_applied, ' +
            'carried_balance_before, carried_balance_after, customers(first_name, last_name)'
        )
        .eq('company_id', companyId)
        .eq('run_id', runId)
        .order('customer_id')
        .range(from, to),
    'bill_charges'
  )
  return (rows as Record<string, unknown>[]).map((r) => {
    const c = r.customers as { first_name: string | null; last_name: string | null } | null
    return {
      id: r.id as number,
      customerId: r.customer_id as number,
      name: [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Customer #' + (r.customer_id as number),
      periodStart: r.period_start as string,
      periodEnd: r.period_end as string,
      chargedOn: r.charged_on as string,
      amount: Number(r.amount ?? 0),
      creditApplied: Number(r.credit_applied ?? 0),
      carriedBefore: Number(r.carried_balance_before ?? 0),
      carriedAfter: Number(r.carried_balance_after ?? 0),
    }
  })
}

export type LastCharge = { chargedOn: string; periodStart: string; periodEnd: string; amount: number }

/**
 * The customer's most recent engine charge, for the "Last Billed" row. Null
 * when the engine has never charged them — the row then falls back to
 * last_billed_date, Run Bills' stamp.
 */
export async function lastChargeFor(companyId: number, customerId: number): Promise<LastCharge | null> {
  const caps = await getSchemaCapabilities()
  if (!caps.billingEngine) return null
  const { data, error } = await tenantClient()
    .from('bill_charges')
    .select('charged_on, period_start, period_end, amount')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[billing] last charge lookup failed: %s', error.message)
    return null
  }
  const r = data as { charged_on: string; period_start: string; period_end: string; amount: number | string } | null
  return r
    ? { chargedOn: r.charged_on, periodStart: r.period_start, periodEnd: r.period_end, amount: Number(r.amount ?? 0) }
    : null
}

// ---------------------------------------------------------------------------
// Going live
// ---------------------------------------------------------------------------

/**
 * Whether a company may switch to LIVE: a FULL DRY-RUN CYCLE must have
 * completed first. A cycle is a month: the earliest completed dry run must be
 * at least one calendar month ago, AND at least one completed dry run must
 * have reached a charge date and previewed real charges. Ezmze's cycle ends
 * on the 1st, when the tick is 988 customers; going live before a dry run has
 * covered a real 1st is exactly the thing this refuses.
 *
 * `today` is the company's date; the caller passes it so this stays testable.
 */
export async function dryRunCycleComplete(
  companyId: number,
  today: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { data, error } = await tenantClient()
    .from('bill_runs')
    .select('run_date, charged')
    .eq('company_id', companyId)
    .eq('mode', 'dry_run')
    .eq('status', 'done')
    .order('run_date', { ascending: true })
  if (error) throw new Error('Could not read the dry runs: ' + error.message)

  const runs = (data ?? []) as { run_date: string; charged: number }[]
  if (runs.length === 0) {
    return { ok: false, reason: 'No dry run has completed yet. Set the mode to dry run and let a full cycle pass.' }
  }
  const earliest = runs[0].run_date
  const needed = oneMonthBefore(today)
  if (earliest > needed) {
    return {
      ok: false,
      reason:
        'The dry run has only covered ' + earliest + ' to ' + today +
        '. A full cycle is one month; live is available from ' + oneMonthAfter(earliest) + '.',
    }
  }
  if (!runs.some((r) => Number(r.charged) > 0)) {
    return {
      ok: false,
      reason: 'No completed dry run has reached a charge date yet, so nothing has been previewed as charged.',
    }
  }
  return { ok: true }
}

function shiftMonth(ymd: string, by: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(y, m - 1 + by, 1)
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(Math.min(d, last))
}
const oneMonthBefore = (ymd: string) => shiftMonth(ymd, -1)
const oneMonthAfter = (ymd: string) => shiftMonth(ymd, 1)

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
