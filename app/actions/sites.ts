'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  createSite, deleteSite, isSiteKind, placeAtSite, setLinkTarget, siteExists, updateSite, type SiteTable,
} from '@/lib/data/sites'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

export type SiteActionResult = { ok: true; message: string; id?: number } | { ok: false; error: string }

const SITES = '/dashboard/network/sites'
const DEVICES = '/dashboard/network/devices'

async function manager() {
  const session = await getSession()
  return can(session.profile.role, 'manage_router_tunnels') ? session : null
}

function fields(input: { name: string; kind: string; notes: string }) {
  const name = String(input.name ?? '').trim().slice(0, 80)
  const kind = String(input.kind ?? '')
  const notes = String(input.notes ?? '').trim().slice(0, 500) || null
  if (name.length < 2) return { error: 'Give the site a name.' } as const
  if (!isSiteKind(kind)) return { error: 'Choose what kind of site it is.' } as const
  return { name, kind, notes } as const
}

export async function addSite(input: { name: string; kind: string; notes: string }): Promise<SiteActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to add sites.' }
  const f = fields(input)
  if ('error' in f) return { ok: false, error: f.error as string }
  const res = await createSite(session.company.id, session.profile.id ?? null, f)
  if (!res.ok) return res
  await logEvent({ type: 'site_added', tag: '[network]', details: 'Site ' + f.name + ' added | by=' + session.profile.email })
  revalidatePath(SITES)
  return { ok: true, message: f.name + ' added.', id: res.id }
}

export async function editSite(id: number, input: { name: string; kind: string; notes: string }): Promise<SiteActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to change sites.' }
  const f = fields(input)
  if ('error' in f) return { ok: false, error: f.error as string }
  const res = await updateSite(session.company.id, Number(id), f)
  if (!res.ok) return res
  revalidatePath(SITES)
  revalidatePath(SITES + '/' + Number(id))
  return { ok: true, message: 'Saved.' }
}

export async function removeSite(id: number): Promise<SiteActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to remove sites.' }
  if (!(await deleteSite(session.company.id, Number(id)))) return { ok: false, error: 'That site was not found.' }
  await logEvent({ type: 'site_removed', tag: '[network]', details: 'Site #' + Number(id) + ' removed | by=' + session.profile.email })
  revalidatePath(SITES)
  revalidatePath(DEVICES)
  return { ok: true, message: 'Removed.' }
}

const TABLES = new Set<SiteTable>(['device', 'olt', 'router'])

/** Put equipment at a site; siteId null takes it off. */
export async function assignToSite(
  items: { table: string; id: number }[],
  siteId: number | null
): Promise<SiteActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to do that.' }
  const clean = (Array.isArray(items) ? items : [])
    .slice(0, 500)
    .filter((i) => TABLES.has(i?.table as SiteTable) && Number.isInteger(Number(i?.id)))
    .map((i) => ({ table: i.table as SiteTable, id: Number(i.id) }))
  if (clean.length === 0) return { ok: false, error: 'Nothing was selected.' }
  const target = siteId == null ? null : Number(siteId)
  if (target != null && !(await siteExists(session.company.id, target))) return { ok: false, error: 'That site was not found.' }
  const moved = await placeAtSite(session.company.id, clean, target)
  revalidatePath(SITES)
  if (target != null) revalidatePath(SITES + '/' + target)
  revalidatePath(DEVICES)
  return { ok: true, message: target == null ? 'Taken off the site.' : moved + (moved === 1 ? ' device' : ' devices') + ' moved.' }
}

/** Which site a backhaul radio links to. */
export async function linkBackhaul(deviceId: number, siteId: number | null): Promise<SiteActionResult> {
  const session = await manager()
  if (!session) return { ok: false, error: 'You do not have permission to do that.' }
  const target = siteId == null ? null : Number(siteId)
  if (target != null && !(await siteExists(session.company.id, target))) return { ok: false, error: 'That site was not found.' }
  if (!(await setLinkTarget(session.company.id, Number(deviceId), target))) return { ok: false, error: 'That device was not found.' }
  revalidatePath(SITES)
  revalidatePath(DEVICES)
  return { ok: true, message: 'Saved.' }
}
