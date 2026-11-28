'use server'

import { logEvent } from '@/lib/audit'
import { can } from '@/lib/permissions'
import { displayName, getSession } from '@/lib/session'
import { billSendPreview, emailBill, smsBill, type BillChannelPreview } from '@/lib/sms/notify'

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

export type BillSendPreview =
  | { ok: true; title: string; email: BillChannelPreview; sms: BillChannelPreview; pdfUrl: string }
  | { ok: false; error: string }

/** What "Send bill" would send, by email and by text, for the pop-up to show first. */
export async function previewBillSend(customerId: number): Promise<BillSendPreview> {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_customer_billing_history')) return { ok: false, error: 'You cannot see this customer’s bills.' }
  if (!Number.isInteger(customerId) || customerId <= 0) return { ok: false, error: 'Unknown customer.' }
  const p = await billSendPreview(company.id, customerId)
  if (!p) return { ok: false, error: 'That customer could not be found, or messaging is not set up.' }
  return { ok: true, title: p.title, email: p.email, sms: p.sms, pdfUrl: '/api/customers/' + customerId + '/bill' }
}

export type SendBillResult = { ok: boolean; lines: { channel: 'email' | 'sms'; ok: boolean; text: string }[] }

/**
 * Sends the bill by the channels ticked in the pop-up: email (the PDF with its
 * cover note) and/or text (the worded bill, as staff left it). Each channel is
 * sent and reported on its own, so a text that cannot go does not stop the
 * email. Logged per channel.
 */
export async function sendCustomerBill(input: {
  customerId: number
  email: boolean
  sms: boolean
  smsText: string
}): Promise<SendBillResult> {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_customer_billing_history')) {
    return { ok: false, lines: [{ channel: 'email', ok: false, text: 'You cannot send this customer’s bills.' }] }
  }
  const customerId = Number(input.customerId)
  const lines: SendBillResult['lines'] = []

  if (input.email) {
    const r = await emailBill({ companyId: company.id, customerId })
    if (r.ok) {
      await logEvent({ customerId, type: 'bill_emailed', details: r.title + ' emailed to ' + r.to + ' by ' + displayName(profile), tag: '[bills]' })
      lines.push({ channel: 'email', ok: true, text: 'Email queued to ' + r.to + '.' })
    } else lines.push({ channel: 'email', ok: false, text: 'Email not sent: ' + r.error })
  }
  if (input.sms) {
    const r = await smsBill({ companyId: company.id, customerId, text: input.smsText })
    if (r.ok) {
      await logEvent({ customerId, type: 'bill_texted', details: 'Bill texted to +' + r.to.replace(/^\+/, '') + ' by ' + displayName(profile), tag: '[bills]' })
      lines.push({ channel: 'sms', ok: true, text: 'Text queued to +' + r.to.replace(/^\+/, '') + '.' })
    } else lines.push({ channel: 'sms', ok: false, text: 'Text not sent: ' + r.error })
  }
  return { ok: lines.length > 0 && lines.every((l) => l.ok), lines }
}
