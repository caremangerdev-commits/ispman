import 'server-only'

import { generateKeyPairSync } from 'node:crypto'

import { devicePassword } from '@/lib/crypto'
import { storeRouterLogin } from '@/lib/data/router-logins'
import type { RouterTunnel } from '@/lib/data/tunnels'
import { addTunnelNas, readTunnelSecret } from '@/lib/radius/operations'
import { tenantClient } from '@/lib/supabase/tenant'
import { generateRadiusSecret, tunnelServer } from '@/lib/tunnels/server'
import {
  ROUTER_API_PORT, ROUTER_API_USER, nasDescription, nasShortname, routerSetupScript,
} from '@/lib/tunnels/wireguard'

/**
 * Everything a router setup script needs that has to exist on ISPMan's side
 * first — the RADIUS entry and its secret, the login the script will create —
 * then the script itself.
 *
 * Shared by the two ways a router gets set up, so they cannot drift:
 *
 *   The one pasted line. The router downloads the script (/tool fetch) and
 *   reports its own public key back the same way.
 *
 *   The whole script pasted in. For a router that is not allowed to download
 *   anything — RouterOS 7.17+ ships home routers in "home" device-mode, which
 *   switches /tool fetch off, and turning it back on needs someone at the
 *   router to press its button. ISPMan makes the WireGuard key pair instead
 *   and the script installs it, so nothing has to travel back from the router.
 *
 * WHY HANDING OVER A PRIVATE KEY IS ACCEPTABLE THERE. The same script already
 * carries the password of a full-rights login on that router and its RADIUS
 * secret. Whoever can read it can already do everything the key would let
 * them. The key is used for this router alone and replaced by running setup
 * again.
 *
 * THE ORDER IS THE RULE FROM lib/radius/operations.ts: the RADIUS write first,
 * then ours. A failed RADIUS write must leave no password stored against a
 * router that cannot authenticate.
 */

export type BuiltScript = { ok: true; script: string } | { ok: false; lines: string[] }

/** A WireGuard key pair, both halves base64 as RouterOS and wg print them. */
export function wireGuardKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  // DER wraps the raw 32-byte keys in a fixed header; the key is the tail.
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { privateKey: priv.toString('base64'), publicKey: pub.toString('base64') }
}

export async function buildSetupScript(input: {
  companyId: number
  tunnel: RouterTunnel
  /** For the one-line path: where the router reports its key. */
  baseUrl: string
  token: string
  /** For the paste-in path: the key the script installs. */
  privateKey?: string
}): Promise<BuiltScript> {
  const { companyId, tunnel } = input

  const srv = tunnelServer()
  if (!srv.ok) {
    console.error('[routers/setup] server not configured:', srv.problem)
    return { ok: false, lines: ['', 'ISPMan is not finished setting up tunnels on its side.', 'Nothing has been changed.'] }
  }

  const { data: companyRow } = await tenantClient()
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .maybeSingle()
  const companyName = (companyRow as { name: string } | null)?.name ?? 'Company #' + companyId

  // --- the RADIUS secret: reuse the router's own, or write it its first ------
  let secret: string
  const existing = await readTunnelSecret(tunnel.tunnelIp)
  if (existing.ok && existing.secret) {
    secret = existing.secret
  } else {
    secret = generateRadiusSecret()
    const nas = await addTunnelNas({
      tunnelIp: tunnel.tunnelIp,
      shortname: nasShortname(tunnel.tunnelIp, companyName, tunnel.name),
      secret,
      description: nasDescription(tunnel.id, companyName, tunnel.name),
    })
    if (!nas.ok) {
      console.error('[routers/setup] RADIUS entry failed for', tunnel.tunnelIp, nas.error)
      return {
        ok: false,
        lines: [
          '',
          'ISPMan could not add this router to its RADIUS server.',
          'Nothing on this router has been changed. Try again shortly.',
        ],
      }
    }
  }

  // --- the login the script is about to create ------------------------------
  const password = devicePassword()
  const stored = await storeRouterLogin(companyId, tunnel.id, {
    user: ROUTER_API_USER,
    password,
    kind: 'api',
    port: ROUTER_API_PORT,
  })
  if (!stored.ok) {
    // The password was never sent anywhere, so the router is untouched. Do not
    // serve a script that sets a password ISPMan failed to remember.
    console.error('[routers/setup] could not store the login:', stored.error)
    return {
      ok: false,
      lines: ['', 'ISPMan could not store the login it was about to create.', 'Nothing on this router has been changed.'],
    }
  }

  return {
    ok: true,
    script: routerSetupScript({
      companyName,
      routerName: tunnel.name,
      tunnelIp: tunnel.tunnelIp,
      serverPublicKey: srv.server.publicKey,
      serverEndpoint: srv.server.endpoint,
      serverPort: srv.server.port,
      secret,
      services: tunnel.services,
      baseUrl: input.baseUrl,
      token: input.token,
      apiPassword: password,
      privateKey: input.privateKey,
    }),
  }
}
