import 'server-only'

import { BILL_TEMPLATES, DEFAULT_TAX_LABEL, toBillTemplate, type BillSettings } from '@/lib/bill/settings'
import { currencySymbol } from '@/lib/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { taxIdLabel } from '@/lib/tax-id'

/**
 * What a company's bills say about it: the template, the tax line, the tax and
 * registration numbers, the invoice prefix, the currency symbol, and how to pay.
 *
 * THE ONE READER. The bill renderers, the portal's "Where to pay" card and the
 * Settings > Bill Design form are all handed what this returns, so the portal cannot
 * tell a customer one bank account while their bill prints another.
 *
 * NEVER THROWS FOR A MISSING PIECE. Before migration 0038 every company reads
 * as: Statement, no tax line, the symbol from settings.currency, no bank
 * details, no letterhead — exactly what a company that never opens Settings >
 * Bills gets afterwards.
 */
export async function getBillSettings(companyId: number): Promise<BillSettings> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  let cols = 'currency'
  if (caps.generalSettings) cols += ', tax_rate'
  if (caps.taxId) cols += ', country, tax_id_label'
  if (caps.portalNote) cols += ', portal_payment_note'
  if (caps.billDocuments) {
    cols +=
      ', bill_template, registered_address, company_tax_id, tax_registration_number, ' +
      'tax_registered, tax_label, currency_symbol, bank_details, letterhead_path'
  }
  if (caps.invoicePrefix) cols += ', invoice_prefix'

  const [settingsRes, companyRes] = await Promise.all([
    db.from('settings').select(cols).eq('company_id', companyId).maybeSingle(),
    db.from('companies').select('address').eq('id', companyId).maybeSingle(),
  ])
  if (settingsRes.error) {
    console.error('[bill-settings] settings read failed for company %d: %s', companyId, settingsRes.error.message)
  }

  const s = (settingsRes.data as unknown as {
    currency?: string | null
    tax_rate?: number | string | null
    country?: string | null
    tax_id_label?: string | null
    portal_payment_note?: string | null
    bill_template?: string | null
    registered_address?: string | null
    company_tax_id?: string | null
    tax_registration_number?: string | null
    tax_registered?: boolean | null
    tax_label?: string | null
    currency_symbol?: string | null
    bank_details?: string | null
    letterhead_path?: string | null
    invoice_prefix?: string | null
  } | null) ?? {}

  const contactAddress = ((companyRes.data as { address?: string | null } | null)?.address ?? '').trim()
  const currency = (s.currency ?? 'JMD').trim() || 'JMD'
  const rate = Number(s.tax_rate ?? 0)
  const trimmed = (v: string | null | undefined) => (v ?? '').trim() || null

  return {
    available: caps.billDocuments,
    template: toBillTemplate(s.bill_template),
    registeredAddress: trimmed(s.registered_address),
    address: trimmed(s.registered_address) ?? (contactAddress || null),
    taxId: trimmed(s.company_tax_id),
    taxIdLabel: taxIdLabel(s.tax_id_label, s.country),
    taxRegistrationNumber: trimmed(s.tax_registration_number),
    taxRegistered: Boolean(s.tax_registered),
    taxLabel: trimmed(s.tax_label) ?? DEFAULT_TAX_LABEL,
    taxLabelOverride: trimmed(s.tax_label),
    taxRate: Number.isFinite(rate) && rate > 0 ? rate : 0,
    currency,
    currencySymbol: trimmed(s.currency_symbol) ?? currencySymbol(currency),
    currencySymbolOverride: trimmed(s.currency_symbol),
    bankDetails: trimmed(s.bank_details),
    paymentNote: trimmed(s.portal_payment_note),
    letterheadPath: trimmed(s.letterhead_path),
    invoicePrefix: trimmed(s.invoice_prefix),
  }
}

export { BILL_TEMPLATES }
