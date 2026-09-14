import { matchesCustomer, type SearchableCustomer } from '@/lib/search'
import type { CustomerStatus } from '@/lib/status'
import type { ConnectionType } from '@/lib/types'

/**
 * The one definition of "which customers am I looking at".
 *
 * WHY THIS EXISTS. The customer list grew its filters inline inside
 * listCustomers(), and the messaging page needs the same question answered
 * about who a batch will reach. Writing that predicate a second time is exactly
 * how lib/search.ts came to exist — three separate customer searches that
 * disagreed about what a customer was findable by — and how lib/log-detail.ts
 * came to exist after two parsers of one format disagreed and took a page down.
 *
 * So the list and the messaging page ask the same function. The consequence is
 * that the customer list GAINS four filters it did not have (misc category,
 * service plan, expiry window, balance owing), because the alternative was to
 * build them for messaging alone and leave the list with a different idea of
 * what a filter means.
 *
 * IN MEMORY, NOT IN SQL, and deliberately. `radiusStatus` comes from the
 * FreeRADIUS MariaDB and the ISPMan event log, not from Postgres — it cannot be
 * a WHERE clause. listCustomers() already reads the whole company and filters
 * in memory for that reason; this is that same pass, named.
 */

/** A row this module can decide about. Structural, like SearchableCustomer. */
export type FilterableCustomer = SearchableCustomer & {
  radiusStatus?: CustomerStatus
  daysUntilExpiry?: number | null
  carried_balance?: number
  account_credit?: number
  balance?: number | string | null
  misc_category_id?: number | null
  service_plan_id?: number | null
  /** Migration 0003. The tower or radio a customer is connected through. */
  access_point?: string | null
  /** Day of month access expires. Not the same as bill_date — see lib/billing.ts. */
  cut_off_date?: number | null
  /** Migration 0005. wireless or wired. */
  connection_type?: ConnectionType | null
  sms_opted_out?: boolean
}

export type CustomerFilters = {
  /** Free text, matched by lib/search.ts. */
  query: string
  /** A network status, or 'all'. */
  status: CustomerStatus | 'all'
  /** Exact address, already trimmed. Empty means every address. */
  address: string
  /**
   * Exact access point. Empty means every one.
   *
   * THE REASON THIS FILTER EXISTS is an AP going down: everyone behind it loses
   * service at once, and they are the exact set who should be told. That is a
   * different question from "everyone at this address" — one tower serves
   * several districts and one district is often served by two.
   */
  accessPoint: string
  /**
   * Day of the month access expires, 1-31. Null means any.
   *
   * THE CUT-OFF, NOT THE BILL DATE. They are different columns describing
   * different events and neither substitutes for the other — the cut-off is
   * when a customer loses service, which is what a reminder is about.
   */
  cutOffDate: number | null
  /** wireless or wired, or null for any. */
  connectionType: ConnectionType | null
  /** misc_categories.id, or null for any. */
  miscCategoryId: number | null
  /** service_plans.id, or null for any. */
  servicePlanId: number | null
  /**
   * Expiring within this many days. Null means no expiry constraint.
   *
   * INCLUDES THE ALREADY-EXPIRED. "Expiring within 7 days" asked by someone
   * about to send a reminder means "everyone I need to chase", and a customer
   * who lapsed yesterday is more in need of chasing than one lapsing next week.
   * Excluding them would be a filter that quietly drops the most urgent rows.
   */
  expiringWithinDays: number | null
  /** Owing at least this much. Null means no balance constraint. */
  owingAtLeast: number | null
}

export const NO_FILTERS: CustomerFilters = {
  query: '',
  status: 'all',
  address: '',
  accessPoint: '',
  cutOffDate: null,
  connectionType: null,
  miscCategoryId: null,
  servicePlanId: null,
  expiringWithinDays: null,
  owingAtLeast: null,
}

/**
 * What a customer owes, as one number.
 *
 * Carried balance less any credit on the account, floored at zero. A customer
 * in credit owes nothing rather than a negative amount — "owing at least 0"
 * must not select the whole company.
 *
 * `balance` is the pre-0011 column and is only consulted when the billing
 * columns are absent, which is what withBillingDefaults() leaves behind.
 */
export function amountOwing(c: FilterableCustomer): number {
  const carried = Number(c.carried_balance ?? 0)
  const credit = Number(c.account_credit ?? 0)
  if (Number.isFinite(carried) && (carried !== 0 || credit !== 0)) {
    return Math.max(0, carried - credit)
  }
  const legacy = Number(c.balance ?? 0)
  return Number.isFinite(legacy) ? Math.max(0, legacy) : 0
}

/** Whether one customer survives the filters. */
export function matchesFilters(c: FilterableCustomer, f: CustomerFilters): boolean {
  if (f.status !== 'all' && (c.radiusStatus ?? 'unknown') !== f.status) return false

  if (f.address && (c.address ?? '').trim() !== f.address.trim()) return false

  if (f.accessPoint && (c.access_point ?? '').trim() !== f.accessPoint.trim()) return false

  if (f.cutOffDate !== null && (c.cut_off_date ?? null) !== f.cutOffDate) return false

  if (f.connectionType !== null && (c.connection_type ?? null) !== f.connectionType) {
    return false
  }

  if (f.miscCategoryId !== null && (c.misc_category_id ?? null) !== f.miscCategoryId) {
    return false
  }

  if (f.servicePlanId !== null && (c.service_plan_id ?? null) !== f.servicePlanId) {
    return false
  }

  if (f.expiringWithinDays !== null) {
    const days = c.daysUntilExpiry
    // A customer with no expiry at all is not "expiring within 7 days". They
    // have never been billed, so including them would put every unprovisioned
    // row into a reminder about a date that does not exist.
    if (days === null || days === undefined) return false
    if (days > f.expiringWithinDays) return false
  }

  if (f.owingAtLeast !== null && amountOwing(c) < f.owingAtLeast) return false

  // Search last: it is the most expensive of these and the others eliminate
  // more rows per comparison.
  return matchesCustomer(c, f.query)
}

/** Applies the whole set. */
export function applyFilters<T extends FilterableCustomer>(
  rows: T[],
  f: CustomerFilters
): T[] {
  return rows.filter((row) => matchesFilters(row, f))
}

/**
 * Reads a filter set out of a URL's query string.
 *
 * Shared so the customer list and the messaging page cannot disagree about what
 * `?owing=5000` means, and so a link copied from one is legible to the other.
 */
export function filtersFromParams(
  get: (key: string) => string | undefined,
  isStatus: (v: string) => v is CustomerStatus
): CustomerFilters {
  const num = (key: string): number | null => {
    const raw = (get(key) ?? '').trim()
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  const statusRaw = (get('filter') ?? '').trim()

  // Validated rather than cast: this value comes off a URL anyone can type, and
  // an unrecognised one must read as "no filter" rather than as a value that
  // matches nobody and silently empties the list.
  const toConnection = (raw: string | undefined): ConnectionType | null => {
    const v = (raw ?? '').trim()
    return v === 'wireless' || v === 'wired' ? v : null
  }

  return {
    query: get('q') ?? '',
    status: isStatus(statusRaw) ? statusRaw : 'all',
    address: (get('address') ?? '').trim(),
    accessPoint: (get('ap') ?? '').trim(),
    cutOffDate: num('cutoff'),
    connectionType: toConnection(get('conn')),
    miscCategoryId: num('category'),
    servicePlanId: num('plan'),
    expiringWithinDays: num('expiring'),
    owingAtLeast: num('owing'),
  }
}

/** The query-string form, for building links. Empty values are omitted. */
export function filtersToParams(f: CustomerFilters): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.query) out.q = f.query
  if (f.status !== 'all') out.filter = f.status
  if (f.address) out.address = f.address
  if (f.accessPoint) out.ap = f.accessPoint
  if (f.cutOffDate !== null) out.cutoff = String(f.cutOffDate)
  if (f.connectionType !== null) out.conn = f.connectionType
  if (f.miscCategoryId !== null) out.category = String(f.miscCategoryId)
  if (f.servicePlanId !== null) out.plan = String(f.servicePlanId)
  if (f.expiringWithinDays !== null) out.expiring = String(f.expiringWithinDays)
  if (f.owingAtLeast !== null) out.owing = String(f.owingAtLeast)
  return out
}

export function hasAnyFilter(f: CustomerFilters): boolean {
  return Object.keys(filtersToParams(f)).length > 0
}

/**
 * The filters in words, for the record a batch leaves behind.
 *
 * Stamped onto sms_batches.audience at send time rather than being recomputed
 * from stored ids later — a misc category can be renamed or deleted, and a
 * batch that then describes itself as "category 7" explains nothing to the
 * person asking why 400 customers got a text.
 */
export type FilterNames = {
  status?: (s: CustomerStatus) => string
  miscCategory?: (id: number) => string | undefined
  servicePlan?: (id: number) => string | undefined
  currency?: (n: number) => string
}

/** One active filter, in words, with the key it came from. */
export type FilterPart = { key: keyof CustomerFilters; text: string }

/**
 * The active filters, one entry each, in the order the description reads.
 *
 * The single source for both the one-line audience description and the
 * per-filter "this one is why nobody matched" explanation, so the two can
 * never name a filter differently.
 */
export function describeFilterParts(f: CustomerFilters, names: FilterNames = {}): FilterPart[] {
  const parts: FilterPart[] = []

  if (f.status !== 'all') {
    parts.push({ key: 'status', text: names.status ? names.status(f.status) : f.status })
  }
  if (f.miscCategoryId !== null) {
    parts.push({
      key: 'miscCategoryId',
      text: names.miscCategory?.(f.miscCategoryId) ?? 'category #' + f.miscCategoryId,
    })
  }
  if (f.servicePlanId !== null) {
    parts.push({
      key: 'servicePlanId',
      text: names.servicePlan?.(f.servicePlanId) ?? 'plan #' + f.servicePlanId,
    })
  }
  if (f.address) parts.push({ key: 'address', text: f.address })
  if (f.accessPoint) parts.push({ key: 'accessPoint', text: 'AP ' + f.accessPoint })
  if (f.cutOffDate !== null) {
    parts.push({ key: 'cutOffDate', text: 'cut-off day ' + f.cutOffDate })
  }
  if (f.connectionType !== null) parts.push({ key: 'connectionType', text: f.connectionType })
  if (f.expiringWithinDays !== null) {
    parts.push({
      key: 'expiringWithinDays',
      text: 'expiring within ' + f.expiringWithinDays + ' day' +
        (f.expiringWithinDays === 1 ? '' : 's'),
    })
  }
  if (f.owingAtLeast !== null) {
    const amount = names.currency ? names.currency(f.owingAtLeast) : String(f.owingAtLeast)
    parts.push({ key: 'owingAtLeast', text: 'owing ' + amount + ' or more' })
  }
  if (f.query) parts.push({ key: 'query', text: 'matching "' + f.query + '"' })

  return parts
}

export function describeFilters(f: CustomerFilters, names: FilterNames = {}): string {
  const parts = describeFilterParts(f, names)
  return parts.length ? parts.map((p) => p.text).join(' · ') : 'All customers'
}

/**
 * Why a filter set matched nobody, filter by filter.
 *
 * "0 matched" on its own leaves the operator guessing whether the search box,
 * the address or the status is the one excluding everyone — and during an
 * outage that guess costs minutes. Each active filter is tried ALONE against
 * the whole company: one that matches nobody by itself is named as the reason.
 * When every filter matches someone on its own, the combination is the
 * problem, and the message says that instead.
 *
 * Empty when the set actually matched someone, or when no filter is active —
 * an empty company is a different message and not this module's to write.
 */
export function explainNoMatch<T extends FilterableCustomer>(
  rows: T[],
  f: CustomerFilters,
  names: FilterNames = {}
): string[] {
  const parts = describeFilterParts(f, names)
  if (parts.length === 0 || rows.length === 0) return []
  if (applyFilters(rows, f).length > 0) return []

  const alone = parts.filter((p) => {
    const only: CustomerFilters = { ...NO_FILTERS, [p.key]: f[p.key] }
    return applyFilters(rows, only).length === 0
  })

  if (alone.length > 0) {
    return alone.map((p) => 'No customer is ' + p.text + '.')
  }

  return ['Each of these filters matches someone, but no customer matches all of them together.']
}
