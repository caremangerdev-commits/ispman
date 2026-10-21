import { isStoredLetterheadShape, isStoredLogoShape, readPngHeader } from '@/lib/brand'
import { pdfString } from '@/lib/receipt-pdf'

/**
 * The small PDF writer full-page documents are drawn with: base-14 text with
 * its metrics, line wrapping, a stored logo or letterhead as an image, and the
 * file itself. Bills (lib/bill/pdf.ts) are what draws on it.
 *
 * Written by hand for the reason lib/receipt-pdf.ts gives: there is no PDF
 * library in this project, and pages of base-14 text with an image or two do
 * not justify one. The 80mm receipt stays as it is.
 *
 * THE SAME FILE THE EMAIL EMBEDS. An image here is a PNG lib/logo.ts stored —
 * the logo, or the letterhead — not a print rendition. Its compressed
 * scanlines go into the PDF AS THEY ARE: a PNG's IDAT data is a zlib stream of
 * PNG-filtered rows, and that is exactly what PDF's FlateDecode with
 * /Predictor 15 reads. No decoding, no re-encoding, no image library. It only
 * works for an 8-bit image with no alpha and no interlacing, which is why the
 * stored files are that shape and why the shape is checked again here:
 * anything else is left out rather than drawn as a corrupt page.
 *
 * WAS lib/letterhead-pdf.ts, which also drew a generated letterhead and a
 * "letterhead sample" page for the Branding card. That was a second, older way
 * of heading a bill that had stopped looking like any of the three templates;
 * it was deleted on 2026-10-21, and the Branding card's sample is now a real
 * bill (app/api/company/bill-sample). Checked by scripts/verify-branding.mjs,
 * which draws bills and reads the embedded image back out of them.
 */

/** A4 in PostScript points. */
export const A4 = { width: 595.28, height: 841.89 }

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

/**
 * Times-Bold, the same way: ASCII 32-126 from the Adobe AFM. Used only for the
 * Statement bill's company name and document title, which the design sets in
 * a serif (lib/bill/pdf.ts).
 */
const TIMES_BOLD = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
  333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
  556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
]

/** F1 Helvetica, F2 Helvetica-Bold, F3 Times-Bold. */
export type PdfFont = 'F1' | 'F2' | 'F3'

/**
 * The typographic characters a bill uses that WinAnsi has but Latin-1 does not,
 * with their WinAnsi byte and their widths in Helvetica / Helvetica-Bold /
 * Times-Bold. The en dash is the one that matters: "5 Oct – 5 Nov".
 */
const WIN_ANSI_EXTRA: Record<string, { byte: number; w: [number, number, number] }> = {
  '–': { byte: 0x96, w: [556, 556, 500] }, // en dash
  '—': { byte: 0x97, w: [1000, 1000, 1000] }, // em dash
  '‘': { byte: 0x91, w: [222, 278, 333] },
  '’': { byte: 0x92, w: [222, 278, 333] },
  '“': { byte: 0x93, w: [333, 500, 500] },
  '”': { byte: 0x94, w: [333, 500, 500] },
  '•': { byte: 0x95, w: [350, 350, 350] }, // bullet
  '…': { byte: 0x85, w: [1000, 1000, 1000] }, // ellipsis
  '€': { byte: 0x80, w: [556, 556, 500] }, // euro
}

/** Characters with no WinAnsi byte that have a fair stand-in. */
const WIN_ANSI_STAND_IN: Record<string, string> = {
  '−': '-', // minus sign
  ' ': ' ', // thin space
  ' ': ' ', // narrow no-break space
  '›': '>', // single right angle quote
}

export function textWidth(text: string, size: number, bold: boolean | PdfFont = false): number {
  const font: PdfFont = bold === true ? 'F2' : bold === false ? 'F1' : bold
  const table = font === 'F3' ? TIMES_BOLD : font === 'F2' ? HELVETICA_BOLD : HELVETICA
  const col = font === 'F3' ? 2 : font === 'F2' ? 1 : 0
  let units = 0
  for (const raw of text) {
    const ch = WIN_ANSI_STAND_IN[raw] ?? raw
    const code = ch.charCodeAt(0)
    const extra = WIN_ANSI_EXTRA[ch]
    // Outside ASCII there is no table here; a digit's width is a fair guess
    // for an accented letter and errs wide, which keeps text inside the margin.
    units += extra
      ? extra.w[col]
      : code >= 32 && code <= 126 ? table[code - 32] : (font === 'F1' ? 556 : font === 'F2' ? 611 : 500)
  }
  return (units / 1000) * size
}

/**
 * Text as WinAnsi bytes (one char per byte), before it reaches pdfString.
 * Latin-1 passes through; the dashes and quotes above become their WinAnsi
 * bytes; anything else becomes '?'.
 */
function winAnsi(text: string): string {
  let out = ''
  for (const raw of text) {
    const ch = WIN_ANSI_STAND_IN[raw] ?? raw
    const extra = WIN_ANSI_EXTRA[ch]
    if (extra) out += String.fromCharCode(extra.byte)
    else out += ch.length === 1 && ch.charCodeAt(0) <= 255 ? ch : '?'
  }
  return out
}

const num = (n: number) => n.toFixed(2)
const fill = ([r, g, b]: [number, number, number]) =>
  (r / 255).toFixed(3) + ' ' + (g / 255).toFixed(3) + ' ' + (b / 255).toFixed(3) + ' rg'

/** One run of text: F1 (Helvetica), F2 (Helvetica-Bold), or `font` F3 (Times-Bold). */
export function textOp(
  text: string, x: number, y: number, size: number,
  opts: { bold?: boolean; font?: PdfFont; colour?: [number, number, number] } = {}
): string {
  const font = opts.font ?? (opts.bold ? 'F2' : 'F1')
  return (
    'BT /' + font + ' ' + num(size) + ' Tf ' + fill(opts.colour ?? TEXT) +
    ' 1 0 0 1 ' + num(x) + ' ' + num(y) + ' Tm (' + pdfString(winAnsi(text)) + ') Tj ET'
  )
}

/** Breaks text into lines no wider than `maxWidth`. A single over-long word is left whole. */
export function wrapText(text: string, size: number, bold: boolean | PdfFont, maxWidth: number): string[] {
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

export type PdfImage = {
  width: number
  height: number
  /** 1 for grey, 3 for RGB. */
  colours: 1 | 3
  /** The PNG's IDAT data, concatenated: zlib-compressed, PNG-filtered rows. */
  data: Uint8Array
}

/**
 * A stored logo or letterhead as a PDF image, or null if these bytes cannot be
 * passed through. Walks the chunks (length, type, data, crc) and joins every
 * IDAT. The shape is checked here as well as on upload and on load: anything
 * that is not 8-bit, opaque and non-interlaced inside the larger (letterhead)
 * box draws the generated block rather than a corrupt page.
 */
export function pngToPdfImage(png: Uint8Array): PdfImage | null {
  const header = readPngHeader(png)
  if (!isStoredLogoShape(header) && !isStoredLetterheadShape(header)) return null

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

/**
 * Assembles a PDF of one or more pages, all the same size. Fonts F1
 * (Helvetica), F2 (Helvetica-Bold) and F3 (Times-Bold) are always available;
 * `images[i]` is /Im{i+1} on every page. Bills use this: a ledger can run to a
 * second page, and a statement may carry a logo or a letterhead.
 */
export function buildPdfDocument(opts: {
  width: number
  height: number
  pages: string[]
  images: PdfImage[]
}): Uint8Array {
  const latin1 = (s: string) => {
    const b = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
    return b
  }

  const pages = opts.pages.length > 0 ? opts.pages : ['']
  // 1 catalog, 2 pages, 3-5 fonts, then the images, then a page and its
  // content stream for each page.
  const firstImage = 6
  const firstPage = firstImage + opts.images.length
  const pageObj = (i: number) => firstPage + i * 2
  const contentObj = (i: number) => firstPage + i * 2 + 1

  const xobjects = opts.images.length
    ? ' /XObject << ' + opts.images.map((_, i) => '/Im' + (i + 1) + ' ' + (firstImage + i) + ' 0 R').join(' ') + ' >>'
    : ''
  const resources = '/Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>' + xobjects

  const objects: Uint8Array[][] = [
    [latin1('<< /Type /Catalog /Pages 2 0 R >>')],
    [latin1(
      '<< /Type /Pages /Kids [' + pages.map((_, i) => pageObj(i) + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>'
    )],
    [latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')],
    [latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')],
    [latin1('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>')],
  ]

  for (const im of opts.images) {
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

  pages.forEach((page, i) => {
    const content = latin1(page + '\n')
    objects.push([latin1(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(opts.width) + ' ' + num(opts.height) + '] ' +
      '/Resources << ' + resources + ' >> /Contents ' + contentObj(i) + ' 0 R >>'
    )])
    objects.push([latin1('<< /Length ' + content.length + ' >>\nstream\n'), content, latin1('endstream')])
  })

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
