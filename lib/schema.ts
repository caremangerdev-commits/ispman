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
  /**
   * `payments.credit_applied` (migration 0015). What makes a prepayment's
   * credit reversible when the payment is corrected or deleted. Until it is
   * present the correction paths move the carried balance only, and say in the
   * log that the credit was left standing.
   */
  creditReversal: boolean
  /**
   * `log.amount` / `correlation_id` / `related_customer_id` (0016). Lets a
   * log row carry the numbers a report needs in columns instead of buried in
   * `details` prose. All three land in one ALTER, so one probe decides them.
   *
   * Until it is present logEvent drops those fields rather than failing the
   * insert — the change being logged has already happened, and losing the whole
   * row to keep the metadata would be the worse trade.
   */
  logMetadata: boolean
  /**
   * Migration 0017: the two first-period switches on `settings`, AND the two
   * payments columns the receipt restates from — `amount_due` and
   * `first_period_discount`. All four
   * are required together — pricing a first period without stamping what was
   * due would print a receipt that cannot be restated.
   *   * FALLBACK IS ASYMMETRIC AND THAT IS THE POINT. When this reads false the app
   * must behave exactly as it did before 0017 existed, and that is not "both
   * rules off": the 21-day rule is already unconditional in the shipped code,
   * while pro-rata is new. So absent means A ON, B OFF — see
   * lib/data/company.ts#getFirstPeriodRules, which is the only place allowed to
   * decide it.
   */
  firstPeriod: boolean
  /**
   * `payments.customer_misc_category_id` (0018). The customer’s segment as it
   * was WHEN THEY PAID, so an income breakdown by owner cannot be rewritten
   * retroactively by recategorising a customer.
   *
   * Absent, the breakdown resolves the segment through the customer’s current
   * category instead — which is what it must do for rows written before this
   * migration in any case, so the fallback is the same code path rather than a
   * degraded one.
   */
  paymentSegment: boolean
  /**
   * Migration 0019: `customers.tax_id` plus `settings.country` and
   * `settings.tax_id_label`, which decide what to CALL it. All three together —
   * a tax id field with no label to put on it renders as an unnamed box, and
   * the country is what makes validating a format safe to add later.
   */
  taxId: boolean
  /**
   * Migration 0020: `customers.account_number`, the `account_counters` table
   * that issues them, and `settings.account_number_prefix`. Required together:
   * the column without the counter has no way to allocate the next number, and
   * allocating without the unique index that ships alongside it would issue
   * duplicates silently.
   */
  accountNumbers: boolean
  /**
   * Migration 0021: the `sms_outbox` queue, `sms_devices`, `sms_batches`, the
   * per-type switches and templates on `settings`, and
   * `customers.sms_opted_out`.
   *
   * REQUIRED TOGETHER. The queue without the settings has nothing to decide
   * whether a message may be sent, and the settings without the queue give an
   * operator switches that silently do nothing. A partially applied 0021 must
   * read as absent, so the SMS settings page and the messaging page stay
   * hidden and nothing enqueues.
   */
  sms: boolean
  /**
   * Migration 0022: the outbox's channel and recipient columns, the routes
   * and email settings, and customers.email_opted_out. Required together, for
   * the same reason as `sms`. Without it the queue is SMS-shaped and only the
   * SMS adapter is offered; nothing about email is shown.
   */
  messaging: boolean
  /**
   * Migration 0023: `settings.logo_path` and `settings.brand_color`. The
   * private `company-assets` bucket lands in the same file and cannot be
   * probed through PostgREST; an upload against a missing bucket says so.
   *
   * Absent, every company is unbranded — a wordmark in the default colour —
   * which is also what a company that never opens the Branding card gets, so
   * the fallback is the ordinary path and not a degraded one.
   */
  branding: boolean
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
    otherPaymentRes, paymentCategoryRes, creditReversalRes, logMetadataRes,
    firstPeriodRes, amountDueRes, paymentSegmentRes,
    taxIdCustomerRes, taxIdSettingRes, accountNumberRes, accountCounterRes,
    accountPrefixRes,
    smsOutboxRes, smsSettingRes, smsOptOutRes,
    messagingOutboxRes, messagingSettingRes, messagingOptOutRes,
    brandingRes,
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
    db.from('payments').select('credit_applied').limit(1),
    db.from('log').select('amount, correlation_id, related_customer_id').limit(1),
    db
      .from('settings')
      .select('first_expiry_rule_enabled, prorata_first_payment_enabled')
      .limit(1),
    db.from('payments').select('amount_due, first_period_discount').limit(1),
    db.from('payments').select('customer_misc_category_id').limit(1),
    db.from('customers').select('tax_id').limit(1),
    db.from('settings').select('country, tax_id_label').limit(1),
    db.from('customers').select('account_number').limit(1),
    db.from('account_counters').select('company_id').limit(1),
    db.from('settings').select('account_number_prefix').limit(1),
    db.from('sms_outbox').select('id').limit(1),
    // The per-kind switches are NOT probed here: 0022 renames them (sms_ to
    // notify_), and a probe on either name would flip `sms` off on the other
    // side of that migration. The columns below are 0021's and stay.
    db
      .from('settings')
      .select('sms_expiry_warning_days, sms_throttle_seconds, sms_allow_foreign')
      .limit(1),
    db.from('customers').select('sms_opted_out').limit(1),
    // 0022: channel-neutral outbox, routes and email settings, email opt-out.
    db.from('sms_outbox').select('channel, recipient').limit(1),
    db
      .from('settings')
      .select('route_bulk, email_from_name, notify_payment_receipt_enabled')
      .limit(1),
    db.from('customers').select('email_opted_out').limit(1),
    // 0023: one ALTER adds both, so one probe decides them.
    db.from('settings').select('logo_path, brand_color').limit(1),
  ])
  console.log('[perf]     schema probe: 26 parallel queries  %dms', Date.now() - tProbe)

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
  // 0015 is a single ALTER, so the one column decides it.
  const missingCreditReversal = creditReversalRes.error?.code === '42703'
  // 0016 likewise: one ALTER adding all three columns to log.
  const missingLogMetadata = logMetadataRes.error?.code === '42703'
  // 0017 spans two tables: the two switches on `settings` and payments.amount_due,
  // which the receipt prints as "Balance due". ANY missing piece disables the
  // lot — a half-applied 0017 that priced a first period without stamping what
  // was due would print a receipt it cannot restate.
  const missingFirstPeriod =
    firstPeriodRes.error?.code === '42703' || amountDueRes.error?.code === '42703'
  // 0018 is a single ALTER, so the one column decides it.
  const missingPaymentSegment = paymentSegmentRes.error?.code === '42703'
  // 0019 spans two tables, so either half missing disables the field.
  const missingTaxId =
    taxIdCustomerRes.error?.code === '42703' || taxIdSettingRes.error?.code === '42703'
  // 0020 likewise, and it also adds a table.
  const missingAccountNumbers =
    accountNumberRes.error?.code === '42703' ||
    accountPrefixRes.error?.code === '42703' ||
    accountCounterRes.error?.code === 'PGRST205' ||
    accountCounterRes.error?.code === '42P01'
  // 0021 spans three tables and two sets of columns. Any missing piece disables
  // the lot — see the note on `sms` above.
  const missingSms =
    smsOutboxRes.error?.code === 'PGRST205' ||
    smsOutboxRes.error?.code === '42P01' ||
    smsSettingRes.error?.code === '42703' ||
    smsOptOutRes.error?.code === '42703'
  const missingPaymentCategories =
    paymentCategoryRes.error?.code === 'PGRST205' || paymentCategoryRes.error?.code === '42P01'
  // 0022 likewise: any missing piece reads as absent.
  const missingMessaging =
    messagingOutboxRes.error?.code === 'PGRST205' ||
    messagingOutboxRes.error?.code === '42P01' ||
    messagingOutboxRes.error?.code === '42703' ||
    messagingSettingRes.error?.code === '42703' ||
    messagingOptOutRes.error?.code === '42703'

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

  if (creditReversalRes.error && !missingCreditReversal) {
    throw new Error(
      'Schema probe failed for credit_applied: ' + creditReversalRes.error.message
    )
  }

  if (logMetadataRes.error && !missingLogMetadata) {
    throw new Error(
      'Schema probe failed for log metadata columns: ' + logMetadataRes.error.message
    )
  }

  if (firstPeriodRes.error && firstPeriodRes.error.code !== '42703') {
    throw new Error(
      'Schema probe failed for first-period settings: ' + firstPeriodRes.error.message
    )
  }
  if (amountDueRes.error && amountDueRes.error.code !== '42703') {
    throw new Error(
      'Schema probe failed for payments.amount_due: ' + amountDueRes.error.message
    )
  }

  for (const [what, res] of Object.entries({
    'customers.tax_id': taxIdCustomerRes,
    'settings tax id columns': taxIdSettingRes,
    'customers.account_number': accountNumberRes,
    'settings.account_number_prefix': accountPrefixRes,
    'settings SMS columns': smsSettingRes,
    'customers.sms_opted_out': smsOptOutRes,
    'settings messaging columns': messagingSettingRes,
    'customers.email_opted_out': messagingOptOutRes,
    'settings branding columns': brandingRes,
  })) {
    if (res.error && res.error.code !== '42703') {
      throw new Error('Schema probe failed for ' + what + ': ' + res.error.message)
    }
  }
  if (
    smsOutboxRes.error &&
    smsOutboxRes.error.code !== 'PGRST205' &&
    smsOutboxRes.error.code !== '42P01'
  ) {
    throw new Error('Schema probe failed for sms_outbox: ' + smsOutboxRes.error.message)
  }
  if (
    messagingOutboxRes.error &&
    messagingOutboxRes.error.code !== 'PGRST205' &&
    messagingOutboxRes.error.code !== '42P01' &&
    messagingOutboxRes.error.code !== '42703'
  ) {
    throw new Error('Schema probe failed for sms_outbox.channel: ' + messagingOutboxRes.error.message)
  }
  if (
    accountCounterRes.error &&
    accountCounterRes.error.code !== 'PGRST205' &&
    accountCounterRes.error.code !== '42P01'
  ) {
    throw new Error('Schema probe failed for account_counters: ' + accountCounterRes.error.message)
  }

  if (paymentSegmentRes.error && !missingPaymentSegment) {
    throw new Error(
      'Schema probe failed for customer_misc_category_id: ' + paymentSegmentRes.error.message
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
    creditReversal: !missingCreditReversal,
    logMetadata: !missingLogMetadata,
    firstPeriod: !missingFirstPeriod,
    paymentSegment: !missingPaymentSegment,
    taxId: !missingTaxId,
    accountNumbers: !missingAccountNumbers,
    sms: !missingSms,
    messaging: !missingSms && !missingMessaging,
    branding: brandingRes.error?.code !== '42703',
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
