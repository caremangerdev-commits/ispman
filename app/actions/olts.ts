'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { secretStorageReady } from '@/lib/crypto'
import {
  createOlt, deleteOlt, oltWithLogin, recordOltCheck, setAutoAuthorise, setOltForward, setServiceVlan,
} from '@/lib/data/olts'
import { linkOnuToCustomer, linkOnusToCustomers, type OnuCustomer } from '@/lib/data/customer-devices'
import { routerLoginFor } from '@/lib/data/router-logins'
import { addOltForward, oltForwardPort, removeOltForward } from '@/lib/olt/forward'
import { oltFeatures, READ_ONLY_NOTE } from '@/lib/olt/features'
import { oltDriver } from '@/lib/olt'
import type {
  LearnedSetup, OltAuthoriseResult, OltChangePlan, OltConfigChange, OltOnu, OltOnuAction, OltOnuDetail, OltPendingOnu, OnuServiceSetup,
  OnuSetupChoice,
} from '@/lib/olt/types'
import { can } from '@/lib/permissions'
import { searchClauses } from '@/lib/search'
import { batchGetRadiusSeen, radiusConfigured } from '@/lib/radius-db'
import { normaliseUsername } from '@/lib/radius/format'
import { blastOutage } from '@/lib/data/incident-notify'
import { createIncident } from '@/lib/data/incidents'
import { customerUsage, type UsageDay } from '@/lib/data/usage'
import { displayName, getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Adding, checking and removing a company's OLTs.
 *
 * ADDING IS THREE STEPS, AND EACH IS REPORTED ON ITS OWN. Save the OLT, put
 * the forwarding rules on its router, then log in to it. A wrong password
 * should not leave someone wondering whether the router rules went on, so the
 * OLT is kept after any failure, showing what failed, and Check again retries
 * from there. Nothing has to be typed twice.
 */

export type OltActionResult = { ok: true; message: string } | { ok: false; error: string }

const PATH = '/dashboard/network/olts'

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

/** A plain IPv4 host address, each part 0 to 255. */
function ipv4(raw: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw)
  if (!m) return null
  return m.slice(1).every((p) => Number(p) <= 255) ? raw : null
}

async function manager() {
  const session = await getSession()
  if (!can(session.profile.role, 'manage_router_tunnels')) return null
  return session
}

/** Puts the router rules on and logs in to the OLT. Records both outcomes. */
async function connect(companyId: number, oltId: number): Promise<OltActionResult> {
  const found = await oltWithLogin(companyId, oltId)
  if (!found) return { ok: false, error: 'That OLT was not found.' }
  const { olt, login } = found

  const router = await routerLoginFor(companyId, olt.tunnelId)
  if (!router) {
    return {
      ok: false,
      error:
        'ISPMan has no login on the router this OLT sits behind. Run the setup command on that router first (Settings → Router Tunnels).',
    }
  }

  const port = oltForwardPort(olt.id)
  try {
    await addOltForward(router, { id: olt.id, mgmtIp: olt.mgmtIp, cliPort: olt.cliPort })
    await setOltForward(companyId, olt.id, port, true)
  } catch (err) {
    await setOltForward(companyId, olt.id, port, false)
    const message = 'Could not set up the router: ' + (err instanceof Error ? err.message : String(err))
    await recordOltCheck(companyId, olt.id, { ok: false, error: message })
    return { ok: false, error: message }
  }

  const driver = oltDriver(olt.brand)
  if (!driver) return { ok: false, error: 'ISPMan cannot talk to that brand of OLT yet.' }

  // UP TO THREE TRIES, a moment apart. A rule added a second ago may not be
  // carrying traffic yet, and an OLT that has just closed one session can
  // refuse the next for an instant. Neither is worth showing a red dot for. A
  // refused login is not retried: the same password will be refused again,
  // and repeated failures are what gets an account locked.
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const info = await driver.inspect({ host: router.tunnelIp, port }, login)
      await recordOltCheck(companyId, olt.id, { ok: true, info })
      return { ok: true, message: olt.name + ' is connected.' }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
      if (!last.startsWith('Could not connect') && !last.startsWith('No answer')) break
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500))
    }
  }
  await recordOltCheck(companyId, olt.id, { ok: false, error: last })
  return { ok: false, error: olt.name + ': ' + last }
}

export async function addOlt(_prev: OltActionResult | null, fd: FormData): Promise<OltActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to add an OLT.' }
  if (!secretStorageReady()) {
    return { ok: false, error: 'This server is not set up to store device logins yet.' }
  }

  const name = str(fd, 'name')
  const brand = str(fd, 'brand') || 'zte'
  const mgmtIp = ipv4(str(fd, 'mgmt_ip'))
  const tunnelId = Number(str(fd, 'tunnel_id'))
  const cliUser = str(fd, 'cli_user')
  // Not trimmed: a password may begin or end with a space.
  const cliPassword = typeof fd.get('cli_password') === 'string' ? (fd.get('cli_password') as string) : ''
  const enablePassword =
    typeof fd.get('enable_password') === 'string' ? (fd.get('enable_password') as string) : ''
  const cliPort = Number(str(fd, 'cli_port') || '23')

  if (name.length < 2 || name.length > 60) return { ok: false, error: 'Give the OLT a name, 2 to 60 characters.' }
  if (!oltDriver(brand)) return { ok: false, error: 'Choose a brand from the list.' }
  if (!mgmtIp) return { ok: false, error: 'Enter the OLT’s IP address, like 10.10.4.6.' }
  if (!Number.isInteger(tunnelId) || tunnelId <= 0) return { ok: false, error: 'Choose the router this OLT sits behind.' }
  if (!cliUser) return { ok: false, error: 'Enter the OLT login username.' }
  if (!cliPassword) return { ok: false, error: 'Enter the OLT login password.' }
  if (!Number.isInteger(cliPort) || cliPort < 1 || cliPort > 65535) return { ok: false, error: 'The port must be 1 to 65535.' }

  if (!(await routerLoginFor(session.company.id, tunnelId))) {
    return {
      ok: false,
      error:
        'ISPMan has no login on that router yet. Run the setup command on it first (Settings → Router Tunnels).',
    }
  }

  const created = await createOlt(session.company.id, session.profile.id ?? null, {
    tunnelId,
    name,
    brand,
    mgmtIp,
    cliPort,
    cliUser,
    cliPassword,
    enablePassword: enablePassword || null,
  })
  if (!created.ok) return created

  await logEvent({
    type: 'olt_added',
    tag: '[olt]',
    details: 'OLT added: ' + name + ' at ' + mgmtIp + ' (' + brand + ') | by=' + session.profile.email,
  })

  const result = await connect(session.company.id, created.id)
  revalidatePath(PATH)
  if (result.ok) return result
  return {
    ok: false,
    error: 'Saved, but not connected yet. ' + result.error + ' Fix that, then press Check again.',
  }
}

export async function checkOlt(_prev: OltActionResult | null, fd: FormData): Promise<OltActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to do that.' }
  const result = await connect(session.company.id, Number(str(fd, 'id')))
  revalidatePath(PATH)
  revalidatePath(PATH + '/' + Number(str(fd, 'id')))
  return result
}

export async function removeOlt(_prev: OltActionResult | null, fd: FormData): Promise<OltActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to remove an OLT.' }
  const id = Number(str(fd, 'id'))
  const found = await oltWithLogin(session.company.id, id)
  if (!found) return { ok: false, error: 'That OLT was not found.' }

  // The router rules go first. If the router cannot be reached they are left
  // behind, and the message says so, rather than the OLT being impossible to
  // remove while a router is down.
  let leftover = ''
  const router = await routerLoginFor(session.company.id, found.olt.tunnelId)
  if (router) {
    try {
      await removeOltForward(router, id)
    } catch {
      leftover = ' Its rules could not be removed from the router; they are labelled "ISPMan OLT #' + id + '".'
    }
  }

  if (!(await deleteOlt(session.company.id, id))) return { ok: false, error: 'Could not remove the OLT.' }

  await logEvent({
    type: 'olt_removed',
    tag: '[olt]',
    details: 'OLT removed: ' + found.olt.name + ' at ' + found.olt.mgmtIp + ' | by=' + session.profile.email,
  })
  revalidatePath(PATH)
  return { ok: true, message: found.olt.name + ' removed.' + leftover }
}

/* -------------------------------------------------------------------------- */
/* ONUs                                                                       */
/* -------------------------------------------------------------------------- */

/** Everything needed to open a session to an OLT, or why that is not possible. */
async function reach(companyId: number, oltId: number) {
  const found = await oltWithLogin(companyId, oltId)
  if (!found) return { error: 'That OLT was not found.' } as const
  const router = await routerLoginFor(companyId, found.olt.tunnelId)
  if (!router) return { error: 'ISPMan has no login on the router this OLT sits behind.' } as const
  const driver = oltDriver(found.olt.brand)
  if (!driver) return { error: 'ISPMan cannot talk to that brand of OLT yet.' } as const
  return {
    olt: found.olt,
    login: found.login,
    driver,
    target: { host: router.tunnelIp, port: found.olt.forwardPort ?? oltForwardPort(found.olt.id) },
  } as const
}

export type OnuListResult =
  | {
      ok: true
      pending: OltPendingOnu[]
      onus: OltOnu[]
      /** Serial number → the customer that ONU belongs to. */
      customers: Record<string, OnuCustomer>
      /**
       * Customer id → whether their router is actually logged in now, from
       * RADIUS. A MAC showing behind an ONU is not proof of that.
       */
      seen: Record<number, { online: boolean; lastSeen: string | null }>
    }
  | { ok: false; error: string }

/**
 * Who is waiting and who is registered, read from the OLT now.
 *
 * LIVE, NOT STORED. An unauthorised ONU exists only while it is plugged in; a
 * saved list would show ONUs that were unplugged an hour ago and offer to
 * authorise them. So the list is whatever the OLT says at the moment it is
 * opened.
 */
/**
 * Whether each customer's router is logged in, by RADIUS. Never fails the
 * list: with RADIUS unreachable the column is simply left blank.
 */
async function customersSeen(
  companyId: number,
  ids: number[]
): Promise<Record<number, { online: boolean; lastSeen: string | null }>> {
  const out: Record<number, { online: boolean; lastSeen: string | null }> = {}
  const unique = [...new Set(ids)]
  if (unique.length === 0 || !radiusConfigured()) return out
  try {
    const { data } = await tenantClient()
      .from('customers')
      .select('id, mac_address')
      .eq('company_id', companyId)
      .in('id', unique)
    const rows = (data ?? []) as { id: number; mac_address: string | null }[]
    const withMac = rows.filter((r) => r.mac_address && r.mac_address.trim())
    const radius = await batchGetRadiusSeen(withMac.map((r) => r.mac_address))
    for (const r of withMac) {
      const hit = radius.get(normaliseUsername(r.mac_address as string))
      out[r.id] = { online: hit?.online ?? false, lastSeen: hit?.lastSeen ? hit.lastSeen.toISOString() : null }
    }
  } catch {
    return out
  }
  return out
}

export async function loadOnus(oltId: number): Promise<OnuListResult> {
  const session = await getSession()
  if (!can(session.profile.role, 'view_network_infrastructure')) {
    return { ok: false, error: 'You do not have permission to see this.' }
  }
  const r = await reach(session.company.id, Number(oltId))
  if ('error' in r) return { ok: false, error: r.error ?? 'Could not reach the OLT.' }
  try {
    const lists = await r.driver.listOnus(r.target, r.login)
    // Worked out on every reading: the OLT has just said which customer router
    // sits behind each ONU. A failure here must not hide the list itself.
    let customers: Record<string, OnuCustomer> = {}
    try {
      customers = await linkOnusToCustomers(session.company.id, r.olt.id, lists.onus)
    } catch {
      customers = {}
    }
    // The addresses behind each ONU are shown in the list: the customer's
    // router, usually one.
    const onus = lists.onus
    const seen = await customersSeen(session.company.id, Object.values(customers).map((c) => c.customerId))
    return { ok: true, pending: lists.pending, onus, customers, seen }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type AuthoriseResult =
  | { ok: true; results: OltAuthoriseResult[]; remaining: number }
  | { ok: false; error: string }

/**
 * How many ONUs one request authorises. Each takes about ten commands over a
 * tunnel; a whole port of 60 in one request would outlast the web server's
 * patience and leave the browser with an error while the OLT carried on. The
 * page asks again until none are left.
 */
const BATCH = 8

/**
 * Authorise ONUs: the ones named, or the next batch of everything waiting.
 *
 * FOR "ALL", THE LIST IS READ AGAIN HERE rather than trusted from the browser.
 * The page may have been open for ten minutes; what gets authorised is what is
 * plugged in now.
 */
export async function authoriseOnus(input: {
  oltId: number
  vlan: number
  items: { port: string; sn: string }[] | 'all'
  /**
   * Serial numbers that already failed in this run. Left out of 'all', so a
   * run moves past an ONU the OLT will not take instead of retrying it and
   * stopping there.
   */
  skip?: string[]
  /**
   * How their traffic is carried. 'learn' (the default) copies the setup of
   * the ONUs already working on the same port, and falls back to untagged on
   * `vlan` where there is nothing to copy. 'untagged': the ONU sends plain
   * traffic. 'tagged': the ONU tags its own traffic with `onuVlan` (or `vlan`).
   */
  mode?: 'learn' | 'untagged' | 'tagged'
  onuVlan?: number
}): Promise<AuthoriseResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to authorise ONUs.' }

  const vlan = Number(input.vlan)
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
    return { ok: false, error: 'Choose the VLAN to put them on, 1 to 4094.' }
  }

  const mode = input.mode ?? 'learn'
  const onuVlan = mode === 'tagged' ? Number(input.onuVlan ?? vlan) : null
  if (onuVlan != null && (!Number.isInteger(onuVlan) || onuVlan < 1 || onuVlan > 4094)) {
    return { ok: false, error: 'Choose the VLAN the ONUs tag with, 1 to 4094.' }
  }
  const setup: OnuSetupChoice = mode === 'learn' ? 'learn' : { onuVlan, vlan }

  const r = await reach(session.company.id, Number(input.oltId))
  if ('error' in r) return { ok: false, error: r.error ?? 'Could not reach the OLT.' }
  if (!oltFeatures(r.olt.brand).writes) return { ok: false, error: READ_ONLY_NOTE }

  try {
    let items: { port: string; sn: string; setup?: OnuSetupChoice }[]
    let waiting = 0
    if (input.items === 'all') {
      const skip = new Set((Array.isArray(input.skip) ? input.skip : []).map((s) => String(s).toUpperCase()))
      const lists = await r.driver.listOnus(r.target, r.login)
      const todo = lists.pending.filter((p) => !skip.has(p.sn.toUpperCase()))
      waiting = todo.length
      items = todo.slice(0, BATCH).map((p) => ({ port: p.port, sn: p.sn }))
    } else {
      items = input.items.slice(0, BATCH)
      waiting = input.items.length
    }
    if (items.length === 0) return { ok: true, results: [], remaining: 0 }
    items = items.map((i) => ({ ...i, setup }))

    const results = await r.driver.authorise(r.target, r.login, items, vlan)
    const done = results.filter((x) => x.ok)

    await setServiceVlan(session.company.id, r.olt.id, vlan)
    if (done.length) {
      await logEvent({
        type: 'onu_authorised',
        tag: '[olt]',
        details:
          done.length + ' ONU(s) authorised on ' + r.olt.name + ': ' +
          done.map((x) => x.sn + ' as ' + x.id + ' (' + setupWords(x.setup ?? { onuVlan: null, vlan }) +
            (x.learnedFrom ? ', copied from ' + x.learnedFrom : '') + ')').join(', ') +
          ' | by=' + session.profile.email,
      })
    }
    revalidatePath(PATH + '/' + r.olt.id)
    // For 'all': what is left untried. The ones that failed here are skipped
    // from the next round, so they no longer count as waiting.
    const left = input.items === 'all' ? waiting - results.length : waiting - done.length
    return { ok: true, results, remaining: Math.max(0, left) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** "tagged VLAN 20" / "untagged on VLAN 100", for logs and messages. */
function setupWords(s: OnuServiceSetup): string {
  if (s.onuVlan == null) return 'untagged on VLAN ' + s.vlan
  return 'tagged VLAN ' + s.onuVlan + (s.onuVlan === s.vlan ? '' : ' carried on VLAN ' + s.vlan)
}

export type PortSetupResult =
  | { ok: true; learned: LearnedSetup | null; canLearn: boolean }
  | { ok: false; error: string }

/**
 * How the ONUs already working on a PON port are set up, so the Authorize
 * screen can say what a new ONU there will get before it gets it.
 */
export async function learnPortSetup(oltId: number, port: string): Promise<PortSetupResult> {
  const session = await getSession()
  if (!can(session.profile.role, 'view_network_infrastructure')) {
    return { ok: false, error: 'You do not have permission to see this.' }
  }
  const r = await reach(session.company.id, Number(oltId))
  if ('error' in r) return { ok: false, error: r.error ?? 'Could not reach the OLT.' }
  if (!r.driver.learnSetup) return { ok: true, learned: null, canLearn: false }
  try {
    return { ok: true, learned: await r.driver.learnSetup(r.target, r.login, String(port)), canLearn: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type OnuSignalDay = { day: string; min: number | null; max: number | null; last: number | null }
export type OnuDrop = {
  downAt: string
  upAt: string | null
  cause: string | null
  /** Other ONUs on the same PON port that went down in the same check. */
  together: number
}
export type OnuDetailResult =
  | {
      ok: true
      detail: OltOnuDetail
      signal: OnuSignalDay[]
      drops: OnuDrop[]
      /** The linked customer's daily download and upload, oldest first. Null without usage data. */
      usage: UsageDay[] | null
    }
  | { ok: false; error: string }

/** The last 50 drops ISPMan recorded for an ONU, newest first. Empty before migration 0065. */
async function dropHistory(companyId: number, oltId: number, serial: string | null): Promise<OnuDrop[]> {
  if (!serial) return []
  const { data, error } = await tenantClient()
    .from('onu_drops')
    .select('down_at, up_at, cause, together')
    .eq('company_id', companyId)
    .eq('olt_id', oltId)
    .eq('serial', serial.toUpperCase())
    .order('down_at', { ascending: false })
    .limit(50)
  if (error) return []
  return ((data ?? []) as { down_at: string; up_at: string | null; cause: string | null; together: number }[]).map(
    (r) => ({ downAt: r.down_at, upAt: r.up_at, cause: r.cause, together: r.together ?? 0 })
  )
}

/** The data the customer on this ONU used each day, for the last 60 days. */
async function onuUsage(companyId: number, oltId: number, serial: string | null): Promise<UsageDay[] | null> {
  if (!serial) return null
  const { data } = await tenantClient()
    .from('network_devices')
    .select('customer_id')
    .eq('company_id', companyId)
    .eq('olt_id', oltId)
    .eq('serial', serial.toUpperCase())
    .not('customer_id', 'is', null)
    .maybeSingle()
  const customerId = (data as { customer_id: number } | null)?.customer_id
  if (!customerId) return null
  try {
    const usage = await customerUsage(companyId, customerId, 60)
    return usage && !usage.empty ? usage.series : null
  } catch {
    return null
  }
}

/** The last 60 days of an ONU's signal, oldest first. Empty before migration 0058. */
async function signalHistory(companyId: number, oltId: number, serial: string | null): Promise<OnuSignalDay[]> {
  if (!serial) return []
  const { data, error } = await tenantClient()
    .from('onu_signal_daily')
    .select('day, rx_min, rx_max, rx_last')
    .eq('company_id', companyId)
    .eq('olt_id', oltId)
    .eq('serial', serial.toUpperCase())
    .order('day', { ascending: false })
    .limit(60)
  if (error) return []
  const n = (v: unknown) => {
    const x = Number.parseFloat(String(v ?? ''))
    return Number.isFinite(x) ? x : null
  }
  return ((data ?? []) as { day: string; rx_min: unknown; rx_max: unknown; rx_last: unknown }[])
    .map((r) => ({ day: r.day, min: n(r.rx_min), max: n(r.rx_max), last: n(r.rx_last) }))
    .reverse()
}

/** One ONU's signal, distance, model and recent history, read from the OLT now. */
export async function loadOnuDetail(oltId: number, onuId: string): Promise<OnuDetailResult> {
  const session = await getSession()
  if (!can(session.profile.role, 'view_network_infrastructure')) {
    return { ok: false, error: 'You do not have permission to see this.' }
  }
  const r = await reach(session.company.id, Number(oltId))
  if ('error' in r) return { ok: false, error: r.error ?? 'Could not reach the OLT.' }
  try {
    const detail = await r.driver.onuDetail(r.target, r.login, String(onuId))
    const [signal, drops, usage] = await Promise.all([
      signalHistory(session.company.id, r.olt.id, detail.sn),
      dropHistory(session.company.id, r.olt.id, detail.sn),
      onuUsage(session.company.id, r.olt.id, detail.sn),
    ])
    return { ok: true, detail, signal, drops, usage }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Reboot, rename or remove one ONU.
 *
 * EVERY ONE IS WRITTEN TO THE ACTIVITY LOG with who did it. A reboot drops a
 * customer for a minute and a removal takes them off the network until
 * someone authorises the ONU again; "who did that, and when" has to have an
 * answer.
 */
export async function onuCommand(input: {
  oltId: number
  onuId: string
  action: OltOnuAction
}): Promise<OltActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to do that.' }
  const r = await reach(session.company.id, Number(input.oltId))
  if ('error' in r) return { ok: false, error: r.error ?? 'Could not reach the OLT.' }
  if (!oltFeatures(r.olt.brand).writes) return { ok: false, error: READ_ONLY_NOTE }

  const kind = input.action?.kind
  if (kind !== 'reboot' && kind !== 'remove' && kind !== 'rename' && kind !== 'disable' && kind !== 'enable' && kind !== 'vsol-fix' && kind !== 'service') {
    return { ok: false, error: 'Unknown action.' }
  }
  if (kind === 'vsol-fix' && r.olt.brand !== 'gcom') {
    return { ok: false, error: 'That setting is only for V-SOL ONUs on a GCOM OLT.' }
  }
  try {
    await r.driver.onuAction(r.target, r.login, String(input.onuId), input.action)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const did =
    kind === 'reboot' ? 'rebooted' : kind === 'remove' ? 'removed' : kind === 'disable' ? 'disabled' : kind === 'enable' ? 'enabled' : kind === 'vsol-fix' ? 'set_up_for_vsol' : kind === 'service' ? 'vlan_changed' : 'renamed'
  await logEvent({
    type: 'onu_' + did,
    tag: '[olt]',
    details:
      'ONU ' + input.onuId + ' ' + did.split('_').join(' ') +
      (input.action.kind === 'service' ? ' to ' + setupWords(input.action.setup) : '') +
      ' on ' + r.olt.name + ' | by=' + session.profile.email,
  })
  revalidatePath(PATH + '/' + r.olt.id)
  return {
    ok: true,
    message:
      kind === 'reboot'
        ? 'Reboot sent. The ONU will be back in about a minute.'
        : kind === 'remove'
          ? 'Removed. If it is still plugged in, it will appear under Unauthorized.'
          : kind === 'disable'
            ? 'Disabled. The customer has no service until you enable it again.'
            : kind === 'enable'
              ? 'Enabled. Service comes back within a minute.'
              : kind === 'vsol-fix'
                ? 'V-SOL settings saved on this ONU only. Reboot it if the customer is not browsing within a minute.'
                : input.action.kind === 'service'
                  ? 'Now ' + setupWords(input.action.setup) + '. Traffic should pass within a minute.'
                  : 'Saved.',
  }
}

/** Link an ONU to a customer by hand, from the ONU list. */
export async function linkOnu(input: {
  oltId: number
  serial: string
  onuRef: string
  model: string | null
  customerId: number
}): Promise<OltActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to do that.' }
  const serial = String(input.serial ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{8,20}$/.test(serial)) return { ok: false, error: 'That ONU has no serial number to link by.' }
  const found = await oltWithLogin(session.company.id, Number(input.oltId))
  if (!found) return { ok: false, error: 'That OLT was not found.' }
  const res = await linkOnuToCustomer(session.company.id, session.profile.id ?? null, {
    customerId: Number(input.customerId),
    serial,
    oltId: found.olt.id,
    onuRef: String(input.onuRef ?? '').slice(0, 40),
    model: input.model ? String(input.model).slice(0, 80) : null,
  })
  if (!res.ok) return res
  await logEvent({
    type: 'device_linked',
    tag: '[network]',
    details: 'ONU ' + serial + ' linked to customer #' + Number(input.customerId) + ' | by=' + session.profile.email,
  })
  revalidatePath('/dashboard/customers/' + Number(input.customerId))
  return { ok: true, message: 'Linked.' }
}

/** Switch automatic authorising of new ONUs on or off for one OLT. */
export async function setOltAutoAuthorise(oltId: number, on: boolean): Promise<OltActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to do that.' }
  const found = await oltWithLogin(session.company.id, Number(oltId))
  if (!found) return { ok: false, error: 'That OLT was not found.' }
  if (on && !oltFeatures(found.olt.brand).writes) return { ok: false, error: READ_ONLY_NOTE }
  if (on && !found.olt.serviceVlan) {
    return { ok: false, error: 'Authorize one ONU by hand first, so ISPMan knows which VLAN to use.' }
  }
  if (!(await setAutoAuthorise(session.company.id, found.olt.id, on === true))) {
    return { ok: false, error: 'Could not save that. Migration 0058 may not be applied.' }
  }
  await logEvent({
    type: 'olt_auto_authorise',
    tag: '[olt]',
    details: 'Automatic authorizing switched ' + (on ? 'on' : 'off') + ' for ' + found.olt.name + ' | by=' + session.profile.email,
  })
  revalidatePath(PATH + '/' + found.olt.id)
  return { ok: true, message: on ? 'On.' : 'Off.' }
}

/* ------------------------------ PON outages ------------------------------ */

export type PonOutage = {
  id: number
  port: string
  startedAt: string
  endedAt: string | null
  onus: number
  customers: { id: number; name: string; phone: string | null }[]
  incidentId: number | null
}

/** The last 30 outages on one OLT, newest first. Empty before migration 0065. */
export async function loadOutages(oltId: number): Promise<{ ok: true; outages: PonOutage[] } | { ok: false; error: string }> {
  const session = await getSession()
  if (!can(session.profile.role, 'view_network_infrastructure')) {
    return { ok: false, error: 'You do not have permission to see this.' }
  }
  const db = tenantClient()
  const { data, error } = await db
    .from('pon_outages')
    .select('id, port, started_at, ended_at, serials, customer_ids, incident_id')
    .eq('company_id', session.company.id)
    .eq('olt_id', Number(oltId))
    .order('started_at', { ascending: false })
    .limit(30)
  if (error) return { ok: true, outages: [] }
  const rows = (data ?? []) as {
    id: number; port: string; started_at: string; ended_at: string | null
    serials: string[]; customer_ids: (number | string)[]; incident_id: number | null
  }[]
  const ids = [...new Set(rows.flatMap((r) => (r.customer_ids ?? []).map(Number)))]
  const people = new Map<number, { id: number; name: string; phone: string | null }>()
  if (ids.length) {
    const { data: cs } = await db
      .from('customers')
      .select('id, first_name, last_name, phone')
      .eq('company_id', session.company.id)
      .in('id', ids.slice(0, 1000))
    for (const c of (cs ?? []) as { id: number; first_name: string | null; last_name: string | null; phone: string | null }[]) {
      people.set(c.id, { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer #' + c.id, phone: c.phone })
    }
  }
  return {
    ok: true,
    outages: rows.map((r) => ({
      id: r.id,
      port: r.port,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      onus: (r.serials ?? []).length,
      customers: (r.customer_ids ?? []).map(Number).map((id) => people.get(id)).filter((x): x is { id: number; name: string; phone: string | null } => Boolean(x)),
      incidentId: r.incident_id,
    })),
  }
}

/**
 * Tell the customers on a PON port that went down. Opens an incident for
 * exactly those customers, which texts them now (if the company has outage
 * messages on), shows the outage on their portal page, and texts them again
 * when the background check sees the port come back and closes it.
 */
export async function notifyOutage(input: { outageId: number; message: string }): Promise<OltActionResult> {
  const session = await getSession()
  if (!can(session.profile.role, 'manage_company_settings')) {
    return { ok: false, error: 'Only someone who can manage incidents can send this.' }
  }
  const companyId = session.company.id
  const message = String(input.message ?? '').trim().slice(0, 300)
  if (message.length < 10) return { ok: false, error: 'Write the message the customers will get.' }

  const db = tenantClient()
  const { data } = await db
    .from('pon_outages')
    .select('id, olt_id, port, customer_ids, incident_id, olts(name)')
    .eq('company_id', companyId)
    .eq('id', Number(input.outageId))
    .maybeSingle()
  const out = data as unknown as {
    id: number; olt_id: number; port: string; customer_ids: (number | string)[]; incident_id: number | null
    olts: { name: string } | null
  } | null
  if (!out) return { ok: false, error: 'That outage was not found.' }
  if (out.incident_id) return { ok: false, error: 'These customers were already told.' }
  const customerIds = (out.customer_ids ?? []).map(Number).filter(Number.isFinite)
  if (customerIds.length === 0) return { ok: false, error: 'None of the ONUs on this outage is linked to a customer.' }

  const portName = 'PON ' + (out.port.split(/[^0-9]+/).filter(Boolean).pop() ?? out.port)
  const where = portName + ' on ' + (out.olts?.name ?? 'the OLT')
  try {
    const id = await createIncident(
      companyId,
      { title: 'Fibre outage: ' + where, message, scope: 'customers', scopeValue: where, nextUpdateAt: null, customerIds },
      { id: session.profile.id, name: displayName(session.profile) }
    )
    await db.from('pon_outages').update({ incident_id: id }).eq('id', out.id)
    const incident = {
      id, title: 'Fibre outage: ' + where, message, scope: 'customers' as const, scopeValue: where,
      customerIds, status: 'open' as const, openedAt: new Date().toISOString(), restoredAt: null,
      nextUpdateAt: null, updatedAt: new Date().toISOString(),
    }
    await blastOutage(companyId, session.company.name, incident, 'open')
    await logEvent({
      type: 'outage_notified', tag: '[olt]',
      details: customerIds.length + ' customers told about the outage on ' + where + ' | by=' + session.profile.email,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  revalidatePath(PATH + '/' + out.olt_id)
  const { data: st } = await db.from('settings').select('notify_outage_enabled').eq('company_id', companyId).maybeSingle()
  if (!(st as { notify_outage_enabled: boolean | null } | null)?.notify_outage_enabled) {
    return {
      ok: true,
      message:
        'Outage opened for ' + customerIds.length + ' customers and shown on their portal page. No texts went out: ' +
        'outage messages are switched off in Settings, Messaging.',
    }
  }
  return { ok: true, message: customerIds.length + ' customers will be texted now, and again when the port is back.' }
}

/* ------------------------------ ONU search ------------------------------ */

export type OnuHit = {
  oltId: number
  oltName: string
  port: string
  onuRef: string | null
  serial: string
  online: boolean
  rx: number | null
  macs: string[]
  customer: { id: number; name: string; phone: string | null } | null
  /** What matched: shown so a hit on a MAC or phone is not a mystery. */
  matched: 'serial' | 'mac' | 'customer'
  updatedAt: string | null
}

/**
 * Find an ONU on any OLT by its serial, the MAC behind it, or the customer's
 * name, phone or account. Reads what the background check saved (every five
 * minutes), so it is instant and touches no OLT.
 */
export async function searchOnus(query: string): Promise<{ ok: true; hits: OnuHit[] } | { ok: false; error: string }> {
  const session = await getSession()
  if (!can(session.profile.role, 'view_network_infrastructure')) {
    return { ok: false, error: 'You do not have permission to see this.' }
  }
  const q = String(query ?? '').trim()
  if (q.length < 3) return { ok: true, hits: [] }
  const companyId = session.company.id
  const db = tenantClient()

  const [{ data: onuRows }, { data: oltRows }, { data: links }] = await Promise.all([
    db.from('olt_onus').select('olt_id, serial, onu_ref, port, online, rx, macs, updated_at').eq('company_id', companyId).limit(20000),
    db.from('olts').select('id, name').eq('company_id', companyId),
    db.from('network_devices').select('serial, olt_id, customer_id').eq('company_id', companyId).not('customer_id', 'is', null).not('serial', 'is', null).limit(20000),
  ])
  const onus = (onuRows ?? []) as {
    olt_id: number; serial: string; onu_ref: string | null; port: string; online: boolean
    rx: number | string | null; macs: string[] | null; updated_at: string | null
  }[]
  const oltName = new Map(((oltRows ?? []) as { id: number; name: string }[]).map((o) => [o.id, o.name]))
  const ownerOf = new Map<string, number>()
  for (const l of (links ?? []) as { serial: string; olt_id: number | null; customer_id: number }[]) {
    ownerOf.set(l.serial.toUpperCase(), l.customer_id)
  }

  // Customers whose name, phone, address, MAC or account matches, by the same
  // rule as the customer search box.
  let q2 = db.from('customers').select('id').eq('company_id', companyId)
  for (const clause of searchClauses(q)) q2 = q2.or(clause)
  const { data: custRows } = await q2.limit(200)
  const matchedCustomers = new Set(((custRows ?? []) as { id: number }[]).map((c) => c.id))

  const upper = q.toUpperCase()
  const hex = upper.replace(/[^0-9A-F]/g, '')
  const hits: (OnuHit & { _cid: number | null })[] = []
  for (const o of onus) {
    const serial = o.serial.toUpperCase()
    const cid = ownerOf.get(serial) ?? null
    const macs = o.macs ?? []
    let matched: OnuHit['matched'] | null = null
    if (serial.includes(upper)) matched = 'serial'
    else if (hex.length >= 4 && macs.some((m) => m.replace(/[^0-9A-F]/g, '').includes(hex))) matched = 'mac'
    else if (cid && matchedCustomers.has(cid)) matched = 'customer'
    if (!matched) continue
    const rx = Number.parseFloat(String(o.rx ?? ''))
    hits.push({
      oltId: o.olt_id,
      oltName: oltName.get(o.olt_id) ?? 'OLT',
      port: o.port,
      onuRef: o.onu_ref,
      serial,
      online: o.online,
      rx: Number.isFinite(rx) ? rx : null,
      macs,
      customer: null,
      matched,
      updatedAt: o.updated_at,
      _cid: cid,
    })
    if (hits.length >= 50) break
  }
  const ids = [...new Set(hits.map((h) => h._cid).filter((x): x is number => x !== null))]
  if (ids.length) {
    const { data: cs } = await db.from('customers').select('id, first_name, last_name, phone').eq('company_id', companyId).in('id', ids)
    const byId = new Map(((cs ?? []) as { id: number; first_name: string | null; last_name: string | null; phone: string | null }[]).map((c) => [c.id, c]))
    for (const h of hits) {
      const c = h._cid !== null ? byId.get(h._cid) : undefined
      if (c) h.customer = { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer #' + c.id, phone: c.phone }
    }
  }
  return { ok: true, hits: hits.map(({ _cid, ...h }) => { void _cid; return h }) }
}

/* -------------------------------------------------------------------------- */
/* The OLT's own settings                                                     */
/* -------------------------------------------------------------------------- */

export type OltChange = {
  id: number
  madeAt: string
  madeBy: string | null
  summary: string
  commands: string[]
  undone: boolean
  /** This row is itself an undo of another change. */
  isUndo: boolean
}

export type PlanResult = { ok: true; plan: OltChangePlan } | { ok: false; error: string }

/**
 * Only the fields each kind needs, coerced, so a change that arrives from a
 * browser is never more than what the form could have sent.
 */
function cleanChange(raw: OltConfigChange): OltConfigChange | null {
  const c = raw as Record<string, unknown>
  const n = (v: unknown) => Number(v)
  const s = (v: unknown) => String(v ?? '').slice(0, 120)
  switch (c.kind) {
    case 'vlan-add':
      return { kind: 'vlan-add', vlan: n(c.vlan), name: s(c.name) }
    case 'vlan-remove':
      return { kind: 'vlan-remove', vlan: n(c.vlan) }
    case 'uplink-vlan-add':
      return { kind: 'uplink-vlan-add', port: s(c.port), vlan: n(c.vlan), tagged: c.tagged === true }
    case 'uplink-vlan-remove':
      return { kind: 'uplink-vlan-remove', port: s(c.port), vlan: n(c.vlan) }
    case 'port-description':
      return { kind: 'port-description', port: s(c.port), text: s(c.text) }
    case 'pon-enable':
    case 'pon-disable':
      return { kind: c.kind, port: s(c.port) }
    default:
      return null
  }
}

/** One change at a time on any one OLT: a second person waits rather than interleaving commands. */
const oltBusy = new Set<number>()

async function reachForChange(oltId: number) {
  const session = await manager()
  if (!session) return { error: 'You do not have permission to change OLT settings.' } as const
  const r = await reach(session.company.id, Number(oltId))
  if ('error' in r) return { error: r.error ?? 'Could not reach the OLT.' } as const
  if (!oltFeatures(r.olt.brand).writes) return { error: READ_ONLY_NOTE } as const
  if (!r.driver.planChange || !r.driver.runCommands) {
    return { error: 'Changing settings from ISPMan is only available on ZTE OLTs so far.' } as const
  }
  return { session, r } as const
}

/** What a change would do — its commands and anything to weigh — without doing it. */
export async function previewOltChange(oltId: number, change: OltConfigChange): Promise<PlanResult> {
  const got = await reachForChange(oltId)
  if ('error' in got) return { ok: false, error: got.error as string }
  const clean = cleanChange(change)
  if (!clean) return { ok: false, error: 'Unknown change.' }
  try {
    return { ok: true, plan: await got.r.driver.planChange!(got.r.target, got.r.login, clean) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Make a change. PLANNED AGAIN HERE from the OLT's state now, not taken from
 * the preview: the preview may be minutes old, and nothing a browser sends is
 * ever run on an OLT as a command.
 */
export async function applyOltChange(oltId: number, change: OltConfigChange): Promise<OltActionResult> {
  const got = await reachForChange(oltId)
  if ('error' in got) return { ok: false, error: got.error as string }
  const { session, r } = got
  const clean = cleanChange(change)
  if (!clean) return { ok: false, error: 'Unknown change.' }
  if (oltBusy.has(r.olt.id)) return { ok: false, error: 'Another change is being made on this OLT. Try again in a moment.' }
  oltBusy.add(r.olt.id)
  try {
    const plan = await r.driver.planChange!(r.target, r.login, clean)
    await r.driver.runCommands!(r.target, r.login, plan.commands)
    await recordChange(session.company.id, r.olt.id, session.profile.email, plan, null)
    await logEvent({
      type: 'olt_setting_changed',
      tag: '[olt]',
      details: plan.summary + ' on ' + r.olt.name + ' | commands=' + plan.commands.join(' ; ') + ' | by=' + session.profile.email,
    })
    // Read it back so the page shows the OLT as it now is.
    await connect(session.company.id, r.olt.id)
    revalidatePath(PATH + '/' + r.olt.id)
    return { ok: true, message: plan.summary + ': done and saved on the OLT.' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    oltBusy.delete(r.olt.id)
  }
}

async function recordChange(
  companyId: number, oltId: number, by: string | null, plan: OltChangePlan, undoOf: number | null
): Promise<void> {
  await tenantClient()
    .from('olt_changes')
    .insert({
      company_id: companyId,
      olt_id: oltId,
      made_by: by,
      summary: plan.summary,
      commands: plan.commands,
      undo: plan.undo,
      undo_of: undoOf,
    })
}

/** The last 20 changes made to this OLT from ISPMan. Empty before migration 0066. */
export async function listOltChanges(oltId: number): Promise<{ ok: true; changes: OltChange[] } | { ok: false; error: string }> {
  const session = await getSession()
  if (!can(session.profile.role, 'view_network_infrastructure')) return { ok: false, error: 'You do not have permission to see this.' }
  const { data, error } = await tenantClient()
    .from('olt_changes')
    .select('id, made_at, made_by, summary, commands, undone_at, undo_of')
    .eq('company_id', session.company.id)
    .eq('olt_id', Number(oltId))
    .order('made_at', { ascending: false })
    .limit(20)
  if (error) return { ok: true, changes: [] }
  return {
    ok: true,
    changes: ((data ?? []) as {
      id: number; made_at: string; made_by: string | null; summary: string; commands: string[]
      undone_at: string | null; undo_of: number | null
    }[]).map((c) => ({
      id: c.id,
      madeAt: c.made_at,
      madeBy: c.made_by,
      summary: c.summary,
      commands: c.commands ?? [],
      undone: !!c.undone_at,
      isUndo: c.undo_of != null,
    })),
  }
}

/** Put a change back, with the undo commands worked out when it was made. */
export async function undoOltChange(changeId: number): Promise<OltActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to change OLT settings.' }
  const { data } = await tenantClient()
    .from('olt_changes')
    .select('id, olt_id, summary, undo, undone_at, undo_of')
    .eq('company_id', session.company.id)
    .eq('id', Number(changeId))
    .maybeSingle()
  const row = data as { id: number; olt_id: number; summary: string; undo: string[]; undone_at: string | null; undo_of: number | null } | null
  if (!row) return { ok: false, error: 'That change was not found.' }
  if (row.undone_at) return { ok: false, error: 'That change has already been undone.' }
  if (row.undo_of != null) return { ok: false, error: 'That was itself an undo. Make the change again instead.' }

  const got = await reachForChange(row.olt_id)
  if ('error' in got) return { ok: false, error: got.error as string }
  const { r } = got
  if (oltBusy.has(r.olt.id)) return { ok: false, error: 'Another change is being made on this OLT. Try again in a moment.' }
  oltBusy.add(r.olt.id)
  try {
    await r.driver.runCommands!(r.target, r.login, row.undo)
    await tenantClient().from('olt_changes').update({ undone_at: new Date().toISOString() }).eq('id', row.id)
    await recordChange(session.company.id, r.olt.id, session.profile.email, {
      summary: 'Undid: ' + row.summary, commands: row.undo, undo: [],
    }, row.id)
    await logEvent({
      type: 'olt_setting_undone',
      tag: '[olt]',
      details: 'Undid "' + row.summary + '" on ' + r.olt.name + ' | by=' + session.profile.email,
    })
    await connect(session.company.id, r.olt.id)
    revalidatePath(PATH + '/' + r.olt.id)
    return { ok: true, message: 'Undone: ' + row.summary + '.' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    oltBusy.delete(r.olt.id)
  }
}
