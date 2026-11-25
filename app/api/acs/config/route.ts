import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

import { NextResponse, type NextRequest } from 'next/server'

import { cleanOnuConfig, wifiNameFor, wifiPasswordFor, type OnuCustomer } from '@/lib/acs/config'
import { serialForms } from '@/lib/acs/genieacs'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * What one ONU should have inside it, asked for by ISPMan's ACS every time
 * that ONU checks in (deploy/genieacs/ispman-ext.js → the "ispman" provision).
 *
 * NO SESSION: the caller is the ACS on this same server. It proves itself
 * with ACS_SHARED_SECRET, and the answer is about one serial only.
 *
 * THE SERIAL DECIDES THE COMPANY. An ONU is set up only if exactly one
 * company has it registered on one of its OLTs, only as that company has
 * chosen (company_onu_config), and only if it is linked to a customer. An ONU
 * nobody claims gets nothing.
 *
 * `version` changes only when what the ONU should have changes. The provision
 * records it on the device and sends the values only for a version it has not
 * applied, because an ONU that never reads its Wi-Fi password back would
 * otherwise have it rewritten — and its Wi-Fi restarted — at every check-in.
 */

export const dynamic = 'force-dynamic'

const nothing = (reason: string) => NextResponse.json({ ok: true, set: false, reason })

function secretOk(given: string | null): boolean {
  const want = process.env.ACS_SHARED_SECRET ?? ''
  if (!want || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Ten characters nobody will misread: no 0/O, 1/l/I. */
function randomPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 10 }, () => chars[randomInt(chars.length)]).join('')
}

export async function GET(req: NextRequest) {
  if (!secretOk(req.headers.get('x-ispman-acs'))) {
    return NextResponse.json({ ok: false, error: 'Not allowed.' }, { status: 403 })
  }
  const serial = (req.nextUrl.searchParams.get('serial') ?? '').trim()
  const model = (req.nextUrl.searchParams.get('model') ?? '').slice(0, 80) || null
  const deviceId = (req.nextUrl.searchParams.get('device') ?? '').slice(0, 200) || null
  if (!/^[A-Za-z0-9-]{8,32}$/.test(serial)) return nothing('no serial')

  const db = tenantClient()
  const forms = serialForms(serial)
  const { data: onus } = await db.from('olt_onus').select('company_id, olt_id, serial').in('serial', forms)
  const owners = [...new Set(((onus ?? []) as { company_id: number }[]).map((o) => o.company_id))]
  if (owners.length !== 1) return nothing(owners.length ? 'claimed by more than one company' : 'not on any OLT')
  const onu = (onus as { company_id: number; olt_id: number; serial: string }[])[0]
  const companyId = onu.company_id

  const { data: cfgRow } = await db.from('company_onu_config').select('config').eq('company_id', companyId).maybeSingle()
  const cfg = cleanOnuConfig((cfgRow as { config: unknown } | null)?.config)

  // Seen, whatever happens next: the ONU page shows that it reached the ACS.
  const { data: had } = await db
    .from('onu_acs')
    .select('version, wifi_password')
    .eq('company_id', companyId)
    .eq('serial', onu.serial)
    .maybeSingle()
  const prev = had as { version: string | null; wifi_password: string | null } | null
  const seen = { company_id: companyId, serial: onu.serial, device_id: deviceId, model, last_seen: new Date().toISOString() }

  if (!cfg.enabled) {
    await db.from('onu_acs').upsert(seen, { onConflict: 'company_id,serial' })
    return nothing('switched off for this company')
  }

  const { data: link } = await db
    .from('network_devices')
    .select('customer_id')
    .eq('company_id', companyId)
    .eq('olt_id', onu.olt_id)
    .eq('serial', onu.serial)
    .not('customer_id', 'is', null)
    .maybeSingle()
  const customerId = (link as { customer_id: number } | null)?.customer_id
  if (!customerId) {
    await db.from('onu_acs').upsert(seen, { onConflict: 'company_id,serial' })
    return nothing('not linked to a customer')
  }

  const { data: row } = await db
    .from('customers')
    .select('first_name, last_name, phone, account_number, customer_type, pppoe_username, pppoe_password')
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()
  const c = row as {
    first_name: string | null; last_name: string | null; phone: string | null; account_number?: string | null
    customer_type?: string | null; pppoe_username?: string | null; pppoe_password?: string | null
  } | null
  if (!c) return nothing('customer not found')

  const customer: OnuCustomer = {
    first: c.first_name ?? '',
    last: c.last_name ?? '',
    account: c.account_number ?? null,
    phone: c.phone ?? null,
    pppoeUser: c.pppoe_username ?? null,
    pppoePass: c.pppoe_password ?? null,
    pppoe: (c.customer_type ?? '').toLowerCase() === 'pppoe',
  }

  const ssid = wifiNameFor(cfg.wifiName, customer)
  // A generated password is generated once and kept, so it stays the same.
  const pass =
    cfg.wifiPassword === 'random' && prev?.wifi_password
      ? prev.wifi_password
      : wifiPasswordFor(cfg.wifiPassword, customer, randomPassword)
  const pppoe = cfg.pppoe && customer.pppoe && customer.pppoeUser && customer.pppoePass
    ? { user: customer.pppoeUser, pass: customer.pppoePass }
    : null

  const version = createHash('sha256').update(JSON.stringify({ ssid, pass, pppoe })).digest('hex').slice(0, 12)
  await db.from('onu_acs').upsert(
    {
      ...seen,
      version,
      wifi_name: ssid,
      wifi_password: cfg.wifiPassword === 'random' ? pass : null,
      ...(prev?.version !== version ? { sent_at: new Date().toISOString() } : {}),
    },
    { onConflict: 'company_id,serial' }
  )

  return NextResponse.json({
    ok: true,
    set: Boolean(ssid || pass || pppoe),
    version,
    ssid,
    pass,
    pppoeUser: pppoe?.user ?? null,
    pppoePass: pppoe?.pass ?? null,
  })
}
