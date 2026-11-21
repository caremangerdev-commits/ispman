/**
 * What kind of device something is, from what it announces about itself.
 *
 * Network gear advertises a platform and a model to its neighbours (MikroTik's
 * own discovery, CDP and LLDP all carry them). A router hears those
 * announcements, and ISPMan reads them off the router. Nothing is probed or
 * logged in to: this is only what each device already tells everyone on its
 * link.
 *
 * A BEST GUESS THAT THE OWNER CAN CHANGE. A model name says what a device was
 * built as, not how it is used — a NanoStation can be an access point for
 * three houses. So the type is a starting point shown in a dropdown, never a
 * verdict.
 */

export const DEVICE_KINDS = [
  { kind: 'router', label: 'Router' },
  { kind: 'olt', label: 'OLT' },
  { kind: 'onu', label: 'ONU' },
  { kind: 'ap', label: 'Access point / sector' },
  { kind: 'cpe', label: 'Customer radio (CPE)' },
  { kind: 'backhaul', label: 'Backhaul link' },
  { kind: 'switch', label: 'Switch' },
  { kind: 'other', label: 'Other' },
] as const

export type DeviceKind = (typeof DEVICE_KINDS)[number]['kind']

export const DEVICE_BRANDS = [
  'MikroTik', 'Ubiquiti', 'Cambium', 'Mimosa', 'TP-Link', 'Tenda', 'ZTE', 'Huawei', 'V-SOL',
  'C-Data', 'HSGQ', 'Other',
] as const

export function kindLabel(kind: string): string {
  return DEVICE_KINDS.find((k) => k.kind === kind)?.label ?? 'Other'
}

export function isDeviceKind(value: string): value is DeviceKind {
  return DEVICE_KINDS.some((k) => k.kind === value)
}

const has = (text: string, ...needles: string[]) => needles.some((n) => text.includes(n))

export function classifyDevice(input: {
  platform?: string | null
  board?: string | null
  description?: string | null
}): { kind: DeviceKind; brand: string | null; model: string | null } {
  const platform = (input.platform ?? '').trim()
  const board = (input.board ?? '').trim()
  const all = (platform + ' ' + board + ' ' + (input.description ?? '')).toLowerCase()
  const b = board.toLowerCase()
  const model = board || platform || null

  if (has(all, 'zxa10', ' olt', 'ma56', 'ma58', 'v1600')) {
    const brand = has(all, 'zxa10', 'zte') ? 'ZTE' : has(all, 'ma56', 'ma58', 'huawei') ? 'Huawei' : has(all, 'v1600') ? 'V-SOL' : null
    return { kind: 'olt', brand, model }
  }

  if (has(all, 'mikrotik', 'routeros')) {
    if (b.startsWith('crs') || b.startsWith('css')) return { kind: 'switch', brand: 'MikroTik', model }
    if (has(b, 'sxt', 'lhg', 'disc', 'ldf', 'sextant', 'dynadish', 'cube', 'wireless wire')) {
      return { kind: 'cpe', brand: 'MikroTik', model }
    }
    if (has(b, 'cap', 'wap', 'mant', 'omnitik', 'netmetal', 'basebox', 'groove', 'metal', 'qrt', 'audience')) {
      return { kind: 'ap', brand: 'MikroTik', model }
    }
    return { kind: 'router', brand: 'MikroTik', model }
  }

  if (has(all, 'ubiquiti', 'ubnt', 'airmax', 'airos', 'edgeos')) {
    return { ...ubiquiti(all), brand: 'Ubiquiti', model }
  }
  // Ubiquiti radios often announce only their model code, with no brand word.
  // Checked across everything it announced: a PowerBeam on a real network put
  // its model in the platform field and left the board field empty.
  if (has(all, 'nanostation', 'nanobeam', 'litebeam', 'powerbeam', 'rocket', 'prismstation', 'airfiber', 'airgrid', 'bullet')) {
    return { ...ubiquiti(all), brand: 'Ubiquiti', model }
  }

  if (has(all, 'mimosa')) return { kind: 'backhaul', brand: 'Mimosa', model }
  if (has(all, 'cambium', 'epmp', 'pmp ')) return { kind: 'ap', brand: 'Cambium', model }
  if (has(all, 'tp-link', 'tplink')) return { kind: has(all, 'cpe') ? 'cpe' : 'other', brand: 'TP-Link', model }
  if (has(all, 'switch')) return { kind: 'switch', brand: null, model }

  return { kind: 'other', brand: null, model }
}

function ubiquiti(all: string): { kind: DeviceKind } {
  if (has(all, 'airfiber', 'af-', 'af5', 'af60', 'gbe', 'wave')) return { kind: 'backhaul' }
  if (has(all, 'edgeswitch', 'usw', 'es-')) return { kind: 'switch' }
  if (has(all, 'edgerouter', 'er-', 'edgeos')) return { kind: 'router' }
  if (has(all, 'rocket', 'prismstation', 'liteap', 'lap-', 'basestation')) return { kind: 'ap' }
  return { kind: 'cpe' }
}
