'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  allocatedTunnelIps, companyTunnelCounts, getRouterTunnel, tunnelHoldingKey, type RouterTunnel,
} from '@/lib/data/tunnels'
import { can } from '@/lib/permissions'
import { addTunnelNas, readTunnelSecret, removeTunnelNas } from '@/lib/radius/operations'
import { getSchemaCapabilities } from '@/lib/schema'
import { displayName, requirePermission, type Session } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import {
  generateRadiusSecret, tunnelServer, tunnelSyncConfigured, type TunnelServer,
} from '@/lib/tunnels/server'
import {
  MAX_ADDRESSES_PER_COMPANY, MAX_LIVE_ROUTERS_PER_COMPANY, ROUTER_REMOVE,
  nasDescription, nasShortname, nextTunnelIp, parseServices, parseWireGuardKey,
  routerConnect, routerNameProblem, serverAddPeer, serverRemovePeer, serverReplacePeer,
  TUNNEL_NETWORK,
  type ConfigBlock, type RouterCommand, type TunnelLabel,
} from '@/lib/tunnels/wireguard'

/**
 * Router tunnels: what the guide on the settings page asks the server to do.
 *
 * TWO AUDIENCES. manage_router_tunnels (company admin and above) may add,
 * key, show and revoke a company's own routers, and gets ROUTER commands.
 * The server half of every change — the WireGuard peer, the RADIUS restart —
 * needs root on the box, so only apply_router_tunnels_on_server (the platform
 * operator) is handed a SERVER block or told how the server is set up. A
 * tenant is told the platform operator does that half.
 *
 * AND ONCE THE SERVER RUNS ITSELF (tunnelSyncConfigured: the root job and the
 * RADIUS server's on-demand clients are installed), nobody is handed a server
 * block at all. The job applies the change within a minute and no restart is
 * needed. A hand-run server block would only fight the job.
 *
 * ROUTER COMMANDS COME ONE PER LINE (lib/tunnels/wireguard.ts says why), so
 * a result carries a list of commands, not a block of text. Step 2's commands
 * are not here at all: they hold nothing from the server, so the guide builds
 * them itself.
 *
 * THE POOL CAPS hold a company admin, not the platform operator.
 *
 * NOTHING TENANT-FACING SAYS "FreeRADIUS" (owner, 13 Oct 2026). The one
 * exception is the literal service command inside a server block, which only
 * the operator sees.
 *
 * The order inside each action is the rule from lib/radius/operations.ts: the
 * RADIUS write first, and Supabase only once it has landed — so a failure
 * leaves the router exactly as it was, never with a key recorded against a
 * RADIUS entry that does not exist.
 *
 * NO PRIVATE KEY PASSES THROUGH HERE. The router generates its own and prints
 * only the public half; that is all these actions accept and all they return.
 * The RADIUS secret does pass through — it has to be in step 4 — but it is
 * read from the RADIUS server's table each time and never stored on this side.
 */

export type TunnelActionResult =
  | {
      ok: true
      message: string
      /** The router just added, so the guide can carry on with it. */
      tunnelId?: number
      /** Commands for the router: one line each, one copy button each. */
      router?: RouterCommand[]
      /** When the router commands are only needed in some cases, says which. */
      routerNote?: string
      /** A root-shell block: the platform operator, hand-run mode, only. */
      server?: ConfigBlock
    }
  | { ok: false; error: string }

const PATH = '/dashboard/settings/tunnels'

const NOT_READY = 'Router tunnels are not set up on this system yet: migration 0033 has not been applied.'

/** What a tenant is told when the operator's half of the server is not configured. */
const SERVER_UNAVAILABLE =
  "Router tunnels aren't available on this server yet. Ask the platform operator to finish setting them up."

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

function label(session: Session, tunnel: Pick<RouterTunnel, 'name'>): TunnelLabel {
  return { companyName: session.company.name, routerName: tunnel.name }
}

/** True for the platform operator, who has root on the server and runs its half. */
function isOperator(session: Session): boolean {
  return can(session.profile.role, 'apply_router_tunnels_on_server')
}

/**
 * Who does the server half of a change:
 *   auto      the root job, within a minute — nobody is handed a server block
 *   operator  the caller, by hand, from the server block
 *   tenant    the platform operator, by hand, later
 */
type ServerHalf = 'auto' | 'operator' | 'tenant'

function serverHalf(session: Session): ServerHalf {
  if (tunnelSyncConfigured()) return 'auto'
  return isOperator(session) ? 'operator' : 'tenant'
}

/** The server's details, or a refusal worded for whoever is asking. */
function serverFor(session: Session): { server: TunnelServer } | { refused: TunnelActionResult } {
  const srv = tunnelServer()
  if (srv.ok) return { server: srv.server }
  return { refused: { ok: false, error: isOperator(session) ? srv.problem : SERVER_UNAVAILABLE } }
}

/** The session, or a refusal when 0033 is missing. */
async function begin(): Promise<{ session: Session } | { refused: TunnelActionResult }> {
  const session = await requirePermission('manage_router_tunnels')
  if (!(await getSchemaCapabilities()).routerTunnels) {
    return { refused: { ok: false, error: NOT_READY } }
  }
  return { session }
}

/** A live tunnel of this company named by the form, or a refusal. */
async function liveTunnel(
  session: Session,
  formData: FormData
): Promise<{ tunnel: RouterTunnel } | { refused: TunnelActionResult }> {
  const tunnel = await getRouterTunnel(session.company.id, Number(str(formData, 'id')))
  if (!tunnel) return { refused: { ok: false, error: 'That router tunnel was not found.' } }
  if (tunnel.revokedAt) {
    return { refused: { ok: false, error: tunnel.name + ' was revoked. Add it again to give it a new tunnel.' } }
  }
  return { tunnel }
}

function connect(tunnel: RouterTunnel, server: TunnelServer, secret: string): RouterCommand[] {
  return routerConnect({
    tunnelIp: tunnel.tunnelIp,
    serverPublicKey: server.publicKey,
    serverEndpoint: server.endpoint,
    serverPort: server.port,
    secret,
    services: tunnel.services,
  })
}

// ---------------------------------------------------------------------------
// Step 1: add the router
// ---------------------------------------------------------------------------

export async function addRouterTunnel(
  _prev: TunnelActionResult | null,
  formData: FormData
): Promise<TunnelActionResult> {
  const started = await begin()
  if ('refused' in started) return started.refused
  const { session } = started
  const { profile, company } = session

  // The operator may add routers ahead of finishing the server; a tenant would
  // only be handed a step 2 they could never complete, and an address used up.
  if (!isOperator(session)) {
    if (!tunnelServer().ok) return { ok: false, error: SERVER_UNAVAILABLE }

    const counts = await companyTunnelCounts(company.id)
    if (counts.live >= MAX_LIVE_ROUTERS_PER_COMPANY) {
      return {
        ok: false,
        error:
          company.name + ' already has ' + counts.live + ' routers, the most a company can have. ' +
          'Revoke one that is no longer used, or ask the platform operator.',
      }
    }
    if (counts.total >= MAX_ADDRESSES_PER_COMPANY) {
      return {
        ok: false,
        error:
          company.name + ' has been given ' + counts.total + ' tunnel addresses, the most a company ' +
          'can have. Revoked routers count, because an address is never reused. Ask the platform operator.',
      }
    }
  }

  const name = str(formData, 'name')
  const nameProblem = routerNameProblem(name)
  if (nameProblem) return { ok: false, error: nameProblem }

  const services = parseServices(formData.getAll('services').map(String))
  if (services.length === 0) {
    return { ok: false, error: 'Choose at least one service for the tunnel to carry.' }
  }

  // The lowest free address, platform-wide. Two people adding at the same
  // moment can pick the same one; the unique index refuses the second, which
  // then takes the next address.
  let added: { id: number; ip: string } | null = null
  for (let attempt = 0; attempt < 3 && !added; attempt++) {
    const ip = nextTunnelIp(await allocatedTunnelIps())
    if (!ip) {
      return { ok: false, error: 'The tunnel network ' + TUNNEL_NETWORK + ' is full.' }
    }
    const { data, error } = await tenantClient()
      .from('router_tunnels')
      .insert({
        company_id: company.id,
        name,
        tunnel_ip: ip,
        services: services.join(','),
        created_by: profile.id,
        created_by_name: displayName(profile),
      })
      .select('id')
      .single()
    if (!error && data) added = { id: (data as { id: number }).id, ip }
    else if (error?.code !== '23505') {
      return { ok: false, error: 'Could not save the router: ' + (error?.message ?? 'no row returned') }
    }
  }
  if (!added) {
    return { ok: false, error: 'Another router took the same address at the same moment. Try again.' }
  }

  await logEvent({
    type: 'router_tunnel_added',
    tag: '[tunnels]',
    details:
      'Router tunnel added: ' + name + ' at ' + added.ip + ', waiting for the router\'s key' +
      ' | services=' + services.join(',') + ' | by=' + profile.email,
  })

  revalidatePath(PATH)
  return { ok: true, message: 'Added ' + name + ' at ' + added.ip + '.', tunnelId: added.id }
}

// ---------------------------------------------------------------------------
// Step 3: the key the router printed — first time, or a replacement
// ---------------------------------------------------------------------------

export async function setRouterTunnelKey(
  _prev: TunnelActionResult | null,
  formData: FormData
): Promise<TunnelActionResult> {
  const started = await begin()
  if ('refused' in started) return started.refused
  const { session } = started
  const { profile, company } = session
  const half = serverHalf(session)

  const found = await liveTunnel(session, formData)
  if ('refused' in found) return found.refused
  const { tunnel } = found

  const key = parseWireGuardKey(str(formData, 'public_key'))
  if (!key) {
    return {
      ok: false,
      error:
        'That is not a WireGuard public key. It is one line of 44 characters ending in "=", ' +
        'exactly as the router printed it in step 2.',
    }
  }

  // Step 4 cannot be written without the server's details, so nothing is
  // recorded until they are there — a key saved now would leave the router
  // half set up with no way to finish it.
  const srv = serverFor(session)
  if ('refused' in srv) return srv.refused
  const { server } = srv

  if (key === server.publicKey) {
    return { ok: false, error: "That is the server's own key. Paste the key the router printed." }
  }
  if (key === tunnel.publicKey) {
    return { ok: false, error: 'That key is already the one recorded for ' + tunnel.name + '.' }
  }
  const holder = await tunnelHoldingKey(key)
  if (holder) {
    return {
      ok: false,
      error: holder.revoked
        ? 'That key belonged to router tunnel #' + holder.id + ', which was revoked, and a key is never ' +
          'reused. Take the old tunnel off the router (the commands shown when it was revoked), then ' +
          'do step 2 again for a new key.'
        : 'That key already belongs to router tunnel #' + holder.id +
          '. Every router must make its own: do step 2 on this router.',
    }
  }

  const names = label(session, tunnel)
  const peer = { ...names, tunnelId: tunnel.id, tunnelIp: tunnel.tunnelIp, publicKey: key }

  // --- First key: the RADIUS entry, then the key ----------------------------
  if (!tunnel.publicKey) {
    const secret = generateRadiusSecret()
    const nas = await addTunnelNas({
      tunnelIp: tunnel.tunnelIp,
      shortname: nasShortname(tunnel.tunnelIp, company.name, tunnel.name),
      secret,
      description: nasDescription(tunnel.id, company.name, tunnel.name),
    })
    if (!nas.ok) return { ok: false, error: nas.error }

    // Only if nobody set a key in between: the RADIUS entry just written is
    // this action's, and it must not end up paired with somebody else's key.
    const { data, error } = await tenantClient()
      .from('router_tunnels')
      .update({ public_key: key, key_set_at: new Date().toISOString() })
      .eq('id', tunnel.id)
      .eq('company_id', company.id)
      .is('public_key', null)
      .is('revoked_at', null)
      .select('id')
    if (error || !data || data.length === 0) {
      // Take the entry back out, so a failed save leaves nothing behind.
      const undo = await removeTunnelNas(tunnel.tunnelIp)
      return {
        ok: false,
        error:
          'Could not record the key' +
          (error ? ': ' + error.message : ': the router was changed while this was saving') + '. ' +
          (undo.ok
            ? 'Its RADIUS server entry was removed again; nothing has changed.'
            : 'Its RADIUS server entry for ' + tunnel.tunnelIp + ' could NOT be removed (' + undo.error +
              '). Ask the platform operator to remove it before trying again.'),
      }
    }

    await logEvent({
      type: 'router_tunnel_key_set',
      tag: '[tunnels]',
      details:
        'Router tunnel key set: ' + tunnel.name + ' at ' + tunnel.tunnelIp +
        '. Added to the RADIUS server' +
        (half === 'auto' ? '' : ', which loads it on its next restart') +
        ' | public_key=' + key + ' | by=' + profile.email,
    })

    revalidatePath(PATH)
    return {
      ok: true,
      message:
        half === 'operator'
          ? 'Key saved. Run the server block as root, then the router commands.'
          : half === 'auto'
            ? 'Key saved. The server adds this router by itself within a minute.'
            : 'Key saved. The platform operator adds the server side; until then the router keeps ' +
              'using its current RADIUS settings.',
      router: connect(tunnel, server, secret),
      server: half === 'operator' ? serverAddPeer(peer) : undefined,
    }
  }

  // --- A replacement --------------------------------------------------------
  // A router that was reset or replaced makes a new key. Same address, same
  // RADIUS entry, same secret; only the server's peer changes.
  if (str(formData, 'confirm_replace') !== 'yes') {
    return { ok: false, error: tunnel.name + ' already has a key. Use Replace key to change it.' }
  }
  const oldKey = tunnel.publicKey

  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .update({ public_key: key, key_set_at: new Date().toISOString() })
    .eq('id', tunnel.id)
    .eq('company_id', company.id)
    .eq('public_key', oldKey)
    .is('revoked_at', null)
    .select('id')
  if (error || !data || data.length === 0) {
    return {
      ok: false,
      error:
        'Could not replace the key' +
        (error ? ': ' + error.message : ': it was changed while this was saving. Reload and try again') + '.',
    }
  }

  await logEvent({
    type: 'router_tunnel_key_replaced',
    tag: '[tunnels]',
    details:
      'Router tunnel key replaced: ' + tunnel.name + ' at ' + tunnel.tunnelIp +
      ' | old_key=' + oldKey + ' | new_key=' + key + ' | by=' + profile.email,
  })

  const secret = await readTunnelSecret(tunnel.tunnelIp)

  revalidatePath(PATH)
  return {
    ok: true,
    message:
      half === 'operator'
        ? 'Key replaced. Run the server block as root.'
        : half === 'auto'
          ? 'Key replaced. The server switches to the new key within a minute.'
          : 'Key replaced. The tunnel stays down until the platform operator updates the server side.',
    router: secret.ok && secret.secret ? connect(tunnel, server, secret.secret) : undefined,
    routerNote:
      'Only if the router was reset or replaced and has lost its tunnel settings. If it kept them, ' +
      'the new key is all that changed and there is nothing to paste.',
    server: half === 'operator' ? serverReplacePeer({ ...peer, oldPublicKey: oldKey }) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Step 4 again: a router's connect commands
// ---------------------------------------------------------------------------

export async function showRouterTunnelConfig(
  _prev: TunnelActionResult | null,
  formData: FormData
): Promise<TunnelActionResult> {
  const started = await begin()
  if ('refused' in started) return started.refused
  const { session } = started

  const found = await liveTunnel(session, formData)
  if ('refused' in found) return found.refused
  const { tunnel } = found

  if (!tunnel.publicKey) {
    return { ok: false, error: 'There is no key for ' + tunnel.name + ' yet: do steps 2 and 3 first.' }
  }

  const srv = serverFor(session)
  if ('refused' in srv) return srv.refused
  const secret = await readTunnelSecret(tunnel.tunnelIp)
  if (!secret.ok) return { ok: false, error: secret.error }
  if (!secret.secret) {
    return {
      ok: false,
      error:
        'The RADIUS server has no entry for ' + tunnel.tunnelIp + ', so it will not answer this ' +
        'router. Revoke the tunnel and add the router again.',
    }
  }

  const names = label(session, tunnel)
  return {
    ok: true,
    message: '',
    router: connect(tunnel, srv.server, secret.secret),
    server:
      serverHalf(session) === 'operator'
        ? serverAddPeer({ ...names, tunnelId: tunnel.id, tunnelIp: tunnel.tunnelIp, publicKey: tunnel.publicKey })
        : undefined,
  }
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export async function revokeRouterTunnel(
  _prev: TunnelActionResult | null,
  formData: FormData
): Promise<TunnelActionResult> {
  const started = await begin()
  if ('refused' in started) return started.refused
  const { session } = started
  const { profile, company } = session

  const found = await liveTunnel(session, formData)
  if ('refused' in found) return found.refused
  const { tunnel } = found

  const nas = await removeTunnelNas(tunnel.tunnelIp)
  if (!nas.ok) return { ok: false, error: nas.error }

  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .update({ revoked_at: new Date().toISOString(), revoked_by: profile.id })
    .eq('id', tunnel.id)
    .eq('company_id', company.id)
    .is('revoked_at', null)
    .select('id')
  if (error || !data || data.length === 0) {
    return {
      ok: false,
      error:
        tunnel.name + ' was removed from the RADIUS server, but the tunnel could not be marked ' +
        'revoked' + (error ? ': ' + error.message : '') + '. Try Revoke again.',
    }
  }

  await logEvent({
    type: 'router_tunnel_revoked',
    tag: '[tunnels]',
    details:
      'Router tunnel revoked: ' + tunnel.name + ' at ' + tunnel.tunnelIp +
      '. Removed from the RADIUS server; the address is not reused' +
      (tunnel.publicKey ? ' | public_key=' + tunnel.publicKey : '') + ' | by=' + profile.email,
  })

  const names = label(session, tunnel)
  const half = serverHalf(session)

  revalidatePath(PATH)
  return {
    ok: true,
    message:
      half === 'operator'
        ? tunnel.name + ' revoked and removed from the RADIUS server, which keeps it loaded until it ' +
          'next restarts. Run the server block as root to drop the peer, and the commands below on the router.'
        : half === 'auto'
          ? tunnel.name + ' revoked and removed from the RADIUS server; the server drops its tunnel ' +
            'within a minute. Run the commands below on the router to take the tunnel off it.'
          : tunnel.name + ' revoked and removed from the RADIUS server. Run the commands below on the ' +
            'router to take the tunnel off it; the platform operator removes the server side.',
    router: ROUTER_REMOVE,
    routerNote:
      'Only if the router still has its other RADIUS entry, or is being retired: without one it has ' +
      'no RADIUS at all.',
    server:
      half === 'operator' && tunnel.publicKey
        ? serverRemovePeer({ ...names, tunnelId: tunnel.id, tunnelIp: tunnel.tunnelIp, publicKey: tunnel.publicKey })
        : undefined,
  }
}
