'use server'

import { revalidatePath } from 'next/cache'

import { CURRENCIES, DATE_FORMATS, TIMEZONES } from '@/lib/data/company'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { toBillingType } from '@/lib/billing'
import { toExpiryMode } from '@/lib/types'

export type CompanyResult = { ok: true } | { ok: false; error: string }

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

const bool = (fd: FormData, k: string) => str(fd, k) === 'true'

/** Returns NaN when present but out of range, so callers can reject it. */
function intInRange(fd: FormData, k: string, lo: number, hi: number) {
  const v = str(fd, k)
  if (!v) return null
  const n = Number(v)
  return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN
}

function numInRange(fd: FormData, k: string, lo: number, hi: number) {
  const v = str(fd, k)
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) && n >= lo && n <= hi ? n : NaN
}

/**
 * Saves the general settings.
 *
 * Company identity lives on `companies`, everything else on `settings`, so
 * this writes both. Restricted to company_admin — managers may edit the
 * catalogue but not the company record.
 */
export async function saveCompanyProfile(
  _prev: CompanyResult | null,
  formData: FormData
): Promise<CompanyResult> {
  const { company, profile } = await getSession()

  if (!can(profile.role, 'manage_company_settings')) {
    throw new Error('Forbidden: role "' + profile.role + '" cannot edit company settings.')
  }

  const name = str(formData, 'name')
  if (!name) return { ok: false, error: 'Company name is required.' }

  const email = str(formData, 'email')
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Enter a valid company email address.' }
  }

  const currency = str(formData, 'currency')
  if (!CURRENCIES.includes(currency as (typeof CURRENCIES)[number])) {
    return { ok: false, error: 'Choose a supported currency.' }
  }

  const timezone = str(formData, 'timezone')
  if (!TIMEZONES.some((t) => t.value === timezone)) {
    return { ok: false, error: 'Choose a supported timezone.' }
  }

  const caps = await getSchemaCapabilities()

  // Fields behind migration 0007 render disabled, and browsers do not submit
  // disabled inputs — so only validate them when they can actually be set.
  const dateFormat = str(formData, 'date_format')
  if (caps.generalSettings && !DATE_FORMATS.includes(dateFormat as (typeof DATE_FORMATS)[number])) {
    return { ok: false, error: 'Choose a supported date format.' }
  }

  const cutOff = intInRange(formData, 'cut_off_date', 1, 28)
  const billDate = intInRange(formData, 'bill_date', 1, 28)
  if (Number.isNaN(cutOff) || Number.isNaN(billDate)) {
    return { ok: false, error: 'Cut off and bill dates must be a day between 1 and 28.' }
  }

  const grace = intInRange(formData, 'grace_period_days', 0, 30)
  if (caps.generalSettings && Number.isNaN(grace)) {
    return { ok: false, error: 'Grace period must be 0 to 30 days.' }
  }

  const tax = numInRange(formData, 'tax_rate', 0, 100)
  if (caps.generalSettings && Number.isNaN(tax)) {
    return { ok: false, error: 'Tax rate must be between 0 and 100.' }
  }

  const defaultRate = numInRange(formData, 'default_monthly_rate', 0, 1_000_000)
  if (caps.defaultMonthlyRate && Number.isNaN(defaultRate)) {
    return { ok: false, error: 'Default monthly rate must be zero or more.' }
  }

  const warning = intInRange(formData, 'expiry_warning_days', 1, 14)
  if (caps.generalSettings && Number.isNaN(warning)) {
    return { ok: false, error: 'Expiry warning must be 1 to 14 days.' }
  }

  // Ranges mirror the CHECK constraints in migration 0012, so a value the form
  // accepts is always a value the column will take.
  const lateCredit = intInRange(formData, 'late_credit_threshold', 0, 90)
  const minPayment = numInRange(formData, 'min_payment_threshold', 0, 100)
  const maxCarried = intInRange(formData, 'max_carried_balance', 0, 12)

  if (caps.billingThresholds) {
    if (Number.isNaN(lateCredit)) {
      return { ok: false, error: 'Late credit threshold must be 0 to 90 days.' }
    }
    if (Number.isNaN(minPayment)) {
      return { ok: false, error: 'Minimum payment threshold must be between 0 and 100%.' }
    }
    if (Number.isNaN(maxCarried)) {
      return { ok: false, error: 'Max carried balance must be 0 to 12 months.' }
    }
  }

  const db = tenantClient()

  const { error: companyError } = await db
    .from('companies')
    .update({
      name,
      email: email || null,
      phone: str(formData, 'phone') || null,
      address: str(formData, 'address') || null,
    })
    .eq('id', company.id)

  if (companyError) return { ok: false, error: 'Could not save company: ' + companyError.message }

  const patch: Record<string, unknown> = {
    currency,
    timezone,
    cut_off_date: cutOff,
    bill_date: billDate,
    sms_enabled: bool(formData, 'sms_enabled'),
    email_enabled: bool(formData, 'email_enabled'),
  }

  if (caps.expiryMode) {
    patch.default_expiry_mode = toExpiryMode(str(formData, 'default_expiry_mode'))
  }

  // Only write the 0007 columns once they exist; PostgREST rejects the whole
  // update otherwise.
  if (caps.generalSettings) {
    patch.date_format = dateFormat
    patch.grace_period_days = grace ?? 0
    patch.tax_rate = tax ?? 0
    patch.expiry_warning_days = warning ?? 3
    patch.ddns_hostname = str(formData, 'ddns_hostname') || null
    patch.radius_secret = str(formData, 'radius_secret') || null
  }

  if (caps.defaultMonthlyRate) {
    patch.default_monthly_rate = defaultRate ?? 0
  }

  if (caps.billing) {
    patch.default_billing_type = toBillingType(str(formData, 'default_billing_type'))
  }

  if (caps.billingThresholds) {
    patch.late_credit_threshold = lateCredit ?? 7
    patch.min_payment_threshold = minPayment ?? 50
    patch.max_carried_balance = maxCarried ?? 2
  }

  // 0007 guarantees a settings row per company, but this page must still work
  // before that migration runs.
  const { data: existing } = await db
    .from('settings')
    .select('id')
    .eq('company_id', company.id)
    .maybeSingle()

  const { error: settingsError } = existing
    ? await db.from('settings').update(patch).eq('company_id', company.id)
    : await db.from('settings').insert({ ...patch, company_id: company.id })

  if (settingsError) {
    return { ok: false, error: 'Company saved but settings failed: ' + settingsError.message }
  }

  revalidatePath('/dashboard/settings/company')
  revalidatePath('/dashboard')
  return { ok: true }
}
