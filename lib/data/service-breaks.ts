import 'server-only'

import { instantToDateOnly, localDateOnly } from '@/lib/format'
import { logExpiryChange, logField, readLogDetail } from '@/lib/log-detail'
import { batchGetRadiusStatus } from '@/lib/radius-db'
import { parseRadiusExpiration, usernameKey } from '@/lib/radius/format'
import { serviceBreaks, type ExpiryEvent, type ServiceBreak } from '@/lib/service-days'
import { fetchAllRows } from '@/lib/supabase/paging'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Every customer's breaks in service, for postpaid day-based charging (owner,
 * 11 Oct 2026: "use the log for October service days").
 *
 * FROM THE LOG, NOT A NEW RECORD. Every change ISPMan makes to an expiry is
 * already logged with what it was before and after: the till's write
 * (`radius_extend`, raw RADIUS values) and the network buttons and scripts
 * (`network_*`, "Expiry A -> B" — read by lib/log-detail.ts#logExpiryChange).
 * When a customer was cut off and when they came back follow from those
 * (lib/service-days.ts#serviceBreaks), and the registry as it stands says
 * whether they are on NOW — which also catches a change made outside ISPMan,
 * though not the day it was made.
 *
 * Read in one pass per company: the bill day prices every customer at once.
 */

const EXPIRY_TYPES = [
  'radius_extend',
  'network_provision', 'network_reconnect', 'network_extend', 'network_disconnect', 'network_expiry_corrected',
]

const rawDay = (raw: string | null) => {
  const d = parseRadiusExpiration(raw)
  return d ? localDateOnly(d) : null
}

export async function readServiceBreaks(opts: {
  companyId: number
  timezone: string
  /** Today in the company's zone. */
  today: string
  customers: { id: number; identity: string | null }[]
}): Promise<Map<number, ServiceBreak[]>> {
  const { companyId, timezone, today, customers } = opts
  const db = tenantClient()

  const rows = await fetchAllRows(
    (from, to) =>
      db
        .from('log')
        .select('customer_id, created_at, type, details')
        .eq('company_id', companyId)
        .in('type', EXPIRY_TYPES)
        .not('customer_id', 'is', null)
        .order('created_at')
        .order('id')
        .range(from, to),
    'expiry changes'
  ) as { customer_id: number; created_at: string; type: string; details: string | null }[]

  const events = new Map<number, ExpiryEvent[]>()
  for (const r of rows) {
    const body = readLogDetail(r.details).body
    // A write that never reached the NAS changed nothing.
    if (body.includes('SKIPPED')) continue
    let change: { from: string | null; to: string } | null = null
    if (r.type === 'radius_extend') {
      const to = rawDay(logField(body, 'new_expiry'))
      if (to) change = { from: rawDay(logField(body, 'old_expiry')), to }
    } else {
      change = logExpiryChange(body)
    }
    if (!change) continue
    const list = events.get(r.customer_id) ?? []
    list.push({ day: instantToDateOnly(new Date(r.created_at), timezone), ...change })
    events.set(r.customer_id, list)
  }

  const registry = await batchGetRadiusStatus(customers.map((c) => c.identity))

  const out = new Map<number, ServiceBreak[]>()
  for (const c of customers) {
    const record = c.identity ? registry.get(usernameKey(c.identity)) : undefined
    if (!record || !record.exists) continue
    const onNow = record.status === 'active'
    const expiryNow = record.expiry ? localDateOnly(record.expiry) : null
    out.set(c.id, serviceBreaks(events.get(c.id) ?? [], today, onNow, expiryNow))
  }
  return out
}
