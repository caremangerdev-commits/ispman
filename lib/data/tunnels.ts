import 'server-only'

import { tenantClient } from '@/lib/supabase/tenant'
import { normaliseTunnelIp, parseServices, type RouterService } from '@/lib/tunnels/wireguard'

/** One router's tunnel (migration 0033). */
export type RouterTunnel = {
  id: number
  name: string
  tunnelIp: string
  /** Null until the owner pastes the key the router generated. */
  publicKey: string | null
  services: RouterService[]
  createdAt: string
  createdByName: string | null
  keySetAt: string | null
  revokedAt: string | null
}

const COLUMNS =
  'id, name, tunnel_ip, public_key, services, created_at, created_by_name, key_set_at, revoked_at'

type Row = {
  id: number
  name: string
  tunnel_ip: string
  public_key: string | null
  services: string | null
  created_at: string
  created_by_name: string | null
  key_set_at: string | null
  revoked_at: string | null
}

function toTunnel(r: Row): RouterTunnel {
  return {
    id: r.id,
    name: r.name,
    // The column is inet, so anything in it is an address; this only strips a
    // prefix if one came back.
    tunnelIp: normaliseTunnelIp(r.tunnel_ip) ?? String(r.tunnel_ip),
    publicKey: r.public_key,
    services: parseServices(String(r.services ?? '').split(',')),
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    keySetAt: r.key_set_at,
    revokedAt: r.revoked_at,
  }
}

/** A company's tunnels, live first by address, then revoked ones. */
export async function listRouterTunnels(companyId: number): Promise<RouterTunnel[]> {
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .order('id')
  if (error) throw new Error('Could not load router tunnels: ' + error.message)
  return ((data ?? []) as Row[]).map(toTunnel)
}

export async function getRouterTunnel(companyId: number, id: number): Promise<RouterTunnel | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error('Could not load router tunnel #' + id + ': ' + error.message)
  return data ? toTunnel(data as Row) : null
}

/**
 * Every tunnel address ever handed out, by any company, revoked or not.
 *
 * DELIBERATELY NOT SCOPED TO A COMPANY, and the one read in this module that
 * is not. The address space is the platform's: two tenants given the same
 * inside address would share a nas row. Returns addresses only.
 */
export async function allocatedTunnelIps(): Promise<string[]> {
  const { data, error } = await tenantClient().from('router_tunnels').select('tunnel_ip')
  if (error) throw new Error('Could not read allocated tunnel addresses: ' + error.message)
  return ((data ?? []) as { tunnel_ip: string }[]).map((r) => String(r.tunnel_ip))
}

/**
 * How many routers a company holds now, and how many addresses it has ever
 * been handed (revoked included: an address is never reused). For the caps
 * in lib/tunnels/wireguard.ts.
 */
export async function companyTunnelCounts(companyId: number): Promise<{ live: number; total: number }> {
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .select('revoked_at')
    .eq('company_id', companyId)
  if (error) throw new Error('Could not count router tunnels: ' + error.message)
  const rows = (data ?? []) as { revoked_at: string | null }[]
  return { live: rows.filter((r) => r.revoked_at === null).length, total: rows.length }
}

/** A router the server's WireGuard interface should have as a peer. */
export type LivePeer = {
  id: number
  companyId: number
  companyName: string
  name: string
  tunnelIp: string
  publicKey: string
  keySetAt: string | null
}

/**
 * Every live router with a key, in every company: exactly the peer list the
 * server's WireGuard interface should hold. Read by the root job through
 * /api/tunnels/peers, and by the platform overview.
 *
 * Unscoped on purpose, like allocatedTunnelIps: the server serves every tenant.
 * Never reachable from a tenant's session — both callers are the platform's.
 */
export async function livePeersAllCompanies(): Promise<LivePeer[]> {
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .select('id, company_id, name, tunnel_ip, public_key, key_set_at, companies(name)')
    .not('public_key', 'is', null)
    .is('revoked_at', null)
    .order('id')
  if (error) throw new Error('Could not load live router tunnels: ' + error.message)

  const rows = (data ?? []) as unknown as {
    id: number
    company_id: number
    name: string
    tunnel_ip: string
    public_key: string
    key_set_at: string | null
    companies: { name: string } | { name: string }[] | null
  }[]
  return rows.map((r) => {
    const company = Array.isArray(r.companies) ? r.companies[0] : r.companies
    return {
      id: r.id,
      companyId: r.company_id,
      companyName: company?.name ?? 'Company #' + r.company_id,
      name: r.name,
      tunnelIp: normaliseTunnelIp(r.tunnel_ip) ?? String(r.tunnel_ip),
      publicKey: r.public_key,
      keySetAt: r.key_set_at,
    }
  })
}

/**
 * The tunnel already holding this public key, in any company, revoked or
 * not, or null. Unscoped for the same reason as allocatedTunnelIps: one key
 * on two peers would have the server flapping between two routers. A revoked
 * tunnel keeps its key, so a revoked router's key cannot come back either.
 * Returns ids only.
 */
export async function tunnelHoldingKey(
  publicKey: string
): Promise<{ id: number; companyId: number; revoked: boolean } | null> {
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .select('id, company_id, revoked_at')
    .eq('public_key', publicKey)
    .maybeSingle()
  if (error) throw new Error('Could not check the public key: ' + error.message)
  const row = data as { id: number; company_id: number; revoked_at: string | null } | null
  return row ? { id: row.id, companyId: row.company_id, revoked: row.revoked_at !== null } : null
}
