import 'server-only'

import mysql from 'mysql2/promise'

import {
  formatRadiusExpiration, normaliseUsername, parseRadiusExpiration, usernameKey,
} from '@/lib/radius/format'
import type { CustomerStatus } from '@/lib/status'

export { parseRadiusExpiration }

/**
 * Connection pool for the FreeRADIUS MySQL database on the NAS box.
 *
 * This is a second datastore alongside Supabase: subscriber records live in
 * Postgres, but the thing that actually lets a customer online is a row in
 * `radcheck`. The two can drift, so every write here is paired with a Supabase
 * write in the calling action.
 *
 * Created lazily so importing this module cannot crash a request when the
 * RADIUS env vars are absent — callers get a clear error instead.
 */
let pool: mysql.Pool | null = null

export function radiusPool(): mysql.Pool {
  if (pool) return pool

  const host = process.env.RADIUS_DB_HOST
  const user = process.env.RADIUS_DB_USER
  const password = process.env.RADIUS_DB_PASSWORD
  const database = process.env.RADIUS_DB_NAME

  if (!host || !user || !password || !database) {
    throw new Error(
      'RADIUS database is not configured. Set RADIUS_DB_HOST, RADIUS_DB_USER, ' +
        'RADIUS_DB_PASSWORD and RADIUS_DB_NAME in .env.local.'
    )
  }

  pool = mysql.createPool({
    host,
    user,
    password,
    database,
    port: Number(process.env.RADIUS_DB_PORT ?? 3306),
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 10_000,
    // The NAS is on AWS, whose network path silently drops idle TCP sockets
    // after a few minutes. MySQL's own wait_timeout is 8h, so the server never
    // closes the connection and mysql2 keeps handing out a socket that is
    // already dead — the next query fails with ECONNRESET. TCP keepalives hold
    // the path open, and idleTimeout recycles anything that still goes stale.
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
    idleTimeout: 120_000,
    maxIdle: 4,
  })

  return pool
}

/** Connection-level failures, as opposed to a SQL error we should surface. */
const TRANSIENT = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'EPROTO',
])

/**
 * Runs a RADIUS query, retrying once if the connection itself failed.
 *
 * A dropped socket surfaces on the first use after the idle period, so a single
 * retry against a fresh connection is enough. Only connection errors are
 * retried — a SQL error is a real error and must propagate.
 *
 * Safe for the writes in this module because all of them are idempotent:
 * activate deletes before inserting, and extend/disconnect are UPDATEs to an
 * absolute value rather than relative increments.
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    const code = (err as { code?: string }).code
    if (!code || !TRANSIENT.has(code)) throw err

    console.warn('[radius] transient %s — retrying once on a fresh connection', code)
    return operation()
  }
}

export default radiusPool

/** True when the RADIUS env vars are present; used to degrade gracefully. */
export function radiusConfigured(): boolean {
  return Boolean(
    process.env.RADIUS_DB_HOST &&
      process.env.RADIUS_DB_USER &&
      process.env.RADIUS_DB_PASSWORD &&
      process.env.RADIUS_DB_NAME
  )
}

const AUTH_TYPE = 'Auth-Type'
const EXPIRATION = 'Expiration'

/**
 * Provisions a customer so FreeRADIUS will accept them until `expiry`.
 *
 * Clears any prior rows for the username first, so a re-activation cannot
 * leave a stale second Expiration row behind — FreeRADIUS would otherwise
 * apply whichever it read first.
 *
 * `expiry` must already be in FreeRADIUS format ("21 Sep 2026 00:00"); use
 * formatRadiusExpiration to produce it.
 */
export async function activateInRadius(mac: string, expiry: string): Promise<void> {
  const username = normaliseUsername(mac)

  return withRetry(async () => {
    const conn = await radiusPool().getConnection()

    try {
      await conn.beginTransaction()

      await conn.execute('DELETE FROM radcheck WHERE username = ?', [username])
      await conn.query(
        'INSERT INTO radcheck (username, attribute, op, value) VALUES ?',
        [[
          [username, AUTH_TYPE, ':=', 'Accept'],
          [username, EXPIRATION, ':=', expiry],
        ]]
      )

      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  })
}

/**
 * Disconnects a customer by setting their Expiration to now.
 *
 * SEPARATE FROM extendInRadius ON PURPOSE. A disconnect writes an expiry
 * EARLIER than the one on record — that is the whole point of it — and
 * extendInRadius refuses backwards writes as its last line of defence against
 * a miscalculated renewal. Rather than weaken that guard with a bypass flag
 * (which the next caller would inevitably reach for), the one operation that
 * legitimately moves an expiry backwards gets its own function.
 *
 * Deliberately does not delete the rows: keeping the record means the history
 * and any per-user attributes survive, and reconnecting is a single update.
 *
 * The NAS enforces Expiration at authentication, so a customer with a live
 * session may stay online until it renews. That is stated in the confirmation
 * dialog rather than papered over here.
 */
export async function disconnectInRadius(mac: string): Promise<void> {
  const username = normaliseUsername(mac)

  const value = formatRadiusExpiration(new Date())

  return withRetry(async () => {
    const pool = radiusPool()
    const [result] = await pool.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ?',
      [value, username, EXPIRATION]
    )

    // No Expiration row means nothing was constraining them — add one, otherwise
    // the "disconnect" would silently leave the account open.
    const affected = (result as mysql.ResultSetHeader).affectedRows ?? 0
    if (affected === 0) {
      await pool.execute(
        'INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)',
        [username, EXPIRATION, ':=', value]
      )
    }
  })
}

/**
 * Sets a customer's expiry to an EARLIER date, to correct a mistaken extension.
 *
 * THE SECOND DELIBERATE BACKWARDS WRITE, and it follows the precedent
 * disconnectInRadius set rather than reopening the argument: the guard in
 * extendInRadius is not weakened, given a bypass flag, or made conditional. An
 * operation that legitimately moves an expiry backwards gets its own function,
 * so every renewal path keeps a guard that cannot be talked out of rejecting a
 * miscalculated date.
 *
 * WHY THIS IS SAFE WHERE A FLAG WOULD NOT BE. The guard exists to catch a date
 * a CALCULATION produced — a renewal that silently shortens paid-for access.
 * Nothing here is calculated: `expiry` is a date a manager typed, having been
 * shown the current one, with a reason recorded against their name. The check
 * being skipped is a check for an error class that cannot occur on this path.
 *
 * Deliberately does NOT create the row when none exists. extendInRadius inserts
 * on a miss because an extension for an unprovisioned customer is still a grant
 * of access; correcting an expiry that is not there is nonsense, and silently
 * provisioning someone in the middle of an undo would be the opposite of what
 * the manager asked for. Callers get `false` and must report it.
 *
 * Returns true when a row was updated, false when the identity had no
 * Expiration row to correct.
 */
export async function correctExpiryInRadius(
  mac: string,
  newExpiry: string
): Promise<boolean> {
  const username = normaliseUsername(mac)

  return withRetry(async () => {
    const pool = radiusPool()
    const [result] = await pool.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ?',
      [newExpiry, username, EXPIRATION]
    )

    return ((result as mysql.ResultSetHeader).affectedRows ?? 0) > 0
  })
}

/**
 * Sets an Expiration to `next` ONLY IF it still holds exactly `expected`.
 *
 * The one compare-and-set write: used to put back the month a deleted payment
 * gave (lib/data/payment-expiry.ts). Nothing is calculated against the live
 * value — the caller read it, decided, and names what it read; if anything
 * changed it in between (another payment, an Extend, a correction), this
 * writes nothing and returns false, and the caller says so rather than guess.
 *
 * Earlier or later are both allowed: an undo moves whichever way the payment
 * did not. Never creates a row.
 */
export async function replaceExpiryInRadius(
  mac: string,
  expected: string,
  next: string
): Promise<boolean> {
  const username = normaliseUsername(mac)

  return withRetry(async () => {
    const pool = radiusPool()
    const [result] = await pool.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [next, username, EXPIRATION, expected]
    )

    return ((result as mysql.ResultSetHeader).affectedRows ?? 0) > 0
  })
}

/**
 * A customer's live state, derived entirely from radcheck.
 *
 * `expiry` is a Date rather than the raw string so callers never re-parse the
 * FreeRADIUS format themselves.
 */
export type RadiusRecord = {
  exists: boolean
  status: CustomerStatus
  expiry: Date | null
  /** Raw Expiration value as stored, for display. */
  rawExpiry: string | null
}

export const UNPROVISIONED: RadiusRecord = {
  exists: false,
  status: 'unprovisioned',
  expiry: null,
  rawExpiry: null,
}

/** Three months before now — the line between "expired" and "inactive". */
function inactiveCutoff(now = new Date()): Date {
  const d = new Date(now)
  d.setMonth(d.getMonth() - 3)
  return d
}

/**
 * Turns one identity's radcheck rows into a status.
 *
 * Expiration is the only thing consulted. `Auth-Type := Reject` is never
 * written by this app — suspension was removed from the status model, and a
 * customer is taken off the network by expiry alone (disconnectInRadius). A
 * Reject row placed there by hand is therefore not something this app claims
 * to understand, and is not read back as a status.
 *
 * 'disconnected' is NOT derived here: radcheck cannot tell a deliberate cut-off
 * from an ordinary lapse, because both are an expiry in the past. The caller
 * layers that on from the event log — see lib/status.ts#resolveStatus.
 */
function deriveStatus(
  records: { attribute: string; value: string }[],
  now = new Date()
): RadiusRecord {
  if (records.length === 0) return UNPROVISIONED

  const rawExpiry = records.find((r) => r.attribute === EXPIRATION)?.value ?? null
  // records arrives already reduced to ONE spelling by the callers below, so
  // find() cannot pick between a clean row and a whitespace variant here.
  const expiry = parseRadiusExpiration(rawExpiry)

  // Rows exist but carry no usable expiry: nothing constrains the account, so
  // FreeRADIUS accepts it. Treated as active rather than failing closed, which
  // would cut off a working customer over a formatting quirk.
  if (!expiry) return { exists: true, status: 'active', expiry: null, rawExpiry }

  const status: CustomerStatus =
    expiry.getTime() > now.getTime() ? 'active'
      : expiry.getTime() > inactiveCutoff(now).getTime() ? 'expired'
        : 'inactive'

  return { exists: true, status, expiry, rawExpiry }
}

/**
 * Reads one customer's current radcheck state.
 *
 * The OR TRIM branch is not redundant with the collation. `username` is
 * `utf8_unicode_ci`, so `= ?` already matches a differently-cased row — but a
 * LEADING SPACE is significant and would hide the row completely. Trailing
 * spaces the collation ignores on its own.
 *
 * Where both a clean row and a whitespace variant exist, the clean one wins:
 * that is the row FreeRADIUS itself authenticates against, so it is the row
 * whose expiry describes the customer's real access.
 */
export async function getRadiusStatus(mac: string): Promise<RadiusRecord> {
  const username = normaliseUsername(mac)

  const [rows] = await withRetry(() =>
    radiusPool().execute(
      'SELECT username, attribute, value FROM radcheck WHERE username = ? OR TRIM(username) = ?',
      [username, username]
    )
  )

  // Same rule as the batch path: where both a clean row and a whitespace
  // variant came back, only the clean one is derived from. Merging the two
  // would let a dead variant's Expiration decide a live customer's status —
  // and on this data those differ by as much as three years.
  const all = rows as { username: string; attribute: string; value: string }[]
  const clean = all.filter((r) => r.username === username)

  return deriveStatus(clean.length > 0 ? clean : all)
}

/**
 * The same derivation for many identities, in a single query.
 *
 * The customer list and the dashboard both need a status per row; doing this
 * one identity at a time would be a round trip each. Identities with no rows
 * are absent from the returned Map, so callers can tell "no record" from
 * "not asked about".
 */
export async function batchGetRadiusStatus(
  macs: (string | null | undefined)[]
): Promise<Map<string, RadiusRecord>> {
  const out = new Map<string, RadiusRecord>()

  const list = [...new Set(
    macs.filter((m): m is string => Boolean(m && m.trim())).map(normaliseUsername)
  )]
  if (list.length === 0) return out

  // OR TRIM catches the rows a leading space hides. The collation already makes
  // the IN case-insensitive, so a lower or mixed case row comes back either way.
  const [rows] = await withRetry(() =>
    radiusPool().query(
      'SELECT username, attribute, value FROM radcheck ' +
      'WHERE username IN (?) OR TRIM(username) IN (?)',
      [list, list]
    )
  )

  // THE BUG THIS REPLACES: the rows were bucketed under `r.username` exactly as
  // radcheck spells it, then read back under the uppercase form. MySQL had
  // matched 'f4:92:bf:4c:b2:77' case-insensitively and handed it over, and the
  // JS Map lookup then missed it — so the customer derived from an empty record
  // set and rendered Unprovisioned while they were online.
  //
  // Two buckets, not one. Where a clean row and a whitespace variant both
  // exist for an identity, the clean row is the one FreeRADIUS authenticates
  // against, so it must win rather than whichever the database listed first.
  const exact = new Map<string, { attribute: string; value: string }[]>()
  const variant = new Map<string, { attribute: string; value: string }[]>()

  for (const r of rows as { username: string; attribute: string; value: string }[]) {
    const key = usernameKey(r.username)
    if (!key) continue
    const into = r.username === key ? exact : variant
    const bucket = into.get(key) ?? []
    bucket.push({ attribute: r.attribute, value: r.value })
    into.set(key, bucket)
  }

  const now = new Date()
  for (const username of list) {
    out.set(username, deriveStatus(exact.get(username) ?? variant.get(username) ?? [], now))
  }

  return out
}

/**
 * Moves a customer's expiry out, creating the row if they have none.
 *
 * DO NOT REMOVE THE GUARD BELOW. An extension is an UPDATE to an absolute
 * value, so a miscalculated date silently shortens access the customer has
 * already paid for — exactly what happened when this was computed from
 * `last_bill_date` instead of the registry. The guard rejects any write that
 * would move an expiry backwards, whatever produced the date. It is the last
 * line of defence and is deliberately independent of the callers.
 */
export async function extendInRadius(mac: string, newExpiry: string): Promise<void> {
  const username = normaliseUsername(mac)

  return withRetry(async () => {
    const pool = radiusPool()

    const [currentRows] = await pool.execute(
      'SELECT value FROM radcheck WHERE username = ? AND attribute = ?',
      [username, EXPIRATION]
    )
    const currentRaw = (currentRows as { value: string }[])[0]?.value ?? null
    const current = parseRadiusExpiration(currentRaw)
    const next = parseRadiusExpiration(newExpiry)

    if (current && next && next.getTime() < current.getTime()) {
      console.error(
        '[radius] BACKWARDS EXTENSION REJECTED for %s: current=%s (%s) new=%s (%s)',
        username, currentRaw, current.toISOString(), newExpiry, next.toISOString()
      )
      throw new Error(
        'Extension rejected: new expiry ' + newExpiry +
        ' is before current expiry ' + currentRaw + '. Possible calculation error.'
      )
    }

    const [result] = await pool.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ?',
      [newExpiry, username, EXPIRATION]
    )

    if (((result as mysql.ResultSetHeader).affectedRows ?? 0) === 0) {
      await pool.execute(
        'INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)',
        [username, EXPIRATION, ':=', newExpiry]
      )
    }
  })
}

/**
 * Which of these identities have radcheck rows, as one query.
 *
 * The customer list needs this for every row on the page; doing it per row
 * would be a round trip each. Returns a Set of the identities that exist, so a
 * miss is an explicit "not provisioned" rather than an unknown.
 *
 * Returns an empty Set on any failure — callers must treat "unknown" and
 * "absent" differently, so use radiusConfigured() to tell them apart.
 */
export async function getProvisionedIdentities(
  identities: (string | null | undefined)[]
): Promise<Set<string>> {
  const list = [...new Set(
    identities.filter((x): x is string => Boolean(x && x.trim())).map(normaliseUsername)
  )]
  if (list.length === 0) return new Set()

  const [rows] = await withRetry(() =>
    radiusPool().query(
      'SELECT DISTINCT username FROM radcheck WHERE username IN (?) OR TRIM(username) IN (?)',
      [list, list]
    )
  )

  // Normalised on the way out, so callers compare like with like. This used to
  // return radcheck's own spelling, which meant a caller holding an uppercase
  // MAC missed every lower-case row and re-provisioned a customer who was
  // already on the network.
  return new Set(
    (rows as { username: string }[]).map((r) => usernameKey(r.username)).filter(Boolean)
  )
}

export type RadiusUsage = {
  /**
   * The latest timestamp radacct holds for them, start or stop — the last
   * moment they are known to have been on. Null if never seen.
   */
  lastSeen: Date | null
  /** True while a session is open (acctstoptime IS NULL). */
  online: boolean
  /** in + out octets summed over the current calendar month. */
  bytesThisMonth: number
  sessionsThisMonth: number
}

/**
 * Session history for one RADIUS identity from `radacct`.
 *
 * The identity is the MAC for DHCP customers and the PPPoE username for PPPoE
 * ones — the same rule the radcheck writes use, so the two tables agree.
 *
 * Note on the octet columns: on this NAS they are frequently 0 even for live
 * sessions, because the hotspot is not reporting interim accounting updates.
 * The sum is therefore correct but often reads as zero — that is the data, not
 * a bug in this query.
 */
export async function getRadiusUsage(identity: string): Promise<RadiusUsage> {
  const username = normaliseUsername(identity)

  // One round trip, not two. Both figures come from the same index range scan
  // on radacct(username), so splitting them into a 'latest session' query and a
  // 'this month' query read the same rows twice for no gain.
  //
  // last_open_start is the newest session that has no stop time. Comparing it
  // to last_start answers 'is the MOST RECENT session still open' — which is
  // what online means here, and is not the same as 'any session is open'.
  //
  // last_seen_at is what the card displays: the latest timestamp radacct holds
  // for them, start or stop. It used to be last_start alone, which for a
  // closed session is days early — sessions here run a median 25h and past 11
  // days at p90. The stop column cannot be taken on its own either: measured
  // 2026-09-27, 89k rows stop BEFORE they start (usually by one second, even
  // with a 36-day acctsessiontime) and 61k stop exactly at the start. None lie
  // in the future. GREATEST keeps a real stop and falls back to the start for
  // a bogus one. acctupdatetime is left out: it always equals the start.
  const [rows] = await withRetry(() =>
    radiusPool().execute(
      `SELECT MAX(acctstarttime)                                         AS last_start,
              MAX(CASE WHEN acctstoptime IS NULL THEN acctstarttime END) AS last_open_start,
              MAX(GREATEST(acctstarttime,
                           COALESCE(acctstoptime, acctstarttime)))       AS last_seen_at,
              COALESCE(SUM(CASE WHEN acctstarttime >= DATE_FORMAT(NOW(), '%Y-%m-01')
                                THEN acctinputoctets + acctoutputoctets END), 0) AS bytes_month,
              COALESCE(SUM(CASE WHEN acctstarttime >= DATE_FORMAT(NOW(), '%Y-%m-01')
                                THEN 1 END), 0)                          AS sessions_month
         FROM radacct
        WHERE username = ?`,
      [username]
    )
  )

  const r = (rows as {
    last_start: Date | null
    last_open_start: Date | null
    last_seen_at: Date | null
    bytes_month: string | number
    sessions_month: string | number
  }[])[0]

  return {
    lastSeen: r?.last_seen_at ? new Date(r.last_seen_at) : null,
    online: Boolean(
      r?.last_open_start && r.last_start &&
      new Date(r.last_open_start).getTime() === new Date(r.last_start).getTime()
    ),
    // SUM() of a BIGINT comes back as a string from the driver.
    bytesThisMonth: Number(r?.bytes_month ?? 0),
    sessionsThisMonth: Number(r?.sessions_month ?? 0),
  }
}

/**
 * The Framed-IP-Address of one identity's newest session that carries one.
 * Read only.
 *
 * NEWEST, NOT "ANY OPEN". A NAS that never sends a stop record leaves a session
 * open forever, so preferring any open row would put a days-old address on the
 * card as current while Last Seen says otherwise. When the customer is really
 * online their open session is the newest row, so this returns it anyway. When
 * that address was in use is the Last Seen row's job, not this one's.
 *
 * Null when radacct holds no address for them — some routers send no
 * accounting, and some send it without Framed-IP-Address.
 */
export async function getRadiusIp(identity: string): Promise<string | null> {
  const username = normaliseUsername(identity)

  const [rows] = await withRetry(() =>
    radiusPool().execute(
      `SELECT framedipaddress
         FROM radacct
        WHERE username = ? AND framedipaddress <> ''
        ORDER BY acctstarttime DESC
        LIMIT 1`,
      [username]
    )
  )

  const address = (rows as { framedipaddress: string }[])[0]?.framedipaddress.trim()
  return address || null
}
