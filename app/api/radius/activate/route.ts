import { NextResponse, type NextRequest } from 'next/server'

import { can } from '@/lib/permissions'
import { activateInRadius, radiusConfigured } from '@/lib/radius-db'
import { getSession } from '@/lib/session'

/**
 * Activates a username in FreeRADIUS.
 *
 * SECURITY: this is a real network-side mutation, so it is gated on an
 * authenticated session holding `activate_customer` — not on a shared header.
 * "Only our app calls it" is not enforceable: the route is reachable by anyone
 * who can reach the server, and a header secret would sit in the same env as
 * the database password without adding a distinct check.
 *
 * The app itself does not need this route — app/actions/customers.ts calls
 * activateInRadius() directly, which is one fewer hop. It exists for external
 * callers (a NAS script, a cron job) that cannot invoke a server action.
 */
export async function POST(request: NextRequest) {
  const { profile } = await getSession()
  if (!can(profile.role, 'activate_customer')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  if (!radiusConfigured()) {
    return NextResponse.json(
      { success: false, error: 'RADIUS database is not configured.' },
      { status: 503 }
    )
  }

  let body: { mac?: unknown; expiry?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Body must be JSON.' }, { status: 400 })
  }

  const mac = typeof body.mac === 'string' ? body.mac.trim() : ''
  const expiry = typeof body.expiry === 'string' ? body.expiry.trim() : ''

  if (!mac) {
    return NextResponse.json(
      { success: false, error: 'mac is required.' },
      { status: 400 }
    )
  }
  if (!expiry) {
    return NextResponse.json(
      { success: false, error: 'expiry is required, in FreeRADIUS format e.g. "21 Sep 2026 00:00".' },
      { status: 400 }
    )
  }

  try {
    await activateInRadius(mac, expiry)
    return NextResponse.json({ success: true })
  } catch (err) {
    const e = err as { code?: string; message?: string; sqlMessage?: string }
    return NextResponse.json(
      {
        success: false,
        code: e.code ?? null,
        error: e.sqlMessage ?? e.message ?? String(err),
      },
      { status: 500 }
    )
  }
}
