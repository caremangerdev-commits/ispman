import 'server-only'

import { instantToDateOnly } from '@/lib/format'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Data carried by each router, today and this month, for the Network page.
 *
 * THERE IS NO PER-ROUTER TABLE, and this does not need one. usage_daily is per
 * customer; usage_state says which router each customer's queue is on. A
 * router's total is the sum of its customers, which means the Network page and
 * the customer records can never disagree — they are the same rows.
 *
 * A customer seen on two routers is counted on the one that saw them last. It
 * is rare (a customer moved between sites) and counting them on both would
 * make the company total larger than the sum of its customers.
 *
 * PAGED. PostgREST stops at 1000 rows and a month of one tenant's usage is far
 * more than that; a silent cut-off here would show as a router carrying a
 * fraction of what it does.
 */

export type RouterUsage = {
  todayDown: number
  todayUp: number
  monthDown: number
  monthUp: number
  /** Customers with a queue on this router that ISPMan could match. */
  customers: number
}

const PAGE = 1000

export async function routerUsage(companyId: number): Promise<Map<number, RouterUsage> | null> {
  const db = tenantClient()

  const { data: settings } = await db
    .from('settings')
    .select('timezone')
    .eq('company_id', companyId)
    .maybeSingle()
  const timezone = (settings as { timezone: string | null } | null)?.timezone || 'America/Jamaica'
  const today = instantToDateOnly(new Date(), timezone)
  const monthStart = today.slice(0, 8) + '01'

  // --- which router each customer is on ------------------------------------
  const routerOf = new Map<number, number>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('usage_state')
      .select('tunnel_id, customer_id')
      .eq('company_id', companyId)
      .not('customer_id', 'is', null)
      .order('last_seen', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      // Migration 0053 not applied: no usage anywhere, and the page says so.
      if (error.code === 'PGRST205' || error.code === '42P01') return null
      throw new Error('Could not read router usage: ' + error.message)
    }
    const rows = (data ?? []) as { tunnel_id: number; customer_id: number }[]
    for (const r of rows) routerOf.set(r.customer_id, r.tunnel_id)
    if (rows.length < PAGE) break
  }

  const out = new Map<number, RouterUsage>()
  const entry = (tunnelId: number): RouterUsage => {
    let e = out.get(tunnelId)
    if (!e) {
      e = { todayDown: 0, todayUp: 0, monthDown: 0, monthUp: 0, customers: 0 }
      out.set(tunnelId, e)
    }
    return e
  }
  for (const tunnelId of routerOf.values()) entry(tunnelId).customers += 1

  // --- this month's usage, summed onto those routers ------------------------
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('usage_daily')
      .select('customer_id, day, rx_bytes, tx_bytes')
      .eq('company_id', companyId)
      .gte('day', monthStart)
      .lte('day', today)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error('Could not read usage totals: ' + error.message)
    const rows = (data ?? []) as {
      customer_id: number
      day: string
      rx_bytes: number
      tx_bytes: number
    }[]
    for (const r of rows) {
      const tunnelId = routerOf.get(r.customer_id)
      if (tunnelId === undefined) continue
      const e = entry(tunnelId)
      // rx is the customer's download, the same reading of the columns the
      // customer record uses.
      e.monthDown += Number(r.rx_bytes)
      e.monthUp += Number(r.tx_bytes)
      if (r.day === today) {
        e.todayDown += Number(r.rx_bytes)
        e.todayUp += Number(r.tx_bytes)
      }
    }
    if (rows.length < PAGE) break
  }

  return out
}

/** Which of a company's routers ISPMan can log in to. */
export async function routersWithLogin(companyId: number): Promise<Set<number>> {
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .select('id')
    .eq('company_id', companyId)
    .not('api_secret', 'is', null)
    .is('revoked_at', null)
  // Migration 0052 not applied reads as "none have one", which is true.
  if (error) return new Set()
  return new Set(((data ?? []) as { id: number }[]).map((r) => r.id))
}
