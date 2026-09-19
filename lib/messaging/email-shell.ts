import type { Brand } from '@/lib/brand'

/**
 * THE EMAIL SHELL: one platform template, every company, every message kind.
 *
 * WHY ONE SHELL IN CODE AND NOT A TEMPLATE PER COMPANY. HTML that survives
 * Gmail, Outlook's Word engine and a phone is tables, inline styles and
 * attributes from 1999, and it breaks quietly — nobody should be editing it in
 * a settings box. And a shell per company is N shells that will differ, which
 * is the mistake AGENTS.md is written about. What a company owns is what a
 * customer can tell apart: the logo, one colour, the name and contact lines
 * (a `Brand`), and the WORDS of each message, which are the plain-text
 * templates on `settings` exactly as before.
 *
 * ONE BODY, TWO RENDERINGS. A message body is a list of blocks. renderEmailHtml
 * and renderEmailText both take the same list, so the text/plain part is never
 * a second, hand-kept copy of the HTML — it cannot say something different,
 * because it is not written separately. Today every kind gets its blocks from
 * its text template through blocksFromText(); a kind that wants more than
 * words (a bill: amount due, a pay button) builds a richer list and changes
 * nothing here.
 *
 * PURE. No database, no storage, no node imports. The Branding card's preview
 * and scripts/verify-branding.mjs render through this same function.
 *
 * THE RULES THE MARKUP FOLLOWS, so a later edit does not undo them:
 *   - layout is nested tables with role="presentation"; no div layout, no flex
 *   - every style is inline; there is no <style> block to be stripped
 *   - colours are also given as bgcolor attributes, which Outlook honours
 *     where it ignores CSS backgrounds
 *   - images carry width AND height attributes; Outlook ignores CSS sizes
 *   - 600px wide at most, fluid below that, so a phone gets no sideways scroll
 *   - the button is a coloured table cell, not a padded link: Outlook drops
 *     padding on <a>
 */

/** The Content-ID the logo is attached under. The HTML refers to it as cid:logo. */
export const LOGO_CID = 'logo'

export type EmailBlock =
  | { type: 'paragraph'; text: string }
  /** A short table of facts: Account / Amount due / Due date. */
  | { type: 'keyvalue'; rows: { label: string; value: string }[] }
  /** One figure that matters more than the rest. */
  | { type: 'callout'; label: string; value: string; note?: string }
  | { type: 'button'; label: string; url: string }

const PAGE_BG = '#f1f3f5'
const CARD_BG = '#ffffff'
const FOOTER_BG = '#f8f9fa'
const RULE = '#e9ecef'
const TEXT = '#1f2933'
const MUTED = '#6b7280'
const FONT = 'Arial, Helvetica, sans-serif'

/** The logo is drawn inside this box, in CSS pixels. */
const LOGO_BOX_WIDTH = 200
const LOGO_BOX_HEIGHT = 64

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Only http(s) and mailto ever become an href. Anything else is dropped to '#'. */
function safeUrl(url: string): string {
  const u = url.trim()
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : '#'
}

/**
 * Escaped text with bare URLs made clickable and newlines kept.
 *
 * ESCAPE FIRST, THEN LINK. The URL pattern runs over already-escaped text, so
 * nothing a template or an operator typed can close the attribute it lands in.
 */
function inlineHtml(text: string, linkColour: string): string {
  const escaped = escapeHtml(text)
  const linked = escaped.replace(/https?:\/\/[^\s<]+/g, (match) => {
    // Sentence punctuation after a URL belongs to the sentence.
    const trail = match.match(/[.,;:!?)]+$/)?.[0] ?? ''
    const url = trail ? match.slice(0, -trail.length) : match
    return '<a href="' + url + '" style="color:' + linkColour + ';text-decoration:underline;">' +
      url + '</a>' + trail
  })
  return linked.replace(/\n/g, '<br>')
}

/**
 * A plain-text body as blocks.
 *
 * Blank lines separate paragraphs. A paragraph of two or more lines that ALL
 * read "Label: value" becomes a table — which is what the built-in templates'
 * "Account: ... / Balance now: ..." lines are, and what an operator writing
 * their own will naturally produce. One such line alone stays a sentence:
 * "Note: we are closed on Monday." is not a table.
 */
export function blocksFromText(text: string): EmailBlock[] {
  const blocks: EmailBlock[] = []
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/)

  for (const raw of paragraphs) {
    const para = raw.replace(/^\n+|\n+$/g, '')
    if (!para.trim()) continue

    const lines = para.split('\n')
    const pairs = lines.map((line) => line.match(/^([A-Za-z][^:\n]{0,30}):[ \t]+(\S.*)$/))
    if (lines.length >= 2 && pairs.every(Boolean)) {
      blocks.push({
        type: 'keyvalue',
        rows: pairs.map((m) => ({ label: (m as RegExpMatchArray)[1].trim(), value: (m as RegExpMatchArray)[2].trim() })),
      })
      continue
    }
    blocks.push({ type: 'paragraph', text: para })
  }
  return blocks
}

function blockHtml(block: EmailBlock, brand: Brand): string {
  const { palette } = brand

  switch (block.type) {
    case 'paragraph':
      return (
        '<tr><td style="padding:0 0 16px 0;font-family:' + FONT + ';font-size:15px;line-height:23px;color:' + TEXT + ';">' +
        inlineHtml(block.text, palette.ink) +
        '</td></tr>'
      )

    case 'keyvalue': {
      const rows = block.rows.map((r, i) => {
        const border = i === block.rows.length - 1 ? '' : 'border-bottom:1px solid ' + RULE + ';'
        return (
          '<tr>' +
          '<td width="42%" valign="top" style="padding:10px 12px 10px 14px;' + border + 'font-family:' + FONT + ';font-size:13px;line-height:19px;color:' + MUTED + ';">' +
          escapeHtml(r.label) + '</td>' +
          '<td valign="top" style="padding:10px 14px 10px 0;' + border + 'font-family:' + FONT + ';font-size:14px;line-height:19px;color:' + TEXT + ';font-weight:bold;">' +
          inlineHtml(r.value, palette.ink) + '</td>' +
          '</tr>'
        )
      }).join('')
      return (
        '<tr><td style="padding:0 0 18px 0;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + FOOTER_BG + '" style="background-color:' + FOOTER_BG + ';border:1px solid ' + RULE + ';">' +
        rows +
        '</table></td></tr>'
      )
    }

    case 'callout':
      return (
        '<tr><td style="padding:0 0 18px 0;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
        '<tr>' +
        '<td width="4" bgcolor="' + palette.accent + '" style="background-color:' + palette.accent + ';font-size:0;line-height:0;">&nbsp;</td>' +
        '<td bgcolor="' + FOOTER_BG + '" style="background-color:' + FOOTER_BG + ';padding:14px 16px;font-family:' + FONT + ';">' +
        '<div style="font-size:12px;line-height:16px;color:' + MUTED + ';text-transform:uppercase;letter-spacing:0.5px;">' + escapeHtml(block.label) + '</div>' +
        '<div style="font-size:26px;line-height:32px;color:' + TEXT + ';font-weight:bold;padding-top:2px;">' + escapeHtml(block.value) + '</div>' +
        (block.note
          ? '<div style="font-size:13px;line-height:19px;color:' + MUTED + ';padding-top:4px;">' + escapeHtml(block.note) + '</div>'
          : '') +
        '</td>' +
        '</tr></table></td></tr>'
      )

    case 'button':
      return (
        '<tr><td style="padding:4px 0 20px 0;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td align="center" bgcolor="' + palette.accent + '" style="background-color:' + palette.accent + ';border-radius:4px;padding:12px 24px;">' +
        '<a href="' + escapeHtml(safeUrl(block.url)) + '" style="font-family:' + FONT + ';font-size:15px;line-height:20px;font-weight:bold;color:' + palette.onAccent + ';text-decoration:none;display:inline-block;">' +
        escapeHtml(block.label) + '</a>' +
        '</td></tr></table></td></tr>'
      )
  }
}

/**
 * The header: the logo, or the company's name set as a wordmark.
 *
 * THE WORDMARK IS LIVE TEXT, not a generated image, so a company with no logo
 * gets the one header that renders everywhere, including with images off. The
 * logo's alt text is styled the same way, so a client that refuses the inline
 * image shows the wordmark in its place rather than a broken-image box.
 */
function headerHtml(brand: Brand, logoSrc: string | null): string {
  const wordmarkStyle =
    'font-family:' + FONT + ';font-size:22px;line-height:28px;font-weight:bold;color:' + brand.palette.ink + ';'

  if (brand.logo && logoSrc) {
    const scale = Math.min(LOGO_BOX_WIDTH / brand.logo.width, LOGO_BOX_HEIGHT / brand.logo.height, 1)
    const w = Math.max(1, Math.round(brand.logo.width * scale))
    const h = Math.max(1, Math.round(brand.logo.height * scale))
    return (
      '<img src="' + escapeHtml(logoSrc) + '" width="' + w + '" height="' + h + '" alt="' + escapeHtml(brand.name) + '" ' +
      'style="display:block;border:0;outline:none;text-decoration:none;width:' + w + 'px;height:' + h + 'px;' + wordmarkStyle + '">'
    )
  }
  return '<span style="' + wordmarkStyle + '">' + escapeHtml(brand.name) + '</span>'
}

/** The contact lines under every message, in the order a person looks for them. */
function contactLines(brand: Brand): string[] {
  const lines: string[] = []
  if (brand.contact.address) lines.push(brand.contact.address.split(/\s*\n\s*/).filter(Boolean).join(', '))
  const reach = [brand.contact.phone, brand.contact.email].filter(Boolean).join('  |  ')
  if (reach) lines.push(reach)
  return lines
}

/** Why this arrived and how to stop it. No link: there is no public page to link to. */
function footerNote(brand: Brand): string {
  return 'You are receiving this because you are a customer of ' + brand.name +
    '. To stop these emails, reply to this message and ask.'
}

/** The grey line a mail client shows after the subject. */
function preheader(blocks: EmailBlock[]): string {
  const words = blocks
    .filter((b): b is Extract<EmailBlock, { type: 'paragraph' }> => b.type === 'paragraph')
    .map((b) => b.text.replace(/\s+/g, ' ').trim())
    .join(' ')
  return words.length > 140 ? words.slice(0, 137) + '...' : words
}

export function renderEmailHtml(opts: {
  brand: Brand
  /**
   * What the logo <img> points at: 'cid:logo' in a real message, a data URI in
   * the settings preview. Null draws the wordmark even if the brand has a logo.
   */
  logoSrc: string | null
  subject: string
  blocks: EmailBlock[]
}): string {
  const { brand, blocks } = opts
  const body = blocks.map((b) => blockHtml(b, brand)).join('')
  const footer = [brand.name, ...contactLines(brand)]

  return (
    '<!DOCTYPE html>' +
    '<html lang="en" xmlns="http://www.w3.org/1999/xhtml">' +
    '<head>' +
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    // The shell is designed light. Saying so stops Apple Mail and Outlook.com
    // from inverting it into a dark page with a white logo box in the middle.
    '<meta name="color-scheme" content="light only">' +
    '<meta name="supported-color-schemes" content="light only">' +
    '<title>' + escapeHtml(opts.subject) + '</title>' +
    '</head>' +
    '<body style="margin:0;padding:0;background-color:' + PAGE_BG + ';">' +
    '<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:' + PAGE_BG + ';">' +
    escapeHtml(preheader(blocks)) + '</div>' +

    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + PAGE_BG + '" style="background-color:' + PAGE_BG + ';">' +
    '<tr><td align="center" style="padding:24px 12px;">' +

    // Outlook ignores max-width, so it is given a fixed 600 table to sit in.
    '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + CARD_BG + '" style="max-width:600px;background-color:' + CARD_BG + ';">' +

    '<tr><td bgcolor="' + CARD_BG + '" style="padding:24px 28px 20px 28px;background-color:' + CARD_BG + ';">' +
    headerHtml(brand, opts.logoSrc) +
    '</td></tr>' +

    '<tr><td height="4" bgcolor="' + brand.palette.accent + '" style="height:4px;background-color:' + brand.palette.accent + ';font-size:0;line-height:0;">&nbsp;</td></tr>' +

    '<tr><td style="padding:28px 28px 12px 28px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + body + '</table>' +
    '</td></tr>' +

    '<tr><td bgcolor="' + FOOTER_BG + '" style="padding:18px 28px 22px 28px;background-color:' + FOOTER_BG + ';border-top:1px solid ' + RULE + ';font-family:' + FONT + ';font-size:12px;line-height:18px;color:' + MUTED + ';">' +
    footer.map((line, i) =>
      i === 0
        ? '<div style="font-weight:bold;color:' + TEXT + ';">' + escapeHtml(line) + '</div>'
        : '<div>' + escapeHtml(line) + '</div>'
    ).join('') +
    '<div style="padding-top:10px;">' + escapeHtml(footerNote(brand)) + '</div>' +
    '</td></tr>' +

    '</table>' +
    '<!--[if mso]></td></tr></table><![endif]-->' +

    '</td></tr></table>' +
    '</body></html>'
  )
}

/**
 * The text/plain part: the same blocks, as words.
 *
 * For a body that came from blocksFromText this gives the operator's own text
 * back, plus the footer. It is generated rather than stored so that the two
 * parts of one message are always the same message.
 */
export function renderEmailText(opts: { brand: Brand; blocks: EmailBlock[] }): string {
  const { brand, blocks } = opts

  const parts = blocks.map((b) => {
    switch (b.type) {
      case 'paragraph': return b.text
      case 'keyvalue': return b.rows.map((r) => r.label + ': ' + r.value).join('\n')
      case 'callout': return b.label + ': ' + b.value + (b.note ? '\n' + b.note : '')
      case 'button': return b.label + ': ' + b.url
    }
  })

  const footer = ['--', brand.name, ...contactLines(brand), '', footerNote(brand)].join('\n')
  return parts.join('\n\n') + '\n\n' + footer + '\n'
}
