import { hexToRgb, isStoredLogoShape, readPngHeader, type Brand } from '@/lib/brand'
import { pdfString } from '@/lib/receipt-pdf'

/**
 * The A4 letterhead, and the small PDF writer it sits on.
 *
 * Written by hand for the reason lib/receipt-pdf.ts gives: there is no PDF
 * library in this project, and a page of base-14 text with one image does not
 * justify one. The 80mm receipt stays as it is and does NOT get a letterhead —
 * a colour logo on a one-colour thermal head is noise. This is for full-page
 * documents; bills are the first.
 *
 * THE SAME FILE THE EMAIL EMBEDS. The logo drawn here is `brand.logo.png`, the
 * one derivative lib/logo.ts stored — not a print rendition. Its compressed
 * scanlines go into the PDF AS THEY ARE: a PNG's IDAT data is a zlib stream of
 * PNG-filtered rows, and that is exactly what PDF's FlateDecode with
 * /Predictor 15 reads. No decoding, no re-encoding, no image library. It only
 * works for an 8-bit image with no alpha and no interlacing, which is why the
 * derivative is that shape and why isStoredLogoShape() is checked again here:
 * anything else draws the wordmark rather than a corrupt page.
 *
 * NO LOGO is the company's name in Helvetica-Bold in its colour — the same
 * decision, from the same `Brand`, that the email header makes.
 *
 * Checked by scripts/verify-branding.mjs, which writes sample pages and reads
 * the embedded image back out of them. It is also live now, not waiting on
 * bills: the Branding card's "sample letterhead" link serves
 * letterheadSamplePdf().
 */

/** A4 in PostScript points. */
export const A4 = { width: 595.28, height: 841.89 }
export const PAGE_MARGIN = 48

/** The logo is drawn inside this box, in points. */
const LOGO_BOX_WIDTH = 170
const LOGO_BOX_HEIGHT = 56
/** Never stretched below 150 dpi: a small logo is drawn small, not blurred. */
const MAX_POINTS_PER_PIXEL = 72 / 150

const WORDMARK_SIZE = 20
const WORDMARK_MIN_SIZE = 11
const CONTACT_SIZE = 9
const CONTACT_LEADING = 12.5
const RULE_THICKNESS = 2.5

const MUTED: [number, number, number] = [107, 114, 128]
const TEXT: [number, number, number] = [31, 41, 51]

/**
 * Advance widths for ASCII 32-126, in 1/1000 em, from the Adobe core-14 AFM
 * files. Needed because the contact block is right-aligned, and a base-14 font
 * is not embedded, so there is nothing else to measure.
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]

export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA
  let units = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    // Outside ASCII there is no table here; a digit's width is a fair guess
    // for an accented letter and errs wide, which keeps text inside the margin.
    units += code >= 32 && code <= 126 ? table[code - 32] : (bold ? 611 : 556)
  }
  return (units / 1000) * size
}

/** Characters WinAnsi cannot encode become '?', before they reach pdfString. */
function winAnsi(text: string): string {
  let out = ''
  for (const ch of text) out += ch.charCodeAt(0) <= 255 && ch.length === 1 ? ch : '?'
  return out
}

const num = (n: number) => n.toFixed(2)
const fill = ([r, g, b]: [number, number, number]) =>
  (r / 255).toFixed(3) + ' ' + (g / 255).toFixed(3) + ' ' + (b / 255).toFixed(3) + ' rg'

/** One run of text. `font` is F1 (Helvetica) or F2 (Helvetica-Bold). */
export function textOp(
  text: string, x: number, y: number, size: number,
  opts: { bold?: boolean; colour?: [number, number, number] } = {}
): string {
  return (
    'BT /' + (opts.bold ? 'F2' : 'F1') + ' ' + num(size) + ' Tf ' + fill(opts.colour ?? TEXT) +
    ' 1 0 0 1 ' + num(x) + ' ' + num(y) + ' Tm (' + pdfString(winAnsi(text)) + ') Tj ET'
  )
}

/** Breaks text into lines no wider than `maxWidth`. A single over-long word is left whole. */
export function wrapText(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ').filter(Boolean)) {
    const next = line ? line + ' ' + word : word
    if (line && textWidth(next, size, bold) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * The wordmark's size and lines for the room beside the contact block.
 *
 * FOUND BY THE SAMPLE PAGE. The first version only shrank the type, and a
 * 74-character company name at the 11pt floor still ran under the address.
 * So: one line at full size if it fits; otherwise the largest size at which
 * it fits on two; and at the floor, two lines with the second cut short — a
 * truncated name is a blemish, text printed over text is a defect.
 */
function fitWordmark(name: string, room: number): { size: number; lines: string[] } {
  if (textWidth(name, WORDMARK_SIZE, true) <= room) return { size: WORDMARK_SIZE, lines: [name] }

  for (let size = WORDMARK_SIZE - 2; size >= WORDMARK_MIN_SIZE; size -= 1) {
    const lines = wrapText(name, size, true, room)
    if (lines.length <= 2 && lines.every((l) => textWidth(l, size, true) <= room)) return { size, lines }
  }

  const size = WORDMARK_MIN_SIZE
  const lines = wrapText(name, size, true, room).slice(0, 2)
  let last = lines[lines.length - 1]
  while (last.length > 1 && textWidth(last + '...', size, true) > room) last = last.slice(0, -1)
  lines[lines.length - 1] = last.trimEnd() + '...'
  if (textWidth(lines[0], size, true) > room) {
    let first = lines[0]
    while (first.length > 1 && textWidth(first + '...', size, true) > room) first = first.slice(0, -1)
    return { size, lines: [first.trimEnd() + '...'] }
  }
  return { size, lines }
}

export type PdfImage = {
  width: number
  height: number
  /** 1 for grey, 3 for RGB. */
  colours: 1 | 3
  /** The PNG's IDAT data, concatenated: zlib-compressed, PNG-filtered rows. */
  data: Uint8Array
}

/**
 * A stored logo as a PDF image, or null if these bytes cannot be passed
 * through. Walks the chunks (length, type, data, crc) and joins every IDAT.
 */
export function pngToPdfImage(png: Uint8Array): PdfImage | null {
  const header = readPngHeader(png)
  if (!isStoredLogoShape(header)) return null

  const parts: Uint8Array[] = []
  let total = 0
  let offset = 8
  while (offset + 12 <= png.length) {
    const length =
      ((png[offset] << 24) | (png[offset + 1] << 16) | (png[offset + 2] << 8) | png[offset + 3]) >>> 0
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7])
    const start = offset + 8
    if (start + length > png.length) return null
    if (type === 'IDAT') {
      parts.push(png.subarray(start, start + length))
      total += length
    }
    if (type === 'IEND') break
    offset = start + length + 4
  }
  if (total === 0) return null

  const data = new Uint8Array(total)
  let at = 0
  for (const p of parts) { data.set(p, at); at += p.length }

  return { width: header.width, height: header.height, colours: header.colourType === 0 ? 1 : 3, data }
}

export type Letterhead = {
  /** Content-stream operators that draw it. */
  ops: string
  /** The logo, to be registered as /Im1. Null when the wordmark was drawn. */
  image: PdfImage | null
  /** The y coordinate the document's own content may start from. */
  bodyTop: number
}

/**
 * Draws the letterhead at the top of a page: logo or wordmark on the left,
 * the company's contact lines right-aligned, the colour as a rule beneath.
 */
export function letterhead(
  brand: Brand,
  page: { width: number; height: number } = A4
): Letterhead {
  const left = PAGE_MARGIN
  const right = page.width - PAGE_MARGIN
  const top = page.height - PAGE_MARGIN
  const ops: string[] = []

  const image = brand.logo ? pngToPdfImage(brand.logo.png) : null

  // --- right: who this is from -------------------------------------------
  // With a logo the name is restated here in words, because a mark is not
  // always legible as a name. With a wordmark it would only be said twice.
  const lines: { text: string; bold: boolean }[] = []
  if (image && brand.name) lines.push({ text: brand.name, bold: true })
  for (const l of (brand.contact.address ?? '').split(/\s*\n\s*/).filter(Boolean).slice(0, 4)) {
    lines.push({ text: l, bold: false })
  }
  if (brand.contact.phone) lines.push({ text: brand.contact.phone, bold: false })
  if (brand.contact.email) lines.push({ text: brand.contact.email, bold: false })

  let contactWidth = 0
  lines.forEach((line, i) => {
    const w = textWidth(line.text, CONTACT_SIZE, line.bold)
    contactWidth = Math.max(contactWidth, w)
    const y = top - CONTACT_SIZE - i * CONTACT_LEADING
    ops.push(textOp(line.text, right - w, y, CONTACT_SIZE, {
      bold: line.bold, colour: line.bold ? TEXT : MUTED,
    }))
  })
  const contactHeight = lines.length ? CONTACT_SIZE + (lines.length - 1) * CONTACT_LEADING : 0

  // --- left: the logo, or the name ---------------------------------------
  let markHeight: number
  if (image) {
    const scale = Math.min(
      LOGO_BOX_WIDTH / image.width, LOGO_BOX_HEIGHT / image.height, MAX_POINTS_PER_PIXEL
    )
    const w = image.width * scale
    const h = image.height * scale
    // An image is a unit square scaled and placed by the matrix before it.
    ops.push('q ' + num(w) + ' 0 0 ' + num(h) + ' ' + num(left) + ' ' + num(top - h) + ' cm /Im1 Do Q')
    markHeight = h
  } else {
    const room = right - left - (contactWidth ? contactWidth + 28 : 0)
    const { size, lines: nameLines } = fitWordmark(brand.name, room)
    const leading = size * 1.2
    // 0.72 of the size is Helvetica's cap height: the capitals' tops meet the
    // top margin, level with the first contact line.
    nameLines.forEach((line, i) => {
      ops.push(textOp(line, left, top - size * 0.72 - i * leading, size, {
        bold: true, colour: hexToRgb(brand.palette.ink),
      }))
    })
    markHeight = size * 0.72 + (nameLines.length - 1) * leading
  }

  // --- the rule ----------------------------------------------------------
  const ruleTop = top - Math.max(markHeight, contactHeight) - 14
  ops.push(
    fill(hexToRgb(brand.palette.accent)) + ' ' +
    num(left) + ' ' + num(ruleTop - RULE_THICKNESS) + ' ' + num(right - left) + ' ' + num(RULE_THICKNESS) + ' re f'
  )

  return { ops: ops.join('\n'), image, bodyTop: ruleTop - RULE_THICKNESS - 28 }
}

/**
 * Assembles a one-page PDF. Fonts F1 (Helvetica) and F2 (Helvetica-Bold) are
 * always available; `image`, if given, is /Im1.
 *
 * BYTES, NOT A STRING. lib/receipt-pdf.ts builds its file as a string because
 * everything in it is text; an image stream is binary, so offsets here are
 * counted over the byte chunks themselves.
 */
export function buildPdf(opts: {
  width: number
  height: number
  content: string
  image: PdfImage | null
}): Uint8Array {
  const latin1 = (s: string) => {
    const b = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
    return b
  }

  const content = latin1(opts.content + '\n')
  const resources =
    '/Font << /F1 5 0 R /F2 6 0 R >>' + (opts.image ? ' /XObject << /Im1 7 0 R >>' : '')

  const objects: Uint8Array[][] = [
    [latin1('<< /Type /Catalog /Pages 2 0 R >>')],
    [latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [latin1(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(opts.width) + ' ' + num(opts.height) + '] ' +
      '/Resources << ' + resources + ' >> /Contents 4 0 R >>'
    )],
    [latin1('<< /Length ' + content.length + ' >>\nstream\n'), content, latin1('endstream')],
    [latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')],
    [latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')],
  ]

  if (opts.image) {
    const im = opts.image
    objects.push([
      latin1(
        '<< /Type /XObject /Subtype /Image /Width ' + im.width + ' /Height ' + im.height +
        ' /ColorSpace /' + (im.colours === 1 ? 'DeviceGray' : 'DeviceRGB') +
        ' /BitsPerComponent 8 /Filter /FlateDecode' +
        ' /DecodeParms << /Predictor 15 /Colors ' + im.colours + ' /BitsPerComponent 8 /Columns ' + im.width + ' >>' +
        ' /Length ' + im.data.length + ' >>\nstream\n'
      ),
      im.data,
      latin1('\nendstream'),
    ])
  }

  const chunks: Uint8Array[] = []
  let size = 0
  const push = (b: Uint8Array) => { chunks.push(b); size += b.length }

  // The second line is four high bytes: the convention that tells a transfer
  // tool this file is binary, which with an image in it, it is.
  push(latin1('%PDF-1.4\n%âãÏÓ\n'))

  const offsets: number[] = []
  objects.forEach((parts, i) => {
    offsets.push(size)
    push(latin1((i + 1) + ' 0 obj\n'))
    for (const p of parts) push(p)
    push(latin1('\nendobj\n'))
  })

  const xrefOffset = size
  let tail = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
  for (const o of offsets) tail += String(o).padStart(10, '0') + ' 00000 n \n'
  tail += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n'
  push(latin1(tail))

  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

/**
 * A page with the letterhead and enough under it to judge the spacing.
 *
 * Served by /api/company/letterhead so a company admin can see their logo on
 * paper the moment they upload it, and written by scripts/verify-branding.mjs.
 */
export function letterheadSamplePdf(brand: Brand): Uint8Array {
  const head = letterhead(brand, A4)
  const ops = [head.ops]
  let y = head.bodyTop

  ops.push(textOp('Letterhead sample', PAGE_MARGIN, y, 16, { bold: true }))
  y -= 26
  for (const line of [
    'This is how full-page documents from ' + (brand.name || 'your company') + ' are headed.',
    'Bills and statements start here, below the rule.',
    '',
    'The logo is the one uploaded under Settings, the same file that heads your emails.',
    'The rule is your brand colour. With no logo, your company name is set in its place.',
  ]) {
    for (const part of line ? wrapText(line, 10.5, false, A4.width - PAGE_MARGIN * 2) : ['']) {
      if (part) ops.push(textOp(part, PAGE_MARGIN, y, 10.5, { colour: MUTED }))
      y -= 16
    }
  }

  return buildPdf({ width: A4.width, height: A4.height, content: ops.join('\n'), image: head.image })
}

export function letterheadSampleFilename(): string {
  return 'letterhead-sample.pdf'
}
