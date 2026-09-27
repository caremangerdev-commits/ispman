'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { logEvent } from '@/lib/audit'
import { getChargesById } from '@/lib/data/charges'
import { findOrCreatePaymentCategory } from '@/lib/data/payment-categories'
import { formatCurrency } from '@/lib/format'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { displayName, getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * One-off charges: putting one on a customer, and voiding one.
 *
 * NEITHER TOUCHES THE SERVICE BALANCE, THE EXPIRY OR RADIUS. A charge is money
 * owed that the till can take payment against (app/actions/payments.ts), and
 * nothing else. Both actions are manager-and-above (manage_charges) and both
 * write a log row, so neither joins the list of changes nobody can trace.
 */

/** Sentinel the category select submits for its "+ Add new category" row. */
const NEW_CATEGORY = '__new__'

const NOTE_MAX = 500

const str = (fd: FormData, key: string) => {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

/** A pipe inside a value would split into a log field that was never written. */
const clean = (v: string) => v.replace(/\|/g, '/').trim()

const round2 = (n: number) => Math.round(n * 100) / 100

function back(customerId: number, message: string, kind?: 'error'): never {
  redirect(
    '/dashboard/customers/' + customerId + '?' +
    (kind === 'error' ? 'toastKind=error&' : '') +
    'toast=' + encodeURIComponent(message)
  )
}

async function authorize() {
  const session = await getSession()
  if (!can(session.profile.role, 'manage_charges')) {
    throw new Error('Forbidden: role "' + session.profile.role + '" lacks manage_charges.')
  }
  return session
}

async function customerName(companyId: number, customerId: number): Promise<string | null> {
  const { data } = await tenantClient()
    .from('customers')
    .select('first_name, last_name')
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()
  if (!data) return null
  const c = data as unknown as { first_name: string | null; last_name: string | null }
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer #' + customerId
}

export async function addCharge(formData: FormData) {
  const { company, profile } = await authorize()

  const customerId = Number(str(formData, 'customer_id'))
  if (!Number.isInteger(customerId)) return

  const caps = await getSchemaCapabilities()
  if (!caps.charges) back(customerId, 'One-off charges are not set up on this system yet.', 'error')

  const amount = Number(str(formData, 'amount'))
  if (!Number.isFinite(amount) || amount <= 0) {
    back(customerId, 'Enter an amount greater than zero.', 'error')
  }

  const chargedOn = str(formData, 'charged_on')
  const today = new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chargedOn)) back(customerId, 'Enter the date of the charge.', 'error')
  if (chargedOn > today) back(customerId, 'The charge date cannot be in the future.', 'error')

  const note = str(formData, 'note')
  if (note.length > NOTE_MAX) back(customerId, 'Keep the note under ' + NOTE_MAX + ' characters.', 'error')

  const name = await customerName(company.id, customerId)
  if (!name) back(customerId, 'That customer could not be found.', 'error')

  // The Purpose list the till already uses (0013), reused rather than copied.
  let categoryId: number | null = null
  let categoryName = ''
  const categoryRaw = str(formData, 'payment_category_id')
  if (categoryRaw === NEW_CATEGORY) {
    const created = await findOrCreatePaymentCategory(company.id, str(formData, 'new_payment_category'))
    if (!created.ok) back(customerId, created.error, 'error')
    categoryId = created.category.id
    categoryName = created.category.name
  } else {
    const parsed = Number(categoryRaw)
    if (!categoryRaw || !Number.isInteger(parsed)) back(customerId, 'Choose what the charge is for.', 'error')
    const { data } = await tenantClient()
      .from('payment_categories')
      .select('id, name')
      .eq('company_id', company.id)
      .eq('id', parsed)
      .maybeSingle()
    if (!data) back(customerId, 'That category no longer exists.', 'error')
    categoryId = parsed
    categoryName = (data as unknown as { name: string }).name
  }

  const value = round2(amount)
  const { data: inserted, error } = await tenantClient()
    .from('customer_charges')
    .insert({
      company_id: company.id,
      customer_id: customerId,
      payment_category_id: categoryId,
      amount: value,
      note: note || null,
      charged_on: chargedOn,
      created_by: profile.id,
      created_by_name: displayName(profile),
    })
    .select('id')
    .single()

  if (error) back(customerId, 'Could not add the charge: ' + error.message, 'error')
  const chargeId = (inserted as unknown as { id: number }).id

  await logEvent({
    customerId,
    type: 'charge_added',
    tag: '[charges]',
    details:
      'One-off charge added for ' + clean(name) +
      ' | charge=#' + chargeId +
      ' | category=' + clean(categoryName) +
      ' | amount=' + formatCurrency(value) +
      ' | charged_on=' + chargedOn +
      ' | by=' + profile.email +
      (note ? ' | note=' + clean(note) : ''),
  })

  revalidatePath('/dashboard/customers/' + customerId)
  revalidatePath('/dashboard/payments/new')

  back(customerId, name + ': ' + categoryName + ' charge of ' + formatCurrency(value) + ' added.')
}

/**
 * Voids a charge. WHAT IS STILL OWED IS WRITTEN OFF; WHAT WAS PAID STANDS.
 *
 * The payments against it are not touched — the money was received — and the
 * database refuses any further payment against it (payments_charge_guard,
 * migration 0025). A charge with nothing left owing has nothing to void.
 *
 * The UPDATE is conditional on voided_at IS NULL, so two managers voiding at
 * once produce one void and one "already voided", never two log rows.
 */
export async function voidCharge(formData: FormData) {
  const { company, profile } = await authorize()

  const customerId = Number(str(formData, 'customer_id'))
  const chargeId = Number(str(formData, 'charge_id'))
  if (!Number.isInteger(customerId) || !Number.isInteger(chargeId)) return

  const reason = str(formData, 'reason')
  if (!reason) back(customerId, 'A reason is required to void a charge.', 'error')
  if (reason.length > NOTE_MAX) back(customerId, 'Keep the reason under ' + NOTE_MAX + ' characters.', 'error')

  const [charge] = await getChargesById(company.id, [chargeId])
  if (!charge) back(customerId, 'That charge could not be found.', 'error')
  if (charge.status === 'voided') back(customerId, 'That charge is already voided.', 'error')
  if (charge.status === 'paid') {
    back(customerId, 'That charge is fully paid. There is nothing left to void.', 'error')
  }

  const { data: updated, error } = await tenantClient()
    .from('customer_charges')
    .update({
      voided_at: new Date().toISOString(),
      voided_by: profile.id,
      voided_by_name: displayName(profile),
      void_reason: reason,
    })
    .eq('company_id', company.id)
    .eq('customer_id', customerId)
    .eq('id', chargeId)
    .is('voided_at', null)
    .select('id')

  if (error) back(customerId, 'Could not void the charge: ' + error.message, 'error')
  if (!updated || updated.length === 0) back(customerId, 'That charge is already voided.', 'error')

  // Re-read AFTER the void: a payment taken between the read above and the
  // update changed what was written off, and the log has to say what was.
  const [after] = await getChargesById(company.id, [chargeId])
  const name = (await customerName(company.id, customerId)) ?? 'Customer #' + customerId

  await logEvent({
    customerId,
    type: 'charge_voided',
    tag: '[charges]',
    details:
      'One-off charge voided for ' + clean(name) +
      ' | charge=#' + chargeId +
      ' | category=' + clean(charge.category) +
      ' | amount=' + formatCurrency(charge.amount) +
      ' | paid=' + formatCurrency(after?.paid ?? charge.paid) +
      ' | written_off=' + formatCurrency(after?.writtenOff ?? charge.outstanding) +
      ' | by=' + profile.email +
      ' | reason=' + clean(reason),
  })

  revalidatePath('/dashboard/customers/' + customerId)
  revalidatePath('/dashboard/payments/new')

  back(
    customerId,
    charge.category + ' charge voided; ' +
    formatCurrency(after?.writtenOff ?? charge.outstanding) + ' written off.'
  )
}
