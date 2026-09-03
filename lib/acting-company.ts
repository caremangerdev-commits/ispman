import 'server-only'
import { cookies } from 'next/headers'

/**
 * The super admin "enter company" switch.
 *
 * WHAT THIS COOKIE IS: a POINTER, not a capability. It names which tenant the
 * platform operator is currently looking at. It carries no authority of its
 * own and is never trusted on its own — `getSession()` re-reads
 * `users.is_super_admin` from the database on every single request and
 * discards this cookie outright when that flag is not set.
 *
 * That is why it needs no signature and no server-side session table: forging
 * it is pointless. A normal user who hand-crafts this cookie selects a company
 * that the session layer then refuses to honour, and lands right back in their
 * own tenant.
 *
 * The user id is embedded so a cookie left behind by one account is dead for
 * the next account to sign in on the same browser, without waiting for the
 * sign-out path to clear it.
 */
export const ACTING_COMPANY_COOKIE = 'ispman_acting_company'

export type ActingCookie = {
  companyId: number
  /** The `users.id` of the super admin who set it. */
  userId: number
}

export function formatActingCookie(companyId: number, userId: number): string {
  return companyId + ':' + userId
}

/** Strict parse — anything malformed reads as "not switched". */
export function parseActingCookie(raw: string | undefined | null): ActingCookie | null {
  if (!raw) return null

  // Matched rather than split-and-Number(), which would quietly accept
  // " 12:7 ", "12:7e0" and other shapes this never writes. Nothing about the
  // value is negotiable, so nothing about it is coerced.
  const m = /^(\d+):(\d+)$/.exec(raw)
  if (!m) return null

  const companyId = Number(m[1])
  const userId = Number(m[2])

  if (!Number.isSafeInteger(companyId) || companyId <= 0) return null
  if (!Number.isSafeInteger(userId) || userId <= 0) return null

  return { companyId, userId }
}

export async function readActingCookie(): Promise<ActingCookie | null> {
  const store = await cookies()
  return parseActingCookie(store.get(ACTING_COMPANY_COOKIE)?.value)
}

/**
 * httpOnly so page scripts cannot write it. No maxAge, so it is a session
 * cookie: closing the browser drops the switch rather than leaving a platform
 * operator silently inside someone else's tenant next week.
 */
export const ACTING_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
}
