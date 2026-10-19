/**
 * The bill's company settings as a type, and the words for its choices.
 *
 * CLIENT-SAFE: Settings > Bills renders the template names and help text from
 * here, and the server reads the same constants (lib/data/bill-settings.ts).
 */

export const BILL_TEMPLATES = ['statement', 'ledger', 'receipt'] as const
export type BillTemplate = (typeof BILL_TEMPLATES)[number]

export const BILL_TEMPLATE_LABELS: Record<BillTemplate, string> = {
  statement: 'Statement',
  ledger: 'Ledger',
  receipt: 'Receipt',
}

export const BILL_TEMPLATE_HELP: Record<BillTemplate, string> = {
  statement:
    'An invoice for the period: an account summary strip in your colour (previous balance, ' +
    'payments, charges, total due), the itemised charges, how to pay, and a tear-off stub ' +
    'to return with a cash or cheque payment.',
  ledger:
    'A statement of account with no boxes, only rules: every charge and payment in date order ' +
    'with a running balance, and the closing balance at the end.',
  receipt:
    'For prepaid companies. A band in your colour, then three facts: when they paid, how, and ' +
    'the date their service runs to, set largest.',
}

/** Unknown or missing reads as the default, the Statement. */
export function toBillTemplate(value: string | null | undefined): BillTemplate {
  return (BILL_TEMPLATES as readonly string[]).includes(value ?? '') ? (value as BillTemplate) : 'statement'
}

/** What the tax line is called when the company has not said. */
export const DEFAULT_TAX_LABEL = 'Tax'

export const TAX_LABEL_MAX = 24
export const CURRENCY_SYMBOL_MAX = 8
export const BANK_DETAILS_MAX = 300
export const REGISTERED_ADDRESS_MAX = 300
export const TAX_NUMBER_MAX = 40

export type BillSettings = {
  /** Migration 0038 applied. False: everything below is the fallback. */
  available: boolean
  template: BillTemplate
  /** As stored; null means "use the contact address". For the settings form. */
  registeredAddress: string | null
  /** What the bill prints: the registered address, else companies.address. */
  address: string | null
  /** The company's own tax identifier, or null. */
  taxId: string | null
  /** What the tax identifier is called: settings.tax_id_label / country (0019). */
  taxIdLabel: string
  taxRegistrationNumber: string | null
  /** Whether the bill shows a tax line at all. */
  taxRegistered: boolean
  /** The tax line's name as printed: the override, else "Tax". */
  taxLabel: string
  /** As stored; null means the default. For the settings form. */
  taxLabelOverride: string | null
  /** Percent, 0 when unset. settings.tax_rate (0007). */
  taxRate: number
  /** The ISO code, e.g. JMD. */
  currency: string
  /** What prefixes an amount: the override, else derived from the code. */
  currencySymbol: string
  /** As stored; null means derived. For the settings form. */
  currencySymbolOverride: string | null
  bankDetails: string | null
  /** settings.portal_payment_note (0036): where and how to pay in person. */
  paymentNote: string | null
  letterheadPath: string | null
}

/** Whether a tax line is printed: registered AND a rate to print. */
export function showsTax(s: Pick<BillSettings, 'taxRegistered' | 'taxRate'>): boolean {
  return s.taxRegistered && s.taxRate > 0
}

/**
 * Splits a TAX-INCLUSIVE amount into its net and its tax.
 *
 * Rates are what customers pay, so the tax is inside them: 3,500 at 15% is
 * 3,043.48 + 456.52. Rounded to the cent on the net, and the tax is whatever is
 * left, so the two always add back to the gross exactly — a bill whose lines do
 * not sum to its total is a defect, however small.
 */
export function splitTax(gross: number, ratePercent: number): { net: number; tax: number } {
  const g = Math.round(gross * 100) / 100
  if (!(ratePercent > 0)) return { net: g, tax: 0 }
  const net = Math.round((g / (1 + ratePercent / 100)) * 100) / 100
  return { net, tax: Math.round((g - net) * 100) / 100 }
}

/** "15%", "16.5%". */
export function formatRate(ratePercent: number): string {
  return (Math.round(ratePercent * 100) / 100).toString() + '%'
}
