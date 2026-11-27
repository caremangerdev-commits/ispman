import 'server-only'

import { logEvent } from '@/lib/audit'
import { formatCurrency } from '@/lib/format'
import { tenantClient } from '@/lib/supabase/tenant'

/** A pipe inside a value would split into a log field that was never written. */
const clean = (v: string) => v.replace(/\|/g, '/').trim()

/**
 * Puts one one-off charge on a customer and logs it. The single writer, used
 * by the customer page (app/actions/charges.ts) and by a technician closing a
 * job (app/actions/tickets.ts), so both record a charge the same way. The
 * caller has checked permission, the amount, the date and the category.
 */
export async function insertCharge(args: {
  companyId: number
  profile: { id: number; email: string }
  byName: string
  customerId: number
  customerName: string
  categoryId: number
  categoryName: string
  amount: number
  chargedOn: string
  note: string | null
  /** Where it was raised, for the log: e.g. "ticket #12". */
  source?: string
}): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const value = Math.round(args.amount * 100) / 100
  const { data, error } = await tenantClient()
    .from('customer_charges')
    .insert({
      company_id: args.companyId,
      customer_id: args.customerId,
      payment_category_id: args.categoryId,
      amount: value,
      note: args.note || null,
      charged_on: args.chargedOn,
      created_by: args.profile.id,
      created_by_name: args.byName,
    })
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }
  const id = (data as unknown as { id: number }).id

  await logEvent({
    customerId: args.customerId,
    type: 'charge_added',
    tag: '[charges]',
    details:
      'One-off charge added for ' + clean(args.customerName) +
      ' | charge=#' + id +
      ' | category=' + clean(args.categoryName) +
      ' | amount=' + formatCurrency(value) +
      ' | charged_on=' + args.chargedOn +
      ' | by=' + args.profile.email +
      (args.source ? ' | from=' + clean(args.source) : '') +
      (args.note ? ' | note=' + clean(args.note) : ''),
  })
  return { ok: true, id }
}
