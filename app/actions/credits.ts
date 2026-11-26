'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { formatCurrencyExact } from '@/lib/format'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

export type CreditResult = { ok: true; message: string } | { ok: false; error: string }

const YMD = /^\d{4}-\d{2}-\d{2}$/

/**
 * A credit or discount on a customer's account: an amount off, a reason, and
 * the service days it is for. It lowers what they owe, like a balance
 * adjustment, but prints on the bill as its own line with its period
 * (migration 0072). Same authority as adjusting a balance: manager and above.
 */
export async function addCustomerCredit(input: {
  customerId: number
  amount: number
  reason: string
  periodStart: string | null
  periodEnd: string | null
  creditedOn: string | null
}): Promise<CreditResult> {
  const session = await getSession()
  if (!can(session.profile.role, 'adjust_carried_balance')) {
    return { ok: false, error: 'You do not have permission to give credits.' }
  }
  const id = Number(input.customerId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'That customer could not be found.' }

  const amount = Math.round(Number(input.amount) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an amount above zero.' }
  if (amount > 9_999_999.99) return { ok: false, error: 'That amount is too large.' }

  const reason = String(input.reason ?? '').trim()
  if (!reason) return { ok: false, error: 'Say what the credit is for. It prints on the bill.' }
  if (reason.length > 120) return { ok: false, error: 'Keep the reason under 120 characters: it is the line on the bill.' }

  const start = input.periodStart && YMD.test(input.periodStart) ? input.periodStart : null
  const end = input.periodEnd && YMD.test(input.periodEnd) ? input.periodEnd : null
  if ((start === null) !== (end === null)) return { ok: false, error: 'Give both the first and the last day, or neither.' }
  if (start && end && end < start) return { ok: false, error: 'The last day is before the first day.' }
  const on = input.creditedOn && YMD.test(input.creditedOn) ? input.creditedOn : null

  const db = tenantClient()
  const { data: cust } = await db
    .from('customers')
    .select('first_name, last_name')
    .eq('company_id', session.company.id)
    .eq('id', id)
    .maybeSingle()
  const c = cust as { first_name: string | null; last_name: string | null } | null
  if (!c) return { ok: false, error: 'That customer could not be found.' }
  const fullName = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer #' + id

  const { data, error } = await db.rpc('apply_customer_credit', {
    p_company_id: session.company.id,
    p_customer_id: id,
    p_amount: amount,
    p_reason: reason,
    p_period_start: start,
    p_period_end: end,
    p_credited_on: on,
    p_by_name: session.profile.email,
  })
  if (error) return { ok: false, error: 'Could not add the credit: ' + error.message }
  const row = data as { carried_balance_before: number | string; carried_balance_after: number | string } | null

  await logEvent({
    customerId: id,
    type: 'credit_given',
    tag: '[billing]',
    details:
      'Credit of ' + formatCurrencyExact(amount) + ' for ' + fullName +
      (start && end ? ' | period=' + start + ' to ' + end : '') +
      ' | old=' + formatCurrencyExact(Number(row?.carried_balance_before ?? 0)) +
      ' | new=' + formatCurrencyExact(Number(row?.carried_balance_after ?? 0)) +
      ' | by=' + session.profile.email +
      ' | reason=' + reason,
  })

  revalidatePath('/dashboard/customers/' + id)
  revalidatePath('/dashboard/customers')
  return {
    ok: true,
    message: formatCurrencyExact(amount) + ' credited to ' + fullName + '. It shows on their next bill as its own line.',
  }
}
