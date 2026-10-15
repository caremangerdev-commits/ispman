'use server'

import { redirect } from 'next/navigation'

import { createGatewayCheckout } from '@/lib/data/payment-gateways'
import { matchCustomersByPhone } from '@/lib/data/portal'
import { classifyPhone } from '@/lib/phone'
import { getPortalCompany } from '@/lib/portal/context'
import { requestOtp, verifyOtp } from '@/lib/portal/otp'
import {
  clearPortalSession, getPendingPick, getPortalSession, setPendingPick, setPortalSession,
} from '@/lib/portal/session'

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
