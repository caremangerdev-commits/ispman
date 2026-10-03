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
  /**
   * The latest start or stop time radacct holds for them. The one time the
   * card shows for when the customer was last on.
   */
  lastSeen: Date | null
  /**
   * The newest session has no stop record. Weak evidence — measured
   * 2026-09-27: the NASes send no interim updates (acctinterval null,
   * acctupdatetime = acctstarttime on every open row) and routinely drop stop
   * records, 94k open rows untouched for over a week, while real sessions run
   * a median 25h and past 11 days at p90. No age cut-off separates live from
   * abandoned, so the card shows lastSeen beside it for the reader to judge.
   */
  online: boolean
  bytesThisMonth: number | null
  sessionsThisMonth: number | null
  /** Framed-IP-Address of the newest session carrying one, or null. */
  ip: string | null
  /** Populated when the lookup failed, for the card's diagnostic line. */
  error: string | null
}

/**
 * The http:// link for a Framed-IP-Address, or null if it is not a dotted IPv4
 * address. radacct is written by the NAS, not by this app, so its text is not
 * put into an href unchecked.
 */
export function ipHref(address: string): string | null {
  const octet = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
  return new RegExp('^' + octet + '(\\.' + octet + '){3}$').test(address)
    ? 'http://' + address
    : null
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
  ip: null,
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

/**
 * WHEN A COMPANY'S ACCESS ENDS ON THE EXPIRY DAY.
 *
 * `settings.expiry_time` (migration 0026) is a time of day on the COMPANY'S OWN
 * clock, in `settings.timezone` - "08:00" means 8:00 AM where the company is.
 * It is converted here to the one thing radcheck can hold.
 *
 * radcheck stores wall-clock text with no zone, and FreeRADIUS reads it on the
 * NAS box's clock. That clock is UTC (checked 2026-10-03: MySQL there reports
 * now() = utc_timestamp(), and one radcheck table serves every company). So
 * 8:00 AM Jamaica (UTC-5, no daylight saving) is written "13:00". A company in
 * another zone, or one that observes daylight saving, gets its own hour, worked
 * out for the expiry date itself rather than assumed. The RADIUS clock being UTC
 * is built into applyExpiryClock below; if the NAS box ever moves zone, that is
 * the one function to change.
 */

/** A company's expiry time and the zone it is measured in. */
export type ExpiryClock = { time: string; timeZone: string }

/** "HH:MM" -> [hours, minutes], or null when it is not a valid 24-hour time. */
export function parseExpiryTime(value: string | null | undefined): [number, number] | null {
  const parts = (value ?? '').trim().split(':')
  if (parts.length !== 2) return null
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return [hours, minutes]
}

/** Minutes the zone is ahead of UTC at `at` (Jamaica is -300). */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')
  )
  return Math.round((asUtc - at.getTime()) / 60_000)
}

/**
 * `date`'s calendar day at the company's expiry time, as the wall-clock fields
 * the RADIUS machine should read.
 *
 * The expiry arithmetic (lib/expiry.ts, lib/billing.ts) works in whole days at
 * midnight and must keep doing so; this is applied once, at the last step
 * before a value is written to radcheck.
 *
 * The result is a Date whose LOCAL getters carry the RADIUS clock's fields,
 * because formatRadiusExpiration prints local getters - it is a carrier for
 * "13:00 on 8 Oct", not an instant. An unreadable time or zone leaves the date
 * untouched (midnight, as before) rather than guessing.
 */
export function applyExpiryClock(date: Date, clock: ExpiryClock | null): Date {
  if (!clock) return date
  const parsed = parseExpiryTime(clock.time)
  if (!parsed) return date

  try {
    // The company's wall time for that day, taken as if it were UTC, then
    // corrected by the zone's offset at that moment. Offset is read again at the
    // corrected instant so a daylight-saving change on the day cannot skew it.
    const naive = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), parsed[0], parsed[1])
    let instant = naive - zoneOffsetMinutes(clock.timeZone, new Date(naive)) * 60_000
    instant = naive - zoneOffsetMinutes(clock.timeZone, new Date(instant)) * 60_000

    const at = new Date(instant)
    return new Date(
      at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes()
    )
  } catch {
    // An unknown time zone name throws RangeError from Intl.
    return date
  }
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
 * The canonical form of a RADIUS identity, for COMPARING two of them.
 *
 * radcheck.username is `utf8_unicode_ci`, so MySQL happily matches
 * 'f4:92:bf:4c:b2:77' against 'F4:92:BF:4C:B2:77'. JavaScript does not, and any
 * place this app matched a value read back out of radcheck against a customer's
 * MAC in JS reported those customers unprovisioned while they were online. 980
 * radcheck rows are lower or mixed case.
 *
 * Whitespace is stripped for the same reason: some rows carry a LEADING space,
 * which is significant to the collation and to FreeRADIUS but is plainly not
 * part of anyone's identity.
 *
 * MAC-SHAPED VALUES ARE UPPERCASED; ANYTHING ELSE IS ONLY TRIMMED. A PPPoE
 * username is case-sensitive to FreeRADIUS, so folding its case would merge two
 * genuinely different subscribers.
 *
 * Total, and never throws — it is applied to whatever the database returns.
 * An empty or missing value keys to '' and matches nothing.
 */
export function usernameKey(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return ''

  const looksLikeMac = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(trimmed)
  return looksLikeMac ? trimmed.toUpperCase().replace(/-/g, ':') : trimmed
}

/**
 * MAC addresses are stored uppercase with colons throughout this app, and the
 * RADIUS username must match byte for byte or authentication silently fails.
 * PPPoE usernames pass through unchanged.
 *
 * THE WRITE PATH. Identical rule to usernameKey above, but it refuses an empty
 * value rather than returning one, because writing a blank username to radcheck
 * would create a row nothing can ever authenticate against or find again.
 */
export function normaliseUsername(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('RADIUS username cannot be empty.')

  return usernameKey(trimmed)
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
