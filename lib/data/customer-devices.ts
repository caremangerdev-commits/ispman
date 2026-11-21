import 'server-only'

import { isDeviceKind, type DeviceKind } from '@/lib/network/classify'
import type { OltOnu } from '@/lib/olt/types'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Which customer a device belongs to (migration 0057).
 *
 * TWO WAYS A LINK IS MADE. A person picks the customer, or ISPMan works it out
 * from a MAC address: the OLT sees the customer's router behind an ONU, or a
 * customer radio carries the customer's own MAC.
 *
 * A PERSON'S ANSWER IS NEVER REPLACED BY A GUESS. Every row a person has
 * linked — or unlinked — is marked 'manual', and the automatic matching leaves
 * those alone. Unlinking keeps the mark with no customer, which is how "this
 * is not that customer's" survives the next reading of the OLT.
 */

export type CustomerDevice = {
  id: number
  kind: DeviceKind
  name: string
  brand: string | null
  model: string | null
  ip: string | null
  mac: string | null
  serial: string | null
  oltId: number | null
  onuRef: string | null
  linkedBy: 'auto' | 'manual' | null
  notes: string | null
  /** For an ONU: its last reading by the background pass. Absent if never read. */
  live?: { online: boolean; rx: number | null; phase: string | null; readAt: string } | null
}

type Row = {
  id: number
  kind: string
  name: string
  brand: string | null
  model: string | null
  ip: string | null
  mac: string | null
  serial: string | null
  olt_id: number | null
  onu_ref: string | null
  linked_by: string | null
  notes: string | null
  customer_id: number | null
}

const COLUMNS = 'id, kind, name, brand, model, ip, mac, serial, olt_id, onu_ref, linked_by, notes, customer_id'

/** Table or columns not there yet: the migration has not been applied. */
const NOT_READY = new Set(['PGRST205', 'PGRST204', '42P01', '42703'])

const toDevice = (r: Row): CustomerDevice => ({
  id: r.id,
  kind: isDeviceKind(r.kind) ? r.kind : 'other',
  name: r.name,
  brand: r.brand,
  model: r.model,
  ip: r.ip,
  mac: r.mac,
  serial: r.serial,
  oltId: r.olt_id,
  onuRef: r.onu_ref,
  linkedBy: r.linked_by === 'auto' || r.linked_by === 'manual' ? r.linked_by : null,
  notes: r.notes,
})

/** Null means migration 0057 is not applied. */
export async function customerDevices(companyId: number, customerId: number): Promise<CustomerDevice[] | null> {
  const { data, error } = await tenantClient()
    .from('network_devices')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .order('kind')
    .order('name')
  if (error) {
    if (NOT_READY.has(error.code ?? '')) return null
    throw new Error('Could not load the customer devices: ' + error.message)
  }
  const devices = ((data ?? []) as Row[]).map(toDevice)
  const serials = devices.filter((d) => d.kind === 'onu' && d.serial).map((d) => d.serial as string)
  if (serials.length) {
    // Tolerant: before migration 0058 there is no reading, and the tag shows without one.
    const live = await tenantClient()
      .from('olt_onus')
      .select('serial, online, rx, phase, updated_at')
      .eq('company_id', companyId)
      .in('serial', serials)
    if (!live.error) {
      for (const r of (live.data ?? []) as { serial: string; online: boolean; rx: unknown; phase: string | null; updated_at: string }[]) {
        const rx = Number.parseFloat(String(r.rx ?? ''))
        const d = devices.find((x) => x.serial === r.serial)
        if (d) d.live = { online: r.online, rx: Number.isFinite(rx) ? rx : null, phase: r.phase, readAt: r.updated_at }
      }
    }
  }
  return devices
}

export type OnuCustomer = { customerId: number; name: string; linkedBy: 'auto' | 'manual' }

type CustomerRow = { id: number; first_name: string | null; last_name: string | null; mac_address: string | null }

const nameOf = (c: { first_name: string | null; last_name: string | null }) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Customer'

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Customers by MAC address. A MAC on more than one customer matches nobody. */
async function customersByMac(companyId: number, macs: string[]): Promise<Map<string, CustomerRow>> {
  const out = new Map<string, CustomerRow>()
  const shared = new Set<string>()
  for (const part of chunks([...new Set(macs)], 200)) {
    const { data, error } = await tenantClient()
      .from('customers')
      .select('id, first_name, last_name, mac_address')
      .eq('company_id', companyId)
      .in('mac_address', part)
    if (error) throw new Error('Could not look up customers: ' + error.message)
    for (const c of (data ?? []) as CustomerRow[]) {
      const mac = (c.mac_address ?? '').toUpperCase()
      if (!mac) continue
      if (out.has(mac)) shared.add(mac)
      out.set(mac, c)
    }
  }
  for (const mac of shared) out.delete(mac)
  return out
}

async function customerNames(companyId: number, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  for (const part of chunks([...new Set(ids)], 200)) {
    const { data } = await tenantClient()
      .from('customers')
      .select('id, first_name, last_name')
      .eq('company_id', companyId)
      .in('id', part)
    for (const c of (data ?? []) as CustomerRow[]) out.set(c.id, nameOf(c))
  }
  return out
}

/**
 * Tie the ONUs just read off an OLT to customers, and say whose each one is.
 *
 * Returns serial number → customer for every ONU that has one, whether the
 * link is new, old, or made by hand. An empty map before migration 0057.
 */
export async function linkOnusToCustomers(
  companyId: number,
  oltId: number,
  onus: OltOnu[]
): Promise<Record<string, OnuCustomer>> {
  const withSerial = onus.filter((o) => o.sn)
  if (withSerial.length === 0) return {}
  const db = tenantClient()

  const existing = new Map<string, Row>()
  for (const part of chunks(withSerial.map((o) => (o.sn as string).toUpperCase()), 200)) {
    const { data, error } = await db.from('network_devices').select(COLUMNS).eq('company_id', companyId).in('serial', part)
    if (error) {
      if (NOT_READY.has(error.code ?? '')) return {}
      throw new Error('Could not load ONU links: ' + error.message)
    }
    for (const r of (data ?? []) as Row[]) if (r.serial) existing.set(r.serial, r)
  }

  const byMac = await customersByMac(companyId, withSerial.flatMap((o) => o.macs ?? []))
  const linked = new Map<string, { customerId: number; linkedBy: 'auto' | 'manual' }>()

  for (const onu of withSerial) {
    const sn = (onu.sn as string).toUpperCase()
    const row = existing.get(sn)
    // The customers found behind this ONU. Exactly one is a match; two is a
    // shared ONU or a switch behind it, and is left for a person.
    const owners = new Set((onu.macs ?? []).map((m) => byMac.get(m)?.id).filter((v): v is number => v != null))
    const match = owners.size === 1 ? [...owners][0] : null

    if (!row) {
      if (match == null) continue
      const { error } = await db.from('network_devices').insert({
        company_id: companyId,
        kind: 'onu',
        name: sn,
        serial: sn,
        model: onu.type,
        olt_id: oltId,
        onu_ref: onu.id,
        customer_id: match,
        linked_by: 'auto',
        source: 'discovered',
      })
      if (!error) linked.set(sn, { customerId: match, linkedBy: 'auto' })
      continue
    }

    const patch: Record<string, unknown> = {}
    if (row.olt_id !== oltId) patch.olt_id = oltId
    if (row.onu_ref !== onu.id) patch.onu_ref = onu.id
    let customerId = row.customer_id
    if (row.linked_by !== 'manual' && match != null && match !== row.customer_id) {
      patch.customer_id = match
      patch.linked_by = 'auto'
      customerId = match
    }
    if (Object.keys(patch).length) {
      await db.from('network_devices').update(patch).eq('company_id', companyId).eq('id', row.id)
    }
    if (customerId != null) {
      linked.set(sn, { customerId, linkedBy: row.linked_by === 'manual' ? 'manual' : 'auto' })
    }
  }

  const names = await customerNames(companyId, [...linked.values()].map((l) => l.customerId))
  const out: Record<string, OnuCustomer> = {}
  for (const [sn, l] of linked) out[sn] = { ...l, name: names.get(l.customerId) ?? 'Customer' }
  return out
}

/**
 * Link devices that carry a customer's own MAC address — a customer radio or
 * router that logs in to the network itself. Returns how many were linked.
 */
export async function linkDevicesByMac(companyId: number): Promise<number> {
  const db = tenantClient()
  const { data, error } = await db
    .from('network_devices')
    .select('id, mac')
    .eq('company_id', companyId)
    .is('customer_id', null)
    .is('linked_by', null)
    .not('mac', 'is', null)
    .limit(1000)
  if (error) return 0
  const rows = (data ?? []) as { id: number; mac: string }[]
  if (rows.length === 0) return 0
  const byMac = await customersByMac(companyId, rows.map((r) => r.mac.toUpperCase()))
  let count = 0
  for (const r of rows) {
    const owner = byMac.get(r.mac.toUpperCase())
    if (!owner) continue
    const res = await db
      .from('network_devices')
      .update({ customer_id: owner.id, linked_by: 'auto' })
      .eq('company_id', companyId)
      .eq('id', r.id)
    if (!res.error) count += 1
  }
  return count
}

export type DeviceLinkInput = {
  customerId: number
  kind: DeviceKind
  name: string
  brand: string | null
  model: string | null
  ip: string | null
  mac: string | null
  serial: string | null
  oltId: number | null
  notes: string | null
}

/**
 * Link a device to a customer by hand.
 *
 * A device already known by its serial number or MAC address is moved to this
 * customer rather than recorded twice — the same ONU cannot be in two houses.
 */
export async function saveCustomerDevice(
  companyId: number,
  createdBy: number | null,
  input: DeviceLinkInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = tenantClient()
  const { data: customer } = await db
    .from('customers')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', input.customerId)
    .maybeSingle()
  if (!customer) return { ok: false, error: 'That customer was not found.' }

  let existingId: number | null = null
  for (const [column, value] of [['serial', input.serial], ['mac', input.mac]] as const) {
    if (!value || existingId != null) continue
    const { data, error } = await db
      .from('network_devices')
      .select('id')
      .eq('company_id', companyId)
      .eq(column, value)
      .limit(1)
    if (error) {
      if (NOT_READY.has(error.code ?? '')) return { ok: false, error: 'Device links are not set up on this system yet (migration 0057).' }
      return { ok: false, error: 'Could not save: ' + error.message }
    }
    existingId = ((data ?? [])[0] as { id: number } | undefined)?.id ?? null
  }

  const fields = {
    kind: input.kind,
    name: input.name.slice(0, 120),
    brand: input.brand,
    model: input.model,
    ip: input.ip,
    mac: input.mac,
    serial: input.serial,
    olt_id: input.oltId,
    notes: input.notes,
    customer_id: input.customerId,
    linked_by: 'manual',
  }
  const res =
    existingId != null
      ? await db.from('network_devices').update(fields).eq('company_id', companyId).eq('id', existingId)
      : await db.from('network_devices').insert({ ...fields, company_id: companyId, source: 'manual', created_by: createdBy })
  if (res.error) {
    if (NOT_READY.has(res.error.code ?? '')) return { ok: false, error: 'Device links are not set up on this system yet (migration 0057).' }
    if (res.error.code === '23505') return { ok: false, error: 'Another device already has that MAC address or serial number.' }
    return { ok: false, error: 'Could not save: ' + res.error.message }
  }
  return { ok: true }
}

/** Link a known ONU (by serial number) to a customer, from the OLT page. */
export async function linkOnuToCustomer(
  companyId: number,
  createdBy: number | null,
  input: { customerId: number; serial: string; oltId: number; onuRef: string; model: string | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await saveCustomerDevice(companyId, createdBy, {
    customerId: input.customerId,
    kind: 'onu',
    name: input.serial,
    brand: null,
    model: input.model,
    ip: null,
    mac: null,
    serial: input.serial,
    oltId: input.oltId,
    notes: null,
  })
  if (!res.ok) return res
  await tenantClient()
    .from('network_devices')
    .update({ onu_ref: input.onuRef })
    .eq('company_id', companyId)
    .eq('serial', input.serial)
  return { ok: true }
}

/**
 * Take a device off a customer. The device stays in the inventory, marked so
 * the automatic matching does not put it straight back.
 */
export async function unlinkCustomerDevice(companyId: number, deviceId: number): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('network_devices')
    .update({ customer_id: null, linked_by: 'manual' })
    .eq('company_id', companyId)
    .eq('id', deviceId)
    .select('id')
  return !error && Boolean(data && data.length)
}

/** Device id → the customer it is linked to, for the inventory list. Empty before 0057. */
export async function deviceCustomers(companyId: number): Promise<Map<number, { id: number; name: string }>> {
  const out = new Map<number, { id: number; name: string }>()
  const { data, error } = await tenantClient()
    .from('network_devices')
    .select('id, customer_id')
    .eq('company_id', companyId)
    .not('customer_id', 'is', null)
    .limit(5000)
  if (error) return out
  const rows = (data ?? []) as { id: number; customer_id: number }[]
  const names = await customerNames(companyId, rows.map((r) => r.customer_id))
  for (const r of rows) out.set(r.id, { id: r.customer_id, name: names.get(r.customer_id) ?? 'Customer' })
  return out
}
