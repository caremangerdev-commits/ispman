import 'server-only'

import { decryptSecret, encryptSecret, hashToken, mintToken } from '@/lib/crypto'
import { tenantClient } from '@/lib/supabase/tenant'
import { normaliseTunnelIp } from '@/lib/tunnels/wireguard'

/**
 * ISPMan's login on a router, and the one-time links that put it there
 * (migration 0052).
 *
 * THE DECRYPTED PASSWORD NEVER LEAVES THIS MODULE'S CALLERS. Everything that
 * returns one says so in its name or its type, and nothing here logs, formats
 * or returns it as part of a wider object a page might render. The rule the
 * rest of the codebase follows for the RADIUS secret — read it where it is
 * needed, never store it on this side — is not available here, because the
 * whole point is that ISPMan can log in again tomorrow. So instead: it is
 * encrypted at rest, and the places that decrypt it are the poller and the
 * device drivers, none of which render anything.
 *
 * ONE MINUTE OF VALIDITY IS THE POINT. A setup token carries, between the
 * script it serves and the row it unlocks, the router's RADIUS secret and its
 * new password. It is single use and 30 minutes old at most, so the line a
 * tenant pastes into a support chat is worthless by the time anyone reads it.
 */

/** How long a pasted line stays good for. */
export const SETUP_TOKEN_MINUTES = 30

export type RouterLogin = {
  user: string
  /** Decrypted. Do not put this in a log line, an error message or a page. */
  password: string
  kind: 'rest' | 'api' | 'ssh'
  port: number | null
}

function parseKind(raw: string | null | undefined): RouterLogin['kind'] {
  return raw === 'ssh' || raw === 'api' ? raw : 'rest'
}

/**
 * Store the login ISPMan will use on a router.
 *
 * Encrypts before the write, so a failed write leaves nothing readable and a
 * succeeded one holds no plaintext. Scoped by company as well as id: a tunnel
 * id from somewhere else cannot be written to.
 */
export async function storeRouterLogin(
  companyId: number,
  tunnelId: number,
  login: { user: string; password: string; kind?: RouterLogin['kind']; port?: number | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  let ciphertext: string
  try {
    ciphertext = encryptSecret(login.password)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not encrypt the login.' }
  }

  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .update({
      api_user: login.user,
      api_secret: ciphertext,
      api_kind: login.kind ?? 'api',
      api_port: login.port ?? null,
      // A new login invalidates what the last check concluded.
      api_checked_at: null,
      api_ok: null,
      api_error: null,
    })
    .eq('id', tunnelId)
    .eq('company_id', companyId)
    .is('revoked_at', null)
    .select('id')

  if (error) return { ok: false, error: 'Could not store the router login: ' + error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: 'That router was not found, or has been revoked.' }
  }
  return { ok: true }
}

/** Record what the last attempt to log in concluded, for the status dot. */
export async function recordLoginCheck(
  tunnelId: number,
  result: { ok: boolean; error?: string }
): Promise<void> {
  await tenantClient()
    .from('router_tunnels')
    .update({
      api_checked_at: new Date().toISOString(),
      api_ok: result.ok,
      api_error: result.ok ? null : (result.error ?? 'Could not log in.').slice(0, 300),
    })
    .eq('id', tunnelId)
}

/** A router the poller can log in to. Carries a decrypted password. */
export type PollTarget = {
  tunnelId: number
  companyId: number
  name: string
  tunnelIp: string
  login: RouterLogin
}

/**
 * Every live router that has a login, in every company: exactly what the usage
 * worker iterates.
 *
 * UNSCOPED, like livePeersAllCompanies, and for the same reason — one worker
 * serves every tenant. Never reachable from a tenant's session: the only
 * caller is the worker, which runs as the platform.
 *
 * A row whose ciphertext will not decrypt is SKIPPED, not thrown on. That
 * happens when ROUTER_SECRET_KEY is rotated without re-running setup, and one
 * such router must not stop the other nine being polled.
 */
export async function pollTargetsAllCompanies(): Promise<{
  targets: PollTarget[]
  undecryptable: number
}> {
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .select('id, company_id, name, tunnel_ip, api_user, api_secret, api_kind, api_port')
    .not('api_secret', 'is', null)
    .not('public_key', 'is', null)
    .is('revoked_at', null)
    .order('id')
  if (error) throw new Error('Could not load routers to poll: ' + error.message)

  const rows = (data ?? []) as {
    id: number
    company_id: number
    name: string
    tunnel_ip: string
    api_user: string | null
    api_secret: string
    api_kind: string | null
    api_port: number | null
  }[]

  const targets: PollTarget[] = []
  let undecryptable = 0
  for (const r of rows) {
    const password = decryptSecret(r.api_secret)
    if (!password) {
      undecryptable += 1
      continue
    }
    targets.push({
      tunnelId: r.id,
      companyId: r.company_id,
      name: r.name,
      tunnelIp: normaliseTunnelIp(r.tunnel_ip) ?? String(r.tunnel_ip),
      login: {
        user: r.api_user ?? 'ispman',
        password,
        kind: parseKind(r.api_kind),
        port: r.api_port,
      },
    })
  }
  return { targets, undecryptable }
}

/** One router's login, for a device driver acting on a tenant's behalf. */
export async function routerLoginFor(
  companyId: number,
  tunnelId: number
): Promise<PollTarget | null> {
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .select('id, company_id, name, tunnel_ip, api_user, api_secret, api_kind, api_port')
    .eq('company_id', companyId)
    .eq('id', tunnelId)
    .is('revoked_at', null)
    .maybeSingle()
  if (error) throw new Error('Could not load the router login: ' + error.message)
  if (!data) return null

  const r = data as {
    id: number
    company_id: number
    name: string
    tunnel_ip: string
    api_user: string | null
    api_secret: string | null
    api_kind: string | null
    api_port: number | null
  }
  const password = decryptSecret(r.api_secret)
  if (!password) return null
  return {
    tunnelId: r.id,
    companyId: r.company_id,
    name: r.name,
    tunnelIp: normaliseTunnelIp(r.tunnel_ip) ?? String(r.tunnel_ip),
    login: { user: r.api_user ?? 'ispman', password, kind: parseKind(r.api_kind), port: r.api_port },
  }
}

/* -------------------------------------------------------------------------- */
/* One-time setup links                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Mint a link for one router. Returns the token ONCE — only its hash is kept,
 * so a lost line cannot be recovered, only replaced.
 *
 * Any unused token for the same router is expired first. Two live links for
 * one router would mean two scripts carrying two different passwords, and
 * whichever ran second would silently invalidate the login ISPMan had stored
 * for the first.
 */
export async function createSetupToken(
  companyId: number,
  tunnelId: number,
  createdBy: number | null
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; error: string }> {
  const db = tenantClient()
  const now = new Date()

  const { error: expireError } = await db
    .from('router_setup_tokens')
    .update({ expires_at: now.toISOString() })
    .eq('tunnel_id', tunnelId)
    .is('used_at', null)
    .gt('expires_at', now.toISOString())
  if (expireError) {
    return { ok: false, error: 'Could not retire the previous link: ' + expireError.message }
  }

  const { token, hash } = mintToken()
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_MINUTES * 60_000)
  const { error } = await db.from('router_setup_tokens').insert({
    company_id: companyId,
    tunnel_id: tunnelId,
    token_hash: hash,
    created_by: createdBy,
    expires_at: expiresAt.toISOString(),
  })
  if (error) return { ok: false, error: 'Could not create the setup link: ' + error.message }
  return { ok: true, token, expiresAt }
}

export type ClaimedToken = {
  id: number
  companyId: number
  tunnelId: number
  usedAt: string | null
}

/**
 * Look a token up without spending it.
 *
 * Returns null for unknown, expired or already-used, deliberately without
 * saying which: the caller shows one message for all three, because the
 * difference is only useful to somebody guessing tokens.
 */
export async function findSetupToken(token: string): Promise<ClaimedToken | null> {
  if (!token || token.length < 20) return null
  const { data, error } = await tenantClient()
    .from('router_setup_tokens')
    .select('id, company_id, tunnel_id, used_at, expires_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle()
  if (error || !data) return null

  const row = data as {
    id: number
    company_id: number
    tunnel_id: number
    used_at: string | null
    expires_at: string
  }
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  return { id: row.id, companyId: row.company_id, tunnelId: row.tunnel_id, usedAt: row.used_at }
}

/**
 * Spend a token, and only if nobody else just did.
 *
 * The `.is('used_at', null)` is the whole guard: two routers fetching the same
 * link at once both reach here, and exactly one update matches. The loser is
 * told the link has been used, which is true.
 */
export async function spendSetupToken(
  id: number,
  from: string | null
): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('router_setup_tokens')
    .update({ used_at: new Date().toISOString(), used_from: from })
    .eq('id', id)
    .is('used_at', null)
    .select('id')
  return !error && Boolean(data && data.length > 0)
}

/** Stamp the moment the router reported its key, for the setup screen. */
export async function markKeyReported(id: number): Promise<void> {
  await tenantClient()
    .from('router_setup_tokens')
    .update({ key_at: new Date().toISOString() })
    .eq('id', id)
}
