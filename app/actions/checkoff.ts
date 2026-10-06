'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import {
  getAgentCollections, getAllAgentsSummary, hasPeriod, isMigratedHandover, listAgents,
  parsePeriod, periodLabel, type CheckoffPeriod,
} from '@/lib/data/checkoff'
import { getGeneralSettings } from '@/lib/data/company'
import { instantToDateOnly, instantToTimeOnly, zonedDateTime } from '@/lib/format'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { logEvent } from '@/lib/audit'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

const str = (fd: FormData, key: string) => {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

const num = (fd: FormData, key: string) => {
  const v = str(fd, key)
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const money = (n: number) =>
  'J$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)

function fail(message: string): never {
  redirect('/dashboard/checkoff?toastKind=error&toast=' + encodeURIComponent(message))
}

/**
 * The period a checkoff covers, from the form's hidden fields.
 *
 * Re-parsed here by the same parser the page used, and the payments re-read
 * through it: the action clears what is dated inside the period NOW, not a list
 * the browser sent. A malformed period fails rather than widening to everything.
 */
function periodFrom(formData: FormData): CheckoffPeriod {
  const parsed = parsePeriod(str(formData, 'period_from'), str(formData, 'period_to'))
  if (!parsed.ok) fail(parsed.error)
  return parsed.period
}

/**
 * The handover's notes with its period in front, so Past handovers says which
 * dates a checkoff covered. Left exactly as typed when no period was chosen.
 */
function notesWithPeriod(period: CheckoffPeriod, notes: string): string | null {
  if (!hasPeriod(period)) return notes || null
  const head = 'Period: ' + periodLabel(period)
  return notes ? head + ' · ' + notes : head
}

/**
 * Clears an agent's outstanding collections.
 *
 * The system total is recomputed here rather than trusted from the form: the
 * page may have been open while more payments came in, and the figure written
 * to checkoff_records has to be what was actually cleared. The payment ids are
 * likewise re-read and marked in one statement, so a payment taken mid-checkoff
 * is either fully included or left for the next one.
 */
export async function confirmCheckoff(formData: FormData) {
  const { company, profile } = await getSession()

  if (!can(profile.role, 'view_checkoff')) {
    throw new Error('Forbidden: role "' + profile.role + '" cannot perform checkoff.')
  }

  const caps = await getSchemaCapabilities()
  if (!caps.checkoff) {
    fail('Checkoff is not set up on this system yet. Ask your administrator to enable it.')
  }

  const agentId = num(formData, 'agent_id')
  const amountReceived = num(formData, 'amount_received')
  const notes = str(formData, 'notes')
  const period = periodFrom(formData)

  if (agentId === null) fail('Select an agent first.')
  if (amountReceived === null || amountReceived < 0) {
    fail('Enter the amount received.')
  }

  const settings = await getGeneralSettings(company.id)
  const agents = await listAgents(company.id)
  const agent = agents.find((a) => a.id === agentId)
  if (!agent) fail('That agent is no longer in this company.')

  const summary = await getAgentCollections({
    companyId: company.id,
    userId: agent.id,
    agentName: agent.name,
    timezone: settings.timezone,
    period,
  })

  if (summary.payments.length === 0) {
    fail(
      agent.name + ' has no outstanding payments' +
      (hasPeriod(period) ? ' dated ' + periodLabel(period) : '') + ' to check off.'
    )
  }

  const systemTotal = summary.sinceCheckoffTotal
  const ids = summary.payments.map((p) => p.id)
  const db = tenantClient()

  const { error: markError } = await db
    .from('payments')
    .update({
      checked_off: true,
      checked_off_at: new Date().toISOString(),
      checked_off_by: profile.id,
    })
    .eq('company_id', company.id)
    .in('id', ids)

  if (markError) fail('Could not mark payments as checked off: ' + markError.message)

  const discrepancy = amountReceived - systemTotal

  const { error: recordError } = await db.from('checkoff_records').insert({
    company_id: company.id,
    agent_id: agent.id,
    agent_name: agent.name,
    checked_off_by: profile.id,
    system_total: systemTotal,
    amount_received: amountReceived,
    discrepancy,
    customers_count: summary.sinceCheckoffCustomers,
    is_all_agents: false,
    notes: notesWithPeriod(period, notes),
  })

  if (recordError) {
    // The payments are already cleared, so surface this rather than pretending
    // the checkoff did not happen — the money is reconciled, the receipt is not.
    fail(
      'Payments were cleared but the checkoff record could not be saved: ' +
      recordError.message
    )
  }

  await logEvent({
    type: 'checkoff',
    tag: '[checkoff]',
    details:
      'Checkoff | agent=' + agent.name +
      (hasPeriod(period) ? ' | period=' + periodLabel(period) : '') +
      ' | system_total=' + money(systemTotal) +
      ' | received=' + money(amountReceived) +
      ' | discrepancy=' + money(discrepancy) +
      ' | payments=' + ids.length +
      (summary.outsidePeriod.count > 0
        ? ' | left_outstanding=' + summary.outsidePeriod.count +
          ' (' + money(summary.outsidePeriod.total) + ')'
        : '') +
      ' | by=' + profile.email +
      (notes ? ' | ' + notes : ''),
  })

  revalidatePath('/dashboard/checkoff')
  revalidatePath('/dashboard/payments')
  revalidatePath('/dashboard/payments/new')

  redirect(
    '/dashboard/checkoff?toast=' +
    encodeURIComponent(
      'Checkoff complete for ' + agent.name + '. ' + money(systemTotal) + ' cleared.'
    )
  )
}

/**
 * Clears every agent's outstanding collections in one pass.
 *
 * Writes one checkoff_records row per agent plus a summary row flagged
 * `is_all_agents`, so a per-agent report still reconciles afterwards. The
 * received amount is a single combined figure, so the discrepancy is recorded
 * against the summary row only — splitting it across agents would invent
 * information nobody supplied.
 */
export async function confirmCheckoffAll(formData: FormData) {
  const { company, profile } = await getSession()

  if (!can(profile.role, 'view_checkoff')) {
    throw new Error('Forbidden: role "' + profile.role + '" cannot perform checkoff.')
  }

  const caps = await getSchemaCapabilities()
  if (!caps.checkoff) {
    fail('Checkoff is not set up on this system yet. Ask your administrator to enable it.')
  }

  const amountReceived = num(formData, 'amount_received')
  const notes = str(formData, 'notes')
  const period = periodFrom(formData)
  if (amountReceived === null || amountReceived < 0) fail('Enter the amount received.')

  const settings = await getGeneralSettings(company.id)
  const all = await getAllAgentsSummary({
    companyId: company.id, timezone: settings.timezone, period,
  })

  if (all.rows.length === 0) {
    fail(
      'There are no outstanding payments' +
      (hasPeriod(period) ? ' dated ' + periodLabel(period) : '') + ' to check off.'
    )
  }

  const db = tenantClient()
  const now = new Date().toISOString()
  let cleared = 0

  for (const row of all.rows) {
    const summary = await getAgentCollections({
      companyId: company.id,
      userId: row.agent.id,
      agentName: row.agent.name,
      timezone: settings.timezone,
      period,
    })
    if (summary.payments.length === 0) continue

    const ids = summary.payments.map((p) => p.id)

    const { error: markError } = await db
      .from('payments')
      .update({ checked_off: true, checked_off_at: now, checked_off_by: profile.id })
      .eq('company_id', company.id)
      .in('id', ids)

    if (markError) {
      fail(
        'Stopped part-way: could not clear ' + row.agent.name + "'s payments (" +
        markError.message + '). ' + cleared + ' agent(s) were already checked off.'
      )
    }

    await db.from('checkoff_records').insert({
      company_id: company.id,
      agent_id: row.agent.id,
      agent_name: row.agent.name,
      checked_off_by: profile.id,
      system_total: summary.sinceCheckoffTotal,
      // The manager counted one combined figure, so a per-agent received
      // amount would be fabricated. Recorded on the summary row instead.
      amount_received: null,
      discrepancy: null,
      customers_count: summary.sinceCheckoffCustomers,
      is_all_agents: true,
      notes: notesWithPeriod(period, notes),
    })

    cleared++
  }

  const discrepancy = amountReceived - all.total

  await db.from('checkoff_records').insert({
    company_id: company.id,
    agent_id: null,
    agent_name: 'All agents (' + cleared + ')',
    checked_off_by: profile.id,
    system_total: all.total,
    amount_received: amountReceived,
    discrepancy,
    customers_count: all.customers,
    is_all_agents: true,
    notes: notesWithPeriod(period, notes),
  })

  await logEvent({
    type: 'checkoff',
    tag: '[checkoff]',
    details:
      'Checkoff ALL | agents=' + cleared +
      (hasPeriod(period) ? ' | period=' + periodLabel(period) : '') +
      ' | system_total=' + money(all.total) +
      ' | received=' + money(amountReceived) +
      ' | discrepancy=' + money(discrepancy) +
      ' | by=' + profile.email +
      (notes ? ' | ' + notes : ''),
  })

  revalidatePath('/dashboard/checkoff')
  revalidatePath('/dashboard/payments')
  revalidatePath('/dashboard/payments/new')

  redirect(
    '/dashboard/checkoff?toast=' +
    encodeURIComponent(
      'Checkoff complete for ' + cleared + ' agent(s). ' + money(all.total) + ' cleared.'
    )
  )
}

function failHistory(message: string): never {
  redirect(
    '/dashboard/checkoff?view=history&toastKind=error&toast=' + encodeURIComponent(message)
  )
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** A money field: blank is null, anything else must be a sane non-negative amount. */
function moneyField(fd: FormData, key: string): number | null | 'bad' {
  const raw = str(fd, key)
  if (!raw) return null
  const n = Number(raw)
  // checkoff_records.* are DECIMAL(10,2): 99,999,999.99 is the most one can hold.
  return Number.isFinite(n) && n >= 0 && n <= 99_999_999.99 ? round2(n) : 'bad'
}

/**
 * Restates a recorded handover: when it happened, who it was, and how much.
 *
 * ADMIN ONLY (edit_checkoff). A handover is the record of money moving from a
 * collector to the office, so changing it rewrites that record. Nothing about
 * it is silent: a reason is required, and the log row carries every field that
 * moved, old and new, with the operator's name.
 *
 * WHAT IT CHANGES, AND WHAT IT DOES NOT.
 *   - Changes the `checkoff_records` row only: date and time (read and written
 *     in the COMPANY's zone, not the server's), the agent who handed over, the
 *     person who received it, the amount handed over, and the system total.
 *   - The difference is recomputed from the two amounts, never typed.
 *   - Does NOT touch payments. The payments a handover cleared carry their own
 *     checked_off_at / checked_off_by, because the table records no link from a
 *     handover to its payments, and what is outstanding is decided by
 *     payments.checked_off, not by any date here. So restating a handover moves
 *     nothing on the reconciliation screen.
 *   - Moving a handover's date does move "last handed over" for that agent,
 *     which is read from these rows (lib/data/checkoff.ts#lastHandoverByAgent).
 *
 * LEGACY ROWS keep their system total and difference as stored: the legacy table
 * never recorded either, and the history screen shows them as "—".
 */
export async function adjustHandover(formData: FormData) {
  const { company, profile } = await getSession()

  if (!can(profile.role, 'edit_checkoff')) {
    throw new Error('Forbidden: role "' + profile.role + '" cannot edit a handover.')
  }

  const caps = await getSchemaCapabilities()
  if (!caps.checkoff) failHistory('Checkoff is not set up on this system yet.')

  const id = num(formData, 'id')
  if (id === null) failHistory('That handover could not be found.')

  const reason = str(formData, 'reason')
  if (!reason) failHistory('A reason is required to edit a handover.')
  if (reason.length > 500) failHistory('Keep the reason under 500 characters.')

  const db = tenantClient()
  const { data } = await db
    .from('checkoff_records')
    .select(
      'id, agent_id, agent_name, checked_off_by, system_total, amount_received, ' +
      'discrepancy, is_all_agents, notes, created_at'
    )
    .eq('company_id', company.id)
    .eq('id', id)
    .maybeSingle()

  const row = data as unknown as {
    id: number
    agent_id: number | null
    agent_name: string | null
    checked_off_by: number | null
    system_total: number | string | null
    amount_received: number | string | null
    discrepancy: number | string | null
    is_all_agents: boolean | null
    notes: string | null
    created_at: string
  } | null
  if (!row) failHistory('That handover could not be found.')

  const settings = await getGeneralSettings(company.id)
  const zone = settings.timezone
  const migrated = isMigratedHandover(row.notes)

  const patch: Record<string, unknown> = {}
  const changes: string[] = []

  // --- date and time, in the company's zone ---------------------------------
  const when = zonedDateTime(str(formData, 'date'), str(formData, 'time'), zone)
  if (!when) failHistory('Enter a valid date and time.')
  if (when.getTime() > Date.now() + 5 * 60_000) {
    failHistory('A handover cannot be dated in the future.')
  }
  // Compared to the MINUTE: the form shows hours and minutes only, so an
  // untouched field must not quietly shave the seconds off the stored instant.
  const was = new Date(row.created_at)
  if (Math.floor(when.getTime() / 60_000) !== Math.floor(was.getTime() / 60_000)) {
    patch.created_at = when.toISOString()
    changes.push(
      'date ' + instantToDateOnly(was, zone) + ' ' + instantToTimeOnly(was, zone) +
      ' -> ' + instantToDateOnly(when, zone) + ' ' + instantToTimeOnly(when, zone)
    )
  }

  const agents = await listAgents(company.id)

  // --- who handed it over ---------------------------------------------------
  // Blank = leave as recorded. The all-agents roll-up row is not a person.
  const agentId = num(formData, 'agent_id')
  if (agentId !== null && !row.is_all_agents && agentId !== row.agent_id) {
    const agent = agents.find((a) => a.id === agentId)
    if (!agent) failHistory('That agent is not in this company.')
    patch.agent_id = agent.id
    patch.agent_name = agent.name
    changes.push('agent ' + (row.agent_name ?? 'none') + ' -> ' + agent.name)
  }

  // --- who received it ------------------------------------------------------
  const receivedBy = num(formData, 'received_by')
  if (receivedBy !== null && receivedBy !== row.checked_off_by) {
    const person = agents.find((a) => a.id === receivedBy)
    if (!person) failHistory('That person is not in this company.')
    const before = agents.find((a) => a.id === row.checked_off_by)?.name ?? 'none'
    patch.checked_off_by = person.id
    changes.push('received_by ' + before + ' -> ' + person.name)
  }

  // --- amounts --------------------------------------------------------------
  const amountIn = moneyField(formData, 'amount_received')
  if (amountIn === 'bad') failHistory('Enter the amount handed over as zero or more.')
  const amountWas = row.amount_received === null ? null : Number(row.amount_received)
  if (amountWas !== null && amountIn === null) {
    failHistory('A recorded amount cannot be blank. Enter the amount handed over.')
  }
  const amountNow = amountIn ?? amountWas

  const systemIn = migrated ? null : moneyField(formData, 'system_total')
  if (systemIn === 'bad') failHistory('Enter the system total as zero or more.')
  const systemWas = Number(row.system_total ?? 0)
  const systemNow = systemIn ?? systemWas

  if (amountNow !== amountWas) {
    patch.amount_received = amountNow
    changes.push('amount_received ' + money(amountWas ?? 0) + ' -> ' + money(amountNow ?? 0))
  }
  if (systemNow !== systemWas) {
    patch.system_total = systemNow
    changes.push('system_total ' + money(systemWas) + ' -> ' + money(systemNow))
  }

  // Recomputed, never typed. Left as stored for a legacy row and for one with no
  // amount of its own (the per-agent rows of an all-agents checkoff).
  if (!migrated && amountNow !== null && (amountNow !== amountWas || systemNow !== systemWas)) {
    const next = round2(amountNow - systemNow)
    const prev = row.discrepancy === null ? null : Number(row.discrepancy)
    if (next !== prev) {
      patch.discrepancy = next
      changes.push('discrepancy ' + (prev === null ? 'none' : money(prev)) + ' -> ' + money(next))
    }
  }

  if (changes.length === 0) failHistory('Nothing was changed.')

  const { error } = await db
    .from('checkoff_records')
    .update(patch)
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) failHistory('Could not save the handover: ' + error.message)

  // AFTER the update, like every audit row here: the correction is what the
  // admin asked for and a failed log write must not undo it. logEvent never throws.
  await logEvent({
    type: 'checkoff_adjusted',
    tag: '[checkoff]',
    details:
      'Handover #' + id + ' adjusted | ' + changes.join(' | ') +
      ' | by=' + profile.email +
      ' | reason=' + reason,
  })

  revalidatePath('/dashboard/checkoff')

  redirect(
    '/dashboard/checkoff?view=history&toast=' +
    encodeURIComponent('Handover #' + id + ' updated.')
  )
}
