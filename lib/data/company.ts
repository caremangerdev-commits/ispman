import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { toBillingType, type BillingType } from '@/lib/billing'
import { toExpiryMode, type ExpiryMode } from '@/lib/types'

/** Caribbean currencies this platform bills in. */
export const CURRENCIES = ['JMD', 'USD', 'TTD', 'BBD', 'GYD', 'XCD'] as const

/** Timezones the supported regions actually fall in. */
export const TIMEZONES = [
  { value: 'America/Jamaica', label: 'America/Jamaica (UTC-5)' },
  { value: 'America/Trinidad', label: 'America/Trinidad (UTC-4)' },
  { value: 'America/Barbados', label: 'America/Barbados (UTC-4)' },
  { value: 'America/Guyana', label: 'America/Guyana (UTC-4)' },
  { value: 'America/Belize', label: 'America/Belize (UTC-6)' },
  { value: 'America/Panama', label: 'America/Panama (UTC-5)' },
  { value: 'America/Puerto_Rico', label: 'America/Puerto_Rico (UTC-4)' },
  { value: 'America/Grand_Turk', label: 'America/Grand_Turk (UTC-5)' },
  { value: 'America/New_York', label: 'America/New_York (UTC-5/-4)' },
  { value: 'America/Chicago', label: 'America/Chicago (UTC-6/-5)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (UTC-8/-7)' },
  { value: 'UTC', label: 'UTC' },
] as const

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const

export type GeneralSettings = {
  // companies
  name: string
  email: string | null
  phone: string | null
  address: string | null
  // settings — regional
  timezone: string
  currency: string
  dateFormat: string
  /** Migration 0019. ISO 3166-1 alpha-2, or '' for "not stated" — which is a
   *  permanent answer, not a gap: it is what keeps tax-id validation off. */
  country: string
  /** Migration 0019. Empty means derive from country — see lib/tax-id.ts. */
  taxIdLabel: string
  /** Migration 0020. Empty means account numbers stand alone. */
  accountNumberPrefix: string
  // settings — billing
  cutOffDate: number | null
  billDate: number | null
  defaultExpiryMode: ExpiryMode
  gracePeriodDays: number
  taxRate: number
  defaultMonthlyRate: number
  /** migration 0011 */
  defaultBillingType: BillingType
  /** migration 0017 — the two first-period switches. See getFirstPeriodRules. */
  firstExpiryRuleEnabled: boolean
  prorataFirstPaymentEnabled: boolean
  /** migration 0012 — policy only; nothing in the payment flow reads these. */
  lateCreditThreshold: number
  minPaymentThreshold: number
  maxCarriedBalance: number
  // settings — notifications & network
  smsEnabled: boolean
  emailEnabled: boolean
  expiryWarningDays: number
  ddnsHostname: string | null
  radiusSecret: string | null
}

/**
 * The general-settings form's current values, stitched from `companies`
 * (identity) and `settings` (everything else).
 *
 * Columns added by 0007 are only selected once the probe confirms they exist,
 * so the page renders against either shape of the schema.
 */
export async function getGeneralSettings(companyId: number): Promise<GeneralSettings> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  let cols = 'currency, cut_off_date, bill_date, timezone, sms_enabled, email_enabled'
  if (caps.expiryMode) cols += ', default_expiry_mode'
  if (caps.generalSettings) {
    cols += ', date_format, grace_period_days, tax_rate, expiry_warning_days, ddns_hostname, radius_secret'
  }
  if (caps.defaultMonthlyRate) cols += ', default_monthly_rate'
  if (caps.taxId) cols += ', country, tax_id_label'
  if (caps.accountNumbers) cols += ', account_number_prefix'
  if (caps.billing) cols += ', default_billing_type'
  if (caps.billingThresholds) {
    cols += ', late_credit_threshold, min_payment_threshold, max_carried_balance'
  }
  if (caps.firstPeriod) {
    cols += ', first_expiry_rule_enabled, prorata_first_payment_enabled'
  }

  const [companyRes, settingsRes] = await Promise.all([
    // DEAD COLUMNS — `companies` also carries ddns_hostname and nas_secret.
    // Neither is read or written anywhere in this app: the live values are
    // settings.ddns_hostname and settings.radius_secret, selected below. The
    // columns are kept so no existing data is lost, but nothing should start
    // writing them again — if you need a network field, add it to `settings`.
    db.from('companies').select('name, email, phone, address').eq('id', companyId).maybeSingle(),
    db.from('settings').select(cols).eq('company_id', companyId).maybeSingle(),
  ])

  if (companyRes.error) throw new Error('Failed to load company: ' + companyRes.error.message)
  if (settingsRes.error) throw new Error('Failed to load settings: ' + settingsRes.error.message)

  const c = companyRes.data as unknown as {
    name: string
    email: string | null
    phone: string | null
    address: string | null
  } | null

  const s = settingsRes.data as unknown as {
    currency: string | null
    cut_off_date: number | null
    bill_date: number | null
    timezone: string | null
    sms_enabled: boolean | null
    email_enabled: boolean | null
    default_expiry_mode?: string | null
    date_format?: string | null
    grace_period_days?: number | null
    tax_rate?: number | string | null
    default_monthly_rate?: number | string | null
    expiry_warning_days?: number | null
    ddns_hostname?: string | null
    radius_secret?: string | null
    default_billing_type?: string | null
    late_credit_threshold?: number | null
    min_payment_threshold?: number | string | null
    max_carried_balance?: number | null
    first_expiry_rule_enabled?: boolean | null
    prorata_first_payment_enabled?: boolean | null
  } | null

  return {
    name: c?.name ?? '',
    email: c?.email ?? null,
    phone: c?.phone ?? null,
    address: c?.address ?? null,
    timezone: s?.timezone ?? 'America/Jamaica',
    currency: s?.currency ?? 'JMD',
    dateFormat: s?.date_format ?? 'DD/MM/YYYY',
    country: (s as { country?: string | null })?.country ?? '',
    taxIdLabel: (s as { tax_id_label?: string | null })?.tax_id_label ?? '',
    accountNumberPrefix:
      (s as { account_number_prefix?: string | null })?.account_number_prefix ?? '',
    cutOffDate: s?.cut_off_date ?? null,
    billDate: s?.bill_date ?? null,
    defaultExpiryMode: toExpiryMode(caps.expiryMode ? s?.default_expiry_mode : 'from_expiry'),
    gracePeriodDays: Number(s?.grace_period_days ?? 0),
    taxRate: Number(s?.tax_rate ?? 0),
    defaultMonthlyRate: Number(s?.default_monthly_rate ?? 0),
    defaultBillingType: toBillingType(caps.billing ? s?.default_billing_type : 'prepaid'),
    // Defaults match migration 0012, so the form shows what the column would
    // hold rather than a row of zeroes before it is applied.
    lateCreditThreshold: Number(s?.late_credit_threshold ?? 7),
    minPaymentThreshold: Number(s?.min_payment_threshold ?? 50),
    maxCarriedBalance: Number(s?.max_carried_balance ?? 2),
    // Read through the same helper the payment and provisioning paths use, so
    // the toggles on this form cannot disagree with what the till applies.
    ...firstPeriodRules(caps.firstPeriod, s),
    smsEnabled: Boolean(s?.sms_enabled),
    emailEnabled: Boolean(s?.email_enabled),
    expiryWarningDays: Number(s?.expiry_warning_days ?? 3),
    ddnsHostname: s?.ddns_hostname ?? null,
    radiusSecret: s?.radius_secret ?? null,
  }
}

/**
 * The rate to pre-fill on the Add Customer form.
 *
 * Returns 0 when unset or when migration 0008 has not been applied, which the
 * form treats as "leave the field empty".
 */
export async function getDefaultMonthlyRate(companyId: number): Promise<number> {
  const caps = await getSchemaCapabilities()
  if (!caps.defaultMonthlyRate) return 0

  const db = tenantClient()
  const { data } = await db
    .from('settings')
    .select('default_monthly_rate')
    .eq('company_id', companyId)
    .maybeSingle()

  return Number((data as { default_monthly_rate: number | string | null } | null)?.default_monthly_rate ?? 0)
}

/**
 * The billing type to pre-select on the Add Customer form.
 *
 * Falls back to prepaid when migration 0011 has not been applied, which is also
 * what every customer reads as until it is.
 */
export async function getDefaultBillingType(companyId: number): Promise<BillingType> {
  const caps = await getSchemaCapabilities()
  if (!caps.billing) return 'prepaid'

  const db = tenantClient()
  const { data } = await db
    .from('settings')
    .select('default_billing_type')
    .eq('company_id', companyId)
    .maybeSingle()

  return toBillingType(
    (data as { default_billing_type: string | null } | null)?.default_billing_type
  )
}

/**
 * The bill day to pre-fill on the Add Customer form for a postpaid customer.
 *
 * `settings.bill_date` predates migration 0011, so no capability gate: the
 * column is there whether or not per-customer postpaid billing is. Null when
 * the settings row has never been saved — the form starts on day 1 then.
 */
export async function getDefaultBillDate(companyId: number): Promise<number | null> {
  const db = tenantClient()
  const { data } = await db
    .from('settings')
    .select('bill_date')
    .eq('company_id', companyId)
    .maybeSingle()

  return (data as { bill_date: number | null } | null)?.bill_date ?? null
}

/** Currency code for this company, used to label prices in settings. */
export async function getCurrency(companyId: number): Promise<string> {
  const db = tenantClient()
  const { data } = await db
    .from('settings')
    .select('currency')
    .eq('company_id', companyId)
    .maybeSingle()

  return (data as { currency: string | null } | null)?.currency ?? 'JMD'
}

// ---------------------------------------------------------------------------
// First-period rules (migration 0017)
// ---------------------------------------------------------------------------

export type FirstPeriodRules = {
  /** CHANGE A: the 21-day rule at provisioning (lib/expiry.ts#firstExpiry). */
  firstExpiryRuleEnabled: boolean
  /** CHANGE B: pro-rata the first payment (lib/billing.ts#firstPeriodCharge). */
  prorataFirstPaymentEnabled: boolean
}

/**
 * THE ONE PLACE THE PRE-0017 FALLBACK IS DECIDED, and it is ASYMMETRIC.
 *
 * "Migration not applied" does not mean "both rules off". It means "behave
 * exactly as the app did before 0017 existed", and those are different:
 *
 *   - the 21-day rule is ALREADY UNCONDITIONAL in the shipped code, reached
 *     through provisionCustomer -> provisionExpiry. Defaulting it off would
 *     silently change how every new customer's first expiry is calculated on
 *     schemas that have not run the migration yet.
 *   - pro-rata DID NOT EXIST. Defaulting it on would start charging customers
 *     differently on exactly those same schemas.
 *
 * So: A on, B off. Both are then whatever the company says once 0017 lands.
 */
function firstPeriodRules(
  applied: boolean,
  row: { first_expiry_rule_enabled?: boolean | null; prorata_first_payment_enabled?: boolean | null } | null | undefined
): FirstPeriodRules {
  if (!applied) return { firstExpiryRuleEnabled: true, prorataFirstPaymentEnabled: false }

  // NOT NULL DEFAULT TRUE in 0017, so a null here means no settings row at all
  // rather than an unset column. A company with no settings row gets the same
  // answer as one that has never touched the toggles.
  return {
    firstExpiryRuleEnabled: row?.first_expiry_rule_enabled ?? true,
    prorataFirstPaymentEnabled: row?.prorata_first_payment_enabled ?? true,
  }
}

/**
 * The two switches, for the paths that need them without the whole settings
 * form: provisioning (app/actions/customers.ts) and the till
 * (app/actions/payments.ts).
 *
 * Deliberately its own small query rather than getGeneralSettings, which also
 * reads `companies` and every 0007/0011/0012 column — none of which either
 * caller wants on a payment.
 */
export async function getFirstPeriodRules(companyId: number): Promise<FirstPeriodRules> {
  const caps = await getSchemaCapabilities()
  if (!caps.firstPeriod) return firstPeriodRules(false, null)

  const db = tenantClient()
  const { data, error } = await db
    .from('settings')
    .select('first_expiry_rule_enabled, prorata_first_payment_enabled')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    // Falls back to the pre-0017 behaviour rather than throwing: a settings read
    // that fails must not stop a cashier taking money.
    console.error('[first-period] settings read failed:', error.message)
    return firstPeriodRules(false, null)
  }

  return firstPeriodRules(true, data as Parameters<typeof firstPeriodRules>[1])
}
