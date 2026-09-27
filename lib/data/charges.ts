import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * One-off charges (migration 0025): installation, hardware, reconnection —
 * money a customer owes that is NOT service.
 *
 * KEPT APART FROM THE SERVICE BALANCE ON PURPOSE. carried_balance decides
 * access; nothing here is read by billing, expiry or RADIUS, and nothing here
 * writes to them. A customer can owe for an installation and still be online.
 *
 * NOTHING OWED IS STORED. `paid` is the sum of the payments that name the
 * charge, and `outstanding` is the amount less that — derived on every read, so
 * a payment edited or deleted afterwards restates the charge with it.
 */
export type ChargeStatus = 'open' | 'paid' | 'voided'

export type CustomerCharge = {
  id: number
  customerId: number
  categoryId: number
  category: string
  amount: number
  paid: number
  /** What is still owed. Always 0 for a voided charge. */
  outstanding: number
  /** What voiding wrote off: the amount less what had been paid. 0 otherwise. */
  writtenOff: number
  status: ChargeStatus
  /** The business date the charge was raised, "YYYY-MM-DD". */
  chargedOn: string
  note: string | null
  createdByName: string | null
  voidedAt: string | null
  voidedByName: string | null
  voidReason: string | null
}

/** The shape the till needs: just what can still be paid. */
export type OpenCharge = Pick<
  CustomerCharge, 'id' | 'categoryId' | 'category' | 'amount' | 'paid' | 'outstanding' | 'chargedOn' | 'note'
>

const round2 = (n: number) => Math.round(n * 100) / 100

type ChargeRow = {
  id: number
  customer_id: number
  payment_category_id: number
  amount: number | string
  note: string | null
  charged_on: string
  created_by_name: string | null
  voided_at: string | null
  voided_by_name: string | null
  void_reason: string | null
  payment_categories: { name: string } | null
}

const CHARGE_COLS =
  'id, customer_id, payment_category_id, amount, note, charged_on, created_by_name, ' +
  'voided_at, voided_by_name, void_reason, payment_categories(name)'

/**
 * Charges by id or by customer, with what has been paid against each.
 *
 * Two queries, not a view: the payments sum is keyed on charge_id alone, so
 * one IN over the charge ids reads exactly the rows that count.
 */
async function loadCharges(
  companyId: number,
  where: { customerId: number } | { ids: number[] }
): Promise<CustomerCharge[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.charges) return []
  if ('ids' in where && where.ids.length === 0) return []

  const db = tenantClient()
  let q = db.from('customer_charges').select(CHARGE_COLS).eq('company_id', companyId)
  q = 'ids' in where ? q.in('id', where.ids) : q.eq('customer_id', where.customerId)

  const { data, error } = await q
    .order('charged_on', { ascending: false })
    .order('id', { ascending: false })
  if (error) throw new Error('Failed to load charges: ' + error.message)

  const rows = (data ?? []) as unknown as ChargeRow[]
  if (rows.length === 0) return []

  const { data: pays, error: payError } = await db
    .from('payments')
    .select('charge_id, amount')
    .eq('company_id', companyId)
    .in('charge_id', rows.map((r) => r.id))
  if (payError) throw new Error('Failed to load charge payments: ' + payError.message)

  const paid = new Map<number, number>()
  for (const p of (pays ?? []) as unknown as { charge_id: number; amount: number | string }[]) {
    paid.set(p.charge_id, round2((paid.get(p.charge_id) ?? 0) + Number(p.amount ?? 0)))
  }

  return rows.map((r) => {
    const amount = Number(r.amount)
    const paidSoFar = paid.get(r.id) ?? 0
    const voided = r.voided_at !== null
    const left = Math.max(0, round2(amount - paidSoFar))
    return {
      id: r.id,
      customerId: r.customer_id,
      categoryId: r.payment_category_id,
      category: r.payment_categories?.name ?? 'Charge',
      amount,
      paid: paidSoFar,
      outstanding: voided ? 0 : left,
      writtenOff: voided ? left : 0,
      status: voided ? 'voided' : left > 0 ? 'open' : 'paid',
      chargedOn: r.charged_on,
      note: r.note,
      createdByName: r.created_by_name,
      voidedAt: r.voided_at,
      voidedByName: r.voided_by_name,
      voidReason: r.void_reason,
    }
  })
}

/** Every charge on one customer, newest first, voided and paid ones included. */
export function listCustomerCharges(companyId: number, customerId: number) {
  return loadCharges(companyId, { customerId })
}

/** The charges one customer can still pay against, oldest first. */
export async function listOpenCharges(companyId: number, customerId: number): Promise<OpenCharge[]> {
  const all = await loadCharges(companyId, { customerId })
  return all
    .filter((c) => c.status === 'open')
    .reverse()
    .map(({ id, categoryId, category, amount, paid, outstanding, chargedOn, note }) => ({
      id, categoryId, category, amount, paid, outstanding, chargedOn, note,
    }))
}

/** Specific charges, for checking a till submission against. */
export function getChargesById(companyId: number, ids: number[]) {
  return loadCharges(companyId, { ids })
}
