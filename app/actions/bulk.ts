'use server'

import { revalidatePath } from 'next/cache'

import { can } from '@/lib/permissions'
import { getSession, type Session } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { getGeneralSettings } from '@/lib/data/company'
import {
  bulkCustomerName, countAllCustomers, findProvisioned, getProvisionPlan,
  readCustomersByIds,
} from '@/lib/data/bulk'
import { activateInRadius, radiusConfigured } from '@/lib/radius-db'
import { formatRadiusExpiration, radiusIdentity } from '@/lib/radius/format'
import { addMonths, nextCutOff } from '@/lib/expiry'

/**
 * The two company-wide bulk actions on the customer list.
 *
 * Both are gated on `import_customers` — the same right that lets someone load
 * a spreadsheet of strangers into the database. Neither is reachable by a CSR.
 *
 * Each run writes exactly ONE log row, at the end, from the action that
 * finishes it. Three hundred rows would bury every other event on the
 * dashboard's activity panel and tell nobody anything the summary does not.
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

  const { error: logError } = await db.from('log').insert({
    company_id: company.id,
    user_id: profile.id,
    customer_id: null,
    type: 'bulk_cut_off_set',
    details:
      'Cut off day set to ' + day + ' for ' + updated +
      (updated === 1 ? ' customer' : ' customers') +
      ' by ' + (profile.first_name ?? profile.email) +
      '. Expiry dates were not changed.',
  })

  // The column is already updated. Failing the whole action to keep the audit
  // row tidy would undo nothing and help nobody.
  if (logError) {
    console.error('[bulk] could not write the bulk_cut_off_set log row: %s', logError.message)
  }

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')
  return { ok: true, updated }
}

// ---------------------------------------------------------------------------
// 2. Provision all
// ---------------------------------------------------------------------------

export type ProvisionTarget = { id: number; name: string }

export type ProvisionPlanResult = {
  ready: ProvisionTarget[]
  noIdentity: ProvisionTarget[]
  alreadyProvisioned: ProvisionTarget[]
  /** `YYYY-MM-DD`, the next cut-off day after today. */
  defaultExpiry: string
  /** False when the RADIUS env vars are absent; the action refuses to run. */
  configured: boolean
}

/**
 * What a bulk provision would do, without doing any of it.
 *
 * The suggested expiry is the plain next occurrence of the company's cut-off
 * day. THE 21-DAY RULE IS NOT APPLIED and provisionExpiry() is deliberately not
 * called: that rule exists so a new customer activating four days before their
 * cut-off does not buy a month and get a week of it. These customers already
 * have service — this is a migration into the registry, not a set of first
 * activations, and pushing them all a month and a half out would move every one
 * of them off their cut-off day.
 */
export async function loadProvisionPlan(): Promise<ProvisionPlanResult> {
  const { company } = await authorize()

  const settings = await getGeneralSettings(company.id)
  const today = new Date()
  const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const defaultExpiry = nextCutOff(anchor, settings.cutOffDate) ?? addMonths(anchor, 1)

  if (!radiusConfigured()) {
    return {
      ready: [],
      noIdentity: [],
      alreadyProvisioned: [],
      defaultExpiry: ymd(defaultExpiry),
      configured: false,
    }
  }

  const plan = await getProvisionPlan(company.id)

  return {
    // The identity stays on the server: the client posts ids, and the identity
    // that gets written is derived from the row again in provisionBatch.
    ready: plan.ready.map((c) => ({ id: c.id, name: c.name })),
    noIdentity: plan.noIdentity,
    alreadyProvisioned: plan.alreadyProvisioned,
    defaultExpiry: ymd(defaultExpiry),
    configured: true,
  }
}

export type ProvisionOutcome = {
  id: number
  name: string
  result: 'provisioned' | 'skipped_no_identity' | 'skipped_already' | 'failed'
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
  /** `YYYY-MM-DD`. Applied to every customer in the batch. */
  expiry: string
}): Promise<{ outcomes: ProvisionOutcome[] }> {
  const { company } = await authorize()

  if (input.ids.length > MAX_BATCH) {
    throw new Error('Too many customers in one batch: ' + input.ids.length + ' (max ' + MAX_BATCH + ').')
  }

  const expiryDate = parseDay(input.expiry)
  if (!expiryDate) throw new Error('"' + input.expiry + '" is not a valid expiry date.')

  // Refuse rather than report every customer as "skipped": a run that wrote
  // nothing because the NAS was not configured must not read as a success.
  if (!radiusConfigured()) {
    throw new Error(
      'The RADIUS database is not configured, so nothing can be provisioned. ' +
      'Set RADIUS_DB_HOST, RADIUS_DB_USER, RADIUS_DB_PASSWORD and RADIUS_DB_NAME.'
    )
  }

  const expiryValue = formatRadiusExpiration(expiryDate)
  const customers = await readCustomersByIds(company.id, input.ids)
  const byId = new Map(customers.map((c) => [c.id, c]))

  const targets: { id: number; name: string; identity: string | null }[] = input.ids.map((id) => {
    const customer = byId.get(id)
    if (!customer) {
      return { id, name: 'Customer #' + id, identity: null }
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

    if (provisioned.has(target.identity.toUpperCase()) || provisioned.has(target.identity)) {
      outcomes.push({ id: target.id, name: target.name, result: 'skipped_already' })
      continue
    }

    try {
      // The existing write: both radcheck rows with op ':=', inside a
      // transaction, clearing any prior rows first. Not extendInRadius, which
      // only ever touches Expiration and would leave these customers without
      // an Auth-Type := Accept row.
      await activateInRadius(target.identity, expiryValue)
      outcomes.push({ id: target.id, name: target.name, result: 'provisioned' })
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

/** ONE log row for the whole run, written once the last batch has returned. */
export async function logBulkProvision(summary: {
  provisioned: number
  skippedNoIdentity: number
  skippedAlready: number
  failed: number
  expiry: string
}): Promise<void> {
  const { company, profile } = await authorize()

  const details =
    'Bulk provision: ' + summary.provisioned +
    (summary.provisioned === 1 ? ' customer' : ' customers') +
    ' provisioned to expire ' + summary.expiry +
    '. Skipped ' + summary.skippedNoIdentity + ' with no MAC address, ' +
    summary.skippedAlready + ' already provisioned. ' +
    summary.failed + ' failed. By ' + (profile.first_name ?? profile.email)

  const { error } = await tenantClient().from('log').insert({
    company_id: company.id,
    user_id: profile.id,
    customer_id: null,
    type: 'bulk_provision',
    details,
  })

  if (error) {
    console.error('[bulk] could not write the bulk_provision log row: %s', error.message)
  }

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')
}
