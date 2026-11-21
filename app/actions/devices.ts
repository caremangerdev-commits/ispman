'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  linkDevicesByMac, saveCustomerDevice, unlinkCustomerDevice,
} from '@/lib/data/customer-devices'
import { addDevices, deleteDevice, listDevices, updateDeviceKind, type NewDevice } from '@/lib/data/devices'
import { listOlts } from '@/lib/data/olts'
import { routerLoginFor } from '@/lib/data/router-logins'
import { routersWithLogin } from '@/lib/data/router-usage'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { classifyDevice, isDeviceKind, type DeviceKind } from '@/lib/network/classify'
import { can } from '@/lib/permissions'
import { readNeighbours, withRouter } from '@/lib/routeros/api'
import { getSession } from '@/lib/session'

/**
 * The device inventory: adding by hand, and finding what is already out there.
 *
 * DISCOVERY ASKS THE COMPANY'S OWN ROUTERS WHAT THEY CAN HEAR. Each router
 * ISPMan can log in to keeps a table of the devices that have announced
 * themselves on its links. Reading those tables finds radios, switches and
 * other routers across every site at once, including ones on private
 * addresses the server could never reach — without scanning an address range
 * or logging in to anything.
 */

export type DeviceActionResult = { ok: true; message: string } | { ok: false; error: string }

const PATH = '/dashboard/network/devices'

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

function ipv4(raw: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw)
  return m && m.slice(1).every((p) => Number(p) <= 255) ? raw : null
}

/** A MAC in any common spelling, returned as AA:BB:CC:DD:EE:FF. */
function mac(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 12) return null
  return (hex.toUpperCase().match(/.{2}/g) ?? []).join(':')
}

async function manager() {
  const session = await getSession()
  return can(session.profile.role, 'manage_router_tunnels') ? session : null
}

export async function addDevice(_prev: DeviceActionResult | null, fd: FormData): Promise<DeviceActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to add devices.' }

  const kind = str(fd, 'kind')
  const name = str(fd, 'name')
  const rawIp = str(fd, 'ip')
  const rawMac = str(fd, 'mac')
  if (!isDeviceKind(kind)) return { ok: false, error: 'Choose a device type.' }
  if (kind === 'router' || kind === 'olt') {
    return { ok: false, error: 'Routers and OLTs are added from their own pages, so ISPMan can connect to them.' }
  }
  if (name.length < 2) return { ok: false, error: 'Give the device a name.' }
  if (rawIp && !ipv4(rawIp)) return { ok: false, error: 'That IP address is not valid.' }
  if (rawMac && !mac(rawMac)) return { ok: false, error: 'That MAC address is not valid.' }

  const res = await addDevices(session.company.id, session.profile.id ?? null, [
    {
      kind,
      name,
      brand: str(fd, 'brand') || null,
      model: str(fd, 'model') || null,
      ip: rawIp || null,
      mac: rawMac ? mac(rawMac) : null,
      notes: str(fd, 'notes') || null,
      source: 'manual',
    },
  ])
  if (!res.ok) return res
  if (res.added === 0) return { ok: false, error: 'A device with that MAC address is already listed.' }
  await linkDevicesByMac(session.company.id)
  revalidatePath(PATH)
  return { ok: true, message: name + ' added.' }
}

export type FoundDevice = {
  name: string
  kind: DeviceKind
  brand: string | null
  model: string | null
  ip: string | null
  mac: string
  version: string | null
  routerId: number
  routerName: string
  heardOn: string | null
}

export type DiscoverResult =
  | {
      ok: true
      found: FoundDevice[]
      /** How many announced devices are already in the inventory. */
      known: number
      routersAsked: number
      /** Routers that could not be read, with why. */
      failed: { router: string; error: string }[]
      /** Routers skipped because ISPMan has no login on them. */
      notReady: string[]
    }
  | { ok: false; error: string }

/**
 * Ask every router what it can hear, and return what is not already listed.
 *
 * NOTHING IS SAVED HERE. The owner sees the list and chooses; a network has
 * plenty on it that is not theirs to track — a neighbour's router on a shared
 * link, a printer — and adding it all unasked would bury the inventory.
 */
export async function discoverDevices(): Promise<DiscoverResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to do that.' }
  const companyId = session.company.id

  const [tunnels, logins, devices, olts] = await Promise.all([
    listRouterTunnels(companyId),
    routersWithLogin(companyId),
    listDevices(companyId),
    listOlts(companyId),
  ])
  if (devices === null) return { ok: false, error: 'Devices are not set up on this system yet (migration 0056).' }

  const live = tunnels.filter((t) => !t.revokedAt)
  // A connected router is heard by its neighbours like anything else. It has
  // no MAC on record to match on, so it is recognised by announcing the same
  // name it has in ISPMan — otherwise it would be offered as a new device.
  const routerNames = new Set(live.map((t) => t.name.trim().toLowerCase()))
  const knownMacs = new Set(devices.map((d) => d.mac).filter(Boolean) as string[])
  const oltIps = new Set((olts ?? []).map((o) => o.mgmtIp))

  const found = new Map<string, FoundDevice>()
  const failed: { router: string; error: string }[] = []
  let known = 0
  let asked = 0

  // One router at a time: the same reasoning as the usage poller. These share
  // one tunnel with RADIUS, which has a one-second timeout.
  for (const t of live) {
    if (!logins.has(t.id)) continue
    const router = await routerLoginFor(companyId, t.id)
    if (!router) continue
    asked += 1
    try {
      const heard = await withRouter(
        { host: router.tunnelIp, port: router.login.port, user: router.login.user, password: router.login.password },
        (s) => readNeighbours(s)
      )
      for (const n of heard) {
        if (!n.mac) continue
        if (
          knownMacs.has(n.mac) ||
          (n.address && oltIps.has(n.address)) ||
          (n.identity && routerNames.has(n.identity.trim().toLowerCase()))
        ) {
          known += 1
          continue
        }
        if (found.has(n.mac)) continue
        const guess = classifyDevice({ platform: n.platform, board: n.board, description: n.description })
        found.set(n.mac, {
          name: n.identity ?? guess.model ?? n.mac,
          kind: guess.kind,
          brand: guess.brand,
          model: guess.model,
          ip: n.address && ipv4(n.address) ? n.address : null,
          mac: n.mac,
          version: n.version,
          routerId: t.id,
          routerName: t.name,
          // "sfp-sfpplus2,bridge": the port, then the bridge it belongs to.
          // The port is the useful part.
          heardOn: n.heardOn ? n.heardOn.split(',')[0].trim() : null,
        })
      }
    } catch (err) {
      failed.push({ router: t.name, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    ok: true,
    found: [...found.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    known,
    routersAsked: asked,
    failed,
    notReady: live.filter((t) => !logins.has(t.id)).map((t) => t.name),
  }
}

/** Add devices the owner picked from a discovery list. */
export async function addFoundDevices(items: FoundDevice[]): Promise<DeviceActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to add devices.' }
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'Nothing was selected.' }

  // Rebuilt field by field: this came back from a browser, so nothing in it
  // is trusted beyond its shape.
  const tunnels = new Set((await listRouterTunnels(session.company.id)).map((t) => t.id))
  const clean: NewDevice[] = []
  for (const item of items.slice(0, 500)) {
    const m = mac(String(item?.mac ?? ''))
    if (!m) continue
    const kind = String(item?.kind ?? '')
    clean.push({
      // A router that is heard but not connected to ISPMan is still a router,
      // and is recorded as one. Only OLTs are kept out: those are added from
      // their own page, where ISPMan logs in to them.
      kind: isDeviceKind(kind) && kind !== 'olt' ? kind : 'other',
      name: String(item?.name ?? m).slice(0, 120) || m,
      brand: item?.brand ? String(item.brand).slice(0, 60) : null,
      model: item?.model ? String(item.model).slice(0, 80) : null,
      ip: item?.ip && ipv4(String(item.ip)) ? String(item.ip) : null,
      mac: m,
      version: item?.version ? String(item.version).slice(0, 60) : null,
      foundVia: tunnels.has(Number(item?.routerId)) ? Number(item.routerId) : null,
      foundOn: item?.heardOn ? String(item.heardOn).slice(0, 80) : null,
      source: 'discovered',
    })
  }
  const res = await addDevices(session.company.id, session.profile.id ?? null, clean)
  if (!res.ok) return res
  await logEvent({
    type: 'devices_added',
    tag: '[network]',
    details: res.added + ' device(s) added from discovery | by=' + session.profile.email,
  })
  // A radio that carries a customer's own MAC address is that customer's.
  const linked = await linkDevicesByMac(session.company.id)
  revalidatePath(PATH)
  return {
    ok: true,
    message:
      res.added + (res.added === 1 ? ' device added.' : ' devices added.') +
      (linked ? ' ' + linked + ' matched to a customer.' : ''),
  }
}

export async function setDeviceKind(id: number, kind: string): Promise<DeviceActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to do that.' }
  if (!isDeviceKind(kind) || kind === 'olt') return { ok: false, error: 'Choose a device type.' }
  if (!(await updateDeviceKind(session.company.id, Number(id), kind))) {
    return { ok: false, error: 'That device was not found.' }
  }
  revalidatePath(PATH)
  return { ok: true, message: 'Saved.' }
}

export async function removeDevice(id: number): Promise<DeviceActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to remove devices.' }
  if (!(await deleteDevice(session.company.id, Number(id)))) return { ok: false, error: 'That device was not found.' }
  revalidatePath(PATH)
  return { ok: true, message: 'Removed.' }
}

/**
 * Link a device to a customer from the customer's page.
 *
 * Allowed for anyone who may edit the customer: fitting an ONU or a radio at a
 * house is the installer's job, and recording it should not need an admin.
 */
export async function linkCustomerDevice(input: {
  customerId: number
  kind: string
  name: string
  brand: string
  model: string
  ip: string
  mac: string
  serial: string
  oltId: number | null
  notes: string
}): Promise<DeviceActionResult> {
  const session = await getSession()
  if (!can(session.profile.role, 'edit_customer') && !can(session.profile.role, 'manage_router_tunnels')) {
    return { ok: false, error: 'You do not have permission to link devices.' }
  }
  const kind = String(input.kind ?? '')
  if (!isDeviceKind(kind) || kind === 'olt') return { ok: false, error: 'Choose a device type.' }
  const rawIp = String(input.ip ?? '').trim()
  const rawMac = String(input.mac ?? '').trim()
  const serial = String(input.serial ?? '').trim().toUpperCase()
  if (rawIp && !ipv4(rawIp)) return { ok: false, error: 'That IP address is not valid.' }
  if (rawMac && !mac(rawMac)) return { ok: false, error: 'That MAC address is not valid.' }
  if (serial && !/^[A-Z0-9-]{4,30}$/.test(serial)) return { ok: false, error: 'That serial number is not valid.' }
  if (kind === 'onu' && !serial) return { ok: false, error: 'Enter the serial number printed on the ONU.' }
  if (!serial && !rawMac) return { ok: false, error: 'Enter a MAC address or a serial number, so the device can be told apart.' }

  const oltId = input.oltId != null && Number.isInteger(Number(input.oltId)) ? Number(input.oltId) : null
  if (oltId != null && !(await listOlts(session.company.id))?.some((o) => o.id === oltId)) {
    return { ok: false, error: 'That OLT was not found.' }
  }
  const name = String(input.name ?? '').trim() || serial || (rawMac ? (mac(rawMac) as string) : '')
  const res = await saveCustomerDevice(session.company.id, session.profile.id ?? null, {
    customerId: Number(input.customerId),
    kind,
    name,
    brand: String(input.brand ?? '').trim().slice(0, 60) || null,
    model: String(input.model ?? '').trim().slice(0, 80) || null,
    ip: rawIp || null,
    mac: rawMac ? mac(rawMac) : null,
    serial: serial || null,
    oltId: kind === 'onu' ? oltId : null,
    notes: String(input.notes ?? '').trim().slice(0, 500) || null,
  })
  if (!res.ok) return res
  await logEvent({
    type: 'device_linked',
    tag: '[network]',
    details: name + ' linked to customer #' + Number(input.customerId) + ' | by=' + session.profile.email,
  })
  revalidatePath('/dashboard/customers/' + Number(input.customerId))
  revalidatePath(PATH)
  return { ok: true, message: 'Linked.' }
}

export async function unlinkDevice(deviceId: number, customerId: number): Promise<DeviceActionResult> {
  const session = await getSession()
  if (!can(session.profile.role, 'edit_customer') && !can(session.profile.role, 'manage_router_tunnels')) {
    return { ok: false, error: 'You do not have permission to do that.' }
  }
  if (!(await unlinkCustomerDevice(session.company.id, Number(deviceId)))) {
    return { ok: false, error: 'That device was not found.' }
  }
  revalidatePath('/dashboard/customers/' + Number(customerId))
  revalidatePath(PATH)
  return { ok: true, message: 'Unlinked.' }
}
