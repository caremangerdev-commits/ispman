'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { secretStorageReady } from '@/lib/crypto'
import {
  createOlt, deleteOlt, oltWithLogin, recordOltCheck, setOltForward, setServiceVlan,
} from '@/lib/data/olts'
import { linkOnuToCustomer, linkOnusToCustomers, type OnuCustomer } from '@/lib/data/customer-devices'
import { routerLoginFor } from '@/lib/data/router-logins'
import { addOltForward, oltForwardPort, removeOltForward } from '@/lib/olt/forward'
import { oltDriver } from '@/lib/olt'
import type {
  OltAuthoriseResult, OltOnu, OltOnuAction, OltOnuDetail, OltPendingOnu,
} from '@/lib/olt/types'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

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
    // The addresses were only needed for the matching above.
    const onus = lists.onus.map((o) => ({ ...o, macs: undefined }))
    return { ok: true, pending: lists.pending, onus, customers }
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
}): Promise<AuthoriseResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to authorise ONUs.' }

  const vlan = Number(input.vlan)
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
    return { ok: false, error: 'Choose the VLAN to put them on, 1 to 4094.' }
  }

  const r = await reach(session.company.id, Number(input.oltId))
  if ('error' in r) return { ok: false, error: r.error ?? 'Could not reach the OLT.' }

  try {
    let items: { port: string; sn: string }[]
    let waiting = 0
    if (input.items === 'all') {
      const lists = await r.driver.listOnus(r.target, r.login)
      waiting = lists.pending.length
      items = lists.pending.slice(0, BATCH).map((p) => ({ port: p.port, sn: p.sn }))
    } else {
      items = input.items.slice(0, BATCH)
      waiting = input.items.length
    }
    if (items.length === 0) return { ok: true, results: [], remaining: 0 }

    const results = await r.driver.authorise(r.target, r.login, items, vlan)
    const done = results.filter((x) => x.ok)

    await setServiceVlan(session.company.id, r.olt.id, vlan)
    if (done.length) {
      await logEvent({
        type: 'onu_authorised',
        tag: '[olt]',
        details:
          done.length + ' ONU(s) authorised on ' + r.olt.name + ', VLAN ' + vlan + ': ' +
          done.map((x) => x.sn + ' as ' + x.id).join(', ') + ' | by=' + session.profile.email,
      })
    }
    revalidatePath(PATH + '/' + r.olt.id)
    return { ok: true, results, remaining: Math.max(0, waiting - done.length) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type OnuDetailResult = { ok: true; detail: OltOnuDetail } | { ok: false; error: string }

/** One ONU's signal, distance, model and recent history, read from the OLT now. */
export async function loadOnuDetail(oltId: number, onuId: string): Promise<OnuDetailResult> {
  const session = await getSession()
  if (!can(session.profile.role, 'view_network_infrastructure')) {
    return { ok: false, error: 'You do not have permission to see this.' }
  }
  const r = await reach(session.company.id, Number(oltId))
  if ('error' in r) return { ok: false, error: r.error ?? 'Could not reach the OLT.' }
  try {
    return { ok: true, detail: await r.driver.onuDetail(r.target, r.login, String(onuId)) }
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

  const kind = input.action?.kind
  if (kind !== 'reboot' && kind !== 'remove' && kind !== 'rename') {
    return { ok: false, error: 'Unknown action.' }
  }
  try {
    await r.driver.onuAction(r.target, r.login, String(input.onuId), input.action)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const did = kind === 'reboot' ? 'rebooted' : kind === 'remove' ? 'removed' : 'renamed'
  await logEvent({
    type: 'onu_' + did,
    tag: '[olt]',
    details: 'ONU ' + input.onuId + ' ' + did + ' on ' + r.olt.name + ' | by=' + session.profile.email,
  })
  revalidatePath(PATH + '/' + r.olt.id)
  return {
    ok: true,
    message:
      kind === 'reboot'
        ? 'Reboot sent. The ONU will be back in about a minute.'
        : kind === 'remove'
          ? 'Removed. If it is still plugged in, it will appear under Unauthorized.'
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
