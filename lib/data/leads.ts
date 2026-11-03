import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Door-to-door prospects (migration 0046).
 *
 * A prospect is somebody who answered the door: a name, a number, an address,
 * a coordinate, and a price they were quoted. They are NOT customers and are
 * deliberately kept out of that table — see the note at the top of the
 * migration. The billing engine never sees this table at all.
 *
 * WHOSE PROSPECTS YOU SEE is decided here and not in the page: a caller
 * without view_all_leads is filtered to their own rows in the query itself, so
 * a rep cannot read another rep's book by guessing an id or passing a filter.
 */

export type LeadStatus = 'new' | 'won' | 'lost'

export type Lead = {
  id: number
  firstName: string
  lastName: string
  name: string
  phone: string
  address: string
  /** Null whenever GPS failed or the rep declined the browser prompt. */
  latitude: number | null
  longitude: number | null
  /**
   * The radius the phone claimed, in metres. A coordinate without this lies:
   * a 2,000m fix off a cell tower and a 5m GPS fix look the same on a map.
   */
  accuracyM: number | null
  gpsTakenAt: string | null
  installFee: number
  monthlyRate: number | null
  servicePlanId: number | null
  notes: string | null
  status: LeadStatus
  lostReason: string | null
  /** The rep, as named the day they sold it. */
  agent: string | null
  createdBy: number | null
  /** Set once the prospect has bought. */
  customerId: number | null
  convertedAt: string | null
  createdAt: string
}

type Row = {
  id: number
  first_name: string | null
  last_name: string | null
  phone: string | null
  address: string | null
  latitude: number | string | null
  longitude: number | string | null
  gps_accuracy_m: number | string | null
  gps_taken_at: string | null
  install_fee: number | string | null
  monthly_rate: number | string | null
  service_plan_id: number | null
  notes: string | null
  status: string | null
  lost_reason: string | null
  agent: string | null
  created_by: number | null
  customer_id: number | null
  converted_at: string | null
  created_at: string
}

const COLS =
  'id, first_name, last_name, phone, address, latitude, longitude, ' +
  'gps_accuracy_m, gps_taken_at, install_fee, monthly_rate, service_plan_id, ' +
  'notes, status, lost_reason, agent, created_by, customer_id, converted_at, created_at'

/** Null-safe, because every one of these columns may legitimately be null. */
const numOrNull = (v: number | string | null): number | null =>
  v === null || v === '' ? null : Number(v)

function toLead(r: Row): Lead {
  const first = r.first_name ?? ''
  const last = r.last_name ?? ''
  return {
    id: r.id,
    firstName: first,
    lastName: last,
    name: [first, last].filter(Boolean).join(' ') || 'Prospect',
    phone: r.phone ?? '',
    address: r.address ?? '',
    latitude: numOrNull(r.latitude),
    longitude: numOrNull(r.longitude),
    accuracyM: numOrNull(r.gps_accuracy_m),
    gpsTakenAt: r.gps_taken_at,
    installFee: Number(r.install_fee ?? 0),
    monthlyRate: numOrNull(r.monthly_rate),
    servicePlanId: r.service_plan_id,
    notes: r.notes,
    status: r.status === 'won' ? 'won' : r.status === 'lost' ? 'lost' : 'new',
    lostReason: r.lost_reason,
    agent: r.agent,
    createdBy: r.created_by,
    customerId: r.customer_id,
    convertedAt: r.converted_at,
    createdAt: r.created_at,
  }
}

export type LeadListResult = {
  rows: Lead[]
  counts: { new: number; won: number; lost: number }
  /** The sum of install fees on prospects that bought. */
  wonValue: number
}

export const EMPTY_LEADS: LeadListResult = {
  rows: [],
  counts: { new: 0, won: 0, lost: 0 },
  wonValue: 0,
}

/**
 * The prospect list.
 *
 * `ownerId` is the caller's user id when they may see only their own, and null
 * when they may see everybody's. It is a parameter rather than something read
 * from the session here so the page decides it once, from the permission, and
 * this stays a plain query.
 *
 * The counts are computed over the whole filtered set rather than the page
 * being shown, so "3 new" means three, not three on this screen.
 */
export async function listLeads(opts: {
  companyId: number
  ownerId: number | null
  status?: LeadStatus | ''
  query?: string
}): Promise<LeadListResult> {
  const { companyId, ownerId, status = '', query = '' } = opts
  if (!(await getSchemaCapabilities()).leads) return EMPTY_LEADS

  const db = tenantClient()
  let q = db
    .from('leads')
    .select(COLS)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(500)

  // THE REP FILTER, IN SQL. A rep's own rows and no others — not hidden in the
  // page, where a stray link or a crafted query string could get round it.
  if (ownerId !== null) q = q.eq('created_by', ownerId)
  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) throw new Error('Failed to load prospects: ' + error.message)

  const all = ((data ?? []) as unknown as Row[]).map(toLead)

  // Name, phone or address, in memory: the list is capped at 500 rows for one
  // company's door-knocking, so there is nothing to gain from a SQL filter and
  // something to lose — a rep searching their own book should match on the
  // address they typed, however they typed it.
  const needle = query.trim().toLowerCase()
  const rows = needle
    ? all.filter((l) =>
        l.name.toLowerCase().includes(needle) ||
        l.phone.toLowerCase().includes(needle) ||
        l.address.toLowerCase().includes(needle))
    : all

  const counts = { new: 0, won: 0, lost: 0 }
  let wonValue = 0
  for (const l of rows) {
    counts[l.status] += 1
    if (l.status === 'won') wonValue += l.installFee
  }

  return { rows, counts, wonValue }
}

/**
 * One prospect, scoped to the company AND to the caller where they may only
 * see their own.
 *
 * The owner filter is part of the query, so a rep asking for somebody else's
 * prospect by id gets the same answer as for one that does not exist. The
 * caller turns either into a 404.
 */
export async function getLead(
  companyId: number,
  id: number,
  ownerId: number | null
): Promise<Lead | null> {
  if (!Number.isInteger(id)) return null
  if (!(await getSchemaCapabilities()).leads) return null

  const db = tenantClient()
  let q = db.from('leads').select(COLS).eq('company_id', companyId).eq('id', id)
  if (ownerId !== null) q = q.eq('created_by', ownerId)

  const { data, error } = await q.maybeSingle()
  if (error) throw new Error('Failed to load prospect: ' + error.message)
  return data ? toLead(data as unknown as Row) : null
}

/**
 * Prospects at this number already, so the form can say so before a second rep
 * works a door that is already sold.
 *
 * Deliberately NOT scoped to the rep: the point is to catch one rep signing up
 * a house another rep already has. It returns only what is needed to say
 * "already recorded", never the other rep's prospect itself.
 */
export async function leadsAtPhone(
  companyId: number,
  phone: string
): Promise<{ id: number; name: string; status: LeadStatus; agent: string | null }[]> {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 7) return []
  if (!(await getSchemaCapabilities()).leads) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('leads')
    .select('id, first_name, last_name, phone, status, agent')
    .eq('company_id', companyId)
    .limit(500)
  if (error) return []

  return ((data ?? []) as unknown as Row[])
    .filter((r) => (r.phone ?? '').replace(/\D/g, '').endsWith(digits.slice(-7)))
    .map((r) => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Prospect',
      status: (r.status === 'won' ? 'won' : r.status === 'lost' ? 'lost' : 'new') as LeadStatus,
      agent: r.agent,
    }))
}

/**
 * A map link for a coordinate.
 *
 * OpenStreetMap rather than Google Maps: it needs no key, opens in anything,
 * and the installer is going to copy the numbers into whatever they already
 * use regardless. The coordinate itself is shown beside it for exactly that.
 */
export function mapLink(lat: number, lng: number): string {
  return 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lng + '#map=18/' + lat + '/' + lng
}

/** How much to trust a fix, in words. */
export function accuracyLabel(accuracyM: number | null): string | null {
  if (accuracyM === null) return null
  if (accuracyM <= 20) return 'to about ' + Math.round(accuracyM) + 'm — good'
  if (accuracyM <= 100) return 'to about ' + Math.round(accuracyM) + 'm — rough'
  return 'to about ' + Math.round(accuracyM) + 'm — too rough to find the house'
}
