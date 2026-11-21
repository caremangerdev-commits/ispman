import 'server-only'

import { pollTargetsAllCompanies, type PollTarget } from '@/lib/data/router-logins'
import { kindLabel } from '@/lib/network/classify'
import { raiseNetworkAlert } from '@/lib/olt/watch'
import { pingFrom, withRouter } from '@/lib/routeros/api'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Is each device on the network answering (migration 0059).
 *
 * THE ROUTER DOES THE ASKING. A radio on 10.10.4.204 is on a private network
 * the server has no route to, but the router that heard it is one hop away.
 * So each connected router pings the devices it found, and a device typed in
 * by hand — which no router is on record as hearing — is tried from each
 * router of its company until one gets an answer.
 *
 * DOWN AFTER TWO MISSES, AND ONLY THE NETWORK'S OWN GEAR RAISES THE BELL. A
 * customer's radio goes off whenever the customer unplugs it; that is shown,
 * not announced. An access point, a backhaul or a switch going quiet is many
 * customers at once, and is.
 */

const ALERT_KINDS = new Set(['ap', 'backhaul', 'switch', 'router'])
/** Devices one router is asked about in a pass. A whole pass must fit in a tick. */
const PER_ROUTER = 80

type DeviceRow = {
  id: number
  company_id: number
  kind: string
  name: string
  ip: string
  found_via: number | null
  status: string | null
  misses: number | null
}

export type DeviceWatchSummary = { checked: number; up: number; down: number; alerts: number; error?: string }

export async function watchDevices(): Promise<DeviceWatchSummary> {
  const summary: DeviceWatchSummary = { checked: 0, up: 0, down: 0, alerts: 0 }
  const db = tenantClient()
  const { data, error } = await db
    .from('network_devices')
    .select('id, company_id, kind, name, ip, found_via, status, misses')
    .not('ip', 'is', null)
    .order('id')
    .limit(2000)
  // Before 0059 the columns are not there; nothing to do, and not an error.
  if (error) return summary
  const devices = (data ?? []) as DeviceRow[]
  if (devices.length === 0) return summary

  const { targets } = await pollTargetsAllCompanies()
  const answered = new Set<number>()
  const asked = new Set<number>()

  for (const router of targets) {
    const mine = devices
      .filter(
        (d) =>
          d.company_id === router.companyId &&
          !answered.has(d.id) &&
          (d.found_via === router.tunnelId || d.found_via === null)
      )
      .slice(0, PER_ROUTER)
    if (mine.length === 0) continue
    try {
      await withRouter(target(router), async (session) => {
        for (const d of mine) {
          asked.add(d.id)
          if (await pingFrom(session, d.ip)) answered.add(d.id)
        }
      })
    } catch (err) {
      // A router that cannot be reached says nothing about the devices behind
      // it. They keep their last status rather than all turning red.
      for (const d of mine) if (!answered.has(d.id)) asked.delete(d.id)
      summary.error = router.name + ': ' + (err instanceof Error ? err.message : String(err))
    }
  }

  const now = new Date().toISOString()
  for (const d of devices) {
    if (!asked.has(d.id)) continue
    summary.checked += 1
    if (answered.has(d.id)) {
      summary.up += 1
      const patch: Record<string, unknown> = { seen_at: now, misses: 0 }
      if (d.status !== 'up') {
        patch.status = 'up'
        patch.status_at = now
      }
      await db.from('network_devices').update(patch).eq('id', d.id)
      continue
    }
    const misses = (d.misses ?? 0) + 1
    const patch: Record<string, unknown> = { misses }
    if (misses >= 2 && d.status !== 'down') {
      patch.status = 'down'
      patch.status_at = now
      // Only something that was seen working is news when it stops.
      if (d.status === 'up' && ALERT_KINDS.has(d.kind)) {
        await raiseNetworkAlert(
          d.company_id,
          null,
          d.name + ' (' + kindLabel(d.kind) + ', ' + d.ip + ') has stopped answering. Customers connected through it may be offline.'
        )
        summary.alerts += 1
      }
    }
    if (misses >= 2) summary.down += 1
    await db.from('network_devices').update(patch).eq('id', d.id)
  }
  return summary
}

const target = (r: PollTarget) => ({
  host: r.tunnelIp,
  port: r.login.port,
  user: r.login.user,
  password: r.login.password,
})
