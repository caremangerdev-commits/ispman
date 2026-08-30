import 'server-only'

import {
  getRadiusStatus as readRegistry,
  getRadiusUsage,
  radiusConfigured,
} from '@/lib/radius-db'
import {
  RADIUS_UNAVAILABLE, formatRadiusExpiration, type RadiusStatus,
} from '@/lib/radius/format'
import { lastNetworkEvent } from '@/lib/data/network-events'
import { resolveStatus } from '@/lib/status'

// Re-exported so existing server-side imports keep working; client components
// must import them from @/lib/radius/format instead.
export {
  formatRadiusExpiration, parseRadiusExpiration, formatBytes,
  RADIUS_UNAVAILABLE, type RadiusStatus,
} from '@/lib/radius/format'

/**
 * Network state for the customer detail card.
 *
 * Status is the registry's answer (see lib/radius-db.ts) with one thing layered
 * on: radcheck records a deliberate disconnection and an ordinary lapse the same
 * way — an expiry in the past — so `customer` supplies the log rows that tell
 * them apart. Pass it whenever the caller knows which customer this identity
 * belongs to; without it the status falls back to 'expired'/'inactive', which
 * is the registry's unaided answer rather than a wrong one.
 *
 * This also adds the session figures and shapes the result for the UI.
 *
 * Every failure degrades to RADIUS_UNAVAILABLE with status 'unknown' rather
 * than throwing — a NAS that is unreachable must not take the customer page
 * down, and must not be reported as "this customer has no record".
 */
export async function getRadiusStatus(
  macAddress: string | null,
  customer?: { companyId: number; customerId: number }
): Promise<RadiusStatus> {
  if (!macAddress) {
    // No identity to look up. That genuinely is an unactivated account.
    return { ...RADIUS_UNAVAILABLE, available: true, status: 'unprovisioned' }
  }

  if (!radiusConfigured()) {
    return { ...RADIUS_UNAVAILABLE, error: 'Network is not configured.' }
  }

  try {
    const record = await readRegistry(macAddress)

    if (!record.exists) {
      return { ...RADIUS_UNAVAILABLE, available: true, status: 'unprovisioned' }
    }

    // Only worth hitting the accounting table once we know they are registered.
    const [usage, lastEvent] = await Promise.all([
      getRadiusUsage(macAddress),
      customer
        ? lastNetworkEvent(customer.companyId, customer.customerId)
        : Promise.resolve(null),
    ])

    return {
      available: true,
      status: resolveStatus(record.status, lastEvent),
      expiry: record.rawExpiry,
      expiresAt: record.expiry,
      lastSeen: usage.lastSeen,
      online: usage.online,
      bytesThisMonth: usage.bytesThisMonth,
      sessionsThisMonth: usage.sessionsThisMonth,
      error: null,
    }
  } catch (err) {
    const e = err as { code?: string; message?: string }
    console.error('[radius] getRadiusStatus failed for %s: %s', macAddress, e.message ?? err)
    return { ...RADIUS_UNAVAILABLE, error: e.code ?? e.message ?? 'Lookup failed' }
  }
}

export type RadcheckRow = {
  username: string
  attribute: string
  op: string
  value: string
}

/**
 * The two rows a customer needs in order to authenticate: an accept rule, and
 * an expiry the NAS enforces itself.
 */
export function buildRadcheckRows(macAddress: string, expiresAt: Date): RadcheckRow[] {
  return [
    { username: macAddress, attribute: 'Auth-Type', op: ':=', value: 'Accept' },
    {
      username: macAddress,
      attribute: 'Expiration',
      op: ':=',
      value: formatRadiusExpiration(expiresAt),
    },
  ]
}
