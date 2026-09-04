import type { CustomerStatus } from '@/lib/status'

/**
 * FreeRADIUS `Expiration` date formatting.
 *
 * Lives in its own module because both the RADIUS client and the MySQL layer
 * need it: importing it from either one into the other would make the two
 * modules circular.
 *
 * The format is "05 Sep 2026 23:06" — DD Mon YYYY HH:MM. This is not a guess:
 * it is the exact shape of all 5,720 Expiration rows already in the production
 * radcheck table, and FreeRADIUS parses it with its own date parser. Writing a
 * different shape risks rows this NAS will not honour, so do not "tidy" it.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * Shape of a live RADIUS lookup, and the pure helpers that render it.
 *
 * These live here rather than in lib/radius/client.ts because the customer
 * detail card is a client component: importing them from the client module
 * would drag mysql2 into the browser bundle and fail the build.
 */
export type RadiusStatus = {
  /** False when the network could not be consulted at all. */
  available: boolean
  /** Derived entirely from the network registry — see lib/status.ts. */
  status: CustomerStatus
  /** Raw expiry value as stored, e.g. "05 Sep 2026 23:06". */
  expiry: string | null
  /**
   * The instant `expiry` parses to IN THE SERVER'S ZONE. Fine for arithmetic
   * inside one process; do NOT send it to a browser and re-read its parts —
   * radcheck stores wall-clock text with no zone, so the parts move. Anything
   * that displays the expiry uses `expiryDate` instead.
   */
  expiresAt: Date | null
  /** `expiry` as the calendar date it names, "YYYY-MM-DD". Display path. */
  expiryDate: string | null
  lastSeen: Date | null
  online: boolean
  bytesThisMonth: number | null
  sessionsThisMonth: number | null
  /** Populated when the lookup failed, for the card's diagnostic line. */
  error: string | null
}

export const RADIUS_UNAVAILABLE: RadiusStatus = {
  available: false,
  status: 'unknown',
  expiry: null,
  expiresAt: null,
  expiryDate: null,
  lastSeen: null,
  online: false,
  bytesThisMonth: null,
  sessionsThisMonth: null,
  error: null,
}

/** Human-readable data volume for the RADIUS card. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return bytes + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[i]
}

/**
 * Formats a date as FreeRADIUS expects: "05 Sep 2026 23:06".
 *
 * Built from an explicit month table rather than toLocaleString because en-GB
 * renders September as "Sept", which FreeRADIUS fails to parse.
 */
export function formatRadiusExpiration(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    pad(date.getDate()) +
    ' ' + MONTHS[date.getMonth()] +
    ' ' + date.getFullYear() +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

/** Parses "05 Sep 2026 23:06" back into a Date. Returns null if malformed. */
export function parseRadiusExpiration(value: string | null): Date | null {
  if (!value) return null

  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(value.trim())
  if (!m) return null

  const monthIndex = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase())
  if (monthIndex === -1) return null

  const d = new Date(
    Number(m[3]), monthIndex, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)
  )
  return Number.isFinite(d.getTime()) ? d : null
}

/**
 * MAC addresses are stored uppercase with colons throughout this app, and the
 * RADIUS username must match byte for byte or authentication silently fails.
 * PPPoE usernames pass through unchanged.
 */
export function normaliseUsername(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('RADIUS username cannot be empty.')

  const looksLikeMac = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(trimmed)
  return looksLikeMac ? trimmed.toUpperCase().replace(/-/g, ':') : trimmed
}

/**
 * The RADIUS username for a customer: the MAC for DHCP and hotspot, the PPPoE
 * username for PPPoE.
 *
 * This is the same rule the provisioning path applies before writing radcheck
 * (see loadNetworkTarget in app/actions/customers.ts), and it has to match, or
 * a PPPoE customer is provisioned under one identity and read back under
 * another — which is exactly why their accounting rows were never found.
 */
export function radiusIdentity(customer: {
  customerType: string | null
  macAddress: string | null
  pppoeUsername: string | null
}): string | null {
  return (
    customer.customerType === 'pppoe' ? customer.pppoeUsername : customer.macAddress
  ) ?? null
}
