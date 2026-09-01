'use server'

import { revalidatePath } from 'next/cache'

import { can } from '@/lib/permissions'
import { getGeneralSettings } from '@/lib/data/company'
import { getSchemaCapabilities, type SchemaCapabilities } from '@/lib/schema'
import { getSession, type Session } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import {
  DEFAULT_CUT_OFF_DAY, displayNameOf, isImportable, normaliseKey, resolveRow,
  type RawRow, type ResolveOptions, type ResolvedRow,
} from '@/lib/import/csv'

/**
 * The write half of the CSV importer. The rules it applies live in
 * lib/import/csv.ts and are shared with the wizard, so what gets written is
 * what the operator was shown.
 *
 * The wizard drives these actions in sequence — plans, then batches, then the
 * log row — rather than posting the whole file to one call. That is what makes
 * the progress bar honest: it counts rows the database has actually accepted.
 *
 * NOTHING HERE TOUCHES radcheck. Every imported customer lands unprovisioned
 * and is put on the network afterwards, one at a time, through the existing
 * network actions.
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

function todayYmd() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Step 4 — MACs already in use
// ---------------------------------------------------------------------------

/** Chunk size for the `in` filter; keeps the querystring inside sane limits. */
const LOOKUP_CHUNK = 400

/**
 * Which of these MACs already belong to a customer of this company.
 *
 * Only reports the clash — it does not stop anything. `mac_address` carries no
 * unique constraint, so the duplicate inserts perfectly well; it is flagged so
 * a person decides which of the two devices is real, instead of the import
 * deciding for them.
 */
export async function findExistingMacs(macs: string[]): Promise<string[]> {
  const { company } = await authorize()
  const unique = [...new Set(macs.filter(Boolean))]
  if (unique.length === 0) return []

  const db = tenantClient()
  const found = new Set<string>()

  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK)
    const { data, error } = await db
      .from('customers')
      .select('mac_address')
      .eq('company_id', company.id)
      .in('mac_address', chunk)

    if (error) throw new Error('Could not check existing MAC addresses: ' + error.message)
    for (const row of (data ?? []) as unknown as { mac_address: string | null }[]) {
      if (row.mac_address) found.add(row.mac_address)
    }
  }

  return [...found]
}

// ---------------------------------------------------------------------------
// Step 5a — service plans
// ---------------------------------------------------------------------------

export type NewPlanInput = {
  /** normaliseKey() of the file's plan name — how rows find the new id. */
  key: string
  name: string
  monthlyPrice: number
}

export type PlanResult =
  | { ok: true; ids: Record<string, number>; created: number }
  | { ok: false; error: string }

/**
 * Creates the plans the operator chose to add, before any customer references
 * them.
 *
 * Speeds are written as 0/0 because no import file carries them — the plan is
 * being created for its NAME, so customers can be grouped and billed under a
 * label that already exists in the file. The wizard says so, and the plan
 * reads "0/0 Mbps" in Settings until somebody fills the real speeds in.
 *
 * Inserted one at a time so a name that collides with an existing plan can be
 * resolved to that plan's id rather than failing the whole import. A collision
 * that this got past step 3 means the two names differ by more than case,
 * spaces and punctuation but still hit the unique index.
 */
export async function createImportPlans(plans: NewPlanInput[]): Promise<PlanResult> {
  const { company } = await authorize()

  const ids: Record<string, number> = {}
  if (plans.length === 0) return { ok: true, ids, created: 0 }

  const caps = await getSchemaCapabilities()
  if (!caps.catalog) {
    return {
      ok: false,
      error:
        'Service plans are not set up on this system yet, so no plans can be created. ' +
        'Map the plan column to Ignore, or ask your administrator to enable the catalogue.',
    }
  }

  const db = tenantClient()
  let created = 0

  for (const plan of plans) {
    const { data, error } = await db
      .from('service_plans')
      .insert({
        company_id: company.id,
        name: plan.name,
        speed_down_mbps: 0,
        speed_up_mbps: 0,
        monthly_price: plan.monthlyPrice,
        status: 'active',
      })
      .select('id')
      .maybeSingle()

    if (!error) {
      const id = (data as { id: number } | null)?.id
      if (id) ids[plan.key] = id
      created += 1
      continue
    }

    if (error.code !== '23505') {
      return { ok: false, error: 'Could not create the plan "' + plan.name + '": ' + error.message }
    }

    // Already there under this exact name — adopt it instead of creating one.
    const { data: existing } = await db
      .from('service_plans')
      .select('id')
      .eq('company_id', company.id)
      .eq('name', plan.name)
      .maybeSingle()

    const id = (existing as { id: number } | null)?.id
    if (!id) {
      return {
        ok: false,
        error: 'The plan "' + plan.name + '" already exists but could not be read back.',
      }
    }
    ids[plan.key] = id
  }

  revalidatePath('/dashboard/settings/service-plans')
  return { ok: true, ids, created }
}

// ---------------------------------------------------------------------------
// Step 5b — the customers
// ---------------------------------------------------------------------------

export type ImportBatch = {
  rows: { rowNumber: number; raw: RawRow }[]
  options: ResolveOptions
  /** normalised plan name -> service_plans.id, from step 3 plus createImportPlans. */
  planIds: Record<string, number>
}

export type RowFailure = {
  rowNumber: number
  name: string
  error: string
}

export type BatchResult = {
  inserted: number
  /** Rows the database refused, named individually. Never a silent drop. */
  failures: RowFailure[]
}

/** The company-wide values every imported customer inherits. */
type ImportDefaults = {
  cutOffDate: number | null
  billDate: number | null
  billingType: string
  expiryMode: string
  companyPhone: string | null
}

/**
 * Turns one resolved row into an insert payload.
 *
 * The columns added by later migrations are only sent when the probe says they
 * exist, exactly as createCustomer does — PostgREST rejects the whole statement
 * for one unknown column, which would fail every row in the batch.
 */
function buildPayload(
  row: ResolvedRow,
  companyId: number,
  planIds: Record<string, number>,
  caps: SchemaCapabilities,
  defaults: ImportDefaults
): Record<string, unknown> {
  const today = todayYmd()

  const payload: Record<string, unknown> = {
    company_id: companyId,
    first_name: row.first_name,
    last_name: row.last_name,
    // Falls back to the company's own number so a customer record is reachable
    // by somebody, rather than carrying a blank contact.
    phone: row.phone || defaults.companyPhone || null,
    address: row.address || null,

    // THE KEY IS ALWAYS PRESENT AND EXPLICITLY NULL WHEN THERE IS NO MAC.
    // Omitting it would store the column default, 00:00:00:00:00:00, and hand
    // every one of those customers the same RADIUS username. Do not "simplify"
    // this into a conditional spread.
    mac_address: row.mac,

    // A row whose rate could not be read gets 0, never the plan's price. An
    // obviously wrong number gets noticed and corrected; a plausible one that
    // was never in the file gets billed.
    monthly_rate: row.rate ?? 0,

    balance: 0,

    // Three steps, in order: the day from the file, then the company setting,
    // then the column's own default. resolveRow leaves cutOffDay null both when
    // the column is unmapped and when the cell was blank or unusable, so an
    // unmapped column still gives every customer the company setting exactly as
    // it did before this column existed.
    cut_off_date: row.cutOffDay ?? defaults.cutOffDate ?? DEFAULT_CUT_OFF_DAY,

    last_bill_date: today,
    date_added: today,
  }

  if (caps.connectionTypes) {
    payload.pppoe_username = row.pppoe || null
    // A username in the file is what says this subscriber authenticates by
    // name rather than by MAC; without it the app's default of DHCP stands.
    payload.customer_type = row.pppoe ? 'pppoe' : 'dhcp'
  }

  if (caps.billing) {
    payload.billing_type = defaults.billingType
    payload.bill_date = defaults.billingType === 'postpaid' ? defaults.billDate : null
    payload.carried_balance = 0
    payload.account_credit = 0
  }

  if (caps.catalog) {
    payload.notes = row.notes || null
    payload.service_plan_id = row.plan ? planIds[normaliseKey(row.plan)] ?? null : null
  }

  if (caps.expiryMode) payload.expiry_mode = defaults.expiryMode

  return payload
}

/**
 * Writes one batch of customers.
 *
 * The rows arrive as the raw strings the operator mapped, not as finished
 * values: resolveRow() runs again here so the split, the MAC normalisation and
 * the rate parse are the server's own work. A client that posted a hand-made
 * payload gets the same treatment as the wizard.
 *
 * On a batch failure the whole statement was rejected, so nothing was written.
 * Rather than lose 250 good rows to one bad one, the batch is retried a row at
 * a time and the actual offenders are named by row number.
 */
export async function importCustomerBatch(batch: ImportBatch): Promise<BatchResult> {
  const { company } = await authorize()
  const [caps, settings] = await Promise.all([
    getSchemaCapabilities(),
    getGeneralSettings(company.id),
  ])

  const defaults: ImportDefaults = {
    cutOffDate: settings.cutOffDate,
    billDate: settings.billDate,
    billingType: settings.defaultBillingType,
    expiryMode: settings.defaultExpiryMode,
    companyPhone: settings.phone,
  }

  const failures: RowFailure[] = []
  const prepared: { row: ResolvedRow; payload: Record<string, unknown> }[] = []

  for (const item of batch.rows) {
    const row = resolveRow(item.rowNumber, item.raw, batch.options)

    // The wizard never sends these, but a customer without a name is the one
    // thing this importer must not create under any circumstances.
    if (!isImportable(row)) {
      failures.push({
        rowNumber: row.rowNumber,
        name: displayNameOf(row),
        error: 'No name on the row, so no customer was created.',
      })
      continue
    }

    prepared.push({
      row,
      payload: buildPayload(row, company.id, batch.planIds, caps, defaults),
    })
  }

  if (prepared.length === 0) return { inserted: 0, failures }

  const db = tenantClient()
  const { error } = await db.from('customers').insert(prepared.map((p) => p.payload))
  if (!error) return { inserted: prepared.length, failures }

  let inserted = 0
  for (const { row, payload } of prepared) {
    const { error: rowError } = await db.from('customers').insert(payload)
    if (rowError) {
      failures.push({
        rowNumber: row.rowNumber,
        name: displayNameOf(row),
        error: rowError.message,
      })
    } else {
      inserted += 1
    }
  }

  return { inserted, failures }
}

// ---------------------------------------------------------------------------
// Step 5c — the audit trail
// ---------------------------------------------------------------------------

/**
 * ONE log row for the whole import.
 *
 * Deliberately not one row per customer: three hundred identical entries would
 * bury every other event on the dashboard's activity panel, and the thing worth
 * recording is the import itself — which file, by whom, how much of it landed.
 * Individual customers carry their own `date_added`.
 */
export async function logCustomerImport(summary: {
  fileName: string
  imported: number
  skipped: number
}): Promise<void> {
  const { company, profile } = await authorize()

  const details =
    'Imported ' + summary.imported +
    (summary.imported === 1 ? ' customer' : ' customers') +
    ' from "' + summary.fileName + '", ' + summary.skipped +
    (summary.skipped === 1 ? ' row skipped' : ' rows skipped') +
    ', by ' + (profile.first_name ?? profile.email)

  const { error } = await tenantClient().from('log').insert({
    company_id: company.id,
    user_id: profile.id,
    customer_id: null,
    type: 'customer_import',
    details,
  })

  // The customers are already in. Failing the whole import to keep the audit
  // row tidy would take away the thing the operator actually wanted.
  if (error) {
    console.error('[import] could not write the customer_import log row: %s', error.message)
  }

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')
}
