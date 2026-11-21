import 'server-only'

import { linkOnusToCustomers, type OnuCustomer } from '@/lib/data/customer-devices'
import { oltWatchTargets, type OltWatchTarget } from '@/lib/data/olts'
import { routerLoginFor } from '@/lib/data/router-logins'
import { oltForwardPort } from '@/lib/olt/forward'
import { oltDriver } from '@/lib/olt'
import type { OltOnu } from '@/lib/olt/types'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The background pass over every OLT: read its ONUs, and act on what changed.
 *
 * FOUR JOBS ON ONE READING, because the reading is the expensive part — a
 * login and a few commands per PON port over a tunnel:
 *
 *   1. let new ONUs on, where the owner has asked for that
 *   2. tie ONUs to customers
 *   3. raise the bell for what went wrong since the last pass
 *   4. keep today's signal levels, for the history graph
 *
 * AN ALERT IS A CHANGE, NOT A STATE. An ONU that has been unplugged for a
 * month is not news every five minutes. Each pass compares the new reading
 * with the last one saved and speaks only about the difference: this one was
 * online and now is not; this signal was fine and now is too low.
 *
 * ONE ALERT FOR A DEAD PORT, NOT ONE PER CUSTOMER. When a fibre is cut every
 * ONU on that port drops in the same pass. Thirty separate alerts would bury
 * the one fact that matters, so a port that loses most of what was working on
 * it is reported once, with who is affected.
 */

/** Below this the ONU is about to drop, or already dropping. */
const RX_TOO_LOW = -27
/** A dip is over once the signal is clearly back, not hovering on the line. */
const RX_RECOVERED = -26
/** A port with at least this many working ONUs can be called down as a port. */
const PORT_MIN = 3
const AUTHORISE_BATCH = 8

export type OltWatchResult = {
  oltId: number
  name: string
  ok: boolean
  onus: number
  online: number
  authorised: number
  alerts: number
  error?: string
}

type Saved = {
  serial: string
  port: string
  online: boolean
  rx: number | null
  weak_alerted: boolean
  last_online_at: string | null
  offline_since: string | null
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

async function raise(companyId: number, customerId: number | null, message: string): Promise<void> {
  // The staff bell (see lib/data/payment-gateways.ts for the column notes):
  // nothing is delivered from this table, and 'pending' is what counts as
  // unread.
  const { error } = await tenantClient().from('notifications_queue').insert({
    company_id: companyId,
    customer_id: customerId,
    type: 'network',
    channel: 'sms',
    recipient: 'staff',
    message: message.slice(0, 500),
    status: 'pending',
  })
  if (error) console.error('[olt-watch] could not raise the bell:', error.message)
}

const who = (sn: string, owners: Record<string, OnuCustomer>) =>
  owners[sn] ? owners[sn].name + ' (' + sn + ')' : sn

async function watchOne(target: OltWatchTarget): Promise<OltWatchResult> {
  const { companyId, olt, login } = target
  const result: OltWatchResult = { oltId: olt.id, name: olt.name, ok: false, onus: 0, online: 0, authorised: 0, alerts: 0 }

  const driver = oltDriver(olt.brand)
  const router = await routerLoginFor(companyId, olt.tunnelId)
  if (!driver || !router) {
    result.error = !driver ? 'Unknown brand.' : 'No login on its router.'
    return result
  }
  const cli = { host: router.tunnelIp, port: olt.forwardPort ?? oltForwardPort(olt.id) }

  let lists = await driver.listOnus(cli, login)

  // 1. Let new ONUs on. Only with a VLAN already chosen — the first one is
  // authorised by a person, which is what picks it.
  if (target.autoAuthorise && olt.serviceVlan && lists.pending.length) {
    const items = lists.pending.slice(0, AUTHORISE_BATCH).map((p) => ({ port: p.port, sn: p.sn }))
    const done = (await driver.authorise(cli, login, items, olt.serviceVlan)).filter((r) => r.ok)
    result.authorised = done.length
    if (done.length) {
      await raise(
        companyId,
        null,
        done.length + (done.length === 1 ? ' new ONU was' : ' new ONUs were') + ' authorized on ' + olt.name +
          ' automatically: ' + done.map((d) => d.sn).join(', ') + '.'
      )
      result.alerts += 1
      lists = await driver.listOnus(cli, login)
    }
  }

  const onus = lists.onus.filter((o): o is OltOnu & { sn: string } => Boolean(o.sn))
  result.onus = onus.length
  result.online = onus.filter((o) => o.online).length

  // 2. Whose is each one.
  let owners: Record<string, OnuCustomer> = {}
  try {
    owners = await linkOnusToCustomers(companyId, olt.id, onus)
  } catch {
    owners = {}
  }

  const db = tenantClient()
  const { data: before, error: beforeError } = await db
    .from('olt_onus')
    .select('serial, port, online, rx, weak_alerted, last_online_at, offline_since')
    .eq('olt_id', olt.id)
  if (beforeError) {
    result.error = 'Could not read the last reading: ' + beforeError.message
    return result
  }
  const last = new Map<string, Saved>()
  for (const r of (before ?? []) as Saved[]) last.set(r.serial, { ...r, rx: num(r.rx) })
  // The first reading of an OLT has nothing to compare with. Everything on it
  // is recorded and nothing is announced: an OLT just added is not an outage.
  const first = last.size === 0

  // 3. What changed.
  const now = new Date().toISOString()
  const dropped = onus.filter((o) => !o.online && last.get(o.sn.toUpperCase())?.online === true)
  const byPort = new Map<string, typeof dropped>()
  for (const o of dropped) byPort.set(o.port, [...(byPort.get(o.port) ?? []), o])

  if (!first) {
    for (const [port, gone] of byPort) {
      const wasWorking = [...last.values()].filter((s) => s.port === port && s.online).length
      if (wasWorking >= PORT_MIN && gone.length >= Math.ceil(wasWorking * 0.8)) {
        const names = gone.map((o) => who(o.sn.toUpperCase(), owners))
        await raise(
          companyId,
          null,
          'PON port ' + port.replace('gpon-olt_', '') + ' on ' + olt.name + ' is down. ' + gone.length +
            ' customers lost service at the same time: ' + names.slice(0, 12).join(', ') +
            (names.length > 12 ? ' and ' + (names.length - 12) + ' more' : '') + '. Check the fibre from that port.'
        )
        result.alerts += 1
      } else {
        for (const o of gone) {
          const sn = o.sn.toUpperCase()
          const why =
            /dying/i.test(o.phase) ? 'It lost power.' : /los/i.test(o.phase) ? 'It lost the fibre signal.' : 'Status: ' + o.phase + '.'
          await raise(companyId, owners[sn]?.customerId ?? null, 'ONU offline on ' + olt.name + ': ' + who(sn, owners) + '. ' + why)
          result.alerts += 1
        }
      }
    }
  }

  const rows = []
  for (const o of onus) {
    const sn = o.sn.toUpperCase()
    const was = last.get(sn)
    const rx = o.rx ?? null
    let weakAlerted = was?.weak_alerted ?? false
    if (rx !== null && rx < RX_TOO_LOW && !weakAlerted) {
      // Recorded on the first reading too, but not announced then.
      if (!first) {
        await raise(
          companyId,
          owners[sn]?.customerId ?? null,
          'Low signal on ' + olt.name + ': ' + who(sn, owners) + ' is receiving ' + rx.toFixed(1) +
            ' dBm. Below ' + RX_TOO_LOW + ' the connection drops. Check the fibre and connectors.'
        )
        result.alerts += 1
      }
      weakAlerted = true
    } else if (rx !== null && rx >= RX_RECOVERED) {
      weakAlerted = false
    }
    rows.push({
      company_id: companyId,
      olt_id: olt.id,
      serial: sn,
      onu_ref: o.id,
      port: o.port,
      phase: o.phase,
      online: o.online,
      rx,
      tx: o.tx ?? null,
      weak_alerted: weakAlerted,
      last_online_at: o.online ? now : was?.last_online_at ?? null,
      offline_since: o.online ? null : was?.offline_since ?? now,
      updated_at: now,
    })
  }
  if (rows.length) {
    const { error } = await db.from('olt_onus').upsert(rows, { onConflict: 'olt_id,serial' })
    if (error) {
      result.error = 'Could not save the reading: ' + error.message
      return result
    }
  }
  // An ONU removed from the OLT is no longer watched.
  const present = new Set(rows.map((r) => r.serial))
  const removed = [...last.keys()].filter((sn) => !present.has(sn))
  if (removed.length) await db.from('olt_onus').delete().eq('olt_id', olt.id).in('serial', removed)

  // 4. Today's signal.
  const day = now.slice(0, 10)
  const withSignal = rows.filter((r) => r.rx !== null)
  if (withSignal.length) {
    const { data: today } = await db
      .from('onu_signal_daily')
      .select('serial, rx_min, rx_max')
      .eq('olt_id', olt.id)
      .eq('day', day)
    const had = new Map<string, { min: number | null; max: number | null }>()
    for (const r of (today ?? []) as { serial: string; rx_min: unknown; rx_max: unknown }[]) {
      had.set(r.serial, { min: num(r.rx_min), max: num(r.rx_max) })
    }
    const { error } = await db.from('onu_signal_daily').upsert(
      withSignal.map((r) => {
        const rx = r.rx as number
        const h = had.get(r.serial)
        return {
          olt_id: olt.id,
          serial: r.serial,
          day,
          company_id: companyId,
          rx_min: h?.min != null ? Math.min(h.min, rx) : rx,
          rx_max: h?.max != null ? Math.max(h.max, rx) : rx,
          rx_last: rx,
          tx_last: r.tx,
        }
      }),
      { onConflict: 'olt_id,serial,day' }
    )
    if (error) console.error('[olt-watch] could not save signal history:', error.message)
  }

  result.ok = true
  return result
}

/** Every OLT, one after another, for the same reason routers are polled in turn. */
export async function watchOlts(): Promise<OltWatchResult[]> {
  const out: OltWatchResult[] = []
  for (const target of await oltWatchTargets()) {
    try {
      out.push(await watchOne(target))
    } catch (err) {
      out.push({
        oltId: target.olt.id,
        name: target.olt.name,
        ok: false,
        onus: 0,
        online: 0,
        authorised: 0,
        alerts: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}
