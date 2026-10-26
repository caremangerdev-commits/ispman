import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'

import { cookies } from 'next/headers'

import { portalBaseDomain } from './config'

/**
 * The customer's portal session — entirely separate from staff auth.
 *
 * Staff sign in through Supabase (lib/session.ts); a customer has no Supabase
 * account and never will. Their session is a small HMAC-signed cookie carrying
 * only which company and which customer they are, verified on every portal
 * request. Stateless: no sessions table to keep, and nothing a customer holds
 * can be altered without the server's secret.
 *
 * TWO COOKIES, TWO PURPOSES:
 *   session  — signed in; { c: companyId, u: customerId }, long-lived.
 *   pending  — phone verified by SMS but the number maps to more than one
 *              customer, so a choice is owed; { c: companyId, p: phone },
 *              short-lived, and the ONLY proof the pick step trusts.
 */

const SESSION_COOKIE = 'ispman_portal'
const PENDING_COOKIE = 'ispman_portal_pending'
const SESSION_TTL = 60 * 60 * 24 * 30 // 30 days
const PENDING_TTL = 60 * 10 // 10 minutes

function secret(): string {
  const s = (process.env.PORTAL_SESSION_SECRET ?? '').trim()
  if (!s) throw new Error('PORTAL_SESSION_SECRET is not set; the customer portal cannot sign sessions.')
  return s
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Signs a payload with an embedded expiry. Returns `<body>.<sig>`. */
function sign(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }))
  const sig = b64url(createHmac('sha256', secret()).update(body).digest())
  return body + '.' + sig
}

/** Verifies `<body>.<sig>` and the expiry. Null on any tampering or staleness. */
function verify<T extends Record<string, unknown>>(token: string | undefined): T | null {
  if (!token) return null
  const dot = token.indexOf('.')
  if (dot < 1) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  let expected: string
  try {
    expected = b64url(createHmac('sha256', secret()).update(body).digest())
  } catch {
    return null
  }
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) as T & { exp?: number }
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

function cookieOptions(maxAge: number) {
  const base = portalBaseDomain()
  // Scope the cookie to the registrable portal domain so a session set on one
  // host (wcnet.pay.ispman.online) is readable on the apex and on every other
  // tenant subdomain — which is what let a cross-host hop after sign-in lose it.
  // Sharing the domain is safe: getPortalSession/getPendingPick reject any token
  // whose company does not match the host's company. Host-only in dev, where the
  // base is a dotless name like "localhost" that browsers refuse as a Domain.
  const domain = base && base.includes('.') ? base : undefined
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
    ...(domain ? { domain } : {}),
  }
}

/**
 * HOW the customer proved who they are, carried in the session itself.
 *
 *   'sms'      a code texted to the number on the account. The number is
 *              proven, because they had to receive on it.
 *   'account'  their phone number and account number, both of which a
 *              neighbour or a relative could know. Enough to see the account
 *              and pay it; not enough to change where messages go.
 *
 * IN THE SIGNED COOKIE, not in a lookup: the level has to be as unforgeable as
 * the customer id beside it, and it is the server that reads it on every
 * action, so hiding a button is never what enforces this.
 */
export type PortalAuthLevel = 'sms' | 'account'

export type PortalSession = {
  companyId: number
  customerId: number
  level: PortalAuthLevel
}

/** The signed-in customer, scoped to the company the request resolved to. */
export async function getPortalSession(companyId: number): Promise<PortalSession | null> {
  const jar = await cookies()
  const payload = verify<{ c: number; u: number; v?: string }>(jar.get(SESSION_COOKIE)?.value)
  if (!payload || payload.c !== companyId) return null
  // A cookie issued before this field existed came from the SMS flow, which was
  // the only way in, so no signed-in customer is demoted by the upgrade.
  return {
    companyId: payload.c,
    customerId: payload.u,
    level: payload.v === 'account' ? 'account' : 'sms',
  }
}

export async function setPortalSession(
  companyId: number,
  customerId: number,
  level: PortalAuthLevel = 'sms'
): Promise<void> {
  const jar = await cookies()
  jar.set(
    SESSION_COOKIE,
    sign({ c: companyId, u: customerId, v: level }, SESSION_TTL),
    cookieOptions(SESSION_TTL)
  )
  // Expire, not delete: a Domain-scoped cookie is only cleared by a Set-Cookie
  // carrying the same Domain and Path, which jar.delete(name) does not send.
  jar.set(PENDING_COOKIE, '', cookieOptions(0))
}

export async function clearPortalSession(): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, '', cookieOptions(0))
  jar.set(PENDING_COOKIE, '', cookieOptions(0))
}

export type PendingPick = { companyId: number; phone: string }

/** Marks a phone as SMS-verified for this company, pending a customer choice. */
export async function setPendingPick(companyId: number, phone: string): Promise<void> {
  const jar = await cookies()
  jar.set(PENDING_COOKIE, sign({ c: companyId, p: phone }, PENDING_TTL), cookieOptions(PENDING_TTL))
}

export async function getPendingPick(companyId: number): Promise<PendingPick | null> {
  const jar = await cookies()
  const payload = verify<{ c: number; p: string }>(jar.get(PENDING_COOKIE)?.value)
  if (!payload || payload.c !== companyId) return null
  return { companyId: payload.c, phone: payload.p }
}
