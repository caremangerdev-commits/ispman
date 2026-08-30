import { cache } from 'react'

import { tenantClient } from '@/lib/supabase/tenant'

export type SchemaCapabilities = {
  /** `customers.customer_type` / `pppoe_username` / `pppoe_password` (0003). */
  connectionTypes: boolean
  /** `customers.expiry_mode` and `settings.default_expiry_mode` (0004). */
  expiryMode: boolean
  /** service_plans / additional_services / misc_categories and the
   *  customers columns that reference them (migration 0005). */
  catalog: boolean
  /** The general-settings columns added by migration 0007. */
  generalSettings: boolean
  /** `settings.default_monthly_rate` (migration 0008). */
  defaultMonthlyRate: boolean
  /** payments.checked_off/payment_method/user_id + checkoff_records (0010). */
  checkoff: boolean
  /**
   * Postpaid billing (0011): the customers and payments billing columns plus
   * `settings.default_billing_type`. All three halves are required together —
   * recording a postpaid payment writes to all of them in one flow, so a
   * partially applied 0011 must read as absent rather than half-enabled.
   */
  billing: boolean
  /** The three billing policy thresholds added by migration 0012. */
  billingThresholds: boolean
  /**
   * "Other" payments, payment categories and paid_on (0013). Both halves are
   * required together: the payment type toggle is useless without the category
   * table to populate its Purpose dropdown, and an "other" payment cannot be
   * inserted without payment_kind. A partially applied 0013 reads as absent,
   * so the form stays on the Service flow it had before.
   */
  otherPayments: boolean
}

/**
 * Detects whether migration 0003 has been applied.
 *
 * This project's migrations are run by hand in the Supabase SQL editor, so the
 * code has to cope with running against either shape of the schema. Rather
 * than crash on a missing column, features probe once and hide themselves.
 *
 * Cached per request: cheap enough to re-check on each render, and it means the
 * new features light up the moment the migration lands — no restart needed.
 *
 * Remove this module once 0003 is applied everywhere; the columns become a
 * hard requirement at that point.
 */
export const getSchemaCapabilities = cache(async (): Promise<SchemaCapabilities> => {
  // [perf] TEMPORARY instrumentation
  const tProbe = Date.now()
  const db = tenantClient()

  const [
    typeRes, expiryRes, catalogRes, generalRes, rateRes, checkoffRes, recordsRes,
    billingCustomerRes, billingPaymentRes, billingSettingRes, thresholdRes,
    otherPaymentRes, paymentCategoryRes,
  ] = await Promise.all([
    db.from('customers').select('customer_type').limit(1),
    db.from('customers').select('expiry_mode').limit(1),
    db.from('service_plans').select('id').limit(1),
    db.from('settings').select('date_format').limit(1),
    db.from('settings').select('default_monthly_rate').limit(1),
    db.from('payments').select('checked_off, payment_method, user_id').limit(1),
    db.from('checkoff_records').select('id').limit(1),
    db
      .from('customers')
      .select('billing_type, carried_balance, account_credit, bill_date, last_billed_date')
      .limit(1),
    db
      .from('payments')
      .select(
        'billing_period_start, billing_period_end, access_granted_until, ' +
          'carried_balance_before, carried_balance_after, access_decision'
      )
      .limit(1),
    db.from('settings').select('default_billing_type').limit(1),
    db
      .from('settings')
      .select('late_credit_threshold, min_payment_threshold, max_carried_balance')
      .limit(1),
    db
      .from('payments')
      .select('payment_kind, payment_category_id, paid_on, service_charge, service_active_until')
      .limit(1),
    db.from('payment_categories').select('id').limit(1),
  ])
  console.log('[perf]     schema probe: 13 parallel queries  %dms', Date.now() - tProbe)

  // PGRST205 = unknown table, 42703 = undefined column. Anything else is a
  // real failure and should not be silently reported as "feature absent".
  const missingType = typeRes.error?.code === '42703'
  const missingExpiry = expiryRes.error?.code === '42703'
  const missingCatalog =
    catalogRes.error?.code === 'PGRST205' || catalogRes.error?.code === '42P01'
  const missingGeneral = generalRes.error?.code === '42703'
  const missingRate = rateRes.error?.code === '42703'
  // Both halves of 0010 must be present: the payments columns and the table.
  const missingCheckoffCols = checkoffRes.error?.code === '42703'
  const missingRecords =
    recordsRes.error?.code === 'PGRST205' || recordsRes.error?.code === '42P01'
  // 0011 lands as three separate ALTERs, so any missing piece disables the lot.
  const missingBillingCustomer = billingCustomerRes.error?.code === '42703'
  const missingBillingPayment = billingPaymentRes.error?.code === '42703'
  const missingBillingSetting = billingSettingRes.error?.code === '42703'
  const missingThresholds = thresholdRes.error?.code === '42703'
  // 0013 lands as one ALTER plus one CREATE TABLE, so either missing disables it.
  const missingOtherPaymentCols = otherPaymentRes.error?.code === '42703'
  const missingPaymentCategories =
    paymentCategoryRes.error?.code === 'PGRST205' || paymentCategoryRes.error?.code === '42P01'

  if (typeRes.error && !missingType) {
    throw new Error('Schema probe failed for customer_type: ' + typeRes.error.message)
  }
  if (expiryRes.error && !missingExpiry) {
    throw new Error('Schema probe failed for expiry_mode: ' + expiryRes.error.message)
  }
  if (catalogRes.error && !missingCatalog) {
    throw new Error('Schema probe failed for service_plans: ' + catalogRes.error.message)
  }
  if (generalRes.error && !missingGeneral) {
    throw new Error('Schema probe failed for settings: ' + generalRes.error.message)
  }
  if (rateRes.error && !missingRate) {
    throw new Error('Schema probe failed for default_monthly_rate: ' + rateRes.error.message)
  }
  if (checkoffRes.error && !missingCheckoffCols) {
    throw new Error('Schema probe failed for payments checkoff columns: ' + checkoffRes.error.message)
  }
  if (recordsRes.error && !missingRecords) {
    throw new Error('Schema probe failed for checkoff_records: ' + recordsRes.error.message)
  }
  if (billingCustomerRes.error && !missingBillingCustomer) {
    throw new Error(
      'Schema probe failed for customers billing columns: ' + billingCustomerRes.error.message
    )
  }
  if (billingPaymentRes.error && !missingBillingPayment) {
    throw new Error(
      'Schema probe failed for payments billing columns: ' + billingPaymentRes.error.message
    )
  }
  if (billingSettingRes.error && !missingBillingSetting) {
    throw new Error(
      'Schema probe failed for default_billing_type: ' + billingSettingRes.error.message
    )
  }
  if (thresholdRes.error && !missingThresholds) {
    throw new Error(
      'Schema probe failed for billing thresholds: ' + thresholdRes.error.message
    )
  }

  if (otherPaymentRes.error && !missingOtherPaymentCols) {
    throw new Error(
      'Schema probe failed for payments 0013 columns: ' + otherPaymentRes.error.message
    )
  }
  if (paymentCategoryRes.error && !missingPaymentCategories) {
    throw new Error(
      'Schema probe failed for payment_categories: ' + paymentCategoryRes.error.message
    )
  }

  return {
    connectionTypes: !missingType,
    expiryMode: !missingExpiry,
    catalog: !missingCatalog,
    generalSettings: !missingGeneral,
    defaultMonthlyRate: !missingRate,
    checkoff: !missingCheckoffCols && !missingRecords,
    billing: !missingBillingCustomer && !missingBillingPayment && !missingBillingSetting,
    billingThresholds: !missingThresholds,
    otherPayments: !missingOtherPaymentCols && !missingPaymentCategories,
  }
})

export const CHECKOFF_HINT =
  'Checkoff is not set up on this system yet. Ask your administrator to enable it.'

export const CATALOG_HINT =
  'This feature is not set up on this system yet. Ask your administrator to enable it.'

export const GENERAL_SETTINGS_HINT =
  'These fields are not set up on this system yet. Ask your administrator to enable them.'

export const DEFAULT_RATE_HINT =
  'This field is not set up on this system yet. Ask your administrator to enable it.'

export const BILLING_HINT =
  'Postpaid billing is not set up on this system yet. Ask your administrator to enable it.'

export const BILLING_THRESHOLD_HINT =
  'These billing policy fields are not set up on this system yet. Ask your administrator to enable them.'

export const OTHER_PAYMENT_HINT =
  'Other payments are not set up on this system yet. Ask your administrator to enable them.'

export const EXPIRY_MODE_HINT =
  'This setting is not available on this system yet. Ask your administrator to enable it.'
