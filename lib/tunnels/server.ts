import 'server-only'

import { randomInt } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

import { DEFAULT_SERVER_PORT, parseWireGuardKey } from '@/lib/tunnels/wireguard'

/**
 * The server end of the router tunnels, as ISPMan needs to describe it in a
 * router's config. Set once, after the server half is built
 * (docs/wireguard-tunnels.md):
 *
 *   WG_SERVER_PUBLIC_KEY  the contents of /etc/wireguard/wg-routers.pub
 *   WG_SERVER_ENDPOINT    the address routers dial: the box's Elastic IP
 *   WG_SERVER_PORT        optional, 51820
 *
 * Only the PUBLIC key. The server's private key stays in a root-only file on
 * the box and is never in ISPMan's environment.
 */
export type TunnelServer = { publicKey: string; endpoint: string; port: number }

export function tunnelServer(): { ok: true; server: TunnelServer } | { ok: false; problem: string } {
  const rawKey = process.env.WG_SERVER_PUBLIC_KEY
  const endpoint = (process.env.WG_SERVER_ENDPOINT ?? '').trim()
  const rawPort = (process.env.WG_SERVER_PORT ?? '').trim()

  if (!rawKey || !endpoint) {
    return {
      ok: false,
      problem:
        'The tunnel server is not set up in ISPMan yet: WG_SERVER_PUBLIC_KEY and WG_SERVER_ENDPOINT ' +
        'must be set (docs/wireguard-tunnels.md). Until then no router can be given its step 2.',
    }
  }

  const publicKey = parseWireGuardKey(rawKey)
  if (!publicKey) {
    return { ok: false, problem: 'WG_SERVER_PUBLIC_KEY is not a WireGuard public key.' }
  }
  // A hostname or an IPv4 address. Anything else would be pasted into a
  // router's command line, so it is refused rather than passed through.
  if (!/^[A-Za-z0-9.-]+$/.test(endpoint)) {
    return { ok: false, problem: 'WG_SERVER_ENDPOINT must be a hostname or an IPv4 address.' }
  }
  const port = rawPort ? Number(rawPort) : DEFAULT_SERVER_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, problem: 'WG_SERVER_PORT must be a port number.' }
  }

  return { ok: true, server: { publicKey, endpoint, port } }
}

/**
 * True once the server half runs itself: the root job (ispman-wg-sync) applies
 * peers from /api/tunnels/peers, and the RADIUS server looks tunnel clients up
 * on demand. TUNNEL_SYNC_SECRET is what the job authenticates with, so it is
 * set only once both are installed (docs/wireguard-tunnels.md). Until then
 * the platform operator is handed server blocks to run by hand.
 */
export function tunnelSyncConfigured(): boolean {
  return Boolean(process.env.TUNNEL_SYNC_SECRET)
}

const SECRET_ALPHABET ='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/**
 * A router's RADIUS shared secret: 24 characters, letters and digits only.
 *
 * Only letters and digits because it is pasted inside double quotes on a
 * RouterOS command line, where $, \ and " all mean something. Look-alikes
 * (0/O, 1/l/I) are left out for the day someone has to read one over the
 * phone. 24 characters of 56 is about 139 bits.
 */
export function generateRadiusSecret(): string {
  let out = ''
  for (let i = 0; i < 24; i++) out += SECRET_ALPHABET[randomInt(SECRET_ALPHABET.length)]
  return out
}

// ---------------------------------------------------------------------------
// Tunnel status
// ---------------------------------------------------------------------------

/**
 * How old a handshake may be and still count as up. With a 25-second
 * keepalive a live tunnel re-handshakes about every two minutes.
 */
export const HANDSHAKE_FRESH_SECONDS = 180

export type Handshakes = {
  /** When the cron job last wrote the file. */
  writtenAt: Date
  /** False when the file has not been rewritten recently: the job has stopped, so its figures are old. */
  fresh: boolean
  /** Public key -> latest handshake, null for a peer that never completed one. */
  peers: Map<string, Date | null>
}

/**
 * Reads what `wg show wg-routers latest-handshakes` last reported.
 *
 * ISPMan cannot ask WireGuard itself — that needs root — so a root cron job
 * writes the output to WG_HANDSHAKES_FILE every minute
 * (docs/wireguard-tunnels.md). latest-handshakes and not `wg show dump`
 * deliberately: dump's first line is the server's PRIVATE key.
 *
 * Null when the variable is unset or the file cannot be read; the card then
 * says status is not reported rather than calling every router down.
 */
export async function readHandshakes(now: Date = new Date()): Promise<Handshakes | null> {
  const path = process.env.WG_HANDSHAKES_FILE
  if (!path) return null

  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const peers = new Map<string, Date | null>()
    for (const line of text.split(/\r?\n/)) {
      const [key, epoch] = line.trim().split(/\s+/)
      const publicKey = parseWireGuardKey(key)
      if (!publicKey) continue
      const seconds = Number(epoch)
      peers.set(publicKey, Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null)
    }
    const writtenAt = info.mtime
    return {
      writtenAt,
      fresh: now.getTime() - writtenAt.getTime() <= HANDSHAKE_FRESH_SECONDS * 1000,
      peers,
    }
  } catch (err) {
    console.warn('[tunnels] could not read %s: %s', path, (err as Error).message)
    return null
  }
}

/** What the root job reported about its last run (WG_SYNC_STATUS_FILE). */
export type SyncStatus = {
  ranAt: Date
  /** False when the job has not run recently: its timer or unit has stopped. */
  fresh: boolean
  ok: boolean
  error: string | null
  added: number
  removed: number
  /**
   * Peers ISPMan no longer lists but the job would not remove: more at once
   * than it is allowed to (MAX_REMOVALS_PER_RUN), or every peer at once.
   * They stay until a person checks and allows it.
   */
  held: { publicKey: string; allowedIps: string }[]
}

export async function readSyncStatus(now: Date = new Date()): Promise<SyncStatus | null> {
  const path = process.env.WG_SYNC_STATUS_FILE
  if (!path) return null

  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const ranAt = new Date(String(raw.ranAt ?? ''))
    if (Number.isNaN(ranAt.getTime())) return null
    const held = Array.isArray(raw.held)
      ? (raw.held as Record<string, unknown>[]).map((h) => ({
          publicKey: String(h.publicKey ?? ''),
          allowedIps: String(h.allowedIps ?? ''),
        }))
      : []
    return {
      ranAt,
      fresh: now.getTime() - ranAt.getTime() <= HANDSHAKE_FRESH_SECONDS * 1000,
      ok: raw.ok === true,
      error: typeof raw.error === 'string' ? raw.error : null,
      added: Number(raw.added ?? 0) || 0,
      removed: Number(raw.removed ?? 0) || 0,
      held,
    }
  } catch (err) {
    console.warn('[tunnels] could not read %s: %s', path, (err as Error).message)
    return null
  }
}
