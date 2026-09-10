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

/**
 * The counter's base. The first customer of a company gets BASE + 1 = 10001.
 *
 * NOT ZERO-PADDED, AND THAT IS THE POINT. An account number of "000001" reads
 * as a placeholder — the thing a form shows before anyone has filled it in —
 * and a customer reading it back over a phone has to say "zero zero zero zero
 * zero one". Starting the count at 10001 makes every number five real digits
 * with no leading zero, so it looks issued rather than defaulted.
 *
 * Five digits carry a company to 89,999 customers before a sixth appears, and
 * a sixth digit is a longer number rather than a broken one.
 */
export const ACCOUNT_SEQ_BASE = 10000

/** Matches customers.account_number VARCHAR(32). */
export const ACCOUNT_NUMBER_MAX = 32

/**
 * Prefix length. Two or three letters, or none.
 *
 * Letters only — a prefix is read aloud, and a digit in it cannot be told from
 * the counted part by ear. One letter is too little to identify a company and
 * is treated as no prefix rather than kept.
 */
export const ACCOUNT_PREFIX_MIN = 2
export const ACCOUNT_PREFIX_MAX = 3

/**
 * Renders one account number.
 *
 * The prefix is joined with a dash because a number read aloud needs an
 * audible break — "E Z dash one oh oh oh one" — and because it keeps the
 * counted part findable by a plain substring search.
 */
export function formatAccountNumber(
  sequence: number,
  prefix: string | null | undefined
): string {
  // No padding: the sequence starts above 10000, so it is already five digits
  // and stays that way. Padding here would only ever add zeros to a number
  // that had grown past five digits, which is exactly backwards.
  const digits = String(Math.max(ACCOUNT_SEQ_BASE + 1, Math.floor(sequence)))
  const p = normalisePrefix(prefix)
  return p ? p + '-' + digits : digits
}

/**
 * A prefix an operator typed, reduced to what may be stored.
 *
 * Uppercased and stripped to letters: a prefix is read out over a phone, and a
 * lowercase letter or a stray space is a difference nobody can hear. Fewer than
 * two letters is not a prefix and returns null, which is the "no prefix" case
 * and what every company has today.
 */
export function normalisePrefix(raw: string | null | undefined): string | null {
  const p = (raw ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, ACCOUNT_PREFIX_MAX)
  return p.length >= ACCOUNT_PREFIX_MIN ? p : null
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
