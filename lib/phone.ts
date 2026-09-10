/**
 * The one definition of what a customer's phone number is and whether we can
 * text it.
 *
 * There is no second copy. Before this, nothing in the app normalised a phone
 * number at all — the importer trimmed the string and stored it, and every
 * reader took it as it came. That was survivable while phone numbers were only
 * ever read by a human. It stops being survivable the moment a dispatcher
 * decides, unattended, whether to send a customer a message.
 *
 * MEASURED, NOT ASSUMED. Every rule below comes from the 4,939 customer rows
 * that were actually in the database when it was written:
 *
 *   sendable as stored        4,078
 *   two numbers in one field     29   "1876-312-4918/748-3967"
 *   country-code stub           413   "876", "1876", "18765"
 *   blank                       125
 *   plausible non-Jamaican      264   "1516-850-9506", "1718-496-7579"
 *   too short / junk             30   "12345678", "55555555", "989595995"
 *
 * The 413 stubs, 125 blanks and 30 junk values are the ISPs' own data to fix.
 * This module's job is not to repair them — it is to be certain about which
 * bucket a row is in, so the send screen can name them by count and the owner
 * can see what their data is costing them.
 */

/** Jamaica: +1 876 and the +1 658 overlay. */
const JM_AREA = /^(876|658)\d{7}$/
const JM_AREA_E164 = /^1(876|658)\d{7}$/

/**
 * Anything that is plausibly a dialable number once we stop assuming Jamaica.
 * North American Numbering Plan shape: 10 digits, or 11 with a leading 1, where
 * the area code and exchange both start 2-9.
 */
const NANP = /^1?[2-9]\d{2}[2-9]\d{6}$/

/**
 * An international number that is not NANP. NARROW ON PURPOSE.
 *
 * 11-15 digits (the E.164 ceiling) starting 2-9. The leading digit is the whole
 * of the trick: every genuinely broken Jamaican number in this database starts
 * with a 1 — "1876-417-993" is a digit short, "187699999999" and "1876555555"
 * are placeholders someone typed to get past a required field — while the only
 * real overseas numbers that NANP misses are three UK mobiles beginning 44.
 *
 * A looser rule (anything 11-15 digits) would reclassify 83 broken Jamaican
 * numbers as "overseas", which reads to an owner as "nothing to fix here" and
 * quietly buries the data problem this module exists to surface. Three rows are
 * not worth that.
 *
 * A leading 0 is a national trunk prefix and cannot be resolved without knowing
 * the country it was dialled in, so those stay junk.
 */
const INTERNATIONAL = /^[2-9]\d{10,14}$/

/**
 * What separates two numbers crammed into one field.
 *
 * `\.{2,}` and not `\.`: "876.123.4567" is one number written with dots, while
 * "1876-495-1742....5600998" is two numbers with an ellipsis between them.
 */
const SPLITTERS = /[/,;|]+|\.{2,}|\s{2,}|\band\b|&/i

export type PhoneClass =
  /** Empty, or no digits at all. */
  | 'blank'
  /** A country code and nothing else: "876", "1876", "18765". */
  | 'stub'
  /** Digits, but not a number anyone could dial. */
  | 'junk'
  /** A Jamaican mobile or landline. Sendable. */
  | 'jamaica'
  /** Dialable, but not Jamaican — an overseas relative paying the bill. */
  | 'foreign'

export type PhoneVerdict = {
  kind: PhoneClass
  /**
   * E.164 without the plus, ready for the relay: "18761234567". Null for every
   * class that cannot be dialled.
   */
  e164: string | null
  /**
   * True when the field held MORE THAN ONE candidate number, whichever one was
   * chosen, so the UI can say which it picked rather than appearing to invent a
   * number the operator cannot see in the record.
   *
   * Not "we picked a later one": a field reading "1876-312-4918/748-3967" is
   * still two numbers even though the first is the one used, and an operator
   * about to text 400 people deserves to know that field was ambiguous.
   */
  recovered: boolean
}

const digits = (s: string) => s.replace(/\D/g, '')

/**
 * Classifies one candidate that has already been split out of a field.
 *
 * NOT EXPORTED — a caller that skipped the splitting would quietly lose the 29
 * customers whose number shares a field with a second one.
 */
function classifyOne(raw: string): { kind: PhoneClass; e164: string | null } {
  const d = digits(raw)

  if (!d) return { kind: 'blank', e164: null }

  // A stub is the country code, the area code, or the two run together, with
  // nothing dialable after it. Checked BEFORE the length rules because "1876"
  // is four digits and would otherwise fall into junk, where it would be
  // indistinguishable from a real typo — and the two want different wording in
  // front of an owner. A stub is a form someone tabbed past; junk is a number
  // somebody meant.
  if (/^1?(876|658)?$/.test(d) || /^1?(876|658)\d{0,3}$/.test(d)) {
    if (d.length <= 5) return { kind: 'stub', e164: null }
  }

  if (JM_AREA.test(d)) return { kind: 'jamaica', e164: '1' + d }
  if (JM_AREA_E164.test(d)) return { kind: 'jamaica', e164: d }

  if (NANP.test(d)) {
    return { kind: 'foreign', e164: d.length === 11 ? d : '1' + d }
  }
  if (INTERNATIONAL.test(d)) return { kind: 'foreign', e164: d }

  return { kind: 'junk', e164: null }
}

/**
 * What this phone field actually is.
 *
 * Splits first, because 29 customers carry two numbers in one field and the
 * first of them is a perfectly good mobile. Prefers a Jamaican number over a
 * foreign one when a field holds both — the local number is the one the ISP
 * deals with.
 */
export function classifyPhone(value: string | null | undefined): PhoneVerdict {
  const raw = String(value ?? '').trim()
  if (!digits(raw)) return { kind: 'blank', e164: null, recovered: false }

  const parts = raw.split(SPLITTERS).map((p) => p.trim()).filter((p) => digits(p))
  const multi = parts.length > 1

  const verdicts = parts.map(classifyOne)

  const jm = verdicts.find((v) => v.kind === 'jamaica')
  if (jm) return { ...jm, recovered: multi }

  const fo = verdicts.find((v) => v.kind === 'foreign')
  if (fo) return { ...fo, recovered: multi }

  // Nothing dialable. Report the FIRST verdict rather than the worst, so a
  // field reading "876" is called a stub and not downgraded to junk by a
  // second fragment after the slash.
  return { ...verdicts[0], recovered: false }
}

/**
 * The number to hand the relay, or null.
 *
 * `allowForeign` is the per-company toggle. It defaults to false because
 * texting an overseas number from a consumer SIM is charged at international
 * rates, and that is not a cost to opt a tenant into on their behalf.
 */
export function sendablePhone(
  value: string | null | undefined,
  opts: { allowForeign?: boolean } = {}
): string | null {
  const v = classifyPhone(value)
  if (v.kind === 'jamaica') return v.e164
  if (v.kind === 'foreign' && opts.allowForeign) return v.e164
  return null
}

/** Why a customer is being skipped, in words an owner can act on. */
export const PHONE_SKIP_REASON: Record<Exclude<PhoneClass, 'jamaica'>, string> = {
  blank: 'No phone number on file',
  stub: 'Phone number is only a country code',
  junk: 'Phone number is not a valid number',
  foreign: 'Overseas number — enable overseas sending to include these',
}

/**
 * Groups a set of customers into who can be reached and who cannot, with the
 * counts the send screen has to show before anyone confirms a batch.
 */
export function summarisePhones<T extends { phone?: string | null }>(
  rows: T[],
  opts: { allowForeign?: boolean } = {}
): {
  sendable: { row: T; e164: string; recovered: boolean }[]
  skipped: { row: T; kind: Exclude<PhoneClass, 'jamaica'>; reason: string }[]
  counts: Record<PhoneClass, number>
} {
  const sendable: { row: T; e164: string; recovered: boolean }[] = []
  const skipped: { row: T; kind: Exclude<PhoneClass, 'jamaica'>; reason: string }[] = []
  const counts: Record<PhoneClass, number> = {
    blank: 0, stub: 0, junk: 0, jamaica: 0, foreign: 0,
  }

  for (const row of rows) {
    const v = classifyPhone(row.phone)
    counts[v.kind] += 1

    const usable = v.kind === 'jamaica' || (v.kind === 'foreign' && opts.allowForeign)
    if (usable && v.e164) {
      sendable.push({ row, e164: v.e164, recovered: v.recovered })
    } else {
      const kind = v.kind as Exclude<PhoneClass, 'jamaica'>
      skipped.push({ row, kind, reason: PHONE_SKIP_REASON[kind] })
    }
  }

  return { sendable, skipped, counts }
}
