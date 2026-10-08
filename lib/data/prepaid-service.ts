import 'server-only'

import { logSystemEvent, type SystemActor } from '@/lib/audit'
import { addonTotals } from '@/lib/data/addon-totals'
import { readBillableCustomers } from '@/lib/data/bulk'
import { formatCurrencyExact, instantToDateOnly, localDateOnly } from '@/lib/format'
import {
  daysAfterServiceEnds, daysAfterServiceResumes, daysInMonth, monthFigure, monthLabel, monthOf,
  round100, ymdParts,
} from '@/lib/prepaid-calendar'
import { batchGetRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { usernameKey } from '@/lib/radius/format'
import { fetchAllRows } from '@/lib/supabase/paging'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The calendar-month prepaid SERVICE PASS: runs every hourly tick for a company
 * with the model on (migration 0028), after the day's billing run.
 *
 * Two things, both read off radcheck:
 *
 *   SERVICE ENDED. A customer whose access has expired — their cut-off passed,
 *   or staff disconnected them — and who is not yet marked. Their month's
 *   charge is reduced to the days they actually had (the day it ended counts),
 *   and they are marked (customers.service_ended_on). Once marked, nothing more
 *   is charged while they stay off: the billing run skips anyone without
 *   service. Their balance then reads what they would actually be asked for.
 *
 *   SERVICE RESUMED, NOT BY THE TILL. A marked customer whose access is back
 *   — Extend Access, Reconnect, or a write from outside this app. Extended days
 *   are service days (owner, 8 Oct 2026): the current month is charged from the
 *   day service came back to its end, and the mark is cleared. The till clears
 *   the mark itself when it takes a payment, so it is never counted twice.
 *
 * Every change goes through set_month_charge() (migration 0028): locked,
 * guarded by the amount read, the balance moved in the same transaction. One
 * log row per customer changed.
 *
 * NEVER GUESSES. If radcheck cannot be read the pass does nothing and says so;
 * the next hour tries again.
 */

export type ServiceChange = {
  customerId: number
  name: string
  kind: 'ended' | 'resumed'
  /** The day service ended (counted) or came back (counted). */
  on: string
  /** The month whose charge changes; null when there is no charge to change. */
  periodStart: string | null
  periodEnd: string | null
  from: { amount: number; days: number | null } | null
  to: { amount: number; days: number } | null
  fullAmount: number
}

export type ServicePlan = {
  today: string
  changes: ServiceChange[]
}

type ChargeRow = {
  customer_id: number
  period_start: string
  period_end: string
  amount: number | string
  service_days: number | null
}

/** What the pass would do now. Reads only. Throws if radcheck cannot be read. */
export async function planServicePass(company: { id: number; timezone: string }): Promise<ServicePlan> {
  const today = instantToDateOnly(new Date(), company.timezone)

  if (!radiusConfigured()) throw new Error('The network registry is not configured.')

  const customers = await readBillableCustomers(company.id)
  const db = tenantClient()

  const markRows = await fetchAllRows(
    (from, to) => db.from('customers').select('id, service_ended_on')
      .eq('company_id', company.id).order('id').range(from, to),
    'service marks'
  )
  const ended = new Map((markRows as { id: number; service_ended_on: string | null }[])
    .map((r) => [r.id, r.service_ended_on]))

  const addons = await addonTotals(customers.map((c) => c.id))

  let registry
  try {
    registry = await batchGetRadiusStatus(customers.map((c) => c.identity))
  } catch (err) {
    throw new Error('The network registry could not be read: ' + (err as Error).message)
  }

  // Charges from three months back cover any service end the pass can meet.
  const [ty, tm] = ymdParts(today)
  const back = new Date(ty, tm - 1 - 3, 1)
  const since = back.getFullYear() + '-' + String(back.getMonth() + 1).padStart(2, '0') + '-01'
  const chargeRows = await fetchAllRows(
    (from, to) => db.from('bill_charges')
      .select('customer_id, period_start, period_end, amount, service_days')
      .eq('company_id', company.id).gte('period_start', since).order('id').range(from, to),
    'month charges'
  ) as ChargeRow[]
  const chargeOf = new Map(chargeRows.map((r) => [r.customer_id + '|' + r.period_start, r]))

  const changes: ServiceChange[] = []
  for (const c of customers) {
    if (!c.identity) continue
    const record = registry.get(usernameKey(c.identity))
    if (!record || !record.exists) continue

    const monthlyCharge = c.monthlyRate + (addons.get(c.id) ?? 0)
    const on = record.status === 'active'
    const mark = ended.get(c.id) ?? null

    if (!on && mark === null) {
      if (!record.expiry) continue
      // The day written in radcheck: "08 Oct 2026 13:00" is the 8th; a staff
      // disconnect stamped "06 Oct 2026 18:06" is the 6th.
      let endedOn = localDateOnly(record.expiry)
      if (endedOn > today) endedOn = today
      const month = monthOf(endedOn)
      const row = chargeOf.get(c.id + '|' + month.start)
      if (row) {
        const days = daysAfterServiceEnds(row.service_days, endedOn)
        changes.push({
          customerId: c.id, name: c.name, kind: 'ended', on: endedOn,
          periodStart: row.period_start, periodEnd: row.period_end,
          from: { amount: Number(row.amount), days: row.service_days },
          to: { amount: monthFigure(monthlyCharge, days, month.days), days },
          fullAmount: round100(monthlyCharge),
        })
      } else {
        changes.push({
          customerId: c.id, name: c.name, kind: 'ended', on: endedOn,
          periodStart: null, periodEnd: null, from: null, to: null, fullAmount: round100(monthlyCharge),
        })
      }
      continue
    }

    if (on && mark !== null) {
      const month = monthOf(today)
      const row = chargeOf.get(c.id + '|' + month.start)
      const days = daysAfterServiceResumes(row ? row.service_days : 'none', today)
      const [y, m] = ymdParts(today)
      changes.push({
        customerId: c.id, name: c.name, kind: 'resumed', on: today,
        periodStart: month.start, periodEnd: month.end,
        from: row ? { amount: Number(row.amount), days: row.service_days } : null,
        to: monthlyCharge > 0 ? { amount: monthFigure(monthlyCharge, days, daysInMonth(y, m)), days } : null,
        fullAmount: round100(monthlyCharge),
      })
    }
  }

  return { today, changes }
}

/** Applies the plan. Live companies only; the tick decides that. */
export async function runServicePass(
  company: { id: number; timezone: string },
  actor: SystemActor
): Promise<{ ended: number; resumed: number; failed: number }> {
  const plan = await planServicePass(company)
  const db = tenantClient()
  let ended = 0
  let resumed = 0
  let failed = 0

  for (const ch of plan.changes) {
    const describe = (amount: number, days: number | null, periodStart: string) => {
      const [y, m] = ymdParts(periodStart)
      return formatCurrencyExact(amount) + ' (' + (days === null || days >= daysInMonth(y, m) ? 'whole month' : days + ' day' + (days === 1 ? '' : 's')) + ')'
    }

    // A mark with no charge to change: set it, guarded so a second tick does nothing.
    if (!ch.to || !ch.periodStart || !ch.periodEnd) {
      const base = db.from('customers')
        .update({ service_ended_on: ch.kind === 'ended' ? ch.on : null })
        .eq('id', ch.customerId).eq('company_id', company.id)
      const { error } = ch.kind === 'ended'
        ? await base.is('service_ended_on', null)
        : await base.not('service_ended_on', 'is', null)
      if (error) { failed++; console.error('[service] #%d: %s', ch.customerId, error.message); continue }
      if (ch.kind === 'ended') ended++
      else resumed++
      await logSystemEvent({
        companyId: company.id, customerId: ch.customerId, process: 'billing', actor,
        type: ch.kind === 'ended' ? 'service_ended' : 'service_resumed', tag: '[service]',
        details: (ch.kind === 'ended' ? 'Service ended ' : 'Service resumed ') + ch.on +
          '. No month charge to change.',
      })
      continue
    }

    const { data, error } = await db.rpc('set_month_charge', {
      p_company_id: company.id,
      p_customer_id: ch.customerId,
      p_period_start: ch.periodStart,
      p_period_end: ch.periodEnd,
      p_charged_on: plan.today,
      p_amount: ch.to.amount,
      p_service_days: ch.to.days,
      p_full_amount: ch.fullAmount,
      p_source: 'service',
      p_expected_amount: ch.from ? ch.from.amount : null,
      p_touch_service: true,
      p_service_ended_on: ch.kind === 'ended' ? ch.on : null,
    })
    const result = data as { ok: boolean; reason?: string; carried_before?: number; carried_after?: number; credit_after?: number; credit_before?: number } | null
    if (error || !result?.ok) {
      failed++
      console.error('[service] #%d %s: %s', ch.customerId, ch.kind, error?.message ?? result?.reason)
      continue
    }
    if (ch.kind === 'ended') ended++
    else resumed++

    const creditMoved = Number(result.credit_after ?? 0) !== Number(result.credit_before ?? 0)
    await logSystemEvent({
      companyId: company.id, customerId: ch.customerId, process: 'billing', actor,
      type: ch.kind === 'ended' ? 'service_ended' : 'service_resumed', tag: '[service]',
      details:
        (ch.kind === 'ended' ? 'Service ended ' : 'Service resumed ') + ch.on + '. ' +
        monthLabel(ch.periodStart) + ' ' +
        (ch.from ? describe(ch.from.amount, ch.from.days, ch.periodStart) + ' -> ' : 'charged ') +
        describe(ch.to.amount, ch.to.days, ch.periodStart) +
        ' | balance ' + formatCurrencyExact(result.carried_before ?? 0) + ' -> ' + formatCurrencyExact(result.carried_after ?? 0) +
        (creditMoved ? ' | credit ' + formatCurrencyExact(result.credit_before ?? 0) + ' -> ' + formatCurrencyExact(result.credit_after ?? 0) : '') +
        ' | days disconnected are free; days with service are charged',
    })
  }

  return { ended, resumed, failed }
}
