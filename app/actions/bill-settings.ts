'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  BANK_DETAILS_MAX, BILL_TEMPLATE_LABELS, normaliseInvoicePrefix, REGISTERED_ADDRESS_MAX, TAX_LABEL_MAX,
  TAX_NUMBER_MAX, toBillTemplate,
} from '@/lib/bill/settings'
import { getBillSettings } from '@/lib/data/bill-settings'
import { getMessagingSettings } from '@/lib/data/sms'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Settings > Bill Design: which template, the company's tax and registration
 * numbers, the tax line, the invoice prefix, the bank details, and whether
 * staff may email bills.
 *
 * ITS OWN FORM AND ACTION. The tax rate moved here from Settings > Billing on
 * 2026-10-19: it decides nothing about what is charged (rates are
 * tax-inclusive) and only ever prints, so it belongs beside the switch that
 * says whether it prints. saveBillingSettings no longer writes it, so two
 * forms cannot overwrite each other's value.
 *
 * Same gate as every company settings page. Every save is logged with what
 * changed: what a company prints on its tax invoices is worth being able to
 * answer for.
 */

export type BillSettingsResult = { ok: true; message: string } | { ok: false; error: string }

function text(fd: FormData, key: string, max: number): string | null | Error {
  const raw = fd.get(key)
  const v = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim() : ''
  if (v.length > max) return new Error('too long')
  return v || null
}

export async function saveBillSettings(
  _prev: BillSettingsResult | null,
  formData: FormData
): Promise<BillSettingsResult> {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'manage_company_settings')) {
    throw new Error('Forbidden: role "' + profile.role + '" cannot edit company settings.')
  }

  const caps = await getSchemaCapabilities()
  if (!caps.billDocuments) {
    return { ok: false, error: 'Bill settings are not set up on this system yet. Ask your administrator to apply migration 0038.' }
  }

  const fields: [string, number, string][] = [
    ['registered_address', REGISTERED_ADDRESS_MAX, 'Registered address'],
    ['company_tax_id', TAX_NUMBER_MAX, 'Tax ID'],
    ['tax_registration_number', TAX_NUMBER_MAX, 'Tax registration number'],
    ['tax_label', TAX_LABEL_MAX, 'Tax line label'],
    ['bank_details', BANK_DETAILS_MAX, 'Bank details'],
  ]
  // NOT the currency symbol: the portal prints it too, so it is the company's
  // and is saved with the currency on Settings > General (moved 2026-10-21).
  const patch: Record<string, unknown> = {}
  for (const [key, max, label] of fields) {
    const v = text(formData, key, max)
    if (v instanceof Error) return { ok: false, error: label + ' must be ' + max + ' characters or fewer.' }
    patch[key] = v
  }

  patch.bill_template = toBillTemplate(String(formData.get('bill_template') ?? ''))
  const registered = formData.get('tax_registered') === 'true'
  patch.tax_registered = registered

  // 0042: whether staff may email bills. Only written once the column exists;
  // before that the form shows the switch disabled and posts its default.
  if (caps.emailBills) patch.notify_bill_enabled = formData.get('notify_bill_enabled') === 'true'

  // 0042: the invoice prefix. Refused, not cleaned, when it holds something it
  // may not — the company should see the number it will actually get.
  if (caps.invoicePrefix) {
    const prefix = normaliseInvoicePrefix(String(formData.get('invoice_prefix') ?? ''))
    if (prefix instanceof Error) return { ok: false, error: prefix.message }
    patch.invoice_prefix = prefix
  }

  // The rate is 0007's column. Written whenever that migration is applied,
  // whether or not the company is registered, so turning registration on later
  // finds the rate they typed.
  if (caps.generalSettings) {
    const raw = String(formData.get('tax_rate') ?? '').trim()
    const rate = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return { ok: false, error: 'Tax rate must be between 0 and 100.' }
    }
    if (registered && rate <= 0) {
      return { ok: false, error: 'Enter the tax rate, or turn off "Registered for tax" to print no tax line.' }
    }
    patch.tax_rate = Math.round(rate * 100) / 100
  } else if (registered) {
    return { ok: false, error: 'The tax rate needs migration 0007 before a tax line can be printed.' }
  }

  const before = await getBillSettings(company.id)
  const emailBefore = caps.emailBills ? (await getMessagingSettings(company.id)).billEmail : false

  const db = tenantClient()
  const { data: existing } = await db.from('settings').select('id').eq('company_id', company.id).maybeSingle()
  const { error } = existing
    ? await db.from('settings').update(patch).eq('company_id', company.id)
    : await db.from('settings').insert({ ...patch, company_id: company.id })
  if (error) return { ok: false, error: 'Could not save bill settings: ' + error.message }

  // What changed, in words, for the log.
  const changes: string[] = []
  const was = (v: unknown) => (v === null || v === undefined || v === '' ? '(none)' : String(v))
  const compare: [string, unknown, unknown][] = [
    ['template', BILL_TEMPLATE_LABELS[before.template], BILL_TEMPLATE_LABELS[patch.bill_template as keyof typeof BILL_TEMPLATE_LABELS]],
    ['registered address', before.registeredAddress, patch.registered_address],
    ['tax ID', before.taxId, patch.company_tax_id],
    ['tax registration', before.taxRegistrationNumber, patch.tax_registration_number],
    ['registered for tax', before.taxRegistered ? 'yes' : 'no', registered ? 'yes' : 'no'],
    ['tax label', before.taxLabelOverride, patch.tax_label],
    ['bank details', before.bankDetails, patch.bank_details],
  ]
  if ('invoice_prefix' in patch) compare.push(['invoice prefix', before.invoicePrefix, patch.invoice_prefix])
  if ('tax_rate' in patch) compare.push(['tax rate', before.taxRate, patch.tax_rate])
  if ('notify_bill_enabled' in patch) {
    compare.push(['email bills', emailBefore ? 'on' : 'off', patch.notify_bill_enabled ? 'on' : 'off'])
  }
  for (const [label, a, b] of compare) {
    if (was(a) !== was(b)) changes.push(label + ' ' + was(a) + ' -> ' + was(b))
  }
  if (changes.length) {
    await logEvent({
      type: 'bill_settings_changed',
      details: 'Bill settings: ' + changes.join('; ').replace(/\n/g, ' / '),
      tag: '[bills]',
    })
  }

  revalidatePath('/dashboard/settings/bill-design')
  return { ok: true, message: 'Bill design saved. Every bill from now on uses it.' }
}
