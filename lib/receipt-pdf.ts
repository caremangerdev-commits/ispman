/**
 * An 80mm receipt as a PDF, written by hand.
 *
 * There is no PDF library in this project and this does not justify adding one.
 * A thermal receipt is a single page of monospace text, and Courier is one of
 * the PDF base-14 fonts every reader ships with — so no font has to be
 * embedded, no glyph widths have to be measured, and the whole file is a few
 * hundred bytes.
 *
 * It renders the exact lines `lib/receipt.ts#renderReceipt` produces, so the
 * downloaded PDF, the printed page and the modal on screen are the same
 * receipt.
 */

/** 80mm in PostScript points (72 per inch). */
const PAGE_WIDTH = (80 / 25.4) * 72 // 226.77

/**
 * 10pt Courier advances 6pt per character, so the 32-column receipt occupies
 * exactly 192pt and sits inside the paper with ~6mm of margin each side.
 */
const FONT_SIZE = 10
const CHAR_WIDTH = FONT_SIZE * 0.6
const LINE_HEIGHT = 12.5

const MARGIN_X = (PAGE_WIDTH - 32 * CHAR_WIDTH) / 2
const MARGIN_Y = 14

/**
 * Escapes a string for a PDF literal.
 *
 * Backslash first, or the escapes this adds get escaped in turn. Anything
 * outside WinAnsi's printable range becomes an octal escape rather than raw
 * bytes, so a company name with an accent cannot corrupt the stream.
 */
function pdfString(text: string): string {
  let out = ''
  for (const ch of text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')) {
    const code = ch.charCodeAt(0)
    out += code >= 32 && code <= 126 ? ch : '\\' + (code & 0xff).toString(8).padStart(3, '0')
  }
  return out
}

/**
 * Builds the PDF for a rendered receipt.
 *
 * The page grows with the content — `@page { size: 80mm auto }` in the print
 * stylesheet does the same thing, and a receipt should never be padded out to
 * a fixed sheet.
 */
export function receiptPdf(lines: string[]): Uint8Array {
  const pageHeight = Math.max(120, lines.length * LINE_HEIGHT + MARGIN_Y * 2)

  // Text runs top-down; PDF's origin is bottom-left, so the first line sits a
  // full line-height below the top edge.
  const startY = pageHeight - MARGIN_Y - FONT_SIZE

  const body = lines
    .map((line, i) => {
      if (!line.trim()) return '' // blank lines advance the cursor, draw nothing
      const y = startY - i * LINE_HEIGHT
      return `1 0 0 1 ${MARGIN_X.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(line)}) Tj`
    })
    .filter(Boolean)
    .join('\n')

  const content = `BT\n/F1 ${FONT_SIZE} Tf\n${body}\nET\n`

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${pageHeight.toFixed(
      2
    )}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  ]

  // The xref table needs each object's byte offset, so the file is assembled in
  // order while the offsets are recorded.
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []

  objects.forEach((obj, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })

  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n'
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  // Latin-1: every byte written above is < 256 by construction (pdfString
  // octal-escapes anything else), so one char is one byte and the offsets
  // recorded from string lengths are the real byte offsets.
  const bytes = new Uint8Array(pdf.length)
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff
  return bytes
}

/** Filename for a downloaded receipt: `receipt-00001847.pdf`. */
export function receiptFilename(number: string): string {
  return `receipt-${number}.pdf`
}
