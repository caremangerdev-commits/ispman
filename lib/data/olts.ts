import 'server-only'

import { decryptSecret, encryptSecret } from '@/lib/crypto'
import type { OltInfo, OltLogin } from '@/lib/olt/types'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * A company's OLTs (migration 0054).
 *
 * THE LIST NEVER CARRIES A PASSWORD. `Olt` is what pages render and has no
 * secret in it at all; the decrypted login is only handed out by oltWithLogin,
 * to the code that is about to connect to the device.
 */

export type Olt = {
  id: number
  tunnelId: number
  name: string
  brand: string
  model: string | null
  mgmtIp: string
  cliPort: number
  cliUser: string
  forwardPort: number | null
  forwardOk: boolean | null
  checkedAt: string | null
  ok: boolean | null
  error: string | null
  info: OltInfo | null
  /** The VLAN new ONUs are carried on. Null until one has been chosen. */
  serviceVlan: number | null
  createdAt: string
}

const COLUMNS =
  'id, tunnel_id, name, brand, model, mgmt_ip, cli_port, cli_user, forward_port, forward_ok, ' +
  'checked_at, ok, error, info, created_at'

/**
 * service_vlan arrived in 0055, after the table. Asked for separately, so a
 * server that has 0054 but not yet 0055 still lists its OLTs.
 */
async function serviceVlans(companyId: number): Promise<Map<number, number>> {
  const { data, error } = await tenantClient()
    .from('olts')
    .select('id, service_vlan')
    .eq('company_id', companyId)
  const out = new Map<number, number>()
  if (error) return out
  for (const r of (data ?? []) as { id: number; service_vlan: number | null }[]) {
    if (r.service_vlan) out.set(r.id, r.service_vlan)
  }
  return out
}

export async function setServiceVlan(companyId: number, id: number, vlan: number): Promise<void> {
  await tenantClient().from('olts').update({ service_vlan: vlan }).eq('company_id', companyId).eq('id', id)
}

type Row = {
  id: number
  tunnel_id: number
  name: string
  brand: string
  model: string | null
  mgmt_ip: string
  cli_port: number
  cli_user: string
  forward_port: number | null
  forward_ok: boolean | null
  checked_at: string | null
  ok: boolean | null
  error: string | null
  info: OltInfo | null
  created_at: string
}

const toOlt = (r: Row, vlans?: Map<number, number>): Olt => ({
  serviceVlan: vlans?.get(r.id) ?? null,
  id: r.id,
  tunnelId: r.tunnel_id,
  name: r.name,
  brand: r.brand,
  model: r.model,
  mgmtIp: r.mgmt_ip,
  cliPort: r.cli_port,
  cliUser: r.cli_user,
  forwardPort: r.forward_port,
  forwardOk: r.forward_ok,
  checkedAt: r.checked_at,
  ok: r.ok,
  error: r.error,
  info: r.info,
  createdAt: r.created_at,
})

const missing = (code: string | undefined) => code === 'PGRST205' || code === '42P01'

/** Null means migration 0054 is not applied, so the page can say so. */
export async function listOlts(companyId: number): Promise<Olt[] | null> {
  const { data, error } = await tenantClient()
    .from('olts')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .order('id')
  if (error) {
    if (missing(error.code)) return null
    throw new Error('Could not load OLTs: ' + error.message)
  }
  const vlans = await serviceVlans(companyId)
  return ((data ?? []) as unknown as Row[]).map((r) => toOlt(r, vlans))
}

export async function getOlt(companyId: number, id: number): Promise<Olt | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const { data, error } = await tenantClient()
    .from('olts')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    if (missing(error.code)) return null
    throw new Error('Could not load the OLT: ' + error.message)
  }
  return data ? toOlt(data as unknown as Row, await serviceVlans(companyId)) : null
}

export async function oltWithLogin(
  companyId: number,
  id: number
): Promise<{ olt: Olt; login: OltLogin } | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const { data, error } = await tenantClient()
    .from('olts')
    .select(COLUMNS + ', cli_secret, enable_secret')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error('Could not load the OLT: ' + error.message)
  if (!data) return null
  const row = data as unknown as Row & { cli_secret: string; enable_secret: string | null }
  const password = decryptSecret(row.cli_secret)
  if (!password) return null
  return {
    olt: toOlt(row, await serviceVlans(companyId)),
    login: {
      user: row.cli_user,
      password,
      enablePassword: decryptSecret(row.enable_secret),
    },
  }
}

export async function createOlt(
  companyId: number,
  createdBy: number | null,
  input: {
    tunnelId: number
    name: string
    brand: string
    mgmtIp: string
    cliPort: number
    cliUser: string
    cliPassword: string
    enablePassword: string | null
  }
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  let secret: string
  let enable: string | null = null
  try {
    secret = encryptSecret(input.cliPassword)
    if (input.enablePassword) enable = encryptSecret(input.enablePassword)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not encrypt the login.' }
  }

  const { data, error } = await tenantClient()
    .from('olts')
    .insert({
      company_id: companyId,
      tunnel_id: input.tunnelId,
      name: input.name,
      brand: input.brand,
      mgmt_ip: input.mgmtIp,
      cli_port: input.cliPort,
      cli_user: input.cliUser,
      cli_secret: secret,
      enable_secret: enable,
      created_by: createdBy,
    })
    .select('id')
    .single()
  if (error) return { ok: false, error: 'Could not save the OLT: ' + error.message }
  return { ok: true, id: (data as { id: number }).id }
}

export async function setOltForward(
  companyId: number,
  id: number,
  forwardPort: number,
  ok: boolean
): Promise<void> {
  await tenantClient()
    .from('olts')
    .update({ forward_port: forwardPort, forward_ok: ok })
    .eq('company_id', companyId)
    .eq('id', id)
}

export async function recordOltCheck(
  companyId: number,
  id: number,
  result: { ok: true; info: OltInfo } | { ok: false; error: string }
): Promise<void> {
  const { error } = await tenantClient()
    .from('olts')
    .update(
      result.ok
        ? {
            checked_at: new Date().toISOString(),
            ok: true,
            error: null,
            info: result.info,
            model: result.info.model,
          }
        : { checked_at: new Date().toISOString(), ok: false, error: result.error.slice(0, 300) }
    )
    .eq('company_id', companyId)
    .eq('id', id)
  // Thrown, not swallowed: the caller is about to tell someone the OLT is
  // connected, and that must not be said if the result was never saved.
  if (error) throw new Error('Could not save the check result: ' + error.message)
}

export async function deleteOlt(companyId: number, id: number): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('olts')
    .delete()
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id')
  return !error && Boolean(data && data.length)
}

/** An OLT the background pass will read: its login, and what it may do there. */
export type OltWatchTarget = {
  companyId: number
  olt: Olt
  login: OltLogin
  autoAuthorise: boolean
}

/**
 * Every OLT of every company that last answered, for the background pass.
 * Empty before migration 0058, which is what makes the pass skip OLTs.
 *
 * An OLT whose last check failed is left out: a wrong password retried every
 * few minutes is how an account gets locked. Refresh on its page brings it
 * back in.
 */
export async function oltWatchTargets(): Promise<OltWatchTarget[]> {
  const { data, error } = await tenantClient()
    .from('olts')
    .select(COLUMNS + ', company_id, cli_secret, enable_secret, service_vlan, auto_authorise')
    .eq('ok', true)
    .order('id')
  if (error) return []
  const out: OltWatchTarget[] = []
  for (const raw of data ?? []) {
    const row = raw as unknown as Row & {
      company_id: number
      cli_secret: string
      enable_secret: string | null
      service_vlan: number | null
      auto_authorise: boolean | null
    }
    const password = decryptSecret(row.cli_secret)
    if (!password) continue
    out.push({
      companyId: row.company_id,
      olt: toOlt(row, new Map(row.service_vlan ? [[row.id, row.service_vlan]] : [])),
      login: { user: row.cli_user, password, enablePassword: decryptSecret(row.enable_secret) },
      autoAuthorise: row.auto_authorise === true,
    })
  }
  return out
}

/** Whether new ONUs are let on without a click. False before migration 0058. */
export async function getAutoAuthorise(companyId: number, id: number): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('olts')
    .select('auto_authorise')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return false
  return (data as { auto_authorise: boolean | null }).auto_authorise === true
}

export async function setAutoAuthorise(companyId: number, id: number, on: boolean): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('olts')
    .update({ auto_authorise: on })
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id')
  return !error && Boolean(data && data.length)
}
