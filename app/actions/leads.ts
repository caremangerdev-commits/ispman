'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { findOrCreatePaymentCategory } from '@/lib/data/payment-categories'
import { getLead } from '@/lib/data/leads'
import { toPaymentMethod } from '@/lib/data/checkoff'
import { chargePaymentRows, round2, visitInsertError } from '@/lib/payments/service-payment'
import { can, type Role } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { displayName, requirePermission } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { ymd } from '@/lib/billing'

const str = (fd: FormData, key: string) => {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}
const numOrNull = (fd: FormData, key: string) => {
  const v = str(fd, key)
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export type LeadResult =
  | { ok: true; leadId: number; customerId?: number; message: string }
  | { ok: false; error?: string; fieldErrors?: Record<string, string> }

const NOTES_MAX = 1000
const NAME_MAX = 100

/**
 * Who may see which prospects, as one answer used by every action here.
 *
 * Returns null when the caller may see all of them, and their own user id when
 * they may not. Passed straight into the data layer, which puts it in the
 * query — so a rep acting on somebody else's prospect gets "not found" rather
 * than a permission error, and learns nothing about what exists.
 */
function ownerScope(role: Role, userId: number): number | null {
  return can(role, 'view_all_leads') ? null : userId
}

/**
 * Signs a prospect up at the door.
 *
 * Deliberately forgiving. This form is filled in on a phone, at a gate,
 * one-handed, by somebody who is being talked at — so only the four things
 * that make the prospect findable again are required, and the GPS fix, the
 * price and the plan are all optional. A prospect recorded with a name and a
 * number is worth having; a form that refuses to save is not.
 */
export async function createLead(
  _prev: LeadResult | null,
  formData: FormData
): Promise<LeadResult> {
  const { company, profile } = await requirePermission('manage_leads')
  if (!(await getSchemaCapabilities()).leads) {
    return { ok: false, error: 'Prospects are not set up on this system yet.' }
  }

  const fieldErrors: Record<string, string> = {}
  const first_name = str(formData, 'first_name').slice(0, NAME_MAX)
  const last_name = str(formData, 'last_name').slice(0, NAME_MAX)
  const phone = str(formData, 'phone')
  const address = str(formData, 'address')

  if (!first_name) fieldErrors.first_name = 'First name is required.'
  if (!last_name) fieldErrors.last_name = 'Last name is required.'
  if (!phone) fieldErrors.phone = 'Phone number is required.'
  if (!address) fieldErrors.address = 'Address is required.'

  const installFee = numOrNull(formData, 'install_fee') ?? 0
  if (installFee < 0) fieldErrors.install_fee = 'Enter 0 or more.'

  const monthlyRate = numOrNull(formData, 'monthly_rate')
  if (monthlyRate !== null && monthlyRate < 0) {
    fieldErrors.monthly_rate = 'Enter 0 or more.'
  }

  // The coordinate, as the browser reported it. Both halves or neither: half a
  // coordinate is not a location, and storing one would put a pin on the
  // equator.
  const lat = numOrNull(formData, 'latitude')
  const lng = numOrNull(formData, 'longitude')
  const haveFix =
    lat !== null && lng !== null &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  const accuracy = numOrNull(formData, 'gps_accuracy_m')

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }

  const { data, error } = await tenantClient()
    .from('leads')
    .insert({
      company_id: company.id,
      first_name,
      last_name,
      phone,
      address,
      latitude: haveFix ? lat : null,
      longitude: haveFix ? lng : null,
      gps_accuracy_m: haveFix ? accuracy : null,
      gps_taken_at: haveFix ? new Date().toISOString() : null,
      install_fee: round2(installFee),
      monthly_rate: monthlyRate === null ? null : round2(monthlyRate),
      service_plan_id: numOrNull(formData, 'service_plan_id'),
      notes: str(formData, 'notes').slice(0, NOTES_MAX) || null,
      status: 'new',
      created_by: profile.id,
      agent: displayName(profile),
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: 'Could not save the prospect: ' + error.message }

  const leadId = (data as unknown as { id: number }).id
  revalidatePath('/dashboard/leads')
  return {
    ok: true,
    leadId,
    message:
      first_name + ' ' + last_name + ' saved' +
      (haveFix ? ' with their location.' : '. No location was captured.'),
  }
}

/**
 * Turns a prospect into a customer, and records any money they handed over.
 *
 * THREE THINGS HAPPEN, IN THIS ORDER, and the order matters:
 *
 *   1. the customer row — with NO MAC, because nobody has been to the house
 *      yet. A customer with no MAC resolves to 'unprovisioned' and the billing
 *      engine skips that verdict, so this does NOT start their monthly
 *      billing. That begins when somebody puts them on the network.
 *
 *   2. the installation fee as a one-off charge, so it is owed rather than
 *      merely remembered, and shows up on their record like any other charge.
 *
 *   3. the money, if any was taken, as a payment against that charge —
 *      through the same chargePaymentRows() the till uses. That is what puts a
 *      rep's cash in the payments book and in their checkoff on the day they
 *      took it, rather than in their pocket until the office hears about it.
 *
 * A rep may do this only for a prospect they can see, which without
 * view_all_leads means one they signed up themselves.
 */
export async function convertLead(formData: FormData): Promise<LeadResult> {
  const { company, profile } = await requirePermission('convert_lead')
  const caps = await getSchemaCapabilities()
  if (!caps.leads) return { ok: false, error: 'Prospects are not set up on this system yet.' }

  const leadId = Number(str(formData, 'lead_id'))
  const lead = await getLead(company.id, leadId, ownerScope(profile.role, profile.id))
  if (!lead) return { ok: false, error: 'That prospect could not be found.' }
  if (lead.status === 'won' && lead.customerId) {
    return { ok: false, error: 'This prospect is already a customer.' }
  }

  // The amount handed over at the door. Zero is the ordinary case — the office
  // collects later — and is not an error.
  const paid = numOrNull(formData, 'amount_paid') ?? 0
  if (paid < 0) return { ok: false, fieldErrors: { amount_paid: 'Enter 0 or more.' } }
  if (paid > lead.installFee) {
    return {
      ok: false,
      fieldErrors: { amount_paid: 'That is more than the installation fee of ' + lead.installFee + '.' },
    }
  }

  const db = tenantClient()

  // --- 1. The customer -----------------------------------------------------
  //
  // Only the columns every schema has, plus the ones the probe confirms. The
  // rest take their defaults, exactly as a customer added through the ordinary
  // form does when those fields are left blank.
  const row: Record<string, unknown> = {
    company_id: company.id,
    first_name: lead.firstName,
    last_name: lead.lastName,
    phone: lead.phone,
    address: lead.address,
    mac_address: null,
    monthly_rate: lead.monthlyRate ?? 0,
    date_added: ymd(new Date()),
  }
  if (caps.connectionTypes) row.customer_type = 'dhcp'
  if (caps.billing) {
    row.carried_balance = 0
    row.account_credit = 0
    const { data: s } = await db
      .from('settings').select('bill_date').eq('company_id', company.id).maybeSingle()
    row.bill_date = (s as { bill_date: number | null } | null)?.bill_date ?? 1
  }
  if (caps.catalog) {
    row.service_plan_id = lead.servicePlanId
    row.notes = lead.notes
  }

  const { data: made, error: customerError } = await db
    .from('customers').insert(row).select('id').single()
  if (customerError) {
    return { ok: false, error: 'Could not create the customer: ' + customerError.message }
  }
  const customerId = (made as unknown as { id: number }).id

  // --- 2. The installation charge ------------------------------------------
  //
  // Skipped when the fee is zero: a charge of nothing is a row that has to be
  // explained to whoever reads the customer's record later.
  let chargeId: number | null = null
  let categoryId: number | null = null
  let categoryName = 'Installation'
  if (lead.installFee > 0 && caps.charges) {
    const category = await findOrCreatePaymentCategory(company.id, 'Installation')
    if (!category.ok) {
      // The customer exists and is correct; only the fee is missing. Say so
      // rather than pretending nothing happened, because the row is there.
      return {
        ok: false,
        error:
          'The customer was created but the installation fee could not be raised: ' +
          category.error + ' Add it by hand on their record.',
      }
    }
    categoryId = category.category.id
    categoryName = category.category.name

    const { data: charge, error: chargeError } = await db
      .from('customer_charges')
      .insert({
        company_id: company.id,
        customer_id: customerId,
        payment_category_id: categoryId,
        amount: round2(lead.installFee),
        note: 'Agreed at the door by ' + (lead.agent ?? 'a sales rep') + '.',
        charged_on: ymd(new Date()),
        created_by: profile.id,
        created_by_name: displayName(profile),
      })
      .select('id')
      .single()
    if (chargeError) {
      return {
        ok: false,
        error:
          'The customer was created but the installation fee could not be raised: ' +
          chargeError.message + ' Add it by hand on their record.',
      }
    }
    chargeId = (charge as unknown as { id: number }).id
  }

  // --- 3. The money, if any ------------------------------------------------
  if (paid > 0 && chargeId !== null && categoryId !== null) {
    const method = toPaymentMethod(str(formData, 'payment_method') || 'cash')
    const today = ymd(new Date())
    const rows = chargePaymentRows({
      companyId: company.id,
      customerId,
      checked: [{
        chargeId,
        amount: round2(paid),
        categoryId,
        category: categoryName,
        outstandingBefore: round2(lead.installFee),
      }],
      visitId: crypto.randomUUID(),
      paidOn: today,
      stampedAt: new Date(),
      method,
      // The REP is the agent, not whoever is converting: the money was handed
      // to them, and their checkoff is where it has to turn up.
      agent: lead.agent ?? displayName(profile),
      notes: 'Taken at the door.',
      userId: lead.createdBy ?? profile.id,
      segmentId: null,
      reference: str(formData, 'reference') || null,
      caps,
    })

    const { data: inserted, error: payError } = await db
      .from('payments').insert(rows).select('id')
    if (payError) {
      return {
        ok: false,
        error:
          'The customer and the installation fee were created, but the payment could not be ' +
          'recorded: ' + visitInsertError(payError.message) +
          ' Take it again on their record so it is not lost.',
      }
    }
    // The row is written; its id is not needed here. The receipt is reached
    // from the customer's record like any other payment's, and printing one at
    // a gate is not something a rep can do anyway.
    void inserted
  }

  // --- The prospect is now a sale ------------------------------------------
  const { error: leadError } = await db
    .from('leads')
    .update({
      status: 'won',
      customer_id: customerId,
      converted_at: new Date().toISOString(),
      converted_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', company.id)
    .eq('id', lead.id)
  if (leadError) {
    // Everything that matters is already written. Losing the link is a
    // reporting problem, not a money one, so it must not read as a failure.
    console.error('[leads] could not mark prospect %d won: %s', lead.id, leadError.message)
  }

  await logEvent({
    customerId,
    type: 'customer_created',
    tag: '[leads]',
    details:
      'Converted from door-to-door prospect #' + lead.id +
      ' sold by ' + (lead.agent ?? 'a sales rep') +
      '. Installation ' + lead.installFee +
      (paid > 0 ? ', ' + paid + ' taken at the door' : ', nothing taken at the door') +
      '. No MAC yet, so they are not on the network and are not being billed monthly.',
    amount: paid > 0 ? paid : null,
  }).catch(() => {})

  revalidatePath('/dashboard/leads')
  revalidatePath('/dashboard/customers')

  return {
    ok: true,
    leadId: lead.id,
    customerId,
    message:
      lead.name + ' is now a customer' +
      (paid > 0 ? ', and ' + paid + ' was recorded against the installation.' : '.') +
      ' They are not on the network yet — add their MAC when the radio goes up.',
  }
}

/**
 * Corrects a prospect.
 *
 * ANYONE WHO CAN SEE IT CAN EDIT IT (owner, 10 Nov 2026) — there is no
 * separate edit permission. `manage_leads` already means "work prospects", and
 * ownerScope() already decides which ones you can see: a rep sees and so edits
 * their own book, the office sees and so edits everybody's. Adding an
 * edit_lead permission would have let somebody read a prospect they could not
 * fix, which is the one combination nobody wants — a wrong phone number at a
 * gate is useless to whoever is looking at it and can do nothing about it.
 *
 * WHAT THIS DOES NOT TOUCH:
 *   status, customer_id, converted_at — those are set by convertLead and
 *     markLeadLost, which are the two actions that mean something happened.
 *     An edit is a correction, not a decision.
 *   the GPS fix, UNLESS a new one is sent. The edit form carries the same
 *     LocationCapture as the new-prospect form, and that sends empty strings
 *     until somebody actually takes a reading. Empty therefore means "leave
 *     the fix alone" and not "clear it" — otherwise correcting a typo in a
 *     name from the office would silently throw away the coordinate the rep
 *     walked to the house for.
 */
export async function updateLead(
  _prev: LeadResult | null,
  formData: FormData
): Promise<LeadResult> {
  const { company, profile } = await requirePermission('manage_leads')
  if (!(await getSchemaCapabilities()).leads) {
    return { ok: false, error: 'Prospects are not set up on this system yet.' }
  }

  const leadId = Number(str(formData, 'lead_id'))
  const lead = await getLead(company.id, leadId, ownerScope(profile.role, profile.id))
  if (!lead) return { ok: false, error: 'That prospect could not be found.' }

  const fieldErrors: Record<string, string> = {}
  const first_name = str(formData, 'first_name').slice(0, NAME_MAX)
  const last_name = str(formData, 'last_name').slice(0, NAME_MAX)
  const phone = str(formData, 'phone')
  const address = str(formData, 'address')

  if (!first_name) fieldErrors.first_name = 'First name is required.'
  if (!last_name) fieldErrors.last_name = 'Last name is required.'
  if (!phone) fieldErrors.phone = 'Phone number is required.'
  if (!address) fieldErrors.address = 'Address is required.'

  const installFee = numOrNull(formData, 'install_fee') ?? 0
  if (installFee < 0) fieldErrors.install_fee = 'Enter 0 or more.'

  const monthlyRate = numOrNull(formData, 'monthly_rate')
  if (monthlyRate !== null && monthlyRate < 0) {
    fieldErrors.monthly_rate = 'Enter 0 or more.'
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }

  const patch: Record<string, unknown> = {
    first_name,
    last_name,
    phone,
    address,
    install_fee: round2(installFee),
    monthly_rate: monthlyRate === null ? null : round2(monthlyRate),
    service_plan_id: numOrNull(formData, 'service_plan_id'),
    notes: str(formData, 'notes').slice(0, NOTES_MAX) || null,
    updated_at: new Date().toISOString(),
  }

  // A new fix, only if one was taken. See the note above.
  const lat = numOrNull(formData, 'latitude')
  const lng = numOrNull(formData, 'longitude')
  if (
    lat !== null && lng !== null &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  ) {
    patch.latitude = lat
    patch.longitude = lng
    patch.gps_accuracy_m = numOrNull(formData, 'gps_accuracy_m')
    patch.gps_taken_at = new Date().toISOString()
  }

  const { error } = await tenantClient()
    .from('leads')
    .update(patch)
    .eq('company_id', company.id)
    .eq('id', lead.id)

  if (error) return { ok: false, error: 'Could not save the changes: ' + error.message }

  // The customer this prospect became is a different record and is NOT
  // updated. Say so rather than letting somebody think they have corrected an
  // account by correcting the prospect it came from.
  const alsoCustomer =
    lead.customerId !== null
      ? ' Their customer account is separate and was not changed.'
      : ''

  revalidatePath('/dashboard/leads')
  revalidatePath('/dashboard/leads/' + lead.id)
  return {
    ok: true,
    leadId: lead.id,
    message: 'Saved.' + alsoCustomer,
  }
}

/**
 * Deletes a prospect for good. Admin only — see delete_lead in
 * lib/permissions.ts for why it is not given to a manager or a rep.
 *
 * A CONVERTED PROSPECT CANNOT BE DELETED. Once it has become a customer the
 * row is the provenance of that account: who sold it, what they quoted, and
 * what was taken at the door. The customer's own audit line points back at
 * this id. Deleting it would leave an account nobody can explain, and would
 * not remove the customer, the installation charge or the payment anyway —
 * so it is refused, and the refusal says what to do instead.
 */
export async function deleteLead(formData: FormData): Promise<LeadResult> {
  const { company, profile } = await requirePermission('delete_lead')
  if (!(await getSchemaCapabilities()).leads) {
    return { ok: false, error: 'Prospects are not set up on this system yet.' }
  }

  const leadId = Number(str(formData, 'lead_id'))
  // Admin holds view_all_leads, so this is unscoped in practice; ownerScope is
  // used anyway so the rule lives in one place and cannot drift.
  const lead = await getLead(company.id, leadId, ownerScope(profile.role, profile.id))
  if (!lead) return { ok: false, error: 'That prospect could not be found.' }

  if (lead.customerId !== null) {
    return {
      ok: false,
      error:
        lead.name + ' already became a customer, so this record is the history of ' +
        'that account and cannot be deleted. Delete the customer instead if that ' +
        'is what you meant.',
    }
  }

  const { error } = await tenantClient()
    .from('leads')
    .delete()
    .eq('company_id', company.id)
    .eq('id', lead.id)

  if (error) return { ok: false, error: 'Could not delete the prospect: ' + error.message }

  // No customer to hang an event on, so this goes in the log without one —
  // deleting somebody else's work is worth a line regardless.
  await logEvent({
    customerId: null,
    type: 'lead_deleted',
    tag: '[leads]',
    details:
      'Deleted prospect #' + lead.id + ' (' + lead.name + ', ' + lead.phone + ')' +
      ' signed up by ' + (lead.agent ?? 'a sales rep') +
      ', quoted ' + lead.installFee + ' installation. Deleted by ' + displayName(profile) + '.',
    amount: null,
  }).catch(() => {})

  revalidatePath('/dashboard/leads')
  return { ok: true, leadId: lead.id, message: lead.name + ' was deleted.' }
}

/** Not interested, or cannot be served. Keeps the row: a door knocked is a fact. */
export async function markLeadLost(formData: FormData): Promise<LeadResult> {
  const { company, profile } = await requirePermission('manage_leads')
  if (!(await getSchemaCapabilities()).leads) {
    return { ok: false, error: 'Prospects are not set up on this system yet.' }
  }

  const leadId = Number(str(formData, 'lead_id'))
  const lead = await getLead(company.id, leadId, ownerScope(profile.role, profile.id))
  if (!lead) return { ok: false, error: 'That prospect could not be found.' }
  if (lead.status === 'won') {
    return { ok: false, error: 'This prospect already bought — it cannot be marked lost.' }
  }

  const { error } = await tenantClient()
    .from('leads')
    .update({
      status: 'lost',
      lost_reason: str(formData, 'lost_reason').slice(0, NOTES_MAX) || null,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', company.id)
    .eq('id', lead.id)

  if (error) return { ok: false, error: 'Could not update the prospect: ' + error.message }

  revalidatePath('/dashboard/leads')
  return { ok: true, leadId: lead.id, message: lead.name + ' marked as not interested.' }
}
