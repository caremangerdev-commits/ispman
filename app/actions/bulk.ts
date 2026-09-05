'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { can } from '@/lib/permissions'
import { getSession, type Session } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { getGeneralSettings } from '@/lib/data/company'
import {
  bulkCustomerName, countAllCustomers, findProvisioned, getProvisionPlan,
  readCustomersByIds, readBillableByIds, readBillableCustomers,
  type BillableCustomer,
} from '@/lib/data/bulk'
import { getSchemaCapabilities } from '@/lib/schema'
import { formatCurrency } from '@/lib/format'
import { activateInRadius, batchGetRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { usernameKey } from '@/lib/radius/format'
import { formatRadiusExpiration, radiusIdentity } from '@/lib/radius/format'
import { applyCredit } from '@/lib/billing'
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

/** Was this customer already billed FOR the chosen period? */
function billedInPeriod(lastBilledDate: string | null, period: BillPeriod): boolean {
  return lastBilledDate !== null && lastBilledDate >= period.start && lastBilledDate <= period.end
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

export type BillAllPlan = {
  /** False until migration 0011 is applied; the modal refuses to run. */
  available: boolean
  period: BillPeriod
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
 */
export async function loadBillAllPlan(periodKey: string): Promise<BillAllPlan> {
  const { company } = await authorize()

  const period = resolvePeriod(periodKey)
  if (!period) throw new Error('"' + periodKey + '" is not a valid billing period.')

  const caps = await getSchemaCapabilities()
  if (!caps.billing) {
    return {
      available: false,
      period,
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

  const customers = await readBillableCustomers(company.id)
  const service = await serviceStateFor(customers)

  let alreadyBilled = 0
  let zeroRate = 0
  let disconnected = 0
  let unprovisioned = 0
  let creditApplied = 0
  const targets: BillTarget[] = []

  for (const customer of customers) {
    const state = service.get(customer.id)

    if (billedInPeriod(customer.lastBilledDate, period)) {
      alreadyBilled++
    } else if (customer.monthlyRate <= 0) {
      zeroRate++
    } else if (state === 'disconnected') {
      // Tested before the rate so an operator sees "disconnected" rather than
      // a zero-rate skip for someone who is both.
      disconnected++
    } else if (state === 'unprovisioned') {
      unprovisioned++
    } else {
      targets.push({ id: customer.id, name: customer.name, amount: customer.monthlyRate })
      // Preview only. billBatch recomputes this from the row it is about to
      // write, so a credit spent between the preview and the run cannot be
      // spent twice.
      creditApplied += applyCredit(
        customer.accountCredit, customer.carriedBalance, customer.monthlyRate
      ).drawn
    }
  }

  return {
    available: true,
    period,
    customerCount: customers.length,
    alreadyBilled,
    zeroRate,
    disconnected,
    unprovisioned,
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
    | 'skipped_zero_rate'
    | 'skipped_disconnected'
    | 'skipped_unprovisioned'
    | 'failed'
  /** Added to carried_balance. Populated for `billed`. */
  amount?: number
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
 * and is skipped. `bill_date` plays no part in any of this — the period comes
 * from the operator, and a customer with no bill day recorded bills exactly like
 * one who has it. See serviceStateFor.
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
 * Sequential, one customer per statement. PostgREST cannot add a column to
 * itself, so each new balance is computed here from the row it was read from —
 * which is also what lets the guard and the arithmetic stay in agreement.
 */
export async function billBatch(input: {
  period: string
  ids: number[]
}): Promise<{ outcomes: BillOutcome[] }> {
  const { company } = await authorize()

  const period = resolvePeriod(input.period)
  if (!period) throw new Error('"' + input.period + '" is not a valid billing period.')

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

    if (billedInPeriod(customer.lastBilledDate, period)) {
      outcomes.push({ id, name: customer.name, result: 'skipped_already' })
      continue
    }

    // Skipped outright rather than billed for nothing: leaving last_billed_date
    // alone means a rate corrected later can still be billed for this period.
    if (customer.monthlyRate <= 0) {
      outcomes.push({ id, name: customer.name, result: 'skipped_zero_rate' })
      continue
    }

    // No service, no bill. last_billed_date is deliberately NOT stamped for
    // these, exactly as for a zero rate: the period stays open, so a customer
    // reconnected later can still be billed for it if that is the right call.
    const state = service.get(id)
    if (state === 'disconnected') {
      outcomes.push({ id, name: customer.name, result: 'skipped_disconnected' })
      continue
    }
    if (state === 'unprovisioned') {
      outcomes.push({ id, name: customer.name, result: 'skipped_unprovisioned' })
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
      const { error, count } = await db
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
        .or(unbilled)

      if (error) throw new Error(error.message)

      // Zero rows matched: something billed this customer for this period
      // between the read above and the write. Not an error — the charge landed
      // exactly once, which is the whole point.
      if ((count ?? 0) === 0) {
        outcomes.push({ id, name: customer.name, result: 'skipped_already' })
        continue
      }

      outcomes.push({ id, name: customer.name, result: 'billed', amount: customer.monthlyRate })
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
}): Promise<void> {
  const { profile } = await authorize()

  const period = resolvePeriod(summary.period)
  const label = period ? period.label : summary.period
  const stamp = period ? period.end : 'the end of the period'

  const details =
    'Bulk bill for ' + label + ': ' + summary.billed +
    (summary.billed === 1 ? ' customer' : ' customers') +
    ' billed ' + formatCurrency(summary.totalAmount) + ' in total, added to carried balance. ' +
    'Skipped ' + summary.skippedAlready + ' already billed for this period, ' +
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
