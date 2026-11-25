import 'server-only'

/**
 * ISPMan's ACS (GenieACS), through its NBI on the same server.
 *
 * WHAT ISPMAN ASKS IT FOR: whether an ONU has ever checked in and when it last
 * did, a handful of readings to show (model, Wi-Fi name, internet login), and
 * the odd task a person asks for (reboot, check in again, send the setup
 * again). The setup itself is not pushed from here: a provision on the ACS
 * asks ISPMan for it every time an ONU checks in (app/api/acs/config).
 *
 * The NBI listens on 127.0.0.1 only; nothing here is reachable from outside.
 */

const NBI = (process.env.GENIEACS_NBI_URL ?? 'http://127.0.0.1:7557').replace(/\/+$/, '')

/** ONU serials as the label prints them (HWTC1234ABCD) and as TR-069 often sends them (485754431234ABCD). */
export function serialForms(serial: string): string[] {
  const s = serial.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const out = new Set([s])
  if (/^[A-Z]{4}[0-9A-F]{8}$/.test(s)) {
    out.add(
      [...s.slice(0, 4)].map((ch) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('') + s.slice(4)
    )
  }
  if (/^[0-9A-F]{16}$/.test(s)) {
    const vendor = (s.slice(0, 8).match(/.{2}/g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join('')
    if (/^[A-Z]{4}$/.test(vendor)) out.add(vendor + s.slice(8))
  }
  return [...out]
}

type Param = { _value?: unknown }
export type AcsDevice = {
  id: string
  lastInform: string | null
  manufacturer: string | null
  model: string | null
  serial: string | null
  wifiNames: string[]
  pppoeUser: string | null
  tags: string[]
  /** The data model's root: InternetGatewayDevice (TR-098) or Device (TR-181). */
  root: 'InternetGatewayDevice' | 'Device'
}

async function nbi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(NBI + path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(init?.method === 'POST' ? 35_000 : 8_000) })
}

/** Every value under a path, wildcards allowed as *, from a device document. */
function values(doc: Record<string, unknown>, path: string): unknown[] {
  let nodes: unknown[] = [doc]
  for (const part of path.split('.')) {
    const next: unknown[] = []
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue
      const o = n as Record<string, unknown>
      if (part === '*') {
        for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) next.push(v)
      } else if (part in o) next.push(o[part])
    }
    nodes = next
  }
  return nodes.map((n) => (n as Param)?._value).filter((v) => v !== undefined && v !== '')
}

function toDevice(doc: Record<string, unknown>): AcsDevice {
  const id = (doc._deviceId ?? {}) as Record<string, unknown>
  const first = (...paths: string[]) => {
    for (const p of paths) {
      const v = values(doc, p)[0]
      if (v != null) return String(v)
    }
    return null
  }
  return {
    id: String(doc._id),
    lastInform: doc._lastInform ? String(doc._lastInform) : null,
    manufacturer: (id._Manufacturer as string) ?? null,
    model: first('InternetGatewayDevice.DeviceInfo.ModelName', 'Device.DeviceInfo.ModelName') ?? ((id._ProductClass as string) ?? null),
    serial: (id._SerialNumber as string) ?? null,
    wifiNames: [
      ...values(doc, 'InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.SSID'),
      ...values(doc, 'Device.WiFi.SSID.*.SSID'),
    ].map(String),
    pppoeUser: first(
      'InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.Username',
      'Device.PPP.Interface.*.Username'
    ),
    tags: Array.isArray(doc._tags) ? (doc._tags as string[]) : [],
    root: 'Device' in doc && !('InternetGatewayDevice' in doc) ? 'Device' : 'InternetGatewayDevice',
  }
}

const PROJECTION = [
  '_id', '_lastInform', '_deviceId', '_tags',
  'InternetGatewayDevice.DeviceInfo.ModelName', 'Device.DeviceInfo.ModelName',
  'InternetGatewayDevice.LANDevice', 'Device.WiFi.SSID',
  'InternetGatewayDevice.WANDevice', 'Device.PPP.Interface',
].join(',')

/** The ACS's record of an ONU, by its serial in any of its forms. Null if it has never checked in. */
export async function findAcsDevice(serial: string): Promise<AcsDevice | null> {
  const query = { '_deviceId._SerialNumber': { $in: serialForms(serial) } }
  const res = await nbi('/devices/?query=' + encodeURIComponent(JSON.stringify(query)) + '&projection=' + PROJECTION)
  if (!res.ok) throw new Error('The ACS answered ' + res.status + '.')
  const list = (await res.json()) as Record<string, unknown>[]
  return list.length ? toDevice(list[0]) : null
}

/** Ask the ACS to do something on a device now if it can reach it, or at its next check-in. */
async function task(id: string, body: Record<string, unknown>): Promise<'done' | 'queued'> {
  const res = await nbi('/devices/' + encodeURIComponent(id) + '/tasks?connection_request&timeout=30000', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 200) return 'done'
  if (res.status === 202) return 'queued'
  throw new Error('The ACS refused that (' + res.status + ').')
}

export const rebootAcsDevice = (id: string) => task(id, { name: 'reboot' })

/**
 * Send the setup again: the tag recording which setup the ONU already has is
 * removed, so the provision applies it afresh, and the ONU is asked to check
 * in now.
 */
export async function resendAcsSetup(device: AcsDevice): Promise<'done' | 'queued'> {
  for (const tag of device.tags.filter((t) => t.startsWith('ispman-'))) {
    await nbi('/devices/' + encodeURIComponent(device.id) + '/tags/' + encodeURIComponent(tag), { method: 'DELETE' })
  }
  // Any session runs the provision; reading one small branch is the cheapest.
  return task(device.id, { name: 'refreshObject', objectName: device.root + '.DeviceInfo' })
}
