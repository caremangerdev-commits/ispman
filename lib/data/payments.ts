import {
  PAYMENT_METHODS, toPaymentMethod, type PaymentMethod,
} from '@/lib/data/checkoff'
import { getSchemaCapabilities } from '@/lib/schema'
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
}

export type PaymentListResult = {
  rows: PaymentListRow[]
  total: number
  page: number
  pageCount: number
  /** Totals across the whole filtered set, not just the visible page. */
  totalCollected: number
  averagePayment: number
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
  page?: number
  perPage?: number
}

export const PAYMENT_TYPES = ['cash', 'card', 'online'] as const

/**
 * Payments for one company, filtered and paginated.
 *
 * Date and type filters run in SQL; the customer-name search is applied in
 * memory because the name lives on the joined `customers` row and PostgREST
 * cannot filter a parent table from an embedded select. The summary figures
 * are computed over the full filtered set, so they do not change as you page.
 */
export async function listPayments(opts: PaymentFilters): Promise<PaymentListResult> {
  const {
    companyId, from, to, type, query = '', agent = '', checked = '',
    page = 1, perPage = 15,
  } = opts

  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  const cols =
    'id, amount, months_paid, payment_type, payment_date, agent, notes, customer_id, ' +
    'customers(first_name, last_name)' +
    (caps.checkoff ? ', payment_method, checked_off' : '') +
    (caps.otherPayments ? ', paid_on, payment_kind, payment_categories(name)' : '')

  let q = db
    .from('payments')
    .select(cols)
    .eq('company_id', companyId)
    .order('payment_date', { ascending: false })

  // paid_on is the business date the cashier stated and is what a date range
  // on this page means. payment_date is the timestamp the row was written with
  // and only orders payments within a day. Before 0013 there is no paid_on, so
  // the timestamp is filtered as it was.
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

  const { data, error } = await q
  if (error) throw new Error('Failed to load payments: ' + error.message)

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
    customers: { first_name: string | null; last_name: string | null } | null
  }

  const all: PaymentListRow[] = ((data ?? []) as unknown as Row[]).map((r) => ({
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
  }))

  const needle = query.trim().toLowerCase()
  const matched = needle
    ? all.filter((r) => r.customerName.toLowerCase().includes(needle))
    : all

  const totalCollected = matched.reduce((sum, r) => sum + r.amount, 0)
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
  }
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
      'customers(id, first_name, last_name, email, phone, address, monthly_rate, balance)'
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
      balance: number | string | null
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
          balance: Number(r.customers.balance ?? 0),
        }
      : null,
  }
}
