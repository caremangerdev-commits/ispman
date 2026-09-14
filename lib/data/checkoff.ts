import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { toRole, type Role } from '@/lib/permissions'

/**
 * Payment methods offered on the record-payment form.
 *
 * `payments.payment_type` (the older column) only understands cash/card/online,
 * so both columns are written on insert: payment_method takes the full value
 * and payment_type is narrowed to the nearest legacy equivalent. See
 * supabase/migrations/0010_checkoff.sql.
 */
export const PAYMENT_METHODS = [
  'cash', 'card', 'bank_transfer', 'cheque', 'paypal',
  'cashapp', 'zelle', 'wire_transfer', 'online', 'other',
] as const

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  paypal: 'PayPal',
  cashapp: 'CashApp',
  zelle: 'Zelle',
  wire_transfer: 'Wire Transfer',
  online: 'Online',
  other: 'Other',
}

/** Narrows a method to a value the legacy payment_type column accepts. */
export function legacyPaymentType(method: PaymentMethod): string {
  if (method === 'cash') return 'cash'
  if (method === 'card' || method === 'cheque') return 'card'
  return 'online'
}

export function toPaymentMethod(value: string | null | undefined): PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(value ?? '')
    ? (value as PaymentMethod)
    : 'other'
}

export type CollectionPayment = {
  id: number
  amount: number
  method: PaymentMethod
  payment_date: string
  /** The business date (0013). Null before that migration is applied. */
  paidOn: string | null
  created_at: string | null
  customerId: number | null
  customerName: string
  notes: string | null
}

export type CollectionSummary = {
  /** False when migration 0010 has not been applied. */
  available: boolean
  sinceCheckoffTotal: number
  sinceCheckoffCustomers: number
  todayTotal: number
  todayCustomers: number
  payments: CollectionPayment[]
  /** Totals per method across the un-checked-off set. */
  byMethod: { method: PaymentMethod; total: number; count: number }[]
}

export const EMPTY_COLLECTION: CollectionSummary = {
  available: false,
  sinceCheckoffTotal: 0,
  sinceCheckoffCustomers: 0,
  todayTotal: 0,
  todayCustomers: 0,
  payments: [],
  byMethod: [],
}

/**
 * How far ahead of UTC a zone is at a given instant, in ms.
 *
 * Formats the instant into the zone, reads the wall-clock fields back as if
 * they were UTC, and takes the difference. Handles DST because the offset is
 * evaluated at that specific instant rather than assumed.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)

  const f = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  // hour can come back as 24 for midnight in some ICU versions.
  const asUtc = Date.UTC(f('year'), f('month') - 1, f('day'), f('hour') % 24, f('minute'), f('second'))
  return asUtc - at.getTime()
}

/**
 * Today as YYYY-MM-DD in the company timezone.
 *
 * paid_on is a calendar date, so "is this payment from today" is a string
 * comparison against this rather than an instant comparison — the company's
 * today, not the server's.
 */
export function todayYmdIn(timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** The instant corresponding to midnight today in the company's timezone. */
export function startOfTodayIn(timeZone: string): Date {
  const now = new Date()

  // en-CA formats as YYYY-MM-DD, so the parts come back in a fixed order.
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now).split('-').map(Number)

  const midnightAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0)
  return new Date(midnightAsUtc - zoneOffsetMs(new Date(midnightAsUtc), timeZone))
}

type PaymentRow = {
  id: number
  amount: number | string
  payment_method: string | null
  payment_type: string | null
  payment_date: string
  paid_on?: string | null
  created_at: string | null
  customer_id: number | null
  notes: string | null
  user_id: number | null
  agent: string | null
  customers: { first_name: string | null; last_name: string | null } | null
}

function shape(rows: PaymentRow[]): CollectionPayment[] {
  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount ?? 0),
    method: toPaymentMethod(r.payment_method ?? r.payment_type),
    payment_date: r.payment_date,
    paidOn: r.paid_on ?? null,
    created_at: r.created_at,
    customerId: r.customer_id,
    customerName:
      [r.customers?.first_name, r.customers?.last_name].filter(Boolean).join(' ') || 'Unknown',
    notes: r.notes,
  }))
}

function summarise(
  payments: CollectionPayment[],
  todayStart: Date,
  /** Today's date in the company timezone, as YYYY-MM-DD. */
  todayYmd?: string
): Omit<CollectionSummary, 'available' | 'payments'> {
  // paid_on is the date the money is attributed to and is compared as a plain
  // string — it is already a calendar date in the company's own terms, so
  // converting it through a Date and a timezone could only move it. Rows
  // written before 0013 have no paid_on and fall back to the timestamp.
  const today = payments.filter((p) =>
    p.paidOn && todayYmd
      ? p.paidOn === todayYmd
      : new Date(p.payment_date).getTime() >= todayStart.getTime()
  )

  const methodMap = new Map<PaymentMethod, { total: number; count: number }>()
  for (const p of payments) {
    const cur = methodMap.get(p.method) ?? { total: 0, count: 0 }
    methodMap.set(p.method, { total: cur.total + p.amount, count: cur.count + 1 })
  }

  const distinct = (list: CollectionPayment[]) =>
    new Set(list.map((p) => p.customerId ?? 'anon-' + p.id)).size

  return {
    sinceCheckoffTotal: payments.reduce((s, p) => s + p.amount, 0),
    sinceCheckoffCustomers: distinct(payments),
    todayTotal: today.reduce((s, p) => s + p.amount, 0),
    todayCustomers: distinct(today),
    byMethod: [...methodMap.entries()]
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.total - a.total),
  }
}

const BASE_SELECT =
  'id, amount, payment_method, payment_type, payment_date, created_at, customer_id, ' +
  'notes, user_id, agent, customers(first_name, last_name)'

/**
 * Collections read paid_on where it exists, so a payment entered today for
 * yesterday counts against yesterday's takings rather than inflating today's.
 */
function selectFor(caps: { otherPayments: boolean }) {
  return caps.otherPayments ? BASE_SELECT + ', paid_on' : BASE_SELECT
}

/**
 * One agent's un-checked-off payments, with totals.
 *
 * Matched on `user_id`, falling back to the free-text `agent` name for rows
 * written before migration 0010 added the column. `query` filters the returned
 * list by customer name only — the totals always cover the whole set, so they
 * do not move as you search.
 */
export async function getAgentCollections(opts: {
  companyId: number
  userId: number
  agentName: string
  timezone: string
  query?: string
}): Promise<CollectionSummary> {
  const { companyId, userId, agentName, timezone, query = '' } = opts

  const caps = await getSchemaCapabilities()
  if (!caps.checkoff) return EMPTY_COLLECTION

  const db = tenantClient()
  const { data, error } = await db
    .from('payments')
    .select(selectFor(caps))
    .eq('company_id', companyId)
    .eq('checked_off', false)
    .or('user_id.eq.' + userId + ',and(user_id.is.null,agent.eq.' + agentName + ')')
    .order('payment_date', { ascending: false })

  if (error) throw new Error('Failed to load collections: ' + error.message)

  const all = shape((data ?? []) as unknown as PaymentRow[])
  const todayStart = startOfTodayIn(timezone)
  const today = todayYmdIn(timezone)

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? all.filter((p) => p.customerName.toLowerCase().includes(needle))
    : all

  return { available: true, ...summarise(all, todayStart, today), payments: visible }
}

export type AgentOption = {
  id: number
  name: string
  role: Role
  email: string
}

/** Every staff account in the company, for the checkoff agent selector. */
export async function listAgents(companyId: number): Promise<AgentOption[]> {
  const db = tenantClient()
  const { data, error } = await db
    .from('users')
    .select('id, first_name, last_name, email, role')
    .eq('company_id', companyId)
    .order('first_name', { ascending: true })

  if (error) throw new Error('Failed to load agents: ' + error.message)

  return ((data ?? []) as unknown as {
    id: number; first_name: string | null; last_name: string | null
    email: string; role: string | null
  }[]).map((u) => ({
    id: u.id,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
    role: toRole(u.role),
    email: u.email,
  }))
}

/** Summary for one agent, used by the checkoff page. */
export async function getCheckoffSummary(opts: {
  companyId: number
  agent: AgentOption
  timezone: string
}): Promise<CollectionSummary> {
  return getAgentCollections({
    companyId: opts.companyId,
    userId: opts.agent.id,
    agentName: opts.agent.name,
    timezone: opts.timezone,
  })
}

export type AllAgentsRow = {
  agent: AgentOption
  total: number
  customers: number
  count: number
}

/**
 * Per-agent totals across everyone with outstanding collections.
 *
 * One query for the whole company rather than one per agent; rows that cannot
 * be attributed to a user id are grouped under the agent name they carry.
 */
export async function getAllAgentsSummary(opts: {
  companyId: number
  timezone: string
}): Promise<{ available: boolean; rows: AllAgentsRow[]; total: number; customers: number }> {
  const caps = await getSchemaCapabilities()
  if (!caps.checkoff) return { available: false, rows: [], total: 0, customers: 0 }

  const [agents, db] = [await listAgents(opts.companyId), tenantClient()]

  const { data, error } = await db
    .from('payments')
    .select(selectFor(caps))
    .eq('company_id', opts.companyId)
    .eq('checked_off', false)
    .order('payment_date', { ascending: false })

  if (error) throw new Error('Failed to load checkoff summary: ' + error.message)

  const raw = (data ?? []) as unknown as PaymentRow[]
  const byAgent = new Map<number, PaymentRow[]>()

  for (const r of raw) {
    const matched =
      agents.find((a) => a.id === r.user_id) ??
      agents.find((a) => r.agent && a.name === r.agent)
    if (!matched) continue
    byAgent.set(matched.id, [...(byAgent.get(matched.id) ?? []), r])
  }

  const rows: AllAgentsRow[] = agents
    .map((agent) => {
      const list = shape(byAgent.get(agent.id) ?? [])
      return {
        agent,
        total: list.reduce((s, p) => s + p.amount, 0),
        customers: new Set(list.map((p) => p.customerId ?? 'anon-' + p.id)).size,
        count: list.length,
      }
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.total - a.total)

  return {
    available: true,
    rows,
    total: rows.reduce((s, r) => s + r.total, 0),
    customers: rows.reduce((s, r) => s + r.customers, 0),
  }
}

// ---------------------------------------------------------------------------
// Past handovers
// ---------------------------------------------------------------------------

/**
 * A completed handover, as `checkoff_records` holds it.
 *
 * WHY THIS FUNCTION DID NOT EXIST UNTIL NOW. `checkoff_records` has been
 * written since migration 0010 — by app/actions/checkoff.ts every time somebody
 * reconciles, and by the legacy migration scripts — and read by nothing. The
 * checkoff page shows OUTSTANDING collections, which it derives from `payments`
 * where `checked_off = false`; that is a live reconciliation screen and by
 * construction it cannot show a handover that is already settled. So every
 * record ever written was invisible: 20 of Ezmze's own, plus 16 migrated for
 * West Central.
 */
export type HandoverRecord = {
  id: number
  agentName: string
  /**
   * NULLABLE, and the difference matters.
   *
   * The all-agents checkoff writes the money onto ONE summary row and leaves
   * the per-agent rows null. So null here means "not recorded against this
   * row", which is a different claim from zero — coercing it would render
   * Ezmze's twenty real handovers as "J$0 handed over".
   */
  amountReceived: number | null
  systemTotal: number
  discrepancy: number | null
  customersCount: number
  isAllAgents: boolean
  createdAt: string
  notes: string | null
  /**
   * True when this row came from a legacy import rather than from someone
   * pressing Check Off in this app.
   *
   * The distinction matters to the reader, not just to us: a migrated handover
   * has NO payments attached to it. The legacy table recorded the amount handed
   * over but never which payments made it up, so there is nothing to drill into
   * and the UI must not imply otherwise.
   */
  migrated: boolean
}

/** Matches what the migration scripts write into `notes`. */
const MIGRATED_NOTE = /^Migrated from legacy checkoff #\d+/i

export async function listHandovers(
  companyId: number,
  limit = 200
): Promise<{ available: boolean; rows: HandoverRecord[] }> {
  const caps = await getSchemaCapabilities()
  if (!caps.checkoff) return { available: false, rows: [] }

  const db = tenantClient()
  const { data, error } = await db
    .from('checkoff_records')
    .select(
      'id, agent_name, amount_received, system_total, discrepancy, ' +
      'customers_count, is_all_agents, created_at, notes'
    )
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error('Failed to load handovers: ' + error.message)

  const rows = (data ?? []).map((r) => {
    const h = r as unknown as {
      id: number
      agent_name: string | null
      amount_received: number | string | null
      system_total: number | string | null
      discrepancy: number | string | null
      customers_count: number | null
      is_all_agents: boolean | null
      created_at: string
      notes: string | null
    }
    return {
      id: h.id,
      agentName: h.agent_name ?? 'Unknown',
      amountReceived: h.amount_received === null ? null : Number(h.amount_received),
      systemTotal: Number(h.system_total ?? 0),
      discrepancy: h.discrepancy === null ? null : Number(h.discrepancy),
      customersCount: Number(h.customers_count ?? 0),
      isAllAgents: Boolean(h.is_all_agents),
      createdAt: h.created_at,
      notes: h.notes,
      migrated: MIGRATED_NOTE.test(String(h.notes ?? '')),
    }
  })

  return { available: true, rows }
}

/**
 * When each agent last handed money over, from `checkoff_records`.
 *
 * THE SAME SOURCE THE PAST HANDOVERS TAB READS, deliberately. "Total Since
 * Checkoff" is a number with no meaning until you know since when — J$856,100
 * is alarming as a running balance and unremarkable as nine days of collecting.
 * Deriving the date from anywhere else would let the tile and the history tab
 * disagree about when an agent last settled up.
 *
 * Keyed BOTH ways. A record carries `agent_id` when the agent was a known user
 * at the time and `agent_name` always; migrated rows may have either, since the
 * legacy table identified agents by id in some rows and by free text in others.
 * Looking up by id alone would report "no handover on record" for an agent who
 * has a shelf full of them under their name.
 */
export async function lastHandoverByAgent(
  companyId: number
): Promise<{ byId: Map<number, string>; byName: Map<string, string> }> {
  const byId = new Map<number, string>()
  const byName = new Map<string, string>()

  const caps = await getSchemaCapabilities()
  if (!caps.checkoff) return { byId, byName }

  const db = tenantClient()
  const { data, error } = await db
    .from('checkoff_records')
    .select('agent_id, agent_name, created_at, is_all_agents')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })

  if (error) throw new Error('Failed to load handover dates: ' + error.message)

  for (const r of (data ?? []) as unknown as {
    agent_id: number | null
    agent_name: string | null
    created_at: string
    is_all_agents: boolean | null
  }[]) {
    // The all-agents summary row is a roll-up of the per-agent rows written
    // beside it, not a handover by anyone called "All agents (3)". Counting it
    // would put a date against a person who does not exist.
    if (r.is_all_agents) continue

    if (r.agent_id !== null) {
      const cur = byId.get(r.agent_id)
      if (!cur || r.created_at > cur) byId.set(r.agent_id, r.created_at)
    }
    const name = (r.agent_name ?? '').trim().toLowerCase()
    if (name) {
      const cur = byName.get(name)
      if (!cur || r.created_at > cur) byName.set(name, r.created_at)
    }
  }

  return { byId, byName }
}

/** The one rule for resolving an agent's last handover. Id first, then name. */
export function handoverDateFor(
  agent: { id: number; name: string },
  index: { byId: Map<number, string>; byName: Map<string, string> }
): string | null {
  return index.byId.get(agent.id)
    ?? index.byName.get(agent.name.trim().toLowerCase())
    ?? null
}
