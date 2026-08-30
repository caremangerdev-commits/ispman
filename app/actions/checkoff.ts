'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import {
  getAgentCollections, getAllAgentsSummary, listAgents,
} from '@/lib/data/checkoff'
import { getGeneralSettings } from '@/lib/data/company'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
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
  })

  if (summary.payments.length === 0) {
    fail(agent.name + ' has no outstanding payments to check off.')
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
    notes: notes || null,
  })

  if (recordError) {
    // The payments are already cleared, so surface this rather than pretending
    // the checkoff did not happen — the money is reconciled, the receipt is not.
    fail(
      'Payments were cleared but the checkoff record could not be saved: ' +
      recordError.message
    )
  }

  await db.from('log').insert({
    company_id: company.id,
    user_id: profile.id,
    type: 'checkoff',
    details:
      'Checkoff | agent=' + agent.name +
      ' | system_total=' + money(systemTotal) +
      ' | received=' + money(amountReceived) +
      ' | discrepancy=' + money(discrepancy) +
      ' | payments=' + ids.length +
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
  if (amountReceived === null || amountReceived < 0) fail('Enter the amount received.')

  const settings = await getGeneralSettings(company.id)
  const all = await getAllAgentsSummary({ companyId: company.id, timezone: settings.timezone })

  if (all.rows.length === 0) fail('There are no outstanding payments to check off.')

  const db = tenantClient()
  const now = new Date().toISOString()
  let cleared = 0

  for (const row of all.rows) {
    const summary = await getAgentCollections({
      companyId: company.id,
      userId: row.agent.id,
      agentName: row.agent.name,
      timezone: settings.timezone,
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
      notes: notes || null,
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
    notes: notes || null,
  })

  await db.from('log').insert({
    company_id: company.id,
    user_id: profile.id,
    type: 'checkoff',
    details:
      'Checkoff ALL | agents=' + cleared +
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
