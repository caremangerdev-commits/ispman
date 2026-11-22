import 'server-only'

import { isDeviceKind, type DeviceKind } from '@/lib/network/classify'
import { tenantClient } from '@/lib/supabase/tenant'

/** Devices that are neither routers nor OLTs (migration 0056). */

export type NetworkDevice = {
  id: number
  kind: DeviceKind
  name: string
  brand: string | null
  model: string | null
  ip: string | null
  mac: string | null
  version: string | null
  foundVia: number | null
  foundOn: string | null
  source: 'manual' | 'discovered'
  notes: string | null
}

type Row = {
  id: number
  kind: string
  name: string
  brand: string | null
  model: string | null
  ip: string | null
  mac: string | null
  version: string | null
  found_via: number | null
  found_on: string | null
  source: string
  notes: string | null
}

const COLUMNS = 'id, kind, name, brand, model, ip, mac, version, found_via, found_on, source, notes'

const toDevice = (r: Row): NetworkDevice => ({
  id: r.id,
  kind: isDeviceKind(r.kind) ? r.kind : 'other',
  name: r.name,
  brand: r.brand,
  model: r.model,
  ip: r.ip,
  mac: r.mac,
  version: r.version,
  foundVia: r.found_via,
  foundOn: r.found_on,
  source: r.source === 'discovered' ? 'discovered' : 'manual',
  notes: r.notes,
})

/** Null means migration 0056 is not applied. */
export async function listDevices(companyId: number): Promise<NetworkDevice[] | null> {
  const out: NetworkDevice[] = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await tenantClient()
      .from('network_devices')
      .select(COLUMNS)
      .eq('company_id', companyId)
      .order('kind')
      .order('name')
      .range(from, from + page - 1)
    if (error) {
      if (error.code === 'PGRST205' || error.code === '42P01') return null
      throw new Error('Could not load devices: ' + error.message)
    }
    const rows = (data ?? []) as Row[]
    out.push(...rows.map(toDevice))
    if (rows.length < page) break
  }
  return out
}

export type NewDevice = {
  kind: DeviceKind
  name: string
  brand?: string | null
  model?: string | null
  ip?: string | null
  mac?: string | null
  version?: string | null
  foundVia?: number | null
  foundOn?: string | null
  source: 'manual' | 'discovered'
  notes?: string | null
}

/**
 * Adds devices, skipping any whose MAC is already recorded for the company.
 * Returns how many were actually added.
 */
export async function addDevices(
  companyId: number,
  createdBy: number | null,
  devices: NewDevice[]
): Promise<{ ok: true; added: number } | { ok: false; error: string }> {
  if (devices.length === 0) return { ok: true, added: 0 }
  const rows = devices.map((d) => ({
    company_id: companyId,
    kind: d.kind,
    name: d.name.slice(0, 120),
    brand: d.brand || null,
    model: d.model || null,
    ip: d.ip || null,
    mac: d.mac ? d.mac.toUpperCase() : null,
    version: d.version || null,
    found_via: d.foundVia ?? null,
    found_on: d.foundOn || null,
    source: d.source,
    notes: d.notes || null,
    created_by: createdBy,
  }))
  const { data, error } = await tenantClient()
    .from('network_devices')
    .upsert(rows, { onConflict: 'company_id,mac', ignoreDuplicates: true })
    .select('id')
  if (error) return { ok: false, error: 'Could not save: ' + error.message }
  return { ok: true, added: (data ?? []).length }
}

export async function updateDeviceKind(companyId: number, id: number, kind: DeviceKind): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('network_devices')
    .update({ kind })
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id')
  return !error && Boolean(data && data.length)
}

export async function deleteDevice(companyId: number, id: number): Promise<boolean> {
  // Remembered by MAC, so the automatic pass does not add it straight back.
  const { data: row } = await tenantClient()
    .from('network_devices')
    .select('mac')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  const mac = (row as { mac: string | null } | null)?.mac
  if (mac) {
    await tenantClient()
      .from('network_device_dismissed')
      .upsert({ company_id: companyId, mac: mac.toUpperCase() }, { onConflict: 'company_id,mac', ignoreDuplicates: true })
  }
  const { data, error } = await tenantClient()
    .from('network_devices')
    .delete()
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id')
  return !error && Boolean(data && data.length)
}

/** Device id → whether it answered the last checks (migration 0059). Empty before it. */
export async function deviceStatuses(
  companyId: number
): Promise<Map<number, { status: 'up' | 'down'; since: string | null }>> {
  const out = new Map<number, { status: 'up' | 'down'; since: string | null }>()
  const { data, error } = await tenantClient()
    .from('network_devices')
    .select('id, status, status_at')
    .eq('company_id', companyId)
    .not('status', 'is', null)
    .limit(5000)
  if (error) return out
  for (const r of (data ?? []) as { id: number; status: string; status_at: string | null }[]) {
    if (r.status === 'up' || r.status === 'down') out.set(r.id, { status: r.status, since: r.status_at })
  }
  return out
}
