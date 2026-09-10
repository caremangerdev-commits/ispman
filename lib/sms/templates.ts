/**
 * The one definition of what an SMS template may say and how it is filled in.
 *
 * Shared by the settings page (which edits templates), the dispatcher (which
 * renders automated messages) and the messaging page (which offers a template
 * as a starting point and previews the result). A second copy of the
 * placeholder list would mean the settings page advertising a placeholder the
 * dispatcher does not substitute, which reaches a customer as the literal text
 * "{{balance}}" — see lib/log-detail.ts for what happened the last time two
 * readers of one format disagreed.
 */

export type SmsKind =
  | 'payment_receipt'
  | 'expiry_warning'
  | 'disconnection_notice'
  | 'bulk'

/** The three automated types, in the order they appear on the settings page. */
export const AUTOMATED_KINDS = [
  'payment_receipt', 'expiry_warning', 'disconnection_notice',
] as const

export const KIND_LABELS: Record<SmsKind, string> = {
  payment_receipt: 'Payment receipt',
  expiry_warning: 'Expiry warning',
  disconnection_notice: 'Disconnection notice',
  bulk: 'Message',
}

export const KIND_DESCRIPTIONS: Record<Exclude<SmsKind, 'bulk'>, string> = {
  payment_receipt: 'Sent when a payment is recorded for the customer.',
  expiry_warning: 'Sent the configured number of days before their cut-off.',
  disconnection_notice: 'Sent when a customer is disconnected for non-payment.',
}

/**
 * Everything a template may refer to.
 *
 * KEPT SMALL DELIBERATELY. Every placeholder here has to be resolvable for
 * every customer in a 400-row bulk send without a second query per row, so
 * anything needing a join does not belong. `{{balance}}` and `{{expiry}}` are
 * already on the customer row the list reads.
 */
export const PLACEHOLDERS = {
  '{{name}}': 'Customer full name',
  '{{first_name}}': 'First name only',
  '{{account}}': 'Account number',
  '{{amount}}': 'Amount paid — payment receipt only',
  '{{balance}}': 'Balance owing',
  '{{expiry}}': 'Expiry date',
  '{{days}}': 'Days until expiry — expiry warning only',
  '{{company}}': 'Your company name',
} as const

export type PlaceholderValues = Partial<Record<keyof typeof PLACEHOLDERS, string>>

/**
 * The built-in templates, used when a company has not written its own.
 *
 * NULL IN THE DATABASE MEANS "USE THESE", not "send nothing" — a company that
 * has never opened the settings page still gets a sensible message the day they
 * switch a type on. Deliberately short: each of these is one 160-character GSM
 * segment with the longest realistic substitutions, which is one message's
 * worth of credit rather than two.
 */
export const DEFAULT_TEMPLATES: Record<Exclude<SmsKind, 'bulk'>, string> = {
  payment_receipt:
    'Hi {{first_name}}, we received your payment of {{amount}}. ' +
    'Your balance is {{balance}}. Thank you. - {{company}}',
  expiry_warning:
    'Hi {{first_name}}, your internet service expires in {{days}} day(s) on ' +
    '{{expiry}}. Please pay {{balance}} to stay connected. - {{company}}',
  disconnection_notice:
    'Hi {{first_name}}, your internet service has been disconnected for ' +
    'non-payment. Please pay {{balance}} to be reconnected. - {{company}}',
}

/**
 * Substitutes placeholders into a template.
 *
 * AN UNKNOWN PLACEHOLDER IS LEFT ALONE, not blanked. If someone types
 * `{{blance}}` the customer receiving "your balance is {{blance}}" is how the
 * typo gets noticed; silently deleting it produces "your balance is " and looks
 * like a bug in the app rather than in the template.
 *
 * A KNOWN placeholder with no value for this customer becomes empty, because
 * `{{amount}}` genuinely has no value outside a payment receipt.
 */
export function renderTemplate(template: string, values: PlaceholderValues): string {
  return template.replace(/\{\{[a-z_]+\}\}/gi, (token) => {
    const key = token.toLowerCase() as keyof typeof PLACEHOLDERS
    if (!(key in PLACEHOLDERS)) return token
    return values[key] ?? ''
  })
}

/** Placeholders in `text` that this app does not know how to fill. */
export function unknownPlaceholders(text: string): string[] {
  const found = text.match(/\{\{[a-z_]+\}\}/gi) ?? []
  return [...new Set(
    found.filter((t) => !(t.toLowerCase() in PLACEHOLDERS))
  )]
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/**
 * The GSM 03.38 basic alphabet. A message using only these is packed 7 bits to
 * a character and fits 160 per segment; ONE character outside it forces the
 * whole message to UCS-2 and the limit drops to 70.
 *
 * That cliff is why this is worth counting in the UI rather than leaving to the
 * carrier. A curly apostrophe pasted in from Word — ’ rather than ' — turns a
 * one-segment message into a three-segment one and triples what the tenant pays
 * for a 400-recipient send, with nothing on screen to explain why.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'

/** Characters that are GSM but cost two septets each. */
const GSM_EXTENDED = '^{}\\[~]|€'

export type SegmentInfo = {
  encoding: 'GSM' | 'UCS2'
  characters: number
  segments: number
  /** Characters still available before another segment is started. */
  remaining: number
}

export function countSegments(text: string): SegmentInfo {
  const isGsm = [...text].every(
    (ch) => GSM_BASIC.includes(ch) || GSM_EXTENDED.includes(ch)
  )

  if (isGsm) {
    // Extended characters occupy two positions in the 7-bit packing.
    const units = [...text].reduce(
      (n, ch) => n + (GSM_EXTENDED.includes(ch) ? 2 : 1), 0
    )
    // A concatenated message spends 7 septets per segment on the UDH that
    // reassembles it, so multi-segment GSM is 153 each and not 160.
    const per = units <= 160 ? 160 : 153
    const segments = units === 0 ? 0 : Math.ceil(units / per)
    return {
      encoding: 'GSM',
      characters: units,
      segments,
      remaining: segments === 0 ? 160 : segments * per - units,
    }
  }

  // UCS-2 counts UTF-16 code units, so an emoji outside the BMP costs two.
  const units = text.length
  const per = units <= 70 ? 70 : 67
  const segments = units === 0 ? 0 : Math.ceil(units / per)
  return {
    encoding: 'UCS2',
    characters: units,
    segments,
    remaining: segments === 0 ? 70 : segments * per - units,
  }
}

/**
 * The worst-case rendering of a template, for the settings page's length
 * warning. Substitutes the longest plausible value for each placeholder so an
 * operator is told their template is two segments BEFORE they turn it on for
 * 1,276 customers, rather than after the bill arrives.
 */
export function worstCaseLength(template: string, companyName: string): SegmentInfo {
  return countSegments(renderTemplate(template, {
    '{{name}}': 'MARGARET CHRISTOPHER-WILLIAMS',
    '{{first_name}}': 'MARGARET',
    '{{account}}': 'WCN-10999',
    '{{amount}}': 'J$12,500.00',
    '{{balance}}': 'J$12,500.00',
    '{{expiry}}': '30 September 2026',
    '{{days}}': '30',
    '{{company}}': companyName,
  }))
}
