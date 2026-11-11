import 'server-only'

import { createHash, randomInt } from 'node:crypto'
import dgram from 'node:dgram'

import { listRouterTunnels } from '@/lib/data/tunnels'
import { getNasRow } from '@/lib/radius-db'

/**
 * Puts a paid PPPoE or hotspot customer back online at once, by telling their
 * router to drop the session so it re-authenticates against the expiry the
 * payment has just extended.
 *
 * PPPoE AND HOTSPOT ONLY, AND THAT IS NOT A LIMITATION OF THIS FILE.
 * MikroTik does not support CoA or Disconnect for DHCP RADIUS at all — a DHCP
 * lease has no session context, and a Disconnect-Request for one is answered
 * Session-Context-Not-Found. 5,432 of our 5,434 customers are DHCP, so for
 * almost everybody this path does not and cannot apply, and the way their
 * cut-off is enforced is Session-Timeout instead (migration 0047).
 *
 * There is deliberately NO disconnectCustomer() here. Cutting a customer off
 * at once is the same packet with the radcheck row already in the past, and it
 * would work for the same two customers and no others — a function nothing can
 * call is worse than no function, because the next person reads it as a
 * capability we have.
 *
 * WHY IT NO LONGER READS radacct (11 Nov 2026). It used to find the customer's
 * open accounting session and send the packet to that row's nasipaddress. That
 * cannot work, and measurably did not: of 530 distinct NAS addresses in open
 * sessions, TEN have a `nas` row. The rest are private addresses —
 * 192.168.100.209 alone holds 18,599 of them — because each tenant's
 * distribution router reports its own LAN address in NAS-IP-Address while the
 * RADIUS packet itself arrives over the tunnel. So the old code looked up a
 * secret for an unroutable address, found none, and returned 'no NAS secret'
 * for almost every customer. Nobody noticed because the whole path is off
 * unless RADIUS_COA_ENABLED is set.
 *
 * Accounting cannot be made to answer this either: interim updates are off, so
 * acctupdatetime equals acctstarttime on all 83,386 open rows and
 * acctsessiontime is 0 — radacct cannot tell a live session from one abandoned
 * in 2021, and one identity holds open rows against 132 different NAS
 * addresses.
 *
 * So the target comes from what we actually know: THE ROUTERS OF THE
 * CUSTOMER'S COMPANY. A tunnel router is reachable (it is a WireGuard peer), it
 * has a `nas` row, and that row holds the shared secret. A company has a
 * handful, so the packet goes to each of them carrying only User-Name, and the
 * one holding the session drops it. The others answer NAK or stay silent,
 * which costs nothing.
 *
 * NOT COVERED: a tenant still on a public-IP NAS rather than a tunnel. Those
 * four rows were made by hand on the box and ISPMan has no record of which
 * company each belongs to, so there is nothing to look up. Their customers
 * keep today's behaviour — expiry at the next re-auth — until the router is
 * moved onto a tunnel.
 *
 * NEVER THROWS. The radcheck write has already landed before any of this runs;
 * an unreachable router must not undo a cut-off or a reconnection.
 */

/**
 * The port the routers listen on for CoA and Disconnect-Messages.
 *
 * RouterOS's `/radius incoming` DEFAULTS TO 1700, not to the IANA port 3799.
 * The default here stays 3799 because that is what the setup instructions tell
 * the operator to set (`/radius incoming set accept=yes port=3799`), but a
 * router left on its own default will never answer — so this is an env var
 * rather than a constant, and a mismatch can be corrected without a deploy.
 */
function coaPort(): number {
  const raw = Number((process.env.RADIUS_COA_PORT ?? '').trim())
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 3799
}

const TIMEOUT_MS = 4000

// RADIUS codes (RFC 5176).
const DISCONNECT_REQUEST = 40
const DISCONNECT_ACK = 41
const DISCONNECT_NAK = 42

function attr(type: number, value: Buffer | string): Buffer {
  const v = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return Buffer.concat([Buffer.from([type, v.length + 2]), v])
}

function ipToBuf(ip: string): Buffer | null {
  const parts = ip.split('.').map((n) => Number(n))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return Buffer.from(parts)
}

/**
 * The Request Authenticator for a Disconnect-Request is, as for an
 * Accounting-Request, MD5(Code+ID+Length + 16 zero bytes + Attributes + Secret).
 *
 * No Message-Authenticator. RFC 5176 says a Disconnect-Request SHOULD carry
 * one, and RouterOS does not document requiring it. Left out deliberately so
 * the first pilot changes only the target and the port; if a router stays
 * silent, adding it is the next thing to try, not the first.
 */
function buildPacket(secret: string, attrs: Buffer, id: number): Buffer {
  const length = 20 + attrs.length
  const header = Buffer.alloc(4)
  header[0] = DISCONNECT_REQUEST
  header[1] = id
  header.writeUInt16BE(length, 2)
  const auth = createHash('md5')
    .update(Buffer.concat([header, Buffer.alloc(16), attrs, Buffer.from(secret, 'utf8')]))
    .digest()
  return Buffer.concat([header, auth, attrs])
}

export function coaEnabled(): boolean {
  return (process.env.RADIUS_COA_ENABLED ?? '').trim() === 'true'
}

/** One router we can send to: its tunnel address and the secret it shares. */
type CoaTarget = { nasIp: string; shortname: string; secret: string }

/**
 * The company's routers that can be sent a Disconnect-Request.
 *
 * Live tunnels only — a tunnel whose key was never pasted is not a peer, and a
 * revoked one is not supposed to answer. The secret is read from the `nas`
 * row rather than kept anywhere in ISPMan, which is the same rule the rest of
 * lib/radius/operations.ts follows: the nas row is the only copy.
 */
async function companyTargets(companyId: number): Promise<CoaTarget[]> {
  const tunnels = (await listRouterTunnels(companyId)).filter(
    (t) => t.keySetAt !== null && t.revokedAt === null
  )

  const targets: CoaTarget[] = []
  for (const t of tunnels) {
    const nas = await getNasRow(t.tunnelIp)
    // No row means FreeRADIUS does not know this router either, so a packet to
    // it could not be authenticated even if it arrived.
    if (nas?.secret) {
      targets.push({ nasIp: t.tunnelIp, shortname: nas.shortname ?? t.name, secret: nas.secret })
    }
  }
  return targets
}

type SendOutcome = 'ack' | 'nak' | 'silent' | 'error'

/** Sends one Disconnect-Request and reports what came back. */
async function sendTo(target: CoaTarget, username: string): Promise<SendOutcome> {
  const parts: Buffer[] = [attr(1, username)] // User-Name
  const nasBuf = ipToBuf(target.nasIp)
  if (nasBuf) parts.push(attr(4, nasBuf)) // NAS-IP-Address

  const packet = buildPacket(target.secret, Buffer.concat(parts), randomInt(0, 256))
  const port = coaPort()

  return new Promise<SendOutcome>((resolve) => {
    const sock = dgram.createSocket('udp4')
    const done = (v: SendOutcome) => {
      clearTimeout(timer)
      try { sock.close() } catch { /* already closed */ }
      resolve(v)
    }
    const timer = setTimeout(() => done('silent'), TIMEOUT_MS)
    sock.on('message', (msg) => {
      if (msg.length === 0) return done('error')
      if (msg[0] === DISCONNECT_ACK) return done('ack')
      if (msg[0] === DISCONNECT_NAK) return done('nak')
      done('error')
    })
    sock.on('error', () => done('error'))
    sock.send(packet, port, target.nasIp, (err) => { if (err) done('error') })
  })
}

export type CoaResult = {
  /** True when at least one router acknowledged tearing the session down. */
  ok: boolean
  /** One line for the audit log, naming what each router said. */
  reason: string
}

/**
 * Sends a Disconnect-Request for one identity to every router the company has.
 *
 * ALL OF THEM, IN PARALLEL, because nothing we hold says which router the
 * customer is on — see the note at the top of this file. A NAK is the ordinary
 * answer from a router that has never heard of them, not a failure.
 */
async function terminate(
  identity: string | null | undefined,
  companyId: number,
  purpose: string
): Promise<CoaResult> {
  if (!coaEnabled()) return { ok: false, reason: 'CoA disabled' }
  if (!identity) return { ok: false, reason: 'no identity' }

  try {
    const targets = await companyTargets(companyId)
    if (targets.length === 0) {
      return { ok: false, reason: 'no reachable router for this company' }
    }

    const outcomes = await Promise.all(
      targets.map(async (t) => ({ name: t.shortname, outcome: await sendTo(t, identity) }))
    )

    const acked = outcomes.filter((o) => o.outcome === 'ack')
    const detail = outcomes.map((o) => o.name + '=' + o.outcome).join(', ')

    return acked.length > 0
      ? { ok: true, reason: purpose + ': session dropped by ' + acked.map((a) => a.name).join(', ') + ' (' + detail + ')' }
      : { ok: false, reason: purpose + ': no router dropped a session (' + detail + ')' }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/**
 * Forces a paid customer back online at once: the session is dropped and the
 * re-auth that follows reads the expiry the payment just extended.
 */
export async function reconnectCustomer(
  identity: string | null | undefined,
  companyId: number
): Promise<CoaResult> {
  return terminate(identity, companyId, 'reconnect')
}
