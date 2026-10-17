import 'server-only'

import { createHash, randomInt } from 'node:crypto'
import dgram from 'node:dgram'

import { getActiveSession, getNasRow } from '@/lib/radius-db'

/**
 * Forces a paid customer back online at once by telling their NAS to re-auth,
 * instead of waiting for the session to renew on its own.
 *
 * There is no CoA anywhere else in this app (expiry is enforced only at
 * authentication), so this is a small, self-contained RADIUS Disconnect-Request
 * (RFC 5176) sent over UDP to the NAS's CoA port. It runs on the box, where the
 * app can reach each tenant MikroTik over the WireGuard tunnel at its tunnel IP
 * — which is also the nas.nasname that holds the CoA secret.
 *
 * It only acts on a customer who HAS an open session (one to disconnect so the
 * router re-authenticates). A fully cut-off customer has none and re-auths on
 * its own the moment the payment lands.
 *
 * OFF unless RADIUS_COA_ENABLED=true AND each router has
 * `/radius incoming set accept=yes port=3799`. NEVER THROWS — the payment has
 * already succeeded; an unreachable router must not undo it.
 */

const COA_PORT = 3799
const TIMEOUT_MS = 4000

// RADIUS codes (RFC 5176).
const DISCONNECT_REQUEST = 40
const DISCONNECT_ACK = 41

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

export type ReconnectResult = { ok: boolean; reason: string }

export function coaEnabled(): boolean {
  return (process.env.RADIUS_COA_ENABLED ?? '').trim() === 'true'
}

export async function reconnectCustomer(identity: string | null | undefined): Promise<ReconnectResult> {
  if (!coaEnabled()) return { ok: false, reason: 'CoA disabled' }
  if (!identity) return { ok: false, reason: 'no identity' }

  try {
    const session = await getActiveSession(identity)
    if (!session) return { ok: false, reason: 'no active session to re-auth' }

    const nas = await getNasRow(session.nasIp)
    if (!nas) return { ok: false, reason: 'no NAS secret for ' + session.nasIp }

    const parts: Buffer[] = [attr(1, session.username)] // User-Name
    if (session.acctSessionId) parts.push(attr(44, session.acctSessionId)) // Acct-Session-Id
    const nasBuf = ipToBuf(session.nasIp)
    if (nasBuf) parts.push(attr(4, nasBuf)) // NAS-IP-Address
    if (session.framedIp) {
      const fb = ipToBuf(session.framedIp)
      if (fb) parts.push(attr(8, fb)) // Framed-IP-Address
    }

    const packet = buildPacket(nas.secret, Buffer.concat(parts), randomInt(0, 256))

    const acked = await new Promise<boolean>((resolve) => {
      const sock = dgram.createSocket('udp4')
      const done = (v: boolean) => {
        clearTimeout(timer)
        try { sock.close() } catch { /* already closed */ }
        resolve(v)
      }
      const timer = setTimeout(() => done(false), TIMEOUT_MS)
      sock.on('message', (msg) => done(msg.length > 0 && msg[0] === DISCONNECT_ACK))
      sock.on('error', () => done(false))
      sock.send(packet, COA_PORT, session.nasIp, (err) => { if (err) done(false) })
    })

    return acked
      ? { ok: true, reason: 'disconnected; router will re-authenticate' }
      : { ok: false, reason: 'no Disconnect-ACK from ' + session.nasIp }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}
