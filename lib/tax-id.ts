/**
 * What a company calls its tax identifier, and nothing else.
 *
 * CLIENT-SAFE: the settings form, the customer form and the customer record all
 * need the label, and all three are client components.
 *
 * THE COLUMN IS NAMELESS ON PURPOSE. In Jamaica this number is the TRN; in the
 * US it is an EIN for a business and an SSN for a person; elsewhere a BIR
 * number or a TIN. A column called `trn` would be wrong in every market but
 * one, so `customers.tax_id` stores the value and this module supplies the word
 * — see supabase/migrations/0019_tax_id.sql.
 */

/** Longest value the field accepts. Matches customers.tax_id VARCHAR(40). */
export const TAX_ID_MAX = 40

/** Fallback when the company has not said which country it is in. */
export const DEFAULT_TAX_ID_LABEL = 'Tax ID'

/**
 * The countries this platform has actually been pointed at, and what the number
 * is called in each.
 *
 * DELIBERATELY SHORT. This is not an attempt at a world list — an unfamiliar
 * country falls back to "Tax ID", which is correct and understood everywhere,
 * rather than to a guess. Adding a market means adding a line here.
 */
export const TAX_ID_LABELS: Record<string, string> = {
  JM: 'TRN',
  US: 'Tax ID (EIN/SSN)',
  CA: 'BN',
  GB: 'UTR',
  TT: 'BIR number',
  BB: 'TIN',
  GY: 'TIN',
  KY: 'TIN',
  BS: 'TIN',
}

/** The countries offered in the settings dropdown, with their display names. */
export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'JM', name: 'Jamaica' },
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'TT', name: 'Trinidad and Tobago' },
  { code: 'BB', name: 'Barbados' },
  { code: 'GY', name: 'Guyana' },
  { code: 'KY', name: 'Cayman Islands' },
  { code: 'BS', name: 'Bahamas' },
]

/**
 * What to call the field, in the order the migration specifies and no other:
 *
 *   1. the company's own override, when set
 *   2. the label for its country, when the country is set and known
 *   3. "Tax ID"
 *
 * There is deliberately no fourth step. A label guessed from anything else —
 * the currency, the timezone — would be a guess presented as a fact.
 */
export function taxIdLabel(
  override: string | null | undefined,
  country: string | null | undefined
): string {
  const chosen = (override ?? '').trim()
  if (chosen) return chosen

  const code = (country ?? '').trim().toUpperCase()
  return TAX_ID_LABELS[code] ?? DEFAULT_TAX_ID_LABEL
}

/**
 * Whether a value is acceptable for this company.
 *
 * ACCEPTS ANYTHING UNLESS THE COUNTRY IS KNOWN, which is the whole rule. A
 * company that has not stated its country gets no format enforced, for good —
 * rejecting a legitimate number because the app assumed the wrong country is a
 * worse failure than storing an odd-looking one.
 *
 * Even with a country set this only checks LENGTH and characters, not a
 * checksum: a TRN check digit or an EIN prefix range is the revenue authority's
 * business, and getting it subtly wrong would block real customers.
 */
export function taxIdError(
  value: string,
  country: string | null | undefined
): string | null {
  const v = value.trim()
  if (!v) return null
  if (v.length > TAX_ID_MAX) return 'Keep it under ' + TAX_ID_MAX + ' characters.'

  const code = (country ?? '').trim().toUpperCase()
  if (!code) return null

  // Digits and separators only, for the countries whose number is numeric.
  // Anything else is left alone.
  const NUMERIC = new Set(['JM', 'US', 'TT', 'BB', 'GY', 'KY', 'BS'])
  if (NUMERIC.has(code) && !/^[\d\s-]+$/.test(v)) {
    return 'Enter digits only, with or without dashes.'
  }
  return null
}
