import 'server-only'

import { logSystemEvent, type SystemActor } from '@/lib/audit'
import { addonTotals } from '@/lib/data/addon-totals'
import { readBillableCustomers } from '@/lib/data/bulk'
import { chargesConnectionMonth, readConnectedOn } from '@/lib/data/prepaid-calendar'
import { readServiceBreaks } from '@/lib/data/service-breaks'
import { formatCurrencyExact } from '@/lib/format'
import { addMonths, monthLabel, monthOf } from '@/lib/prepaid-calendar'
import { postpaidMonthCharge } from '@/lib/service-days'
import { fetchAllRows } from '@/lib/supabase/paging'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * POSTPAID: THE MONTH JUST ENDED, SETTLED ON THE NEXT BILL DAY (owner, 11 Oct
 * 2026 — "changes after the bill day settle on the next bill day, with
 * overpayment coming back as credit").
 *
 * A month is billed on its bill day while it is still running, priced from
 * the days so far plus the rest of the month. What happens after — a customer
 * reconnecting, a staff disconnection, a customer connected after the bill day
 * with the connection month on — is settled here, on the next bill day, once
 * the month has ended and its days are known: the month is priced again
 * (lib/service-days.ts#postpaidMonthCharge, the same pricing the bill day
 * used) and any difference goes through set_month_charge() (0028) — guarded
 * by the amount read; a cut below what was paid comes back as credit.
 *
 * ONCE PER MONTH: a `month_settle_run` row marks it done. Never for a month
 * before the engine's start month, nor one the engine wrote no charges for:
 * those were billed by Run Bills in full. Nothing else ever reduces a billed
 * month.
 */
export async function settlePreviousMonth(
  company: { id: number; name: string; timezone: string; startDate: string | null },
  today: string,
  actor: SystemActor
): Promise<{ checked: number; changed: number; failed: number } | null> {
  const prev = monthOf(addMonths(today, -1))
  if (!company.startDate || prev.end < company.startDate) return null

  const db = tenantClient()
  const marker = 'Settled ' + prev.key
  const { data: done } = await db.from('log').select('id').eq('company_id', company.id)
    .eq('type', 'month_settle_run').like('details', marker + '%').limit(1)
  if (done && done.length) return null

  const rows = await fetchAllRows(
    (from, to) => db.from('bill_charges').select('customer_id, amount, service_days')
      .eq('company_id', company.id).eq('period_start', prev.start).order('id').range(from, to),
    'month charges'
  ) as { customer_id: number; amount: number | string; service_days: number | null }[]
  // NOT A MONTH THE ENGINE BILLED: Run Bills writes no bill_charges rows, so a
  // month with none was billed by hand, in full, or not at all. Settling it
  // would charge every customer the whole month again. The start date alone
  // does not guard this — a start date set ahead of a mode left off (Vernon's
  // was 25 Sep while its September went through Run Bills) would let it in.
  if (rows.length === 0) return null
  const rowOf = new Map(rows.map((r) => [r.customer_id, r]))

  const customers = await readBillableCustomers(company.id)
  const addons = await addonTotals(customers.map((c) => c.id))
  const connectedOn = await readConnectedOn(company.id)
  const chargeConnectionMonth = await chargesConnectionMonth(company.id)
  const breaks = await readServiceBreaks({ companyId: company.id, timezone: company.timezone, today, customers })

  let checked = 0
  let changed = 0
  let failed = 0
  for (const c of customers) {
    const b = breaks.get(c.id)
    if (!b) continue // not in the registry: nothing known about their days
    const monthlyCharge = c.monthlyRate + (addons.get(c.id) ?? 0)
    if (monthlyCharge <= 0) continue
    checked += 1

    const target = postpaidMonthCharge({
      monthStart: prev.start,
      monthlyCharge,
      breaks: b,
      joinedOn: (connectedOn.get(c.id) ?? c.dateAdded ?? null)?.slice(0, 10) ?? null,
      chargeConnectionMonth,
    })
    const row = rowOf.get(c.id)
    const before = row ? Number(row.amount) : null
    if (before === target.amount || (before === null && target.amount === 0)) continue

    const { data, error } = await db.rpc('set_month_charge', {
      p_company_id: company.id, p_customer_id: c.id,
      p_period_start: prev.start, p_period_end: prev.end, p_charged_on: today,
      p_amount: target.amount, p_service_days: target.serviceDays, p_full_amount: target.fullAmount,
      p_source: 'engine', p_expected_amount: before, p_touch_service: false, p_service_ended_on: null,
    })
    const result = data as { ok: boolean; reason?: string; carried_before?: number; carried_after?: number; credit_before?: number; credit_after?: number } | null
    if (error || !result?.ok) {
      failed += 1
      console.error('[settle] %s #%d: %s', company.name, c.id, error?.message ?? result?.reason)
      continue
    }
    changed += 1
    const days = (n: number | null) => (n === null ? 'full month' : n + (n === 1 ? ' day' : ' days'))
    await logSystemEvent({
      companyId: company.id, process: 'billing', actor, customerId: c.id,
      type: 'month_settled', tag: '[billing]',
      details:
        monthLabel(prev.start) + ' settled on the next bill day: ' +
        (before === null ? 'not billed' : formatCurrencyExact(before) + ' (' + days(row?.service_days ?? null) + ')') +
        ' -> ' + formatCurrencyExact(target.amount) + ' (' + days(target.serviceDays) + ')' +
        ' | balance ' + formatCurrencyExact(result.carried_before ?? 0) + ' -> ' + formatCurrencyExact(result.carried_after ?? 0) +
        ((result.credit_after ?? 0) !== (result.credit_before ?? 0)
          ? ' | credit ' + formatCurrencyExact(result.credit_before ?? 0) + ' -> ' + formatCurrencyExact(result.credit_after ?? 0)
          : ''),
    })
  }

  await logSystemEvent({
    companyId: company.id, process: 'billing', actor, type: 'month_settle_run', tag: '[billing]',
    details: marker + ' on ' + today + ': ' + checked + ' customers checked, ' + changed + ' changed' +
      (failed ? ', ' + failed + ' FAILED (left as billed; the next run does not retry)' : '') + '.',
  })
  return { checked, changed, failed }
}
