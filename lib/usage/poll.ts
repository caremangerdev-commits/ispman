import 'server-only'

import { pollTargetsAllCompanies, recordLoginCheck, type PollTarget } from '@/lib/data/router-logins'
import { instantToDateOnly } from '@/lib/format'
import { canonicalMac } from '@/lib/mac'
import { readDhcpLeases, readSimpleQueues, withRouter, type SimpleQueue } from '@/lib/routeros/api'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * One pass over every router: read the queue counters, turn them into usage.
 *
 * THE SHAPE OF THE PROBLEM. A simple queue counts bytes for an ADDRESS. ISPMan
 * knows customers by MAC. The router's DHCP lease table is the only thing that
 * joins the two, and it is on the same router, so each visit reads both and
 * does the join locally.
 *
 *   queue.target  ->  lease.address  ->  lease.mac  ->  customers.mac_address
 *
 * WHAT IS DELIBERATELY NOT ATTEMPTED. A queue whose address has no current
 * lease is skipped, not guessed at. Addresses are reused, so attributing a
 * queue to whoever held that address last would hand one customer another's
 * traffic — and the error would look exactly like heavy usage, which is the
 * figure most likely to be argued about with a customer.
 *
 * A COUNTER THAT WENT BACKWARDS IS A REBOOT. The delta becomes the new reading
 * itself, and the queue's reset count goes up so the under-counting is visible
 * rather than silent. The traffic between the last poll and the reboot is gone
 * and no arithmetic here can recover it.
 *
 * NOTHING THROWS PAST ONE ROUTER. A router that is off, or whose login was
 * removed, must not stop the other nine being read. Each failure is recorded
 * against that router and the pass continues.
 */

export type RouterPollResult = {
  router: string
  tunnelIp: string
  ok: boolean
  /** Queues found on the router. */
  queues: number
  /** Queues matched to a customer. */
  matched: number
  /** Queues skipped because the address had no current lease. */
  unmatched: number
  /** Counters that had gone backwards since the last pass. */
  resets: number
  /** Bytes added to today's totals by this router, both directions. */
  bytesAdded: number
  error?: string
}

export type PollSummary = {
  startedAt: string
  routers: RouterPollResult[]
  /** Rows whose stored login could not be decrypted — a rotated key. */
  undecryptable: number
  tookMs: number
}

/** A company's own date, which is the day its bills and its graphs mean. */
type CompanyDay = { timezone: string; day: string }

/**
 * The same fallback lib/data/bill.ts uses, and for the same reason: UTC would
 * put five hours of every evening's traffic on the following day, so a day's
 * usage and a day's bill would disagree about which day it was.
 */
const FALLBACK_ZONE = 'America/Jamaica'

async function companyDays(companyIds: number[]): Promise<Map<number, CompanyDay>> {
  const out = new Map<number, CompanyDay>()
  if (companyIds.length === 0) return out
  const { data } = await tenantClient()
    .from('settings')
    .select('company_id, timezone')
    .in('company_id', companyIds)
  const now = new Date()
  for (const row of (data ?? []) as { company_id: number; timezone: string | null }[]) {
    const timezone = row.timezone || FALLBACK_ZONE
    out.set(row.company_id, { timezone, day: instantToDateOnly(now, timezone) })
  }
  // A company with no settings row still gets a day, so its usage is not lost.
  for (const id of companyIds) {
    if (!out.has(id)) {
      out.set(id, { timezone: FALLBACK_ZONE, day: instantToDateOnly(now, FALLBACK_ZONE) })
    }
  }
  return out
}

/**
 * MAC to customer id, for one company.
 *
 * PAGED, because PostgREST stops at 1000 rows by default and the largest
 * tenant here has over 5,000 customers. A silent truncation would read as
 * "most of these queues belong to nobody", which is indistinguishable from a
 * genuinely unmatched queue and would quietly halve someone's usage.
 */
async function macIndex(companyId: number): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await tenantClient()
      .from('customers')
      .select('id, mac_address')
      .eq('company_id', companyId)
      .not('mac_address', 'is', null)
      .range(from, from + page - 1)
    if (error) throw new Error('Could not read customers for company ' + companyId + ': ' + error.message)
    const rows = (data ?? []) as { id: number; mac_address: string | null }[]
    for (const r of rows) {
      const mac = canonicalMac(r.mac_address ?? '')
      if (mac) index.set(mac, r.id)
    }
    if (rows.length < page) break
  }
  return index
}

/** The address a queue serves, without a mask or a port. */
function queueAddress(target: string): string | null {
  const first = target.split(',')[0].trim()
  const bare = first.split('/')[0].trim()
  // Only a plain IPv4 host address can be matched to a lease.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) ? bare : null
}

type StateRow = {
  id: number
  target: string
  customer_id: number | null
  last_rx: number
  last_tx: number
  resets: number
}

async function statesFor(tunnelId: number): Promise<Map<string, StateRow>> {
  const out = new Map<string, StateRow>()
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await tenantClient()
      .from('usage_state')
      .select('id, target, customer_id, last_rx, last_tx, resets')
      .eq('tunnel_id', tunnelId)
      .range(from, from + page - 1)
    if (error) throw new Error('Could not read the last readings: ' + error.message)
    const rows = (data ?? []) as StateRow[]
    for (const r of rows) out.set(r.target, r)
    if (rows.length < page) break
  }
  return out
}

/** Difference between two readings of the same counter. */
function delta(now: number, before: number): { value: number; reset: boolean } {
  if (now < before) return { value: now, reset: true }
  return { value: now - before, reset: false }
}

async function pollRouter(target: PollTarget, day: CompanyDay): Promise<RouterPollResult> {
  const result: RouterPollResult = {
    router: target.name,
    tunnelIp: target.tunnelIp,
    ok: false,
    queues: 0,
    matched: 0,
    unmatched: 0,
    resets: 0,
    bytesAdded: 0,
  }

  let queues: SimpleQueue[]
  let leaseByAddress: Map<string, string>
  try {
    const read = await withRouter(
      {
        host: target.tunnelIp,
        port: target.login.port,
        user: target.login.user,
        password: target.login.password,
      },
      async (session) => ({
        queues: await readSimpleQueues(session),
        leases: await readDhcpLeases(session),
      })
    )
    queues = read.queues
    leaseByAddress = new Map(read.leases.map((l) => [l.address, l.mac]))
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    await recordLoginCheck(target.tunnelId, { ok: false, error: result.error })
    return result
  }

  result.queues = queues.length
  const macs = await macIndex(target.companyId)
  const states = await statesFor(target.tunnelId)

  // Accumulated per customer, so one customer with two queues gets one row.
  const perCustomer = new Map<number, { rx: number; tx: number }>()
  const stateWrites: Record<string, unknown>[] = []

  for (const queue of queues) {
    const address = queueAddress(queue.target)
    if (!address) {
      result.unmatched += 1
      continue
    }
    const mac = canonicalMac(leaseByAddress.get(address) ?? '')
    const customerId = mac ? macs.get(mac) ?? null : null
    if (!customerId) {
      result.unmatched += 1
      // Still remember the reading: when the lease comes back, the delta from
      // here is right, rather than counting the whole counter as one day's use.
    } else {
      result.matched += 1
    }

    const before = states.get(queue.target)
    if (before) {
      const rx = delta(queue.rx, before.last_rx)
      const tx = delta(queue.tx, before.last_tx)
      if (rx.reset || tx.reset) result.resets += 1

      if (customerId && (rx.value > 0 || tx.value > 0)) {
        const acc = perCustomer.get(customerId) ?? { rx: 0, tx: 0 }
        acc.rx += rx.value
        acc.tx += tx.value
        perCustomer.set(customerId, acc)
        result.bytesAdded += rx.value + tx.value
      }
      stateWrites.push({
        company_id: target.companyId,
        tunnel_id: target.tunnelId,
        target: queue.target,
        customer_id: customerId,
        last_rx: queue.rx,
        last_tx: queue.tx,
        last_seen: new Date().toISOString(),
        resets: before.resets + (rx.reset || tx.reset ? 1 : 0),
      })
    } else {
      // FIRST SIGHT OF THIS QUEUE COUNTS NOTHING. The counter holds everything
      // since the queue was made, which could be months, and booking that as
      // today's usage would put an impossible figure on a customer's record on
      // the day polling was switched on.
      stateWrites.push({
        company_id: target.companyId,
        tunnel_id: target.tunnelId,
        target: queue.target,
        customer_id: customerId,
        last_rx: queue.rx,
        last_tx: queue.tx,
        last_seen: new Date().toISOString(),
        resets: 0,
      })
    }
  }

  const db = tenantClient()

  if (stateWrites.length > 0) {
    const { error } = await db
      .from('usage_state')
      .upsert(stateWrites, { onConflict: 'tunnel_id,target' })
    if (error) {
      result.error = 'Read the router, but could not save the readings: ' + error.message
      await recordLoginCheck(target.tunnelId, { ok: true })
      return result
    }
  }

  // --- today's totals -------------------------------------------------------
  // Read, add, write. There is no atomic increment through PostgREST, and the
  // alternative — a stored procedure — is a migration for something only this
  // worker writes to, one router at a time.
  if (perCustomer.size > 0) {
    const ids = [...perCustomer.keys()]
    const { data: existing, error: readError } = await db
      .from('usage_daily')
      .select('customer_id, rx_bytes, tx_bytes')
      .eq('day', day.day)
      .in('customer_id', ids)
    if (readError) {
      result.error = "Could not read today's totals: " + readError.message
      await recordLoginCheck(target.tunnelId, { ok: true })
      return result
    }
    const before = new Map(
      ((existing ?? []) as { customer_id: number; rx_bytes: number; tx_bytes: number }[]).map((r) => [
        r.customer_id,
        r,
      ])
    )

    const rows = ids.map((customerId) => {
      const add = perCustomer.get(customerId)!
      const had = before.get(customerId)
      return {
        company_id: target.companyId,
        customer_id: customerId,
        day: day.day,
        rx_bytes: (had?.rx_bytes ?? 0) + add.rx,
        tx_bytes: (had?.tx_bytes ?? 0) + add.tx,
        updated_at: new Date().toISOString(),
      }
    })
    const { error } = await db.from('usage_daily').upsert(rows, { onConflict: 'customer_id,day' })
    if (error) {
      result.error = "Could not save today's totals: " + error.message
      await recordLoginCheck(target.tunnelId, { ok: true })
      return result
    }
  }

  result.ok = true
  await recordLoginCheck(target.tunnelId, { ok: true })
  return result
}

/**
 * Every router, one after another.
 *
 * SEQUENTIAL, NOT PARALLEL. Ten routers at once over one WireGuard interface,
 * each pulling a few hundred queue rows, is a burst on the same tunnel the
 * RADIUS traffic uses — and RADIUS has a one-second timeout on these routers.
 * A pass that takes twenty seconds instead of three costs nothing; a customer
 * failing to get an address because the tunnel was saturated costs a call.
 */
export async function pollUsage(): Promise<PollSummary> {
  const started = Date.now()
  const { targets, undecryptable } = await pollTargetsAllCompanies()
  const days = await companyDays([...new Set(targets.map((t) => t.companyId))])

  const routers: RouterPollResult[] = []
  for (const target of targets) {
    const day = days.get(target.companyId) ?? {
      timezone: FALLBACK_ZONE,
      day: instantToDateOnly(new Date(), FALLBACK_ZONE),
    }
    try {
      routers.push(await pollRouter(target, day))
    } catch (err) {
      routers.push({
        router: target.name,
        tunnelIp: target.tunnelIp,
        ok: false,
        queues: 0,
        matched: 0,
        unmatched: 0,
        resets: 0,
        bytesAdded: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    startedAt: new Date(started).toISOString(),
    routers,
    undecryptable,
    tookMs: Date.now() - started,
  }
}
