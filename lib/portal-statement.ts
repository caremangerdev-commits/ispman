import type { Brand } from '@/lib/brand'
import { A4, buildPdf, letterhead, PAGE_MARGIN, textOp, textWidth, wrapText } from '@/lib/letterhead-pdf'

/**
 * A one-page account statement / period bill, on the company's letterhead.
 *
 * Built on the same hand-written PDF writer as the letterhead (lib/letterhead-pdf.ts)
 * — no PDF library, base-14 fonts, one image — so it stays a few KB and renders
 * on a phone over mobile data. One page: a statement shows the most recent rows
 * that fit and says so; a single-month bill is small and fits easily.
 */

const MUTED: [number, number, number] = [107, 114, 128]
const LINE = 15
const ROW_SIZE = 10

export type StatementRow = { date: string; description: string; amount: string }

export function statementPdf(opts: {
  brand: Brand
  heading: string
  generatedOn: string
  customerName: string
  accountNumber: string | null
  summary: { label: string; value: string }[]
  rows: StatementRow[]
  note?: string | null
}): { bytes: Uint8Array; shown: number } {
  const head = letterhead(opts.brand, A4)
  const left = PAGE_MARGIN
  const right = A4.width - PAGE_MARGIN
  const ops: string[] = [head.ops]
  let y = head.bodyTop

  ops.push(textOp(opts.heading, left, y, 16, { bold: true }))
  ops.push(textOp(opts.generatedOn, right - textWidth(opts.generatedOn, 9), y + 2, 9, { colour: MUTED }))
  y -= LINE * 1.6

  ops.push(textOp(opts.customerName, left, y, 11, { bold: true }))
  y -= LINE
  if (opts.accountNumber) {
    ops.push(textOp('Account ' + opts.accountNumber, left, y, 10, { colour: MUTED }))
    y -= LINE
  }
  y -= LINE * 0.5

  for (const s of opts.summary) {
    ops.push(textOp(s.label, left, y, 10, { colour: MUTED }))
    ops.push(textOp(s.value, right - textWidth(s.value, 10), y, 10))
    y -= LINE
  }

  y -= LINE * 0.6
  ops.push(textOp('Date', left, y, 9, { bold: true, colour: MUTED }))
  ops.push(textOp('Amount', right - textWidth('Amount', 9, true), y, 9, { bold: true, colour: MUTED }))
  y -= LINE * 0.9

  // How many rows fit before the bottom margin.
  const bottom = PAGE_MARGIN + LINE * 2
  const descX = left + 95
  const descWidth = right - descX - textWidth('J$000,000.00', ROW_SIZE) - 10
  let shown = 0
  for (const r of opts.rows) {
    if (y <= bottom) break
    ops.push(textOp(r.date, left, y, ROW_SIZE, { colour: MUTED }))
    const desc = wrapText(r.description, ROW_SIZE, false, descWidth)[0] ?? r.description
    ops.push(textOp(desc, descX, y, ROW_SIZE))
    ops.push(textOp(r.amount, right - textWidth(r.amount, ROW_SIZE), y, ROW_SIZE))
    y -= LINE
    shown += 1
  }

  if (opts.rows.length === 0) {
    ops.push(textOp('No activity in this period.', left, y, ROW_SIZE, { colour: MUTED }))
    y -= LINE
  }

  const trailing = opts.note || (shown < opts.rows.length ? 'Showing the most recent ' + shown + ' of ' + opts.rows.length + '.' : null)
  if (trailing) {
    ops.push(textOp(trailing, left, Math.max(y - LINE, PAGE_MARGIN), 9, { colour: MUTED }))
  }

  return { bytes: buildPdf({ width: A4.width, height: A4.height, content: ops.join('\n'), image: head.image }), shown }
}
