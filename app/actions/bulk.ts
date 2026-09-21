'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  applyFilters, describeFilters, hasAnyFilter, type CustomerFilters, type FilterNames,
} from '@/lib/customer-filter'
import { listMiscCategories, listServicePlans } from '@/lib/data/catalog'
import { loadEnrichedCustomers } from '@/lib/data/customers'
import { can } from '@/lib/permissions'
import { getSession, type Session } from '@/lib/session'
import { STATUS_LABELS } from '@/lib/status'
import { tenantClient } from '@/lib/supabase/tenant'
import { getGeneralSettings } from '@/lib/data/company'
import {
  bulkCustomerName, countAllCustomers, findProvisioned, getProvisionPlan,
  readCustomersByIds, readBillableByIds, readBillableCustomers,
  type BillableCustomer,
} from '@/lib/data/bulk'
import { getSchemaCapabilities } from '@/lib/schema'
import { CURRENCY_SYMBOL, formatCurrency, instantToDateOnly } from '@/lib/format'
import { activateInRadius, batchGetRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { usernameKey } from '@/lib/radius/format'
import { formatRadiusExpiration, radiusIdentity } from '@/lib/radius/format'
import {
  applyCredit, billRunVerdict, type BillRunVerdict, type BillScope,
} from '@/lib/billing'
import { addMonths, nextCutOff } from '@/lib/expiry'

/**
 * The company-wide bulk actions on the customer list.
 *
 * All of them are gated on `import_customers` — the same right that lets
 * someone load a spreadsheet of strangers into the database. None is reachable
 * by a CSR.
 *
 * Each run writes exactly ONE log row, at the end, from the action that
 * finishes it. Three hundred rows would bury every other event on the
 * dashboard's activity panel and tell nobody anything the summary does not.
 *
 * NOTHING HERE IS SCHEDULED. Every action in this file runs because a person
 * opened a modal, read a count and typed it back. There is no cron, no Edge
 * Function and no recurring job behind any of them, and Bill All in particular
 * must stay that way: its period selector and its idempotency guard only make
 * sense as things a human chooses and re-checks.
 */

async function authorize(): Promise<Session> {
  const session = await getSession()
  if (!can(session.profile.role, 'import_customers')) {
    throw new Error(
      'Forbidden: role "' + session.profile.role + '" lacks import_customers.'
    )
  }
  return session
}

/** A `YYYY-MM-DD` string as local midnight, or null if it is not one. */
function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (!Number.isFinite(date.getTime())) return null
  // Rejects 2026-02-31, which the Date constructor would roll into March.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

function ymd(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

// ---------------------------------------------------------------------------
// 1. Set all cut off dates
// ---------------------------------------------------------------------------

export type CutOffPlan = {
  customerCount: number
  /** The company's configured cut-off day, to pre-fill the field. */
  currentDay: number | null
}

export async function loadCutOffPlan(): Promise<CutOffPlan> {
  const { company } = await authorize()
  const [customerCount, settings] = await Promise.all([
    countAllCustomers(company.id),
    getGeneralSettings(company.id),
  ])
  return { customerCount, currentDay: settings.cutOffDate }
}

export type CutOffResult =
  | { ok: true; updated: number }
  | { ok: false; error: string }

/**
 * Sets `customers.cut_off_date` for every customer in the company.
 *
 * THAT COLUMN AND NOTHING ELSE. The cut-off day is when a customer's next
 * period is due; it is not their current expiry, which lives in radcheck. This
 * action does not read, write or invalidate the network registry, and a
 * customer who is online stays online with the expiry they already hold.
 *
 * `confirmCount` is the number the operator was shown and typed back. If the
 * customer count has moved since the modal opened, the run is refused rather
 * than applied to a different set than the one they agreed to.
 */
export async function setAllCutOffDates(input: {
  day: number
  confirmCount: number
}): Promise<CutOffResult> {
  const { company, profile } = await authorize()

  const day = Math.floor(input.day)
  // The same 1-28 rule the Add Customer form applies: a cut-off day has to
  // exist in every month, including February.
  if (!Number.isFinite(day) || day < 1 || day > 28) {
    return { ok: false, error: 'The cut off day must be a day between 1 and 28.' }
  }

  const customerCount = await countAllCustomers(company.id)
  if (customerCount !== input.confirmCount) {
    return {
      ok: false,
      error:
        'The customer count changed from ' + input.confirmCount + ' to ' + customerCount +
        ' while this was open. Nothing was changed — reopen and confirm the new number.',
    }
  }

  if (customerCount === 0) return { ok: false, error: 'There are no customers to update.' }

  const db = tenantClient()
  const { error, count } = await db
    .from('customers')
    .update({ cut_off_date: day }, { count: 'exact' })
    .eq('company_id', company.id)

  if (error) return { ok: false, error: 'Could not update cut off dates: ' + error.message }

  const updated = count ?? customerCount

  // The column is already updated. logEvent reports a failed audit write to the
  // console and returns: failing the whole action to keep the audit row tidy
  // would undo nothing and help nobody.
  await logEvent({
    customerId: null,
    type: 'bulk_cut_off_set',
    details:
      'Cut off day set to ' + day + ' for ' + updated +
      (updated === 1 ? ' customer' : ' customers') +
      ' by ' + (profile.first_name ?? profile.email) +
      '. Expiry dates were not changed.',
    tag: '[bulk]',
  })

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')
  return { ok: true, updated }
}

// ---------------------------------------------------------------------------
// 2. Provision all
// ---------------------------------------------------------------------------

export type ProvisionTarget = {
  id: number
  name: string
  /** `YYYY-MM-DD`, derived from this customer's OWN cut-off day. */
  expiry: string
}

/**
 * What expiry a run writes.
 *
 * `per_cut_off` is the default and gives each customer the next occurrence of
 * their own cut-off day. `single` is the "Use one date for everyone" escape
 * hatch, and is exactly the behaviour this action had before.
 */
export type ProvisionExpiryChoice =
  | { mode: 'per_cut_off' }
  | { mode: 'single'; date: string }

export type ProvisionPlanResult = {
  ready: ProvisionTarget[]
  noIdentity: { id: number; name: string }[]
  alreadyProvisioned: { id: number; name: string }[]
  /**
   * `YYYY-MM-DD`, the next occurrence of the COMPANY cut-off day.
   *
   * Two jobs: it seeds the single-date field, and it is the fallback expiry for
   * a customer who has no cut-off day of their own.
   */
  defaultExpiry: string
  /** The distinct dates the per-customer rule produces, and how many land on each. */
  breakdown: { expiry: string; count: number }[]
  /** How many of `ready` have no cut-off day and fell back to `defaultExpiry`. */
  withoutCutOff: number
  /** False when the RADIUS env vars are absent; the action refuses to run. */
  configured: boolean
}

/**
 * The expiry for ONE customer: the next occurrence of their own cut-off day
 * after today.
 *
 * THE 21-DAY RULE IS NOT APPLIED and provisionExpiry() is deliberately not
 * called: that rule exists so a new customer activating four days before their
 * cut-off does not buy a month and get a week of it. These customers already
 * have service — this is a migration into the registry, not a set of first
 * activations, and pushing them all a month and a half out would move every one
 * of them off their cut-off day.
 *
 * The cascade when a customer has no day of their own is the company day, then
 * one month out. Falling back rather than skipping is deliberate: a customer
 * with a blank cut_off_date still needs to be on the network, and the company
 * day is the same answer this action gave everybody before.
 *
 * ONE function for both the preview and the write, so the dates an operator
 * agreed to in the modal cannot drift from the dates that get written.
 */
function expiryForCustomer(
  cutOffDay: number | null,
  companyCutOffDay: number | null,
  anchor: Date
): Date {
  return (
    nextCutOff(anchor, cutOffDay) ??
    nextCutOff(anchor, companyCutOffDay) ??
    addMonths(anchor, 1)
  )
}

/** Today at local midnight — the anchor every expiry in a run is measured from. */
function todayAnchor(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Distinct expiry dates and how many customers land on each, earliest first. */
function summariseDates(targets: { expiry: string }[]): { expiry: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const t of targets) counts.set(t.expiry, (counts.get(t.expiry) ?? 0) + 1)
  return [...counts.entries()]
    .map(([expiry, count]) => ({ expiry, count }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry))
}

/**
 * What a bulk provision would do, without doing any of it.
 *
 * Every customer gets their own expiry, derived by expiryForCustomer above, and
 * the modal shows the resulting spread rather than one date field. The dates
 * are recomputed on the write from the same function and the same rows, so what
 * comes back here is a preview, not an instruction — see provisionBatch.
 */
export async function loadProvisionPlan(): Promise<ProvisionPlanResult> {
  const { company } = await authorize()

  const settings = await getGeneralSettings(company.id)
  const anchor = todayAnchor()
  const defaultExpiry = nextCutOff(anchor, settings.cutOffDate) ?? addMonths(anchor, 1)

  if (!radiusConfigured()) {
    return {
      ready: [],
      noIdentity: [],
      alreadyProvisioned: [],
      defaultExpiry: ymd(defaultExpiry),
      breakdown: [],
      withoutCutOff: 0,
      configured: false,
    }
  }

  const plan = await getProvisionPlan(company.id)

  // The identity stays on the server: the client posts ids, and the identity
  // that gets written is derived from the row again in provisionBatch.
  const ready: ProvisionTarget[] = plan.ready.map((c) => ({
    id: c.id,
    name: c.name,
    expiry: ymd(expiryForCustomer(c.cutOffDate, settings.cutOffDate, anchor)),
  }))

  return {
    ready,
    noIdentity: plan.noIdentity,
    alreadyProvisioned: plan.alreadyProvisioned,
    defaultExpiry: ymd(defaultExpiry),
    breakdown: summariseDates(ready),
    withoutCutOff: plan.ready.filter((c) => !c.cutOffDate).length,
    configured: true,
  }
}

export type ProvisionOutcome = {
  id: number
  name: string
  result: 'provisioned' | 'skipped_no_identity' | 'skipped_already' | 'failed'
  /** `YYYY-MM-DD` actually written. Populated for `provisioned`. */
  expiry?: string
  /** Populated for `failed`. */
  error?: string
}

/** Refused above this. The client sends far smaller batches; this is a bound,
 *  not a target — a huge batch would hold a RADIUS connection for minutes. */
const MAX_BATCH = 100

/**
 * Provisions one batch of customers, sequentially.
 *
 * SEQUENTIAL ON PURPOSE. The mysql2 pool is a process-wide singleton shared
 * with every page load that reads a customer's status, and it allows 10
 * connections. Running a batch through Promise.all would queue every write
 * against that pool at once and starve the dashboard of connections while a
 * few hundred writes drain — against a NAS that is serving live subscribers.
 * One at a time means this feature never holds more than one connection.
 *
 * EVERY EXPIRY IS DERIVED HERE, from the customer row, exactly as the identity
 * is. The client posts ids and which of the two rules to apply; it never posts
 * a per-customer date, so a tampered or stale payload cannot put a date on a
 * customer that the preview did not compute for them.
 *
 * The existence check is ONE query for the whole batch, not one per customer,
 * and it is done here rather than reused from the preview: a set captured when
 * the modal opened is stale by the time the last batch runs, and re-running a
 * half-finished job has to see the rows the earlier attempt wrote.
 *
 * A failure is recorded against that customer and the loop continues. Nothing
 * is dropped: every id that comes in leaves with an outcome.
 */
export async function provisionBatch(input: {
  ids: number[]
  expiry: ProvisionExpiryChoice
}): Promise<{ outcomes: ProvisionOutcome[] }> {
  const { company } = await authorize()

  if (input.ids.length > MAX_BATCH) {
    throw new Error('Too many customers in one batch: ' + input.ids.length + ' (max ' + MAX_BATCH + ').')
  }

  const choice = input.expiry
  const singleDate = choice.mode === 'single' ? parseDay(choice.date) : null
  if (choice.mode === 'single' && !singleDate) {
    throw new Error('"' + choice.date + '" is not a valid expiry date.')
  }

  // Refuse rather than report every customer as "skipped": a run that wrote
  // nothing because the NAS was not configured must not read as a success.
  if (!radiusConfigured()) {
    throw new Error(
      'The RADIUS database is not configured, so nothing can be provisioned. ' +
      'Set RADIUS_DB_HOST, RADIUS_DB_USER, RADIUS_DB_PASSWORD and RADIUS_DB_NAME.'
    )
  }

  // Only read for the per-customer rule, where it is the fallback for anyone
  // with no cut-off day of their own.
  const companyCutOffDay =
    choice.mode === 'per_cut_off' ? (await getGeneralSettings(company.id)).cutOffDate : null

  const anchor = todayAnchor()
  const customers = await readCustomersByIds(company.id, input.ids)
  const byId = new Map(customers.map((c) => [c.id, c]))

  const targets: {
    id: number
    name: string
    identity: string | null
    expiry: Date | null
  }[] = input.ids.map((id) => {
    const customer = byId.get(id)
    if (!customer) {
      return { id, name: 'Customer #' + id, identity: null, expiry: null }
    }
    return {
      id,
      name: bulkCustomerName(customer),
      identity:
        radiusIdentity({
          customerType: customer.customer_type,
          macAddress: customer.mac_address,
          pppoeUsername: customer.pppoe_username,
        })?.trim() || null,
      expiry: singleDate ?? expiryForCustomer(customer.cut_off_date, companyCutOffDay, anchor),
    }
  })

  // One round trip for the batch. Left to throw: a failed lookup must not read
  // as "nobody is provisioned", because activateInRadius deletes before it
  // inserts and would replace a paid-up customer's expiry with this one.
  const provisioned = await findProvisioned(
    targets.map((t) => t.identity).filter((x): x is string => Boolean(x))
  )

  const outcomes: ProvisionOutcome[] = []

  for (const target of targets) {
    if (!byId.has(target.id)) {
      outcomes.push({
        id: target.id,
        name: target.name,
        result: 'failed',
        error: 'This customer no longer exists.',
      })
      continue
    }

    if (!target.identity) {
      outcomes.push({ id: target.id, name: target.name, result: 'skipped_no_identity' })
      continue
    }

    // Normalised both sides — see the same comparison in lib/data/bulk.ts.
    if (provisioned.has(usernameKey(target.identity))) {
      outcomes.push({ id: target.id, name: target.name, result: 'skipped_already' })
      continue
    }

    // Unreachable — a row present in byId always gets a date above — but the
    // write must never run without one, so it fails closed rather than guessing.
    if (!target.expiry) {
      outcomes.push({
        id: target.id,
        name: target.name,
        result: 'failed',
        error: 'Could not work out an expiry date for this customer.',
      })
      continue
    }

    try {
      // The existing write: both radcheck rows with op ':=', inside a
      // transaction, clearing any prior rows first. Not extendInRadius, which
      // only ever touches Expiration and would leave these customers without
      // an Auth-Type := Accept row.
      await activateInRadius(target.identity, formatRadiusExpiration(target.expiry))
      outcomes.push({
        id: target.id,
        name: target.name,
        result: 'provisioned',
        expiry: ymd(target.expiry),
      })
    } catch (err) {
      const e = err as { code?: string; sqlMessage?: string; message?: string }
      const message = (e.sqlMessage ?? e.message ?? 'unknown error') + (e.code ? ' (' + e.code + ')' : '')
      console.error(
        '[bulk] provision failed for customer %d (%s): %s',
        target.id, target.identity, message
      )
      outcomes.push({ id: target.id, name: target.name, result: 'failed', error: message })
    }
  }

  return { outcomes }
}

/**
 * How the run's expiry dates are described in the audit row.
 *
 * A single date reads as it always did. Per-customer dates are named in full
 * when there are only a few, and summarised as a range beyond that — an audit
 * line listing forty dates tells a reader less than one saying it spanned two.
 */
function describeExpiry(dates: { expiry: string; count: number }[], single: string | null): string {
  if (single) return 'to expire ' + single

  if (dates.length === 0) return "to each customer's own cut off day"
  if (dates.length === 1) return 'to expire ' + dates[0].expiry + ", each customer's own cut off day"

  const listed = dates.map((d) => d.expiry + ' (' + d.count + ')').join(', ')
  const summary =
    dates.length <= 6
      ? listed
      : dates.length + ' dates from ' + dates[0].expiry + ' to ' + dates[dates.length - 1].expiry

  return "to each customer's own cut off day: " + summary
}

/** ONE log row for the whole run, written once the last batch has returned. */
export async function logBulkProvision(summary: {
  provisioned: number
  skippedNoIdentity: number
  skippedAlready: number
  failed: number
  /** Set when "use one date for everyone" was ticked; null for per-customer. */
  singleExpiry: string | null
  /** The distinct dates actually written, and how many customers got each. */
  dates: { expiry: string; count: number }[]
}): Promise<void> {
  // Still authorizes: logEvent resolves the tenant, but the permission check
  // for this action belongs here.
  const { profile } = await authorize()

  const details =
    'Bulk provision: ' + summary.provisioned +
    (summary.provisioned === 1 ? ' customer' : ' customers') +
    ' provisioned ' + describeExpiry(summary.dates, summary.singleExpiry) +
    '. Skipped ' + summary.skippedNoIdentity + ' with no MAC address, ' +
    summary.skippedAlready + ' already provisioned. ' +
    summary.failed + ' failed. By ' + (profile.first_name ?? profile.email)

  await logEvent({
    customerId: null,
    type: 'bulk_provision',
    details,
    tag: '[bulk]',
  })

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')
}

// ---------------------------------------------------------------------------
// 3. Bill all customers
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export type BillPeriod = {
  /** `YYYY-MM`, as posted. */
  key: string
  /** First day of the month, `YYYY-MM-DD`. */
  start: string
  /** LAST day of the month, `YYYY-MM-DD`. This is what gets written. */
  end: string
  /** "August 2026". */
  label: string
}

/**
 * A `YYYY-MM` string as a calendar month, or null if it is not one.
 *
 * The end date is `new Date(y, m, 0)` — day zero of the following month, which
 * Postgres and JavaScript agree is the last day of this one, February and leap
 * years included.
 */
function resolvePeriod(key: string): BillPeriod | null {
  if (!/^\d{4}-\d{2}$/.test(key)) return null
  const [y, m] = key.split('-').map(Number)
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return null
  if (!Number.isInteger(m) || m < 1 || m > 12) return null

  return {
    key,
    start: ymd(new Date(y, m - 1, 1)),
    end: ymd(new Date(y, m, 0)),
    label: MONTH_NAMES[m - 1] + ' ' + y,
  }
}

/**
 * Which of these customers had service at the moment the run fired.
 *
 * SERVICE DELIVERED IS THE TEST FOR WHETHER A BILL IS OWED. A customer whose
 * access had expired when the run fired did not have the month they would be
 * charged for, so they are not charged for it.
 *
 * THE EXPIRY COMES FROM radcheck AND NOWHERE ELSE. Not last_billed_date, not
 * last_bill_date, not a cut-off day walked forward — those are billing records
 * and derived dates, and the whole point of this rule is to bill against what
 * the network actually did. radcheck is the only authority on that.
 *
 * NO GRACE PERIOD, DELIBERATELY. A customer cut off on the 5th whose run fires
 * on the 25th is disconnected and is skipped, even though they had service for
 * part of the period. Adding grace here would re-introduce the "charge them
 * anyway" behaviour this rule exists to remove; a part-month that should be
 * charged is a manual payment, not a bill run.
 *
 * A customer with no radcheck row at all — never provisioned, or no MAC and no
 * PPPoE username to look one up by — is reported separately. They are skipped
 * too: no row means no access, which means no service to bill for.
 *
 * THROWS IF THE REGISTRY CANNOT BE REACHED. Both fallbacks are wrong: billing
 * everybody charges customers who were cut off, and billing nobody silently
 * reports a run that did nothing. Neither is safe on a company's whole book, so
 * the run refuses rather than guessing.
 */
async function serviceStateFor(
  customers: BillableCustomer[]
): Promise<Map<number, 'active' | 'disconnected' | 'unprovisioned'>> {
  const out = new Map<number, 'active' | 'disconnected' | 'unprovisioned'>()
  if (customers.length === 0) return out

  if (!radiusConfigured()) {
    throw new Error(
      'The network registry is not configured, so the bill run cannot tell which ' +
      'customers had service. Nothing was billed.'
    )
  }

  let registry
  try {
    registry = await batchGetRadiusStatus(customers.map((c) => c.identity))
  } catch (err) {
    throw new Error(
      'The network registry could not be read, so the bill run cannot tell which ' +
      'customers had service. Nothing was billed. (' + (err as Error).message + ')'
    )
  }

  for (const customer of customers) {
    if (!customer.identity) {
      out.set(customer.id, 'unprovisioned')
      continue
    }

    // Keyed the way batchGetRadiusStatus normalises identities, not by the
    // spelling the customers row happens to hold.
    const record = registry.get(usernameKey(customer.identity))

    if (!record || !record.exists) {
      out.set(customer.id, 'unprovisioned')
      continue
    }

    // 'active' is the only state that means access has not expired.
    // 'expired' and 'inactive' are both an expiry in the past — they differ
    // only in how long ago, which this rule does not care about.
    out.set(customer.id, record.status === 'active' ? 'active' : 'disconnected')
  }

  return out
}

export type BillTarget = {
  id: number
  name: string
  /** Preview only. The write recomputes it from the row — see billBatch. */
  amount: number
}

/** One line of the preview's bill-date table. */
export type BillDayLine = {
  /** The day customers on this line are billed on — their own, or the company's. */
  day: number
  /** The date this period's bill falls due for them, `YYYY-MM-DD`. */
  dueDate: string
  /** Would be billed by this run. */
  included: number
  /** Their bill date for this period has not arrived. */
  notDue: number
  /** It arrived before they were on the platform, so it was never theirs. */
  beforeJoined: number
}

/**
 * What the run needs to know about the company, read once: today IN THE
 * COMPANY'S ZONE, and its bill day for customers with none of their own.
 *
 * NOT THE SERVER'S TODAY. The server runs in UTC; at 8pm in Kingston on the
 * 19th it already reads the 20th, and a run pressed then would bill the
 * 20th-group a day early.
 */
async function billRunContext(companyId: number): Promise<{ today: string; companyBillDate: number | null }> {
  const { data, error } = await tenantClient()
    .from('settings').select('bill_date, timezone').eq('company_id', companyId).maybeSingle()
  if (error) throw new Error('Could not read the company bill day: ' + error.message)

  const row = data as { bill_date: number | null; timezone: string | null } | null
  return {
    today: instantToDateOnly(new Date(), row?.timezone || 'America/Jamaica'),
    companyBillDate: row?.bill_date ?? null,
  }
}

/** The period before this one, for the "still unbilled" line. */
function previousPeriod(period: BillPeriod): BillPeriod | null {
  const [y, m] = period.key.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return resolvePeriod(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'))
}

export type BillAllPlan = {
  /** False until migration 0011 is applied; the modal refuses to run. */
  available: boolean
  period: BillPeriod
  /** Which customers this plan considered — see lib/billing.ts#BillScope. */
  scope: BillScope
  /** Today in the company's zone: the date bill dates were tested against. */
  today: string
  /**
   * Per bill date: who is included, who is not yet due, who joined too late.
   * What lets an operator SEE which dates they are about to bill. In scope
   * 'all' every customer counts as included, whatever their date.
   */
  billDays: BillDayLine[]
  /** Bill date for this period not reached yet. Always 0 in scope 'all'. */
  notDue: number
  /** Bill date came round before they were on the platform. 0 in scope 'all'. */
  beforeJoined: number
  /**
   * Customers whose bill date for the PREVIOUS period has come round and who
   * were never billed for it. A group missed last month is otherwise invisible
   * once the picker moves on; this is how it gets noticed. Bill the older
   * period FIRST — see the note on billBatch about running periods out of order.
   */
  priorUnbilled: { label: string; key: string; count: number } | null
  /** Every customer in the company. Was postpaid-only before the split was
   *  retired — see lib/billing.ts. */
  customerCount: number
  /** Customers whose last_billed_date already falls in this period. */
  alreadyBilled: number
  /** Unbilled, but on a monthly rate of zero. Skipped entirely. */
  zeroRate: number
  /** Access had expired in radcheck when the plan was read. Not billed. */
  disconnected: number
  /** No radcheck row at all — never provisioned. Not billed. */
  unprovisioned: number
  /**
   * Of `totalAmount`, how much standing account_credit would absorb rather
   * than land on a carried balance. Money already collected — it is not a
   * discount, and it is not deducted from what the run charges.
   */
  creditApplied: number
  /** Who would actually be billed, and for how much. */
  targets: BillTarget[]
  /** Sum of `targets`. */
  totalAmount: number
}

/**
 * What a bill run would do for one period, without doing any of it.
 *
 * The "already billed" count is computed HERE, before the operator can confirm,
 * because it is the only thing standing between them and silently doubling
 * every balance in the company. A run that would bill nobody still returns a
 * plan — the modal shows why rather than an empty error.
 *
 * BY BILL DATE, BY DEFAULT. `scope` 'due' considers only customers whose bill
 * date for this period has been reached; 'all' is the whole company, which is
 * what this did before bill dates counted. The per-date table is returned in
 * both, so the operator is shown WHICH dates they are about to bill either way.
 * Who is billed is decided by lib/billing.ts#billRunVerdict — the same call
 * billBatch makes before it writes.
 */
export async function loadBillAllPlan(
  periodKey: string,
  scope: BillScope = 'due'
): Promise<BillAllPlan> {
  const { company } = await authorize()

  const period = resolvePeriod(periodKey)
  if (!period) throw new Error('"' + periodKey + '" is not a valid billing period.')
  // Anything that is not exactly 'all' is the safe one.
  const runScope: BillScope = scope === 'all' ? 'all' : 'due'

  const caps = await getSchemaCapabilities()
  if (!caps.billing) {
    return {
      available: false,
      period,
      scope: runScope,
      today: '',
      billDays: [],
      notDue: 0,
      beforeJoined: 0,
      priorUnbilled: null,
      customerCount: 0,
      alreadyBilled: 0,
      zeroRate: 0,
      disconnected: 0,
      unprovisioned: 0,
      creditApplied: 0,
      targets: [],
      totalAmount: 0,
    }
  }

  const [customers, context] = await Promise.all([
    readBillableCustomers(company.id),
    billRunContext(company.id),
  ])
  const service = await serviceStateFor(customers)
  const prior = previousPeriod(period)

  const counts: Record<BillRunVerdict, number> = {
    bill: 0, already_billed: 0, not_due: 0, before_joined: 0,
    zero_rate: 0, disconnected: 0, unprovisioned: 0,
  }
  const lines = new Map<number, BillDayLine>()
  let creditApplied = 0
  let priorCount = 0
  const targets: BillTarget[] = []

  for (const customer of customers) {
    const decided = billRunVerdict({
      period, scope: runScope, today: context.today,
      companyBillDate: context.companyBillDate,
      customer, service: service.get(customer.id),
    })
    counts[decided.verdict]++

    // The table is about DATES, so it only counts what a date decided: who is
    // in, who is not yet due, who joined too late. Already-billed, zero-rate
    // and lapsed customers are reported company-wide below, as before.
    const line = lines.get(decided.billDay) ??
      { day: decided.billDay, dueDate: decided.dueDate, included: 0, notDue: 0, beforeJoined: 0 }
    if (decided.verdict === 'bill') line.included++
    else if (decided.verdict === 'not_due') line.notDue++
    else if (decided.verdict === 'before_joined') line.beforeJoined++
    lines.set(decided.billDay, line)

    if (decided.verdict === 'bill') {
      targets.push({ id: customer.id, name: customer.name, amount: customer.monthlyRate })
      // Preview only. billBatch recomputes this from the row it is about to
      // write, so a credit spent between the preview and the run cannot be
      // spent twice.
      creditApplied += applyCredit(
        customer.accountCredit, customer.carriedBalance, customer.monthlyRate
      ).drawn
    }

    // Due for the period BEFORE this one, with a rate, and never billed for it.
    // Service state is not consulted: this is a prompt to go and look, not a
    // list of who that run would bill.
    if (prior && customer.monthlyRate > 0) {
      const before = billRunVerdict({
        period: prior, scope: 'due', today: context.today,
        companyBillDate: context.companyBillDate, customer, service: 'active',
      })
      if (before.verdict === 'bill') priorCount++
    }
  }

  return {
    available: true,
    period,
    scope: runScope,
    today: context.today,
    billDays: [...lines.values()]
      .filter((l) => l.included + l.notDue + l.beforeJoined > 0)
      .sort((a, b) => a.day - b.day),
    notDue: counts.not_due,
    beforeJoined: counts.before_joined,
    priorUnbilled: prior && priorCount > 0 ? { label: prior.label, key: prior.key, count: priorCount } : null,
    customerCount: customers.length,
    alreadyBilled: counts.already_billed,
    zeroRate: counts.zero_rate,
    disconnected: counts.disconnected,
    unprovisioned: counts.unprovisioned,
    creditApplied: Math.round(creditApplied * 100) / 100,
    targets,
    totalAmount: targets.reduce((sum, t) => sum + t.amount, 0),
  }
}

export type BillOutcome = {
  id: number
  name: string
  result:
    | 'billed'
    | 'skipped_already'
    /** Bill date for this period not reached when the write ran. */
    | 'skipped_not_due'
    /** Bill date came round before the customer was on the platform. */
    | 'skipped_before_joined'
    | 'skipped_zero_rate'
    | 'skipped_disconnected'
    | 'skipped_unprovisioned'
    | 'failed'
  /** Added to carried_balance. Populated for `billed`. */
  amount?: number
  /** The day they are billed on. Populated for `billed`, for the log row. */
  billDay?: number
  /** Populated for `failed`. */
  error?: string
}

/**
 * Bills one batch of customers for one period.
 *
 * WHAT IT WRITES, per customer, and nothing else:
 *   carried_balance  += monthly_rate
 *   last_billed_date  = the LAST DAY OF THE PERIOD BILLED
 *
 * It does not WRITE to radcheck, and does not touch expiry_mode, balance,
 * cut_off_date, bill_date or billing_type, and it creates no payment rows. A
 * customer who is online stays online with the expiry they already hold; a bill
 * is a debt, not a disconnection.
 *
 * It does READ radcheck, and that read decides who is billed at all: a customer
 * whose access has expired when the run fires had no service to be charged for
 * and is skipped. See serviceStateFor.
 *
 * THE PERIOD COMES FROM THE OPERATOR; WHO IS DUE COMES FROM `bill_date`. In the
 * default scope a customer is billed only once their bill date for the period
 * has been reached — their own day, else the company's — and only if they were
 * on the platform when it came round. Reached means reached OR PASSED: a run
 * pressed on the 25th still bills the 20th-group; late is not skipped. It used
 * to bill the whole company whatever their dates, which charged JMEDIA's
 * 4th-group a month early the moment anyone billed its 20th-group. Scope 'all'
 * is that old behaviour, kept as a deliberate choice. Decided by
 * lib/billing.ts#billRunVerdict, the same call the preview makes.
 *
 * ONE RUN, ONE PERIOD, ONE STAMP — so customers on different dates are billed
 * by DIFFERENT RUNS OF THE SAME PERIOD. August is run on 4 September for the
 * 4th-group and again on the 20th for the rest, and the guard below is what
 * makes the second run skip the first group. Nothing about the stamp changed.
 *
 * last_billed_date IS THE PERIOD, NOT THE RUN DATE. Billing August 2026 writes
 * 2026-08-31 whether the run happens on 1 September or on 14 October. Stamping
 * the run date instead would make the column useless as a guard: the second run
 * would see a date outside the period and bill everyone again.
 *
 * THE GUARD IS IN THE WHERE CLAUSE, not only in the plan. loadBillAllPlan's
 * count is read when the modal opens, which is minutes and possibly a second
 * operator before this runs. Each update therefore re-asserts that the row is
 * still unbilled for this period, and a write that matches nothing is reported
 * as skipped rather than counted. Two people clicking Bill All at the same
 * moment bill each customer once between them.
 *
 * The stamp only ever moves FORWARD. Billing an earlier period for a customer
 * already billed for a later one adds the charge but keeps the later stamp,
 * because lowering it would re-open a period that has already been billed.
 *
 * ON THE RECORD: RUNNING PERIODS OUT OF ORDER IS NOT SAFE TO REPEAT, AND A
 * STAMP COLUMN CANNOT MAKE IT SO. One date per customer can say "billed through
 * here"; it cannot say "billed for September AND for August". So once a
 * customer carries September's stamp, billing August leaves the stamp where it
 * is, the guard's third arm (`last_billed_date.gt.<period end>`) still reads
 * them as unbilled for August, and A SECOND AUGUST RUN BILLS THEM AGAIN. That
 * is how Ezmze's 2026-09-30 stamp would have double-billed 952 customers.
 * Billing by date makes out-of-order catch-up more likely, not less. The safe
 * order is always OLDEST PERIOD FIRST, and the preview's "still unbilled for
 * last period" line exists to point there. The real fix is a row per customer
 * per month — a ledger the guard can look a period up in — and until that
 * exists this is a rule for operators, not something the code enforces.
 *
 * Sequential, one customer per statement. PostgREST cannot add a column to
 * itself, so each new balance is computed here from the row it was read from —
 * which is also what lets the guard and the arithmetic stay in agreement.
 */
export async function billBatch(input: {
  period: string
  ids: number[]
  /** Absent, or anything that is not exactly 'all', means 'due' — the safe one. */
  scope?: BillScope
}): Promise<{ outcomes: BillOutcome[] }> {
  const { company } = await authorize()

  const period = resolvePeriod(input.period)
  if (!period) throw new Error('"' + input.period + '" is not a valid billing period.')
  const scope: BillScope = input.scope === 'all' ? 'all' : 'due'

  if (input.ids.length > MAX_BATCH) {
    throw new Error('Too many customers in one batch: ' + input.ids.length + ' (max ' + MAX_BATCH + ').')
  }

  const caps = await getSchemaCapabilities()
  if (!caps.billing) {
    throw new Error(
      'Postpaid billing is not available on this database yet. Apply migration ' +
      '0011_postpaid_billing.sql first — nothing was billed.'
    )
  }

  const db = tenantClient()
  const customers = await readBillableByIds(company.id, input.ids)
  const byId = new Map(customers.map((c) => [c.id, c]))

  // Re-read at WRITE time, not carried from the plan. The modal may have been
  // open for minutes and a customer can lapse in between; "expired at the
  // moment the run fires" is what the rule says, so this is the reading that
  // decides. Same reasoning as the unbilled guard in the WHERE clause below.
  const service = await serviceStateFor(customers)

  // Today and the company's bill day, read at WRITE time for the same reason.
  const context = await billRunContext(company.id)

  // Matches a row that has NOT been billed for this period: never billed, last
  // billed before it, or last billed after it. The three arms are what let an
  // earlier period be billed without disturbing a later stamp.
  const unbilled =
    'last_billed_date.is.null,' +
    'last_billed_date.lt.' + period.start + ',' +
    'last_billed_date.gt.' + period.end

  const outcomes: BillOutcome[] = []

  for (const id of input.ids) {
    const customer = byId.get(id)

    if (!customer) {
      outcomes.push({
        id,
        name: 'Customer #' + id,
        result: 'failed',
        error: 'This customer no longer exists.',
      })
      continue
    }

    // THE SAME DECISION THE PREVIEW MADE, made again on the row as it is now.
    // The ids came from the plan, but a plan is minutes old: a bill date can
    // have been edited, a customer can have lapsed, midnight can have passed.
    //
    // Nothing is stamped for any skip. A zero rate corrected later, a customer
    // reconnected later, a bill date reached later — each leaves the period
    // open so it can still be billed when that is the right call.
    const decided = billRunVerdict({
      period, scope, today: context.today,
      companyBillDate: context.companyBillDate,
      customer, service: service.get(id),
    })

    if (decided.verdict !== 'bill') {
      const SKIPS: Record<Exclude<BillRunVerdict, 'bill'>, BillOutcome['result']> = {
        already_billed: 'skipped_already',
        not_due: 'skipped_not_due',
        before_joined: 'skipped_before_joined',
        zero_rate: 'skipped_zero_rate',
        disconnected: 'skipped_disconnected',
        unprovisioned: 'skipped_unprovisioned',
      }
      outcomes.push({ id, name: customer.name, result: SKIPS[decided.verdict] })
      continue
    }

    const stamp =
      customer.lastBilledDate && customer.lastBilledDate > period.end
        ? customer.lastBilledDate
        : period.end

    // PREPAYMENT IS SPENT BEFORE ANYTHING IS OWED. A customer who paid three
    // months up front has the charge taken out of their credit, so the two runs
    // their money already covers leave carried_balance at zero rather than
    // showing them in arrears and then being paid off again.
    //
    // Computed from the row read at the top of this batch, and written in the
    // same guarded statement as the charge — the `unbilled` filter below means
    // a second concurrent run matches nothing and draws the credit down once.
    const applied = applyCredit(
      customer.accountCredit, customer.carriedBalance, customer.monthlyRate
    )

    try {
      let write = db
        .from('customers')
        .update(
          {
            carried_balance: applied.carriedBalance,
            account_credit: applied.credit,
            last_billed_date: stamp,
          },
          { count: 'exact' }
        )
        .eq('company_id', company.id)
        .eq('id', id)
        // THE GUARD, unchanged: the row is still unbilled for this period.
        .or(unbilled)

      // AND STILL ON THE BILL DATE THAT MADE IT DUE. Asserted in the statement
      // for the same reason the guard is: the decision above was made on a row
      // read a moment ago. A bill date edited in between matches nothing, and
      // the customer is reported skipped rather than billed on a date they are
      // no longer on. Not asserted in scope 'all', where no date decided
      // anything and the write is exactly what it was before.
      if (scope === 'due') {
        write = customer.billDate === null
          ? write.is('bill_date', null)
          : write.eq('bill_date', customer.billDate)
      }

      const { error, count } = await write

      if (error) throw new Error(error.message)

      // Zero rows matched: something billed this customer for this period
      // between the read above and the write. Not an error — the charge landed
      // exactly once, which is the whole point.
      if ((count ?? 0) === 0) {
        outcomes.push({ id, name: customer.name, result: 'skipped_already' })
        continue
      }

      outcomes.push({
        id, name: customer.name, result: 'billed',
        amount: customer.monthlyRate, billDay: decided.billDay,
      })
    } catch (err) {
      const message = (err as Error).message
      console.error('[bulk] bill failed for customer %d: %s', id, message)
      outcomes.push({ id, name: customer.name, result: 'failed', error: message })
    }
  }

  return { outcomes }
}

/** ONE log row for the whole run, written once the last batch has returned. */
export async function logBulkBill(summary: {
  /** `YYYY-MM`. */
  period: string
  billed: number
  totalAmount: number
  skippedAlready: number
  skippedZeroRate: number
  skippedDisconnected: number
  skippedUnprovisioned: number
  failed: number
  /** Absent reads as 'due', which is what billBatch ran if it was given none. */
  scope?: BillScope
  skippedNotDue?: number
  skippedBeforeJoined?: number
  /** Customers billed, per bill day. What the log says was actually billed. */
  billDays?: { day: number; count: number }[]
}): Promise<void> {
  const { profile } = await authorize()

  const period = resolvePeriod(summary.period)
  const label = period ? period.label : summary.period
  const stamp = period ? period.end : 'the end of the period'

  const ordinal = (n: number) => {
    const tens = n % 100
    const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
    return n + suffix
  }
  const days = (summary.billDays ?? [])
    .filter((d) => d.count > 0)
    .sort((a, b) => a.day - b.day)
    .map((d) => ordinal(d.day) + ' (' + d.count + ')')
    .join(', ')

  // WHICH customers, said in the row itself: a log that reads the same for a
  // by-date run and a whole-company run cannot answer "why was this customer
  // billed on the 20th" a month later.
  const who = summary.scope === 'all'
    ? 'WHOLE COMPANY, regardless of bill date'
    : 'customers whose bill date had been reached'

  const details =
    'Bulk bill for ' + label + ', ' + who + (days ? ' — bill dates ' + days : '') + ': ' + summary.billed +
    (summary.billed === 1 ? ' customer' : ' customers') +
    ' billed ' + formatCurrency(summary.totalAmount) + ' in total, added to carried balance. ' +
    'Skipped ' + summary.skippedAlready + ' already billed for this period, ' +
    (summary.skippedNotDue ?? 0) + ' whose bill date has not been reached, ' +
    (summary.skippedBeforeJoined ?? 0) + ' not on the platform when it came round, ' +
    summary.skippedZeroRate + ' with no monthly rate, ' +
    summary.skippedDisconnected + ' disconnected, ' +
    summary.skippedUnprovisioned + ' never provisioned. ' +
    summary.failed + ' failed. Last billed date set to ' + stamp +
    '. No expiry dates, network records or payments were changed. ' +
    'By ' + (profile.first_name ?? profile.email)

  await logEvent({
    customerId: null,
    type: 'bulk_bill',
    details,
    tag: '[bulk]',
  })

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')
}

// ---------------------------------------------------------------------------
// 4. Set all bill dates
// ---------------------------------------------------------------------------

export type BillDatePlan = {
  /** False until migration 0011 is applied; the column does not exist yet. */
  available: boolean
  customerCount: number
  /** The company's configured default bill day, to pre-fill the field. */
  currentDay: number | null
}

export async function loadBillDatePlan(): Promise<BillDatePlan> {
  const { company } = await authorize()
  const [customerCount, settings, caps] = await Promise.all([
    countAllCustomers(company.id),
    getGeneralSettings(company.id),
    getSchemaCapabilities(),
  ])
  return { available: caps.billing, customerCount, currentDay: settings.billDate }
}

export type BillDateResult =
  | { ok: true; updated: number }
  | { ok: false; error: string }

/**
 * Sets `customers.bill_date` for every customer in the company.
 *
 * THAT COLUMN AND NOTHING ELSE. The bill day is when a postpaid customer's bill
 * is generated; it is not their expiry, which lives in radcheck, and it is not
 * their billing type. Nobody goes online or offline because of this, and no
 * balance moves.
 *
 * Applied to every customer, prepaid included, exactly as Set Cut Off Dates is.
 * On a prepaid customer the value is inert — nothing reads bill_date unless
 * billing_type is 'postpaid' — and it means somebody later switched to postpaid
 * already carries the company's day rather than a blank.
 *
 * `confirmCount` is the number the operator was shown and typed back. If the
 * customer count has moved since the modal opened, the run is refused rather
 * than applied to a different set than the one they agreed to.
 */
export async function setAllBillDates(input: {
  day: number
  confirmCount: number
}): Promise<BillDateResult> {
  const { company, profile } = await authorize()

  const caps = await getSchemaCapabilities()
  if (!caps.billing) {
    return {
      ok: false,
      error:
        'The bill date column does not exist on this database yet. Apply migration ' +
        '0011_postpaid_billing.sql first.',
    }
  }

  const day = Math.floor(input.day)
  // The same 1-28 rule the Add Customer form applies: a bill day has to exist
  // in every month, including February.
  if (!Number.isFinite(day) || day < 1 || day > 28) {
    return { ok: false, error: 'The bill day must be a day between 1 and 28.' }
  }

  const customerCount = await countAllCustomers(company.id)
  if (customerCount !== input.confirmCount) {
    return {
      ok: false,
      error:
        'The customer count changed from ' + input.confirmCount + ' to ' + customerCount +
        ' while this was open. Nothing was changed — reopen and confirm the new number.',
    }
  }

  if (customerCount === 0) return { ok: false, error: 'There are no customers to update.' }

  const db = tenantClient()
  const { error, count } = await db
    .from('customers')
    .update({ bill_date: day }, { count: 'exact' })
    .eq('company_id', company.id)

  if (error) return { ok: false, error: 'Could not update bill dates: ' + error.message }

  const updated = count ?? customerCount

  await logEvent({
    customerId: null,
    type: 'bulk_bill_date_set',
    details:
      'Bill day set to ' + day + ' for ' + updated +
      (updated === 1 ? ' customer' : ' customers') +
      ' by ' + (profile.first_name ?? profile.email) +
      '. No balances, expiry dates or billing types were changed.',
    tag: '[bulk]',
  })

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')
  return { ok: true, updated }
}

// ---------------------------------------------------------------------------
// 5. Set access point on the filtered customers
// ---------------------------------------------------------------------------

/**
 * THE ONLY BULK ACTION THAT TAKES THE LIST'S FILTERS. The four above are
 * company-wide by design — a migration or a bill run is everyone. An access
 * point is the opposite: one tower serves a few districts, so the operator
 * filters the list to an address and stamps the tower on what is left.
 *
 * Why it matters: the messaging page's access point filter is only as good as
 * the column behind it, and when this was written one customer on the whole
 * platform had one recorded. An outage is almost always one AP, and without
 * this the choice during one is "text everybody" or "text nobody".
 */

export type AccessPointPlan = {
  /** Migration 0005 not applied: the column cannot be selected or written. */
  supported: boolean
  /** How many customers the filters select right now. */
  matched: number
  /** The whole company, so the modal can say when the two are the same. */
  total: number
  /** Whether any filter is active — an empty set means every customer. */
  filtered: boolean
  /** The filters in words, for the modal and for the log row. */
  audience: string
  /** Matched customers that already carry an access point, which this replaces. */
  alreadySet: number
  /** Every access point in use, for the input's suggestions. */
  existing: string[]
}

async function filterNames(companyId: number): Promise<FilterNames> {
  const caps = await getSchemaCapabilities()
  const [categories, plans] = caps.catalog
    ? await Promise.all([
        listMiscCategories(companyId).catch(() => []),
        listServicePlans(companyId).catch(() => []),
      ])
    : [[], []]
  return {
    status: (s) => STATUS_LABELS[s],
    miscCategory: (id) => categories.find((c) => c.id === id)?.name,
    servicePlan: (id) => plans.find((p) => p.id === id)?.name,
    currency: (n) => CURRENCY_SYMBOL + n.toLocaleString(),
  }
}

export async function loadAccessPointPlan(filters: CustomerFilters): Promise<AccessPointPlan> {
  const { company } = await authorize()

  const caps = await getSchemaCapabilities()
  if (!caps.connectionTypes) {
    return {
      supported: false, matched: 0, total: 0, filtered: hasAnyFilter(filters),
      audience: '', alreadySet: 0, existing: [],
    }
  }

  const [all, names] = await Promise.all([
    loadEnrichedCustomers(company.id), filterNames(company.id),
  ])
  const matched = applyFilters(all, filters)

  return {
    supported: true,
    matched: matched.length,
    total: all.length,
    filtered: hasAnyFilter(filters),
    audience: describeFilters(filters, names),
    alreadySet: matched.filter((c) => (c.access_point ?? '').trim() !== '').length,
    existing: [
      ...new Set(all.map((c) => (c.access_point ?? '').trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b)),
  }
}

export type AccessPointResult =
  | { ok: true; updated: number; accessPoint: string }
  | { ok: false; error: string }

/** customers.access_point is VARCHAR(100) — see migration 0003. */
const ACCESS_POINT_MAX = 100

/**
 * Writes one access point onto every customer the filters select.
 *
 * RECOMPUTES THE SET from the filters, the way sendBulkSms does: the browser
 * never posts a list of ids. `confirmCount` is the number the operator was
 * shown and typed back, and if the filters select a different number now, the
 * run is refused rather than applied to a set they did not agree to.
 *
 * Only `access_point` is written. Nothing about a customer's service, expiry
 * or network state changes.
 */
export async function setAccessPoint(input: {
  filters: CustomerFilters
  accessPoint: string
  confirmCount: number
}): Promise<AccessPointResult> {
  const { company, profile } = await authorize()

  const caps = await getSchemaCapabilities()
  if (!caps.connectionTypes) {
    return { ok: false, error: 'Access points need migration 0005. Ask your administrator.' }
  }

  // Trimmed, because the filter compares trimmed values and a stored
  // "TOWER 3 " would be a tower nobody can select.
  const accessPoint = input.accessPoint.trim()
  if (!accessPoint) return { ok: false, error: 'Enter the access point name.' }
  if (accessPoint.length > ACCESS_POINT_MAX) {
    return { ok: false, error: 'Access point names are at most ' + ACCESS_POINT_MAX + ' characters.' }
  }

  const [all, names] = await Promise.all([
    loadEnrichedCustomers(company.id), filterNames(company.id),
  ])
  const matched = applyFilters(all, input.filters)

  if (matched.length !== input.confirmCount) {
    return {
      ok: false,
      error:
        'The selection changed from ' + input.confirmCount + ' to ' + matched.length +
        ' customers while this was open. Nothing was changed — reopen and confirm the new number.',
    }
  }
  if (matched.length === 0) return { ok: false, error: 'No customers match these filters.' }

  const db = tenantClient()
  const ids = matched.map((c) => c.id)
  let updated = 0

  // Chunked: the id list travels in the request URL, and a company-wide
  // selection is thousands of ids.
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { error, count } = await db
      .from('customers')
      .update({ access_point: accessPoint }, { count: 'exact' })
      .eq('company_id', company.id)
      .in('id', slice)

    if (error) {
      return {
        ok: false,
        error:
          'Could not set the access point: ' + error.message +
          (updated > 0 ? ' — ' + updated + ' of ' + ids.length + ' were updated before it failed.' : ''),
      }
    }
    updated += count ?? slice.length
  }

  const audience = describeFilters(input.filters, names)

  await logEvent({
    customerId: null,
    type: 'bulk_access_point_set',
    details:
      'Access point set to ' + accessPoint + ' for ' + updated +
      (updated === 1 ? ' customer' : ' customers') +
      ' (' + audience + ') by ' + (profile.first_name ?? profile.email),
    tag: '[bulk]',
  })

  revalidatePath('/dashboard/customers')
  // The messaging page builds its access point dropdown from this column.
  revalidatePath('/dashboard/messages')
  return { ok: true, updated, accessPoint }
}
