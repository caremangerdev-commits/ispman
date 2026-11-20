import 'server-only'

import { instantToDateOnly } from '@/lib/format'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * What a customer has used, for their record.
 *
 * READS usage_daily AND NOTHING ELSE. The figure that used to sit here came
 * from radacct and was always zero, because MikroTik's DHCP accounting carries
 * no octets (see migration 0053 for the measurements). This reads what the
 * poller wrote, which is the only real measurement available on this network.
 *
 * DAYS WITH NO ROW ARE ZERO, NOT MISSING. A customer who was offline on
 * Tuesday has no Tuesday row, and a graph that skipped it would put Monday
 * next to Wednesday and quietly compress the week. The series is built over a
 * fixed run of dates and filled in.
 */

export type UsageDay = { day: string; rx: number; tx: number }

export type CustomerUsage = {
  /** Month to date, in the company's own dates. */
  monthRx: number
  monthTx: number
  /** Oldest first, one entry per day, always `days` long. */
  series: UsageDay[]
  /** The newest day that has any figure at all, or null if nothing ever has. */
  lastDay: string | null
  /** True when the poller has never recorded anything for this customer. */
  empty: boolean
}

/** Walks back from `end` for `count` days, oldest first, as YYYY-MM-DD. */
function dateRun(end: string, count: number): string[] {
  const out: string[] = []
  // Noon avoids the daylight-saving hour: stepping by exact days from midnight
  // can land on the same date twice, or skip one, in a zone that shifts.
  const cursor = new Date(end + 'T12:00:00Z')
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(cursor)
    d.setUTCDate(d.getUTCDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/**
 * The company's own timezone, which decides what "today" and "this month"
 * mean here — the same source and the same fallback lib/data/bill.ts uses, so
 * a day's usage and a day's bill agree about which day it was.
 */
async function timezoneFor(companyId: number): Promise<string> {
  const { data } = await tenantClient()
    .from('settings')
    .select('timezone')
    .eq('company_id', companyId)
    .maybeSingle()
  return (data as { timezone: string | null } | null)?.timezone || 'America/Jamaica'
}

/**
 * Returns null when migration 0053 is not applied, so a caller needs no
 * capability check: the block simply does not render. Any other failure still
 * throws, because a broken read must not look like an absent feature.
 */
export async function customerUsage(
  companyId: number,
  customerId: number,
  days = 30
): Promise<CustomerUsage | null> {
  const timezone = await timezoneFor(companyId)
  const today = instantToDateOnly(new Date(), timezone)
  const run = dateRun(today, days)
  const monthStart = today.slice(0, 8) + '01'
  // Whichever reaches further back, so one query serves both answers.
  const from = run[0] < monthStart ? run[0] : monthStart

  const { data, error } = await tenantClient()
    .from('usage_daily')
    .select('day, rx_bytes, tx_bytes')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .gte('day', from)
    .lte('day', today)
    .order('day')
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return null
    throw new Error('Could not read usage: ' + error.message)
  }

  const rows = (data ?? []) as { day: string; rx_bytes: number; tx_bytes: number }[]
  const byDay = new Map(rows.map((r) => [r.day, r]))

  let monthRx = 0
  let monthTx = 0
  for (const r of rows) {
    if (r.day >= monthStart) {
      monthRx += Number(r.rx_bytes)
      monthTx += Number(r.tx_bytes)
    }
  }

  const series = run.map((day) => {
    const r = byDay.get(day)
    return { day, rx: Number(r?.rx_bytes ?? 0), tx: Number(r?.tx_bytes ?? 0) }
  })

  const withAny = rows.filter((r) => Number(r.rx_bytes) + Number(r.tx_bytes) > 0)
  return {
    monthRx,
    monthTx,
    series,
    lastDay: withAny.length ? withAny[withAny.length - 1].day : null,
    empty: rows.length === 0,
  }
}

/**
 * Whether this company has any usage at all yet, for deciding whether to show
 * the section or explain why it is empty.
 *
 * ONE ROW IS ENOUGH TO ANSWER IT, so it asks for one. "Has the poller ever
 * worked here" and "has this customer used anything" are different questions,
 * and a customer with no usage on a working poller should not be told the
 * feature is not set up.
 */
export async function companyHasUsage(companyId: number): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('usage_daily')
    .select('id')
    .eq('company_id', companyId)
    .limit(1)
  if (error) return false
  return (data ?? []).length > 0
}
