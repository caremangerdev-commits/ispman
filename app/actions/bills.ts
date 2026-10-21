'use server'

import { logEvent } from '@/lib/audit'
import { can } from '@/lib/permissions'
import { displayName, getSession } from '@/lib/session'
import { emailBill } from '@/lib/sms/notify'

export type EmailBillResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * "Email bill" on the customer record: queues the customer's current bill, in
 * the company's template, to their email address — see lib/sms/notify.ts#emailBill
 * for every rule it goes through.
 *
 * Gated like the "Bill (PDF)" link beside it (view_customer_billing_history):
 * whoever may open the bill may send it to the customer it belongs to. Logged,
 * because a document sent out in the company's name is something staff are
 * asked about afterwards.
 */
export async function emailCustomerBill(
  _prev: EmailBillResult | null,
  formData: FormData
): Promise<EmailBillResult> {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_customer_billing_history')) {
    throw new Error('Forbidden: role "' + profile.role + '" cannot see customer bills.')
  }

  const customerId = Number(formData.get('customer_id'))
  if (!Number.isInteger(customerId) || customerId <= 0) return { ok: false, error: 'Unknown customer.' }

  const result = await emailBill({ companyId: company.id, customerId })
  if (!result.ok) return result

  await logEvent({
    customerId,
    type: 'bill_emailed',
    details: result.title + ' emailed to ' + result.to + ' by ' + displayName(profile),
    tag: '[bills]',
  })

  return { ok: true, message: result.title + ' queued to ' + result.to + '. It leaves within a minute or two.' }
}
