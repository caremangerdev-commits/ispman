'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createGatewayCheckout } from '@/lib/data/payment-gateways'
import {
  findCustomerByPhoneAndAccount, findCustomerIdByMac, matchCustomersByPhone,
} from '@/lib/data/portal'
import {
  clearPhoneAttempts, loginThrottled, noteLoginFailure,
} from '@/lib/portal/login-throttle'
import {
  createPortalTicket, getPortalTicket, readTicketPhoto, uploadTicketPhoto,
} from '@/lib/data/portal-tickets'
import { addTicketMessage } from '@/lib/data/tickets'
import { classifyPhone } from '@/lib/phone'
import { getPortalCompany } from '@/lib/portal/context'
import { requestOtp, verifyOtp } from '@/lib/portal/otp'
import {
  clearPortalSession, getPendingPick, getPortalSession, setPendingPick, setPortalSession,
} from '@/lib/portal/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The customer portal's actions. Every one resolves the tenant from the request
 * (getPortalCompany) rather than trusting anything the form carries, so a form
 * from one tenant's page cannot act on another's data.
 *
 * Phone login only accepts a Jamaican number for now: that is the number almost
 * every customer is on file with, and texting an overseas number to log in is a
 * cost and a complication to add later, not in a first cut.
 */

export type LoginState =
  | { phase: 'phone'; error?: string }
  | { phase: 'code'; phone: string; error?: string }
  /** The account-details form, which never leaves its own tab. */
  | { phase: 'account'; error?: string }

/** Step 1: a phone number is entered; find the account(s) and text a code. */
export async function requestCode(_prev: LoginState | null, formData: FormData): Promise<LoginState> {
  const company = await getPortalCompany()
  if (!company) return { phase: 'phone', error: 'This portal is not available.' }

  const verdict = classifyPhone(String(formData.get('phone') ?? ''))
  const e164 = verdict.kind === 'jamaica' ? verdict.e164 : null
  if (!e164) {
    return { phase: 'phone', error: 'Enter the Jamaican mobile number on your account.' }
  }

  // Only text a code to a number that is actually on an account here. The
  // code is the second factor; sending to a stranger's number would be both a
  // nuisance and a cost.
  const matches = await matchCustomersByPhone(company.id, e164)
  if (matches.length === 0) {
    return {
      phase: 'phone',
      error: 'We could not find an account with that number. Check with ' + company.name + '.',
    }
  }

  const sent = await requestOtp(company.id, company.name, e164)
  if (!sent.ok) return { phase: 'phone', error: sent.error }

  return { phase: 'code', phone: e164 }
}

/** Step 2: the code is entered; verify it and sign in (or offer a choice). */
export async function verifyCode(_prev: LoginState | null, formData: FormData): Promise<LoginState> {
  const company = await getPortalCompany()
  if (!company) return { phase: 'phone', error: 'This portal is not available.' }

  const phone = String(formData.get('phone') ?? '')
  const code = String(formData.get('code') ?? '').replace(/\D/g, '')
  if (!/^\d{6}$/.test(code)) return { phase: 'code', phone, error: 'Enter the 6-digit code.' }

  const verified = await verifyOtp(company.id, phone, code)
  if (!verified.ok) return { phase: 'code', phone, error: verified.error }

  const matches = await matchCustomersByPhone(company.id, phone)
  if (matches.length === 0) {
    return { phase: 'phone', error: 'We could not find your account. Contact ' + company.name + '.' }
  }
  if (matches.length === 1) {
    await setPortalSession(company.id, matches[0].id)
    redirect('/')
  }

  // More than one account on this number — the number is verified, so mark it
  // pending and let them pick which account.
  await setPendingPick(company.id, phone)
  redirect('/choose')
}

/**
 * The second way in: the phone number on the account, plus the account number.
 *
 * WHY IT EXISTS (owner, 26 October 2026, from a tenant). The SMS code is the
 * better proof, but it depends on that tenant's messaging being up. When it is
 * not, every customer is locked out of their own account at exactly the moment
 * they are trying to pay. This way in needs nothing but the bill in their hand.
 *
 * IT IS DELIBERATELY WEAKER, and the session says so. A neighbour or a
 * relative could know both of these, so the session it issues is marked
 * 'account' and the phone change refuses it (app/portal/phone). Everything
 * else — the balance, the bills, paying — is open, because someone paying
 * another person's bill does them no harm.
 *
 * ONE ERROR FOR EVERY FAILURE. Saying which half was wrong would turn this
 * into a way of testing whether a number is on the system, or of hunting for
 * an account number once a number is known.
 */
export async function signInWithAccount(
  _prev: LoginState | null,
  formData: FormData
): Promise<LoginState> {
  const company = await getPortalCompany()
  if (!company) return { phase: 'account', error: 'This portal is not available.' }

  const typedPhone = String(formData.get('phone') ?? '')
  const account = String(formData.get('account_number') ?? '').trim()
  const verdict = classifyPhone(typedPhone)
  const e164 = verdict.kind === 'jamaica' ? verdict.e164 : null

  const refuse = 'Those details do not match an account. Check them and try again.'

  // The throttle is keyed on the number as typed when it will not normalise,
  // so a run of malformed guesses still counts against the attempt.
  const key = e164 ?? typedPhone.replace(/\D/g, '').slice(-10)
  if (await loginThrottled(company.id, key)) {
    return {
      phase: 'account',
      error: 'Too many attempts. Wait a few minutes, or sign in with a code instead.',
    }
  }

  if (!e164 || !account) {
    await noteLoginFailure(company.id, key, !e164 ? 'unreadable number' : 'no account number')
    return { phase: 'account', error: refuse }
  }

  const customerId = await findCustomerByPhoneAndAccount(company.id, e164, account)
  if (customerId === null) {
    await noteLoginFailure(company.id, e164, 'no single match')
    return { phase: 'account', error: refuse }
  }

  clearPhoneAttempts(company.id, e164)
  await setPortalSession(company.id, customerId, 'account')
  redirect('/')
}

/** The multi-account picker's submit: sign in as the chosen, verified account. */
export async function pickCustomer(formData: FormData): Promise<void> {
  const company = await getPortalCompany()
  if (!company) redirect('/')

  const pending = await getPendingPick(company.id)
  if (!pending) redirect('/')

  const customerId = Number(formData.get('customer_id'))
  const matches = await matchCustomersByPhone(company.id, pending.phone)
  // Only an account actually on the verified number — not any id the form posts.
  if (!Number.isInteger(customerId) || !matches.some((m) => m.id === customerId)) {
    redirect('/choose')
  }

  await setPortalSession(company.id, customerId)
  redirect('/')
}

/** Start an online payment: hand the customer to the gateway's hosted checkout. */
export async function startCheckout(formData: FormData): Promise<void> {
  const company = await getPortalCompany()
  if (!company) redirect('/')

  const session = await getPortalSession(company.id)
  if (!session) redirect('/')

  const amount = Math.round(Number(formData.get('amount')) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) {
    redirect('/?e=' + encodeURIComponent('Enter an amount greater than zero.'))
  }

  const checkout = await createGatewayCheckout({
    companyId: company.id,
    customerId: session.customerId,
    amount,
  })
  if (!checkout.ok) redirect('/?e=' + encodeURIComponent(checkout.error))

  redirect(checkout.url)
}

export async function logout(): Promise<void> {
  await clearPortalSession()
  redirect('/')
}

const fd = (formData: FormData, key: string) => String(formData.get(key) ?? '').trim()

// --- Change your phone number (verify the NEW number by SMS first) ----------

export type PhoneChangeState =
  | { phase: 'enter'; error?: string }
  | { phase: 'code'; phone: string; error?: string }
  | { phase: 'done' }

/**
 * Said the same way wherever the phone change is refused, so the page and the
 * two actions cannot drift into describing the rule differently.
 */
export const NEEDS_SMS =
  'To change the number on this account, sign in with a code sent by text.'

export async function requestPhoneChange(
  _prev: PhoneChangeState | null,
  formData: FormData
): Promise<PhoneChangeState> {
  const company = await getPortalCompany()
  if (!company) return { phase: 'enter', error: 'This portal is not available.' }
  const session = await getPortalSession(company.id)
  if (!session) return { phase: 'enter', error: 'Please sign in again.' }
  // CHECKED ON THE SERVER, not only by hiding the page. Whoever signed in with
  // an account number has not proved they hold the number on the account, so
  // they must not be able to move where that account's messages go.
  if (session.level !== 'sms') return { phase: 'enter', error: NEEDS_SMS }

  const verdict = classifyPhone(fd(formData, 'phone'))
  const e164 = verdict.kind === 'jamaica' ? verdict.e164 : null
  if (!e164) return { phase: 'enter', error: 'Enter a Jamaican mobile number.' }

  const sent = await requestOtp(company.id, company.name, e164)
  if (!sent.ok) return { phase: 'enter', error: sent.error }
  return { phase: 'code', phone: e164 }
}

export async function confirmPhoneChange(
  _prev: PhoneChangeState | null,
  formData: FormData
): Promise<PhoneChangeState> {
  const company = await getPortalCompany()
  if (!company) return { phase: 'enter', error: 'This portal is not available.' }
  const session = await getPortalSession(company.id)
  if (!session) return { phase: 'enter', error: 'Please sign in again.' }
  // Re-checked here, not only at the request step: the two are separate posts
  // and this is the one that writes.
  if (session.level !== 'sms') return { phase: 'enter', error: NEEDS_SMS }

  const phone = fd(formData, 'phone')
  const code = fd(formData, 'code').replace(/\D/g, '')
  if (!/^\d{6}$/.test(code)) return { phase: 'code', phone, error: 'Enter the 6-digit code.' }

  const verified = await verifyOtp(company.id, phone, code)
  if (!verified.ok) return { phase: 'code', phone, error: verified.error }

  // Store the verified number in the E.164 form login matches on (lib/data/portal).
  const { error } = await tenantClient()
    .from('customers')
    .update({ phone })
    .eq('company_id', company.id)
    .eq('id', session.customerId)
  if (error) return { phase: 'code', phone, error: 'Could not save the new number. Try again.' }

  revalidatePath('/')
  return { phase: 'done' }
}

// --- Support tickets --------------------------------------------------------

export type TicketActionState = { ok: false; error: string } | null

/** A staff bell notification for customer ticket activity. Best-effort. */
async function notifyStaffTicket(companyId: number, customerId: number, message: string): Promise<void> {
  try {
    await tenantClient().from('notifications_queue').insert({
      company_id: companyId,
      customer_id: customerId,
      type: 'ticket',
      channel: 'email',
      recipient: '',
      message,
      status: 'pending',
    })
  } catch (err) {
    console.error('[portal] could not raise staff ticket bell:', (err as Error).message)
  }
}

// The photo check is lib/data/portal-tickets.ts#readTicketPhoto, shared with
// the staff side of the ticket.

export async function openTicket(
  _prev: TicketActionState,
  formData: FormData
): Promise<TicketActionState> {
  const company = await getPortalCompany()
  if (!company) return { ok: false, error: 'This portal is not available.' }
  const session = await getPortalSession(company.id)
  if (!session) return { ok: false, error: 'Please sign in again.' }

  const subject = fd(formData, 'subject')
  const description = fd(formData, 'description')
  if (!subject) return { ok: false, error: 'Enter a short subject.' }
  if (!description) return { ok: false, error: 'Describe the problem.' }

  const photo = readTicketPhoto(formData)
  if (photo.error) return { ok: false, error: photo.error }

  const ticketId = await createPortalTicket({ companyId: company.id, customerId: session.customerId, subject, description })

  let photoPath: string | null = null
  if (photo.file) {
    try { photoPath = await uploadTicketPhoto(company.id, ticketId, photo.file) } catch { photoPath = null }
  }
  await addTicketMessage({
    companyId: company.id, ticketId, author: 'customer',
    authorUserId: null, authorName: null, body: description, photoPath,
  })
  await notifyStaffTicket(company.id, session.customerId, 'New support ticket: ' + subject)
  redirect('/support/' + ticketId)
}

export async function replyToTicket(
  _prev: TicketActionState,
  formData: FormData
): Promise<TicketActionState> {
  const company = await getPortalCompany()
  if (!company) return { ok: false, error: 'This portal is not available.' }
  const session = await getPortalSession(company.id)
  if (!session) return { ok: false, error: 'Please sign in again.' }

  const ticketId = Number(fd(formData, 'ticket_id'))
  if (!Number.isInteger(ticketId)) return { ok: false, error: 'Unknown ticket.' }
  // Scoped read: a customer can only reply to their own ticket.
  const ticket = await getPortalTicket(company.id, session.customerId, ticketId)
  if (!ticket) return { ok: false, error: 'That ticket could not be found.' }

  const body = fd(formData, 'body')
  const photo = readTicketPhoto(formData)
  if (photo.error) return { ok: false, error: photo.error }
  if (!body && !photo.file) return { ok: false, error: 'Write a message or attach a photo.' }

  let photoPath: string | null = null
  if (photo.file) {
    try { photoPath = await uploadTicketPhoto(company.id, ticketId, photo.file) } catch { photoPath = null }
  }
  await addTicketMessage({
    companyId: company.id, ticketId, author: 'customer',
    authorUserId: null, authorName: null, body: body || null, photoPath,
  })
  await notifyStaffTicket(company.id, session.customerId, 'New reply on ticket #' + ticketId)
  redirect('/support/' + ticketId)
}

// --- Walled-garden reconnection (no login; identified by MAC) ---------------

/**
 * Pays from the reconnection page a cut-off customer reaches without signing in.
 * The customer is resolved from the MikroTik-supplied MAC, never a posted id,
 * so the amount can only ever be applied to the account on that device.
 */
export async function reconnectCheckout(formData: FormData): Promise<void> {
  const company = await getPortalCompany()
  if (!company) redirect('/reconnect?e=' + encodeURIComponent('This page is not available.'))

  const mac = fd(formData, 'mac')
  const back = (msg: string) => '/reconnect?mac=' + encodeURIComponent(mac) + '&e=' + encodeURIComponent(msg)

  const customerId = await findCustomerIdByMac(company.id, mac)
  if (!customerId) redirect(back('We could not find your account from this device.'))

  const amount = Math.round(Number(formData.get('amount')) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0) redirect(back('Enter an amount greater than zero.'))

  const checkout = await createGatewayCheckout({ companyId: company.id, customerId, amount })
  if (!checkout.ok) redirect(back(checkout.error))
  redirect(checkout.url)
}
