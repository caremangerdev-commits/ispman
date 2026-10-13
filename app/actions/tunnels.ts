'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  allocatedTunnelIps, getRouterTunnel, tunnelHoldingKey, type RouterTunnel,
} from '@/lib/data/tunnels'
import { can } from '@/lib/permissions'
import { addTunnelNas, readTunnelSecret, removeTunnelNas } from '@/lib/radius/operations'
import { getSchemaCapabilities } from '@/lib/schema'
import { displayName, requirePermission, type Session } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { generateRadiusSecret, tunnelServer, type TunnelServer } from '@/lib/tunnels/server'
import {
  nasDescription, nasShortname, nextTunnelIp, parseServices, parseWireGuardKey,
  routerNameProblem, routerRemove, routerStepOne, routerStepTwo, serverAddPeer,
  serverRemovePeer, serverReplacePeer, TUNNEL_NETWORK,
  type ConfigBlock, type TunnelLabel,
} from '@/lib/tunnels/wireguard'

/**
 * Router tunnels: the four things the settings card does.
 *
 * TWO AUDIENCES. manage_router_tunnels (company admin and above) may add,
 * key, show and revoke a company's own routers, and is handed the ROUTER
 * blocks. The server half of every change — the WireGuard peer, the RADIUS
 * restart — needs root on the box, so only apply_router_tunnels_on_server
 * (the platform operator) is handed SERVER blocks or told how the server is
 * set up. A tenant is told the platform operator does that half.
 *
 * NOTHING TENANT-FACING SAYS "FreeRADIUS" (owner, 13 Oct 2026): messages and
 * log rows say the RADIUS server. The one exception is the literal service
 * command inside a server block, which only the operator sees.
 *
 * The order inside each action is the rule from lib/radius/operations.ts: the
 * RADIUS write first, and Supabase only once it has landed — so a failure
 * leaves the router exactly as it was, never with a key recorded against a
 * RADIUS entry that does not exist.
 *
 * NO PRIVATE KEY PASSES THROUGH HERE. The router generates its own and prints
 * only the public half; that is all these actions accept and all they return.
 * The RADIUS secret does pass through — it has to be in the router's step 2 —
 * but it is read from the RADIUS server's table each time and never stored on
 * this side.
 */

export type TunnelActionResult =
  | { ok: true; message: string; blocks: ConfigBlock[] }
  | { ok: false; error: string }

const PATH = '/dashboard/settings/tunnels'

const NOT_READY = 'Router tunnels are not set up on this system yet: migration 0033 has not been applied.'

/** What a tenant is told when the operator's half of the server is not configured. */
const SERVER_UNAVAILABLE =
  "Router tunnels aren't available on this server yet. Ask the platform operator to finish setting them up."

const STEP_TWO_IF_LOST = 'Router, step 2 — ONLY if the router lost its tunnel config (a reset or a new router)'

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

function stepTwo(
  names: TunnelLabel,
  tunnel: RouterTunnel,
  server: TunnelServer,
  secret: string
): ConfigBlock {
  return routerStepTwo({
    ...names,
    tunnelIp: tunnel.tunnelIp,
    serverPublicKey: server.publicKey,
    serverEndpoint: server.endpoint,
    serverPort: server.port,
    secret,
    services: tunnel.services,
  })
}

// ---------------------------------------------------------------------------
// Add a router: an address and step 1
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
  // only be handed a step 1 they could never complete, and an address used up.
  if (!isOperator(session) && !tunnelServer().ok) {
    return { ok: false, error: SERVER_UNAVAILABLE }
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
  return {
    ok: true,
    message:
      name + ' has tunnel address ' + added.ip + '. Paste step 1 into the router, then paste ' +
      'the public key it prints into "Paste key" below.',
    blocks: [routerStepOne({ companyName: company.name, routerName: name })],
  }
}

// ---------------------------------------------------------------------------
// The router's public key: first time, or a replacement
// ---------------------------------------------------------------------------

export async function setRouterTunnelKey(
  _prev: TunnelActionResult | null,
  formData: FormData
): Promise<TunnelActionResult> {
  const started = await begin()
  if ('refused' in started) return started.refused
  const { session } = started
  const { profile, company } = session
  const operator = isOperator(session)

  const found = await liveTunnel(session, formData)
  if ('refused' in found) return found.refused
  const { tunnel } = found

  const key = parseWireGuardKey(str(formData, 'public_key'))
  if (!key) {
    return {
      ok: false,
      error:
        'That is not a WireGuard public key. It is 44 characters ending in "=", ' +
        'exactly as the last line of step 1 printed it.',
    }
  }

  // Step 2 cannot be written without the server's details, so nothing is
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
          'reused. On the router, run the remove block from that revoke, then step 1 again for a new key.'
        : 'That key already belongs to router tunnel #' + holder.id +
          '. Every router must generate its own: paste step 1 on this router to make one.',
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
        '. Added to the RADIUS server, which loads it on its next restart' +
        ' | public_key=' + key + ' | by=' + profile.email,
    })

    revalidatePath(PATH)
    return operator
      ? {
          ok: true,
          message:
            'Key saved and the router added to the RADIUS server. Run the server block as root (it ' +
            'restarts the RADIUS server to load the router), then paste step 2 into the router.',
          blocks: [serverAddPeer(peer), stepTwo(names, tunnel, server, secret)],
        }
      : {
          ok: true,
          message:
            'Key saved. Paste step 2 into the router now. The platform operator adds the server ' +
            'side; the status here shows Up once the tunnel is working. Until then the router keeps ' +
            'using its current RADIUS settings.',
          blocks: [stepTwo(names, tunnel, server, secret)],
        }
  }

  // --- A replacement --------------------------------------------------------
  // A router that was reset or replaced generates a new key. Same address,
  // same RADIUS entry, same secret; only the server's peer changes.
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

  const blocks: ConfigBlock[] = operator ? [serverReplacePeer({ ...peer, oldPublicKey: oldKey })] : []
  const secret = await readTunnelSecret(tunnel.tunnelIp)
  if (secret.ok && secret.secret) {
    blocks.push({ ...stepTwo(names, tunnel, server, secret.secret), title: STEP_TWO_IF_LOST })
  }

  revalidatePath(PATH)
  return {
    ok: true,
    message: operator
      ? 'Key replaced. Run the server block as root. The router needs step 2 again only if it was ' +
        'reset or replaced; if it kept its config, the new key is all that changed.'
      : 'Key replaced. The tunnel stays down until the platform operator updates the server side. ' +
        'Paste step 2 again only if the router was reset or replaced.',
    blocks,
  }
}

// ---------------------------------------------------------------------------
// Show a router's config again
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
  const names = label(session, tunnel)

  // Step 1 holds nothing secret, so it can be handed out as often as needed.
  if (!tunnel.publicKey) {
    return {
      ok: true,
      message: 'Waiting for the router\'s key. Paste step 1 into the router, then paste the key it prints.',
      blocks: [routerStepOne(names)],
    }
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

  const step = stepTwo(names, tunnel, srv.server, secret.secret)
  return isOperator(session)
    ? {
        ok: true,
        message: 'The server block is only needed if the peer is not on the server yet.',
        blocks: [
          step,
          serverAddPeer({ ...names, tunnelId: tunnel.id, tunnelIp: tunnel.tunnelIp, publicKey: tunnel.publicKey }),
        ],
      }
    : { ok: true, message: 'Step 2 for ' + tunnel.name + '.', blocks: [step] }
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
  const operator = isOperator(session)
  const blocks: ConfigBlock[] = []
  if (operator && tunnel.publicKey) {
    blocks.push(serverRemovePeer({ ...names, tunnelId: tunnel.id, tunnelIp: tunnel.tunnelIp, publicKey: tunnel.publicKey }))
  }
  blocks.push(routerRemove(names))

  revalidatePath(PATH)
  return {
    ok: true,
    message: operator
      ? tunnel.name + ' revoked and removed from the RADIUS server, which keeps it loaded until it next ' +
        'restarts. Run the server block as root to drop the peer, and the router block on the router.'
      : tunnel.name + ' revoked and removed from the RADIUS server. Paste the block below into the ' +
        'router to take the tunnel off it; the platform operator removes the server side.',
    blocks,
  }
}
