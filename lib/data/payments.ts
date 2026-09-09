import {
  PAYMENT_METHODS, toPaymentMethod, type PaymentMethod,
} from '@/lib/data/checkoff'
import { radiusIdentity } from '@/lib/radius/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { fetchAllRows } from '@/lib/supabase/paging'
import { tenantClient } from '@/lib/supabase/tenant'

export type PaymentListRow = {
  id: number
  amount: number
  months_paid: number | null
  payment_type: string | null
  /** Full method from migration 0010; falls back to payment_type. */
  method: PaymentMethod
  payment_date: string
  /** The business date (0013). Null on rows written before it was applied. */
  paid_on: string | null
  /** 'other' payments settle a one-off charge and touch no billing field. */
  kind: 'service' | 'other'
  /** The category name for an 'other' payment; null for a service payment. */
  purpose: string | null
  agent: string | null
  notes: string | null
  customerId: number | null
  customerName: string
  checkedOff: boolean
  /**
   * The customer segment this payment is attributed to: the value stamped on
   * the payment (0018), falling back to the customer’s current misc category
   * for rows written before that column existed. Null means Uncategorised.
   */
  segmentId: number | null
}

export type PaymentListResult = {
  rows: PaymentListRow[]
  total: number
  page: number
  pageCount: number
  /** Totals across the whole filtered set, not just the visible page. */
  totalCollected: number
  averagePayment: number
  /**
   * Income split by the customer segment (misc category) the payment belongs
   * to. Empty when the company keeps no misc categories, which is most of them.
   *
   * Computed from the SAME filtered rows as totalCollected, so the split always
   * sums back to it. A second query could not promise that: this page filters
   * on the customer name in memory, and any separate aggregate would silently
   * disagree the moment somebody typed in the search box.
   */
  categories: SegmentTotal[]
}

/** One row of the income breakdown. */
export type SegmentTotal = {
  /** misc_categories.id, or null for the Uncategorised row. */
  id: number | null
  label: string
  /** Recurring service payments. */
  service: number
  /** Installations, router sales — one-off income, kept in its own column so
   *  neither owner reads it as recurring. */
  other: number
  total: number
  count: number
}

export type PaymentFilters = {
  companyId: number
  from?: string
  to?: string
  /** Payment method (or a legacy payment_type value). */
  type?: string
  query?: string
  /** Free-text agent name, or a user id as a string. */
  agent?: string
  /** 'yes' | 'no' — checkoff state, ignored otherwise. */
  checked?: string
  /**
   * Customer segment (misc category) to narrow to.
   *
   * A misc_categories id as a string, or the literal 'none' for the
   * Uncategorised rows — which are a real answer, not the absence of one, and
   * have to be selectable for the same reason the breakdown never hides them.
   * Empty means every segment.
   */
  category?: string
  page?: number
  perPage?: number
}

/** The `category` value that selects payments carrying no segment at all. */
export const UNCATEGORISED = 'none'

export const PAYMENT_TYPES = ['cash', 'card', 'online'] as const

/**
 * Payments for one company, filtered and paginated.
 *
 * Date and type filters run in SQL; the customer-name search and the segment
 * filter are applied in memory. The name lives on the joined `customers` row,
 * which PostgREST cannot filter a parent table by; the segment is in memory for
 * a different and more important reason — see the filter itself below. The
 * summary figures are computed over the full filtered set, so they do not
 * change as you page.
 */
export async function listPayments(opts: PaymentFilters): Promise<PaymentListResult> {
  const {
    companyId, from, to, type, query = '', agent = '', checked = '',
    category = '', page = 1, perPage = 15,
  } = opts

  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  const cols =
    'id, amount, months_paid, payment_type, payment_date, agent, notes, customer_id, ' +
    'customers(first_name, last_name' + (caps.catalog ? ', misc_category_id' : '') + ')' +
    // The stamped segment (0018) for rows written since it existed; the join
    // above is the fallback for everything older. See segmentOf.
    (caps.paymentSegment ? ', customer_misc_category_id' : '') +
    (caps.checkoff ? ', payment_method, checked_off' : '') +
    (caps.otherPayments ? ', paid_on, payment_kind, payment_categories(name)' : '')

  // PAGED, so the whole filtered set is read rather than PostgREST's first
  // 1000 rows. Everything below this line — the totals, the average, the
  // segment breakdown and the export — is computed over these rows, so a
  // truncated read would not shorten a list, it would understate money.
  //
  // The SQL filters are applied inside the page factory rather than to a
  // builder held outside it: a Supabase builder is single-use, so each range
  // needs its own.
  const data = await fetchAllRows((offset, limit) => {
    let q = db
      .from('payments')
      .select(cols)
      .eq('company_id', companyId)
      // payment_date is NOT UNIQUE, so it cannot be the only sort key for a
      // paged read: two payments sharing a timestamp could come back in a
      // different order between two requests and land in both pages or in
      // neither. id breaks the tie and never repeats.
      .order('payment_date', { ascending: false })
      .order('id', { ascending: false })

    // paid_on is the business date the cashier stated and is what a date range
    // on this page means. payment_date is the timestamp the row was written
    // with and only orders payments within a day. Before 0013 there is no
    // paid_on, so the timestamp is filtered as it was.
    if (caps.otherPayments) {
      if (from) q = q.gte('paid_on', from)
      // A DATE column needs no end-of-day boundary; the day itself is inclusive.
      if (to) q = q.lte('paid_on', to)
    } else {
      if (from) q = q.gte('payment_date', from + 'T00:00:00')
      // Inclusive of the whole end day.
      if (to) q = q.lte('payment_date', to + 'T23:59:59')
    }

    if (type) {
      if (caps.checkoff && (PAYMENT_METHODS as readonly string[]).includes(type)) {
        q = q.eq('payment_method', type)
      } else if ((PAYMENT_TYPES as readonly string[]).includes(type)) {
        q = q.eq('payment_type', type)
      }
    }
    if (agent) q = q.eq('agent', agent)
    if (caps.checkoff && (checked === 'yes' || checked === 'no')) {
      q = q.eq('checked_off', checked === 'yes')
    }

    return q.range(offset, limit)
  }, 'payments')

  type Row = {
    id: number
    amount: number | string
    months_paid: number | null
    payment_type: string | null
    payment_method?: string | null
    checked_off?: boolean | null
    payment_date: string
    paid_on?: string | null
    payment_kind?: string | null
    payment_categories?: { name: string } | null
    agent: string | null
    notes: string | null
    customer_id: number | null
    customer_misc_category_id?: number | null
    customers: {
      first_name: string | null
      last_name: string | null
      misc_category_id?: number | null
    } | null
  }

  const all: PaymentListRow[] = (data as unknown as Row[]).map((r) => ({
    id: r.id,
    amount: Number(r.amount ?? 0),
    months_paid: r.months_paid,
    payment_type: r.payment_type,
    method: toPaymentMethod(r.payment_method ?? r.payment_type),
    payment_date: r.payment_date,
    paid_on: r.paid_on ?? null,
    kind: r.payment_kind === 'other' ? 'other' : 'service',
    purpose: r.payment_categories?.name ?? null,
    agent: r.agent,
    notes: r.notes,
    customerId: r.customer_id,
    customerName: [r.customers?.first_name, r.customers?.last_name]
      .filter(Boolean)
      .join(' ') || 'Unknown',
    checkedOff: Boolean(r.checked_off),
    // STAMPED FIRST, JOIN SECOND. The stamp says which segment the customer was
    // in when they paid; the join says which one they are in now. They differ
    // exactly when somebody has been recategorised, and for a report two owners
    // use to divide income the historical answer is the correct one.
    //
    // Rows written before migration 0018 have no stamp and fall through to the
    // join, which is all that was ever knowable about them. Not backfilled: see
    // the note in 0018.
    segmentId:
      r.customer_misc_category_id ?? r.customers?.misc_category_id ?? null,
  }))

  const needle = query.trim().toLowerCase()
  const byName = needle
    ? all.filter((r) => r.customerName.toLowerCase().includes(needle))
    : all

  /**
   * Segment filter, ON THE RESOLVED segmentId AND NOT IN SQL.
   *
   * `segmentId` is "the stamp (0018) if there is one, otherwise the customer's
   * current category" — the rule the income breakdown has always used, decided
   * per row a few lines above. A SQL `.eq('customer_misc_category_id', id)`
   * would be a different rule: once 0018 is applied it would match only stamped
   * rows and silently drop every payment taken before it, so the filter and the
   * breakdown would give two different answers about the same money. Filtering
   * here means there is exactly one definition of which segment a payment
   * belongs to, and both readings of it agree by construction.
   *
   * It also means the filter needs no migration to work and needs no change
   * when one arrives: apply 0018 and these same rows start resolving through
   * their stamps, so a recategorised customer stops moving old payments,
   * everywhere at once.
   */
  const wanted =
    category === UNCATEGORISED ? null : category ? Number(category) : undefined
  const matched =
    wanted === undefined || (wanted !== null && !Number.isFinite(wanted))
      ? byName
      : byName.filter((r) => r.segmentId === wanted)

  const totalCollected = matched.reduce((sum, r) => sum + r.amount, 0)

  // FROM `matched`, NOT FROM A SECOND QUERY. Same rows as totalCollected, so
  // the breakdown sums back to it whatever combination of filters is applied,
  // including the two that only exist in memory — the customer-name search and
  // the segment filter. Narrowing to one segment therefore collapses the
  // breakdown to that segment, which is why the page hides it in that case
  // rather than showing every other owner at zero.
  const categories = await summariseSegments(companyId, caps.catalog, matched)
  const pageCount = Math.max(1, Math.ceil(matched.length / perPage))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const start = (safePage - 1) * perPage

  return {
    rows: matched.slice(start, start + perPage),
    total: matched.length,
    page: safePage,
    pageCount,
    totalCollected,
    averagePayment: matched.length ? totalCollected / matched.length : 0,
    categories,
  }
}

/**
 * Income split by customer segment, for the payments page panel.
 *
 * WHY THIS TAKES ROWS RATHER THAN FILTERS. The figure it has to agree with —
 * totalCollected — is computed over rows that have already been through an
 * IN-MEMORY name filter, because the customer name lives on a joined row that
 * PostgREST cannot filter a parent by. An aggregate built from its own query
 * could not see that filter, so the panel and the headline total would disagree
 * the moment anyone typed in the search box. Sharing the rows makes them agree
 * by construction rather than by care.
 *
 * UNCATEGORISED IS A PERMANENT ROW. It is emitted whenever any payment has no
 * segment, never folded into another row and never dropped. At the time of
 * writing 154 of one company’s 978 customers have no category and account for
 * 11.6% of everything they have collected; money that belongs to neither owner
 * has to be visible, or the two totals quietly stop reconciling with the bank.
 *
 * A SEGMENT THAT NO LONGER RESOLVES is labelled as deleted rather than merged
 * into Uncategorised. The payment was attributed when it was taken; the
 * category being gone since is a different fact from never having had one, and
 * 0018 keeps the id precisely so the two stay distinguishable.
 *
 * Returns an empty array when the company keeps no misc categories at all, so
 * the page can leave the panel out entirely rather than render a table with one
 * meaningless row.
 */
async function summariseSegments(
  companyId: number,
  hasCatalog: boolean,
  rows: PaymentListRow[]
): Promise<SegmentTotal[]> {
  if (!hasCatalog) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('misc_categories')
    .select('id, name')
    .eq('company_id', companyId)
    .order('name')

  if (error) {
    // The list itself is fine without the panel, so this degrades rather than
    // failing the page.
    console.error('[payments] segment lookup failed:', error.message)
    return []
  }

  const names = new Map(
    ((data ?? []) as { id: number; name: string }[]).map((c) => [c.id, c.name])
  )
  if (names.size === 0) return []

  const totals = new Map<number | null, SegmentTotal>()

  // Every category is seeded, so an owner who collected nothing this month sees
  // a zero rather than vanishing from the report — an absent row reads as a
  // missing figure, not as none.
  for (const [id, name] of names) {
    totals.set(id, { id, label: name, service: 0, other: 0, total: 0, count: 0 })
  }

  for (const row of rows) {
    const key = row.segmentId
    let entry = totals.get(key)

    if (!entry) {
      entry =
        key === null
          ? { id: null, label: 'Uncategorised', service: 0, other: 0, total: 0, count: 0 }
          : { id: key, label: 'Deleted category #' + key, service: 0, other: 0, total: 0, count: 0 }
      totals.set(key, entry)
    }

    if (row.kind === 'other') entry.other += row.amount
    else entry.service += row.amount
    entry.total += row.amount
    entry.count += 1
  }

  // Uncategorised last, then by size. An owner comparing two figures wants the
  // bigger one first; the remainder belongs at the bottom where a total sits.
  return [...totals.values()].sort((a, b) => {
    if (a.id === null) return 1
    if (b.id === null) return -1
    return b.total - a.total
  })
}
export type PaymentDetail = {
  id: number
  amount: number
  months_paid: number | null
  payment_type: string | null
  payment_date: string
  agent: string | null
  notes: string | null
  created_at: string | null
  customer: {
    id: number
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
    address: string | null
    monthly_rate: number
    balance: number
  } | null
}

export type ReversalSubject = {
  id: number
  /** For the log line, which has to stay readable once the customer is gone. */
  name: string
  /** radcheck identity, or null when the customer was never provisioned. */
  identity: string | null
}

/**
 * The customer a payment reversal concerns: who they are, and how to find them
 * in radcheck.
 *
 * ONE FUNCTION FOR BOTH CALLERS. The delete dialog needs the identity so it can
 * name the expiry it is about to leave standing; the reversal log line needs
 * the identity for the same reading plus the name, because the payment row is
 * gone afterwards and "customer #41" is not something anyone can act on. Those
 * were two selects with the same capability gate on them, which is two places
 * to get 0003 wrong.
 *
 * Not folded into getPayment's join: `customer_type` and `pppoe_username` only
 * exist once migration 0003 is applied, and getPayment is not capability-aware,
 * so widening its select would break the payment page on the older schema.
 */
export async function getReversalSubject(
  companyId: number,
  customerId: number
): Promise<ReversalSubject | null> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  const { data } = await db
    .from('customers')
    .select(
      'id, first_name, last_name, mac_address' +
      (caps.connectionTypes ? ', customer_type, pppoe_username' : '')
    )
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()

  const row = data as unknown as {
    id: number
    first_name: string | null
    last_name: string | null
    mac_address: string | null
    customer_type?: string | null
    pppoe_username?: string | null
  } | null

  if (!row) return null

  return {
    id: row.id,
    // Not lib/format.ts#fullName: its fallback is "Unknown", and a log row that
    // has the id in hand should say "Customer #41" rather than throw it away.
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Customer #' + row.id,
    identity: radiusIdentity({
      customerType: row.customer_type ?? null,
      macAddress: row.mac_address,
      pppoeUsername: row.pppoe_username ?? null,
    }),
  }
}

/**
 * One payment, scoped to the company.
 *
 * The company filter is part of the query rather than a check on the result so
 * a wrong-tenant id is indistinguishable from a missing one — the caller turns
 * either into a 404.
 */
export async function getPayment(
  companyId: number,
  id: number
): Promise<PaymentDetail | null> {
  const db = tenantClient()

  const { data, error } = await db
    .from('payments')
    .select(
      'id, amount, months_paid, payment_type, payment_date, agent, notes, created_at, ' +
      'customers(id, first_name, last_name, email, phone, address, monthly_rate, carried_balance)'
    )
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error('Failed to load payment: ' + error.message)
  if (!data) return null

  const r = data as unknown as {
    id: number
    amount: number | string
    months_paid: number | null
    payment_type: string | null
    payment_date: string
    agent: string | null
    notes: string | null
    created_at: string | null
    customers: {
      id: number
      first_name: string | null
      last_name: string | null
      email: string | null
      phone: string | null
      address: string | null
      monthly_rate: number | string | null
      carried_balance: number | string | null
    } | null
  }

  return {
    id: r.id,
    amount: Number(r.amount ?? 0),
    months_paid: r.months_paid,
    payment_type: r.payment_type,
    payment_date: r.payment_date,
    agent: r.agent,
    notes: r.notes,
    created_at: r.created_at,
    customer: r.customers
      ? {
          id: r.customers.id,
          first_name: r.customers.first_name,
          last_name: r.customers.last_name,
          email: r.customers.email,
          phone: r.customers.phone,
          address: r.customers.address,
          monthly_rate: Number(r.customers.monthly_rate ?? 0),
          // carried_balance, not balance — see lib/billing.ts.
          balance: Number(r.customers.carried_balance ?? 0),
        }
      : null,
  }
}
