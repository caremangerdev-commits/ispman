import { NextResponse } from 'next/server'

import { can } from '@/lib/permissions'
import { radiusConfigured, radiusPool } from '@/lib/radius-db'
import { getSession } from '@/lib/session'

/**
 * Connectivity check for the FreeRADIUS MySQL bridge.
 *
 * Diagnostic only — it reports whether the pool can reach the database and how
 * many radcheck rows exist. Gated on an authenticated admin session because the
 * error text can disclose the host, user and network topology.
 */
export async function GET() {
  const { profile } = await getSession()
  if (!can(profile.role, 'manage_company_settings')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  if (!radiusConfigured()) {
    return NextResponse.json(
      {
        success: false,
        error:
          'RADIUS database is not configured. Set RADIUS_DB_HOST, RADIUS_DB_USER, ' +
          'RADIUS_DB_PASSWORD and RADIUS_DB_NAME in .env.local.',
      },
      { status: 503 }
    )
  }

  const started = Date.now()

  try {
    const [rows] = await radiusPool().query('SELECT COUNT(*) AS count FROM radcheck')
    const count = Number((rows as { count: number | string }[])[0]?.count ?? 0)

    return NextResponse.json({
      success: true,
      count,
      host: process.env.RADIUS_DB_HOST,
      database: process.env.RADIUS_DB_NAME,
      elapsedMs: Date.now() - started,
    })
  } catch (err) {
    const e = err as { code?: string; errno?: number; message?: string; sqlMessage?: string }
    return NextResponse.json(
      {
        success: false,
        // The driver's code is the useful part when diagnosing: ETIMEDOUT means
        // the host or firewall, ER_ACCESS_DENIED_ERROR means the credentials,
        // ER_NO_SUCH_TABLE means the schema.
        code: e.code ?? null,
        errno: e.errno ?? null,
        error: e.sqlMessage ?? e.message ?? String(err),
        host: process.env.RADIUS_DB_HOST,
        database: process.env.RADIUS_DB_NAME,
        elapsedMs: Date.now() - started,
      },
      { status: 500 }
    )
  }
}
