import 'server-only'

/**
 * The only place that talks to the SMSGate relay.
 *
 * Every path and field below was read out of the server's own example requests
 * (github.com/android-sms-gateway/server, api/requests.http) rather than
 * recalled, because a wrong path here fails at the moment a customer is
 * standing at a counter and not at build time.
 *
 * WHAT THIS DOES NOT DO: retry, throttle, or decide anything. It performs one
 * HTTP call and reports what happened. The dispatcher owns pacing and retries,
 * because those need the outbox row to be honest about attempts.
 */

/**
 * The relay's base URL — the Apache vhost from docs/sms-relay-setup.md, e.g.
 * https://sms.example.com. Paths are appended to it.
 *
 * ONE RELAY FOR EVERY TENANT. It is our box; tenants are separated by their
 * device credentials, not by having a relay each.
 */
export function relayUrl(): string | null {
  const raw = (process.env.SMS_RELAY_URL ?? '').trim()
  return raw ? raw.replace(/\/+$/, '') : null
}

export function relayConfigured(): boolean {
  return relayUrl() !== null
}

/**
 * The API prefix.
 *
 * The upstream example file is INCONSISTENT: most endpoints are
 * `{base}/3rdparty/v1/...` while two (`/logs`, and one push route) appear as
 * `{base}/api/3rdparty/v1/...`. The messages and devices endpoints this app
 * uses are all in the first form, which is also what the docs show, so that is
 * what is used here. If a future server version moves them, this is the one
 * line to change.
 */
const API = '/3rdparty/v1'

/** How long any single call may take before it is abandoned. */
const TIMEOUT_MS = 15_000

export type RelayCredentials = {
  username: string
  password: string
  /** Address a specific handset. Omitted when the tenant has only one. */
  deviceId?: string | null
  simNumber?: number | null
}

export type SendResult =
  | { ok: true; providerId: string; state: string | null }
  | { ok: false; error: string; retryable: boolean }

function authHeader(c: RelayCredentials): string {
  return 'Basic ' + Buffer.from(c.username + ':' + c.password).toString('base64')
}

/**
 * A fetch with a timeout that never leaks the credential into an error.
 *
 * The Authorization header is built here and the caller only ever sees a
 * message, so a thrown error landing in a log or an `error` column cannot carry
 * a tenant's relay password with it.
 */
async function call(
  path: string,
  creds: RelayCredentials,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const base = relayUrl()
  if (!base) throw new Error('SMS_RELAY_URL is not set')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(base + API + path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        Authorization: authHeader(creds),
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    })

    const text = await res.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }

    return { status: res.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Queues one message on the relay.
 *
 * `id` IS THE IDEMPOTENCY KEY and is the outbox row id. The relay treats a
 * repeated id as the same message, so a dispatcher that posts, times out, and
 * retries cannot deliver twice. That is the second half of the guarantee whose
 * first half is the unique index on `dedupe_key` — the index stops the same
 * event being queued twice, this stops one queued row being sent twice.
 *
 * `phone` must already be E.164 without the plus, as lib/phone.ts produces.
 */
export async function sendMessage(
  creds: RelayCredentials,
  msg: {
    id: string
    text: string
    phone: string
    /**
     * 100+ bypasses the relay's own rate limiting. Used ONLY for a payment
     * receipt, so a customer at a counter is not queued behind a 400-message
     * blast. Bulk always goes at normal priority — see the dispatcher.
     */
    priority?: number
    /** Seconds. After this the relay stops trying rather than sending a
     *  disconnection notice three days late. */
    ttlSeconds?: number
  }
): Promise<SendResult> {
  let res
  try {
    res = await call('/messages', creds, {
      method: 'POST',
      body: JSON.stringify({
        id: msg.id,
        textMessage: { text: msg.text },
        phoneNumbers: ['+' + msg.phone],
        withDeliveryReport: true,
        ...(msg.priority === undefined ? {} : { priority: msg.priority }),
        ...(msg.ttlSeconds === undefined ? {} : { ttl: msg.ttlSeconds }),
        ...(creds.deviceId ? { deviceId: creds.deviceId } : {}),
        ...(creds.simNumber ? { simNumber: creds.simNumber } : {}),
      }),
    })
  } catch (err) {
    // A timeout or a DNS failure. Retryable: the relay may well be fine and the
    // message may even have been accepted, which is precisely why `id` is sent.
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: 'relay unreachable: ' + message, retryable: true }
  }

  if (res.status >= 200 && res.status < 300) {
    const body = res.body as { id?: string; state?: string } | null
    const providerId = body?.id
    if (!providerId) {
      return { ok: false, error: 'relay accepted the message but returned no id', retryable: false }
    }
    return { ok: true, providerId, state: body?.state ?? null }
  }

  // 401/403 mean the tenant's device credentials are wrong. Retrying cannot fix
  // that and would lock the queue behind a row that can never succeed, so it is
  // reported as terminal and surfaces on the settings page.
  const retryable = res.status === 429 || res.status >= 500
  return {
    ok: false,
    error: 'relay returned ' + res.status + ': ' + res.text.slice(0, 300),
    retryable,
  }
}

export type RelayMessageState = {
  state: string | null
  error: string | null
}

/** Reads one message back, for delivery reporting. */
export async function getMessageState(
  creds: RelayCredentials,
  providerId: string
): Promise<RelayMessageState | null> {
  try {
    const res = await call('/messages/' + encodeURIComponent(providerId), creds)
    if (res.status < 200 || res.status >= 300) return null
    const body = res.body as { state?: string; recipients?: { error?: string }[] } | null
    return {
      state: body?.state ?? null,
      error: body?.recipients?.find((r) => r.error)?.error ?? null,
    }
  } catch {
    return null
  }
}

export type RelayDevice = {
  id: string
  name: string | null
  lastSeen: string | null
}

/**
 * The handsets registered to these credentials.
 *
 * Used by the settings page for online status and by the dispatcher to keep
 * `sms_devices.last_seen_at` fresh. Returns null — rather than an empty list —
 * when the relay could not be reached, so "we could not ask" is never rendered
 * as "the phone is offline".
 */
export async function listDevices(creds: RelayCredentials): Promise<RelayDevice[] | null> {
  try {
    const res = await call('/devices', creds)
    if (res.status < 200 || res.status >= 300) return null
    const rows = Array.isArray(res.body) ? res.body : []
    return rows.map((r) => {
      const d = r as { id?: string; name?: string; lastSeen?: string; last_seen?: string }
      return {
        id: String(d.id ?? ''),
        name: d.name ?? null,
        lastSeen: d.lastSeen ?? d.last_seen ?? null,
      }
    })
  } catch {
    return null
  }
}

/**
 * Whether the credentials work at all.
 *
 * Used by the settings page's "Test connection" button. Distinguishes the three
 * outcomes an operator needs to tell apart: the relay is down, the credentials
 * are wrong, or it works but no phone has ever connected.
 */
export async function verifyCredentials(
  creds: RelayCredentials
): Promise<{ ok: boolean; message: string; devices: RelayDevice[] }> {
  if (!relayConfigured()) {
    return { ok: false, message: 'The SMS relay is not configured on this server.', devices: [] }
  }

  let res
  try {
    res = await call('/devices', creds)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: 'Could not reach the relay: ' + message, devices: [] }
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: 'The relay rejected these credentials.', devices: [] }
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, message: 'The relay returned ' + res.status + '.', devices: [] }
  }

  const devices = (Array.isArray(res.body) ? res.body : []).map((r) => {
    const d = r as { id?: string; name?: string; lastSeen?: string; last_seen?: string }
    return {
      id: String(d.id ?? ''),
      name: d.name ?? null,
      lastSeen: d.lastSeen ?? d.last_seen ?? null,
    }
  })

  if (devices.length === 0) {
    return {
      ok: true,
      message: 'Connected, but no phone has registered with these credentials yet.',
      devices,
    }
  }

  return {
    ok: true,
    message: devices.length === 1
      ? 'Connected. One phone is registered.'
      : 'Connected. ' + devices.length + ' phones are registered.',
    devices,
  }
}
