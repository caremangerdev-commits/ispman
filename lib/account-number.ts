/**
 * How an account number is spelled.
 *
 * CLIENT-SAFE: the customer list, the record and the importer preview all show
 * these. Allocation — deciding WHICH number — is a server concern and lives in
 * lib/data/account-numbers.ts.
 *
 * See supabase/migrations/0020_account_numbers.sql for why the rendered string
 * is what gets stored rather than the counter behind it.
 */

/** Digits in the counted part: 999,999 accounts before the format changes. */
export const ACCOUNT_PAD = 6

/** Matches customers.account_number VARCHAR(32). */
export const ACCOUNT_NUMBER_MAX = 32

/** Longest prefix a company may set. Matches settings.account_number_prefix. */
export const ACCOUNT_PREFIX_MAX = 8

/**
 * Renders one account number.
 *
 * The prefix is joined with a dash because a number read aloud needs an audible
 * break — "E Z M dash zero zero zero one two three" — and because it keeps the
 * counted part findable by a plain substring search.
 */
export function formatAccountNumber(
  sequence: number,
  prefix: string | null | undefined
): string {
  const digits = String(Math.max(1, Math.floor(sequence))).padStart(ACCOUNT_PAD, '0')
  const p = (prefix ?? '').trim()
  return p ? p + '-' + digits : digits
}

/**
 * A prefix an operator typed, reduced to what may be stored.
 *
 * Uppercased and stripped to letters and digits: a prefix is read out over a
 * phone, and a lowercase letter or a stray space is a difference nobody can
 * hear. Returns null for an empty result, which is the "no prefix" case and
 * what most companies will have.
 */
export function normalisePrefix(raw: string | null | undefined): string | null {
  const p = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ACCOUNT_PREFIX_MAX)
  return p || null
}

/**
 * Whether a value supplied on import is usable as an account number.
 *
 * DELIBERATELY PERMISSIVE ABOUT SHAPE. A company migrating in brings the
 * numbers its customers already know, and those may be "A-4471" or "OLD/22/3".
 * Refusing them would force every one of that company's customers to learn a
 * new number, which is the opposite of why the import exists. Only length and
 * emptiness are checked here; uniqueness is the database's job.
 */
export function accountNumberError(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  if (v.length > ACCOUNT_NUMBER_MAX) {
    return 'Account number must be ' + ACCOUNT_NUMBER_MAX + ' characters or fewer.'
  }
  return null
}
