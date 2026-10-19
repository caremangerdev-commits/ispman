import { hexToRgb, type Rgb } from '@/lib/brand'
import { formatRate } from '@/lib/bill/settings'
import {
  dayLong, dayMonth, dayShort, money, rangeText, type BillDocument, type BillLine,
} from '@/lib/bill/document'
import {
  A4, buildPdfDocument, pngToPdfImage, textOp, textWidth, wrapText, type PdfFont, type PdfImage,
} from '@/lib/letterhead-pdf'

/**
 * The three bill templates, drawn from docs/designs/bill-designs.html.
 *
 * ON THE HAND-WRITTEN PDF WRITER (lib/letterhead-pdf.ts), not a library. The
 * one thing that might have forced a library — an uploaded raster letterhead —
 * does not: lib/logo.ts#normaliseLetterhead stores it as an 8-bit opaque PNG,
 * whose scanlines PDF reads as they are. Base-14 fonts stand in for the
 * reference's web fonts: Helvetica for Public Sans, Times-Bold for the
 * Statement's Source Serif headings.
 *
 * GEOMETRY IS THE REFERENCE'S, IN MILLIMETRES: an A4 sheet, 16 mm top, 15 mm
 * sides, 14 mm bottom, the legal line 9 mm off the foot. Type sizes are the
 * reference's CSS pixels at 0.75 pt each. Nothing here computes a figure; every
 * number comes from lib/bill/document.ts.
 */

const MM = 72 / 25.4
const W = A4.width
const H = A4.height
const LEFT = 15 * MM
const RIGHT = W - 15 * MM
const CONTENT = RIGHT - LEFT
const TOP = 16 * MM
/** Content may not run below this (distance from the top of the page). */
const FLOOR = H - 24 * MM

const px = (n: number) => n * 0.75

const INK: Rgb = [25, 31, 38]
const MUTED: Rgb = [99, 110, 123]
const LINE: Rgb = [217, 223, 229]
const HAIR: Rgb = [236, 239, 242]
const SOFT: Rgb = [250, 251, 252]
const PAID_BG: Rgb = [238, 247, 241]
const PAID_EDGE: Rgb = [198, 226, 210]
const OWED_BG: Rgb = [253, 241, 223]
const OWED_EDGE: Rgb = [240, 212, 158]

const n2 = (v: number) => v.toFixed(2)
const rg = ([r, g, b]: Rgb) => (r / 255).toFixed(3) + ' ' + (g / 255).toFixed(3) + ' ' + (b / 255).toFixed(3)

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] * t + b[i] * (1 - t))) as Rgb
}

// ---------------------------------------------------------------------------
// A page, drawn top-down: every `top` is a distance from the top of the page.
// ---------------------------------------------------------------------------

type Align = 'left' | 'right' | 'center'

class Page {
  ops: string[] = []

  text(t: string, x: number, baseline: number, size: number,
    o: { font?: PdfFont; colour?: Rgb; align?: Align } = {}) {
    if (!t) return
    const font = o.font ?? 'F1'
    const w = textWidth(t, size, font)
    const at = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x
    this.ops.push(textOp(t, at, H - baseline, size, { font, colour: o.colour ?? INK }))
  }

  /** Runs of mixed weight on one line, left to right. Returns the end x. */
  runs(parts: { t: string; font?: PdfFont; colour?: Rgb }[], x: number, baseline: number, size: number): number {
    let at = x
    for (const p of parts) {
      this.text(p.t, at, baseline, size, { font: p.font, colour: p.colour })
      at += textWidth(p.t, size, p.font ?? 'F1')
    }
    return at
  }

  rect(x: number, top: number, w: number, h: number, colour: Rgb) {
    this.ops.push(rg(colour) + ' rg ' + n2(x) + ' ' + n2(H - top - h) + ' ' + n2(w) + ' ' + n2(h) + ' re f')
  }

  /** A rounded rectangle, filled and/or stroked. */
  round(x: number, top: number, w: number, h: number, r: number, o: { fill?: Rgb; stroke?: Rgb; width?: number }) {
    const k = 0.5523 * r
    const x0 = x, x1 = x + w, y0 = H - top - h, y1 = H - top
    const path = [
      n2(x0 + r) + ' ' + n2(y0) + ' m',
      n2(x1 - r) + ' ' + n2(y0) + ' l',
      n2(x1 - r + k) + ' ' + n2(y0) + ' ' + n2(x1) + ' ' + n2(y0 + r - k) + ' ' + n2(x1) + ' ' + n2(y0 + r) + ' c',
      n2(x1) + ' ' + n2(y1 - r) + ' l',
      n2(x1) + ' ' + n2(y1 - r + k) + ' ' + n2(x1 - r + k) + ' ' + n2(y1) + ' ' + n2(x1 - r) + ' ' + n2(y1) + ' c',
      n2(x0 + r) + ' ' + n2(y1) + ' l',
      n2(x0 + r - k) + ' ' + n2(y1) + ' ' + n2(x0) + ' ' + n2(y1 - r + k) + ' ' + n2(x0) + ' ' + n2(y1 - r) + ' c',
      n2(x0) + ' ' + n2(y0 + r) + ' l',
      n2(x0) + ' ' + n2(y0 + r - k) + ' ' + n2(x0 + r - k) + ' ' + n2(y0) + ' ' + n2(x0 + r) + ' ' + n2(y0) + ' c',
      'h',
    ].join(' ')
    const paint = o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S'
    this.ops.push(
      'q ' + (o.fill ? rg(o.fill) + ' rg ' : '') + (o.stroke ? rg(o.stroke) + ' RG ' + n2(o.width ?? 0.75) + ' w ' : '') +
      path + ' ' + paint + ' Q'
    )
  }

  /** A horizontal rule; `dash` in points. */
  hline(x1: number, x2: number, top: number, width: number, colour: Rgb, dash?: number) {
    const y = H - top
    this.ops.push(
      'q ' + rg(colour) + ' RG ' + n2(width) + ' w ' + (dash ? '[' + dash + ' ' + dash + '] 0 d ' : '') +
      n2(x1) + ' ' + n2(y) + ' m ' + n2(x2) + ' ' + n2(y) + ' l S Q'
    )
  }

  vline(x: number, top: number, bottom: number, width: number, colour: Rgb) {
    this.ops.push(
      'q ' + rg(colour) + ' RG ' + n2(width) + ' w ' + n2(x) + ' ' + n2(H - top) + ' m ' + n2(x) + ' ' + n2(H - bottom) + ' l S Q'
    )
  }

  image(name: string, x: number, top: number, w: number, h: number) {
    this.ops.push('q ' + n2(w) + ' 0 0 ' + n2(h) + ' ' + n2(x) + ' ' + n2(H - top - h) + ' cm /' + name + ' Do Q')
  }
}

/** The pages and images of one document. */
class Doc {
  pages: Page[] = [new Page()]
  images: PdfImage[] = []

  get page(): Page {
    return this.pages[this.pages.length - 1]
  }

  addPage(): Page {
    const p = new Page()
    this.pages.push(p)
    return p
  }

  /** Registers an image and returns its resource name. */
  register(im: PdfImage): string {
    this.images.push(im)
    return 'Im' + this.images.length
  }

  bytes(): Uint8Array {
    return buildPdfDocument({
      width: W, height: H,
      pages: this.pages.map((p) => p.ops.join('\n')),
      images: this.images,
    })
  }
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

type Ctx = {
  bill: BillDocument
  doc: Doc
  accent: Rgb
  onAccent: Rgb
  m: (n: number) => string
}

/** The fields under the document's title: "Invoice  10140-202610", right-aligned. */
function docFields(ctx: Ctx, page: Page, rows: [string, string][], right: number, top: number,
  colours: { dt: Rgb; dd: Rgb } = { dt: MUTED, dd: INK }): number {
  const size = px(12.5)
  const lead = size * 1.7
  const ddMin = 30 * MM
  let y = top
  for (const [dt, dd] of rows) {
    y += lead
    const ddW = Math.max(ddMin, textWidth(dd, size, 'F2'))
    page.text(dd, right, y - lead * 0.3, size, { font: 'F2', colour: colours.dd, align: 'right' })
    page.text(dt, right - ddW - px(10), y - lead * 0.3, size, { colour: colours.dt, align: 'right' })
  }
  return y
}

function fieldRows(bill: BillDocument): [string, string][] {
  const rows: [string, string][] = []
  if (bill.template === 'ledger') rows.push(['Account', bill.customer.accountNumber])
  rows.push([bill.numberLabel, bill.number])
  rows.push(['Issued', dayShort(bill.issued)])
  if (bill.template !== 'receipt') rows.push(['Due', bill.due ? dayShort(bill.due) : 'On receipt'])
  return rows
}

/** The company's contact lines as the generated block prints them. */
function metaLines(bill: BillDocument, oneLine: boolean): string[] {
  const c = bill.company
  const address = c.addressLines.join(', ')
  const contact = [c.phone, c.email].filter(Boolean).join(' · ')
  const tax = [c.taxIdLine, c.taxRegLine].filter(Boolean).join(' · ')
  if (oneLine) return [[address, c.phone, c.taxIdLine].filter(Boolean).join(' · ')].filter(Boolean)
  return [address, contact, tax].filter(Boolean)
}

/**
 * The uploaded letterhead across the top, in place of the generated block.
 * Returns the distance from the top where the page may continue.
 */
function drawLetterhead(ctx: Ctx, top: number): number | null {
  const lh = ctx.bill.letterhead
  if (!lh) return null
  const image = pngToPdfImage(lh.png)
  if (!image) return null
  const name = ctx.doc.register(image)
  const h = CONTENT * (image.height / image.width)
  ctx.doc.page.image(name, LEFT, top, CONTENT, h)
  return top + h
}

/** Below a letterhead: the document's title on the left, its fields on the right. */
function titleRow(ctx: Ctx, top: number, titleFont: PdfFont): number {
  const page = ctx.doc.page
  const y = top + 7 * MM
  page.text(ctx.bill.title, LEFT, y + px(22) * 0.8, px(22), { font: titleFont })
  const end = docFields(ctx, page, fieldRows(ctx.bill), RIGHT, y - px(12.5) * 0.4)
  return Math.max(y + px(22), end)
}

/** "Billed to" and "Account", side by side. */
function billTo(ctx: Ctx, top: number, labels: { left: string; accountLines: string[] }): number {
  const page = ctx.doc.page
  const b = ctx.bill
  const colW = (CONTENT - 14 * MM) / 2
  const rightX = LEFT + colW + 14 * MM
  const lab = px(11)
  const body = px(13.5)
  const lead = body * 1.6
  let yl = top + lab
  page.text(labels.left, LEFT, yl, lab, { font: 'F2', colour: MUTED })
  page.text(labels.left === 'Customer' || labels.left === 'Billed to' ? 'Account' : 'Account', rightX, yl, lab, { font: 'F2', colour: MUTED })
  yl += 2 * MM

  let y = yl + px(15)
  page.text(b.customer.name, LEFT, y, px(15), { font: 'F2' })
  for (const l of [...b.customer.addressLines, b.customer.phone ?? ''].filter(Boolean)) {
    for (const part of wrapText(l, body, false, colW)) {
      y += lead
      page.text(part, LEFT, y, body)
    }
  }

  let yr = yl + px(15)
  page.text(b.customer.accountNumber, rightX, yr, px(15), { font: 'F2' })
  for (const l of labels.accountLines) {
    yr += lead
    page.text(l, rightX, yr, body)
  }
  return Math.max(y, yr) + body * 0.4
}

function lineCells(ctx: Ctx, l: BillLine): { amount: number } {
  const split = ctx.bill.tax.shown && ctx.bill.tax.rate > 0
    ? Math.round((l.gross / (1 + ctx.bill.tax.rate / 100)) * 100) / 100
    : l.gross
  return { amount: split }
}

/**
 * The itemised table: description (with a muted detail line), the period it
 * covers, and the amount — net of tax when a tax line is printed below.
 */
function itemsTable(ctx: Ctx, top: number, heads: [string, string, string]): number {
  const page = ctx.doc.page
  const th = px(11.5)
  const td = px(13.5)
  const sub = px(12)
  const periodX = LEFT + CONTENT * 0.5
  const descW = CONTENT * 0.5 - 6 * MM

  let y = top + th
  page.text(heads[0], LEFT, y, th, { font: 'F2', colour: MUTED })
  page.text(heads[1], periodX, y, th, { font: 'F2', colour: MUTED })
  page.text(heads[2], RIGHT, y, th, { font: 'F2', colour: MUTED, align: 'right' })
  y += 2.5 * MM

  if (ctx.bill.lines.length === 0) {
    page.hline(LEFT, RIGHT, y, 0.75, HAIR)
    y += 3 * MM + td
    page.text('No charges in this period.', LEFT, y, td, { colour: MUTED })
    return y + 3 * MM
  }

  for (const l of ctx.bill.lines) {
    page.hline(LEFT, RIGHT, y, 0.75, HAIR)
    const rowTop = y + 3 * MM
    let yy = rowTop + td * 0.8
    for (const part of wrapText(l.description, td, false, descW)) {
      page.text(part, LEFT, yy, td)
      yy += td * 1.3
    }
    if (l.detail) {
      yy += 0.8 * MM - td * 0.3
      page.text(l.detail, LEFT, yy + sub * 0.5, sub, { colour: MUTED })
      yy += sub * 1.3
    }
    if (l.period) page.text(rangeText(l.period.start, l.period.end), periodX, rowTop + td * 0.8, td)
    page.text(ctx.m(lineCells(ctx, l).amount), RIGHT, rowTop + td * 0.8, td, { align: 'right' })
    y = yy + 3 * MM - td * 0.5
  }
  return y
}

/** Subtotal, tax, total — right-aligned, 78 mm wide. */
function totalsBlock(ctx: Ctx, top: number, rows: { label: string; value: number; tax?: boolean }[],
  due: { label: string; value: number }): number {
  const page = ctx.doc.page
  const x0 = RIGHT - 78 * MM
  const size = px(13.5)
  const pad = 2.2 * MM
  let y = top
  for (const r of rows) {
    if (r.tax && !ctx.bill.tax.shown) continue
    y += pad + size
    page.text(r.label, x0, y - size * 0.15, size, { colour: MUTED })
    page.text(ctx.m(r.value), RIGHT, y - size * 0.15, size, { align: 'right' })
    y += pad
  }
  y += 2 * MM
  page.hline(x0, RIGHT, y, 1.5, INK)
  const big = px(17)
  y += 3 * MM + big
  page.text(due.label, x0, y - big * 0.15, big, { font: 'F2' })
  page.text(ctx.m(due.value), RIGHT, y - big * 0.15, big, { font: 'F2', align: 'right' })
  return y + 2 * MM
}

function taxRowLabel(ctx: Ctx): string {
  return ctx.bill.tax.label + ' ' + formatRate(ctx.bill.tax.rate)
}

/** The how-to-pay columns, each only when the company has said how. */
function payColumns(ctx: Ctx, compact: boolean): { title: string; lines: string[] }[] {
  const b = ctx.bill
  const cols: { title: string; lines: string[] }[] = []
  if (b.howToPay.inPerson) cols.push({ title: 'In person', lines: [b.howToPay.inPerson] })
  if (b.howToPay.bank) {
    cols.push({
      title: 'Bank transfer',
      lines: compact
        ? [b.howToPay.bank.split(/\r?\n/).join(', ') + ' · ref ' + b.customer.accountNumber]
        : [...b.howToPay.bank.split(/\r?\n/), 'Use account ' + b.customer.accountNumber + ' as reference'],
    })
  }
  if (b.howToPay.online) {
    cols.push({
      title: 'Card, online',
      lines: compact ? [b.howToPay.online] : [b.howToPay.online, 'Sign in with your phone number'],
    })
  }
  return cols
}

function payBlock(ctx: Ctx, top: number, title: string, compact: boolean): number {
  const cols = payColumns(ctx, compact)
  if (cols.length === 0) return top
  const page = ctx.doc.page
  let y = top + 10 * MM
  page.hline(LEFT, RIGHT, y, 0.75, LINE)
  y += 5 * MM + px(12.5)
  page.text(title, LEFT, y, px(12.5), { font: 'F2' })
  y += 3 * MM

  const size = px(12.5)
  const lead = size * 1.7
  const gap = 10 * MM
  const colW = (CONTENT - gap * (cols.length - 1)) / cols.length
  let bottom = y
  cols.forEach((c, i) => {
    const x = LEFT + i * (colW + gap)
    let yy = y + lead * 0.75
    page.text(c.title, x, yy, size, { font: 'F2' })
    for (const l of c.lines) {
      for (const part of wrapText(l, size, false, colW)) {
        yy += lead
        page.text(part, x, yy, size, { colour: MUTED })
      }
    }
    bottom = Math.max(bottom, yy)
  })
  return bottom + lead * 0.3
}

/** The legal line, 9 mm off the foot of every page. */
function legal(ctx: Ctx, page: Page) {
  const size = px(10.5)
  const lead = size * 1.6
  const parts = wrapText(ctx.bill.legal, size, false, CONTENT).slice(0, 3)
  const bottom = H - 9 * MM
  const top = bottom - parts.length * lead
  page.hline(LEFT, RIGHT, top - 3 * MM + lead * 0.2, 0.75, HAIR)
  parts.forEach((p, i) => page.text(p, LEFT, top + (i + 1) * lead - lead * 0.3, size, { colour: MUTED }))
}

// ---------------------------------------------------------------------------
// A · Statement
// ---------------------------------------------------------------------------

function statement(ctx: Ctx) {
  const { bill, doc } = ctx
  const page = doc.page

  // --- Header: the letterhead, or the generated block ----------------------
  let y: number
  const lh = drawLetterhead(ctx, TOP)
  if (lh !== null) {
    y = titleRow(ctx, lh, 'F3')
  } else {
    let left = TOP
    const logo = bill.brand.logo ? pngToPdfImage(bill.brand.logo.png) : null
    if (logo) {
      const name = doc.register(logo)
      const h = 13 * MM
      const w = Math.min(60 * MM, h * (logo.width / logo.height))
      const hh = w * (logo.height / logo.width)
      page.image(name, LEFT, left, w, hh)
      left += hh + 4 * MM
    } else {
      const s = 13 * MM
      page.round(LEFT, left, s, s, 3 * MM, { fill: ctx.accent })
      const initial = (bill.company.name.trim()[0] ?? '?').toUpperCase()
      page.text(initial, LEFT + s / 2, left + s / 2 + px(20) * 0.36, px(20), { font: 'F2', colour: ctx.onAccent, align: 'center' })
      left += s + 4 * MM
    }
    const nameSize = px(19)
    const nameW = CONTENT * 0.55
    for (const part of wrapText(bill.company.name, nameSize, true, nameW).slice(0, 2)) {
      left += nameSize * 1.2
      page.text(part, LEFT, left - nameSize * 0.2, nameSize, { font: 'F3' })
    }
    left += 2 * MM
    const meta = px(12.5)
    for (const l of metaLines(bill, false)) {
      for (const part of wrapText(l, meta, false, nameW)) {
        left += meta * 1.65
        page.text(part, LEFT, left - meta * 0.4, meta, { colour: MUTED })
      }
    }

    const kind = px(22)
    page.text(bill.title, RIGHT, TOP + kind * 0.8, kind, { font: 'F3', align: 'right' })
    const right = docFields(ctx, page, fieldRows(bill), RIGHT, TOP + kind + 3 * MM - px(12.5) * 0.5)
    y = Math.max(left, right, TOP + 26 * MM)
  }

  // --- Billed to / Account -------------------------------------------------
  y = billTo(ctx, y + 9 * MM, {
    left: 'Billed to',
    accountLines: [bill.customer.plan ? 'Service: ' + bill.customer.plan : '', 'Quote this number when you pay'].filter(Boolean),
  })

  // --- The account summary strip, in the brand colour ----------------------
  y += 8 * MM
  const headH = 3 * MM * 2 + px(12.5)
  const bodyH = 5 * MM * 2 + px(11.5) + 1.5 * MM + px(21)
  const stripH = headH + bodyH
  page.round(LEFT, y, CONTENT, stripH, 0.8 * MM, { fill: [255, 255, 255], stroke: LINE, width: 0.75 })
  page.rect(LEFT + 0.4, y + 0.4, CONTENT - 0.8, headH - 0.4, ctx.accent)
  page.text('Account summary', LEFT + 5 * MM, y + 3 * MM + px(12.5) * 0.8, px(12.5), { font: 'F2', colour: ctx.onAccent })
  const s = bill.summary
  const credit = s.totalDue < -0.005
  const cells: [string, string][] = [
    ['Previous balance', ctx.m(s.previousBalance)],
    ['Payments received', s.payments > 0.005 ? '-' + ctx.m(s.payments) : ctx.m(0)],
    ['Charges this period', ctx.m(s.charges)],
    [credit ? 'In credit' : 'Total due', ctx.m(Math.abs(s.totalDue))],
  ]
  const cellW = CONTENT / 4
  const bodyTop = y + headH
  page.rect(LEFT + cellW * 3, bodyTop, cellW - 0.4, bodyH - 0.4, SOFT)
  cells.forEach(([dt, dd], i) => {
    const x = LEFT + i * cellW
    if (i > 0) page.vline(x, bodyTop, bodyTop + bodyH, 0.75, HAIR)
    page.text(dt, x + 5 * MM, bodyTop + 5 * MM + px(11.5) * 0.8, px(11.5), { colour: MUTED })
    const last = i === 3
    page.text(dd, x + 5 * MM, bodyTop + 5 * MM + px(11.5) + 1.5 * MM + (last ? px(21) : px(17)) * 0.8,
      last ? px(21) : px(17), { font: 'F2' })
  })
  y += stripH

  // --- Charges ---------------------------------------------------------------
  y += 9 * MM + px(12.5)
  page.text('Charges', LEFT, y, px(12.5), { font: 'F2' })
  y = itemsTable(ctx, y + 3 * MM, ['Description', 'Period', 'Amount'])
  const sameAsDue = Math.abs(bill.totals.gross - Math.max(0, s.totalDue)) < 0.005
  y = totalsBlock(ctx, y + 6 * MM, [
    { label: 'Subtotal', value: bill.totals.net },
    { label: taxRowLabel(ctx), value: bill.totals.tax, tax: true },
  ], { label: sameAsDue ? 'Total due' : 'Total this period', value: bill.totals.gross })

  // --- How to pay ------------------------------------------------------------
  y = payBlock(ctx, y, 'How to pay', false)

  // --- The tear-off stub, at the foot so it tears off cleanly ---------------
  const noteSize = px(11)
  const noteLead = noteSize * 1.6
  const note =
    'Detach and return this portion with a cash or cheque payment.' +
    (bill.serviceRunsTo
      ? ' Service continues to ' + dayLong(bill.serviceRunsTo) +
        '. After that date service is interrupted until payment is received.'
      : '')
  const noteLines = wrapText(note, noteSize, false, 90 * MM)
  const stubH = 5 * MM + Math.max(noteLines.length * noteLead, px(11) * 1.6 + px(19))
  const stubTop = Math.max(y + 11 * MM, FLOOR - stubH)
  page.hline(LEFT, RIGHT, stubTop, 1.1, LINE, 3)
  noteLines.forEach((l, i) => page.text(l, LEFT, stubTop + 5 * MM + (i + 0.8) * noteLead, noteSize, { colour: MUTED }))
  const stubBottom = stubTop + stubH
  page.text(ctx.m(Math.max(0, s.totalDue)), RIGHT, stubBottom - 1, px(19), { font: 'F2', align: 'right' })
  page.text('Account ' + bill.customer.accountNumber + ' · Invoice ' + bill.number, RIGHT,
    stubBottom - px(19) - 2, px(11), { colour: MUTED, align: 'right' })

  legal(ctx, page)
}

// ---------------------------------------------------------------------------
// B · Ledger
// ---------------------------------------------------------------------------

function ledger(ctx: Ctx) {
  const { bill, doc } = ctx
  let page = doc.page
  const lg = bill.ledger
  const top = TOP + 2 * MM // the reference sets this sheet 2 mm lower

  let y: number
  const lh = drawLetterhead(ctx, top)
  if (lh !== null) {
    y = titleRow(ctx, lh, 'F2')
  } else {
    const nameSize = px(16)
    page.text(bill.company.name, LEFT, top + nameSize * 0.8, nameSize, { font: 'F2' })
    let left = top + nameSize
    const meta = px(12.5)
    for (const l of metaLines(bill, true)) {
      for (const part of wrapText(l, meta, false, CONTENT * 0.55)) {
        left += meta * 1.65
        page.text(part, LEFT, left - meta * 0.4, meta, { colour: MUTED })
      }
    }
    const kind = px(15)
    page.text(bill.title, RIGHT, top + kind * 0.8, kind, { font: 'F2', align: 'right' })
    const right = docFields(ctx, page, fieldRows(bill), RIGHT, top + kind + 3 * MM - px(12.5) * 0.5)
    y = Math.max(left, right, top + 26 * MM)
  }
  y += 6 * MM
  page.rect(LEFT, y, CONTENT, 3, ctx.accent)
  y += 3

  // --- Who, and the window ---------------------------------------------------
  const size = px(13.5)
  y += 7 * MM + size * 0.8
  const who = [bill.customer.addressLines.join(', ')].filter(Boolean).join('')
  page.runs([
    { t: bill.customer.name, font: 'F2' },
    ...(who ? [{ t: ' · ' + who, colour: MUTED }] : []),
  ], LEFT, y, size)
  y += size * 1.5
  const endX = page.runs([
    { t: 'Transactions from ', colour: MUTED },
    { t: dayLong(lg.from).replace(/ \d{4}$/, lg.from.slice(0, 4) === lg.to.slice(0, 4) ? '' : ' ' + lg.from.slice(0, 4)), font: 'F2' },
    { t: ' to ', colour: MUTED },
    { t: dayLong(lg.to), font: 'F2' },
  ], LEFT, y, size)
  if (bill.customer.plan) {
    const tag = px(11)
    const tw = textWidth(bill.customer.plan, tag, 'F2')
    const tx = endX + textWidth(' · ', size) + 2
    page.text(' · ', endX, y, size, { colour: MUTED })
    page.round(tx, y - tag - 1 * MM + 1, tw + 5 * MM, tag + 2 * MM, 0.7, { fill: ctx.accent })
    page.text(bill.customer.plan, tx + 2.5 * MM, y - 0.5, tag, { font: 'F2', colour: ctx.onAccent })
  }

  // --- The table -------------------------------------------------------------
  const th = px(11.5)
  const td = px(13.5)
  const balR = RIGHT
  const payR = RIGHT - 30 * MM
  const chgR = RIGHT - 60 * MM
  const detailX = LEFT + 20 * MM
  const detailW = chgR - 28 * MM - detailX

  const heads = () => {
    y += 5 * MM + th
    page.text('Date', LEFT, y, th, { font: 'F2', colour: MUTED })
    page.text('Detail', detailX, y, th, { font: 'F2', colour: MUTED })
    page.text('Charges', chgR, y, th, { font: 'F2', colour: MUTED, align: 'right' })
    page.text('Payments', payR, y, th, { font: 'F2', colour: MUTED, align: 'right' })
    page.text('Balance', balR, y, th, { font: 'F2', colour: MUTED, align: 'right' })
    y += 2 * MM
    page.hline(LEFT, RIGHT, y, 1.1, INK)
  }
  heads()

  const row = (date: string, detail: string, charge: string, payment: string, balance: string) => {
    const parts = wrapText(detail, td, false, detailW).slice(0, 2)
    const h = 3.2 * MM * 2 + td + (parts.length - 1) * td * 1.3
    if (y + h > FLOOR) {
      legal(ctx, page)
      page = doc.addPage()
      y = TOP
      heads()
    }
    const base = y + 3.2 * MM + td * 0.8
    page.text(date, LEFT, base, td)
    parts.forEach((p, i) => page.text(p, detailX, base + i * td * 1.3, td))
    page.text(charge, chgR, base, td, { align: 'right' })
    page.text(payment, payR, base, td, { align: 'right' })
    page.text(balance, balR, base, td, { font: 'F2', align: 'right' })
    y += h
    page.hline(LEFT, RIGHT, y, 0.75, HAIR)
  }

  row(dayMonth(lg.from), 'Balance brought forward', '—', '—', ctx.m(lg.broughtForward))
  for (const e of lg.entries) {
    row(dayMonth(e.date), e.detail, e.charge !== null ? ctx.m(e.charge) : '—', e.payment !== null ? ctx.m(e.payment) : '—', ctx.m(e.balance))
  }
  page.hline(LEFT, RIGHT, y, 1.1, INK)

  // --- Closing ---------------------------------------------------------------
  const closeSize = px(21)
  if (y + 5 * MM + closeSize + 20 > FLOOR) {
    legal(ctx, page)
    page = doc.addPage()
    y = TOP
  }
  y += 5 * MM + closeSize
  const amount = ctx.m(Math.max(0, lg.closing))
  page.text(amount, RIGHT, y - closeSize * 0.15, closeSize, { font: 'F2', align: 'right' })
  page.text('Balance at ' + dayLong(bill.issued), RIGHT - textWidth(amount, closeSize, 'F2') - 8 * MM,
    y - closeSize * 0.15, px(13), { colour: MUTED, align: 'right' })
  if (lg.creditHeld > 0.005) {
    y += px(13) * 1.6
    page.text('Credit held toward future bills: ' + ctx.m(lg.creditHeld), RIGHT, y, px(12.5), { colour: MUTED, align: 'right' })
  }

  // --- Tax on the period's charges ------------------------------------------
  if (bill.tax.shown && lg.charged > 0.005) {
    const rate = bill.tax.rate
    const net = Math.round((lg.charged / (1 + rate / 100)) * 100) / 100
    if (y + 40 * MM > FLOOR) {
      legal(ctx, page)
      page = doc.addPage()
      y = TOP
    }
    y = totalsBlock({ ...ctx, doc }, y + 8 * MM, [
      { label: 'Charges in period', value: net },
      { label: taxRowLabel(ctx), value: Math.round((lg.charged - net) * 100) / 100, tax: true },
    ], { label: 'Total charged', value: lg.charged })
  }

  if (y + 35 * MM > FLOOR) {
    legal(ctx, page)
    page = doc.addPage()
    y = TOP
  }
  payBlock({ ...ctx, doc }, y, 'How to pay', true)
  legal(ctx, page)
}

// ---------------------------------------------------------------------------
// C · Receipt
// ---------------------------------------------------------------------------

function receipt(ctx: Ctx) {
  const { bill, doc } = ctx
  const page = doc.page
  const r = bill.receipt
  if (!r) return statement(ctx)

  // --- The band, edge to edge — or the letterhead in its place -------------
  let y: number
  const lh = drawLetterhead(ctx, TOP)
  if (lh !== null) {
    // The company's own stationery replaces the band entirely: a second
    // colour under somebody's printed letterhead fights it.
    y = titleRow(ctx, lh, 'F2')
  } else {
    const soft = mix(ctx.onAccent, ctx.accent, 0.8)
    const nameSize = px(17)
    const meta = px(12.5)
    const metas = metaLines(bill, true).flatMap((l) => wrapText(l, meta, false, CONTENT * 0.6))
    const kind = px(22)
    const fieldsH = px(12.5) * 1.7 * 2
    const inner = Math.max(nameSize * 1.2 + metas.length * meta * 1.65 + 2 * MM, kind + 3 * MM + fieldsH)
    const bandH = 11 * MM + inner + 9 * MM
    page.rect(0, 0, W, bandH, ctx.accent)
    let left = 11 * MM + nameSize
    page.text(bill.company.name, LEFT, left - nameSize * 0.2, nameSize, { font: 'F2', colour: ctx.onAccent })
    left += 2 * MM
    for (const l of metas) {
      left += meta * 1.65
      page.text(l, LEFT, left - meta * 0.4, meta, { colour: soft })
    }
    page.text(bill.title, RIGHT, 11 * MM + kind * 0.8, kind, { font: 'F2', colour: ctx.onAccent, align: 'right' })
    docFields(ctx, page, [[bill.numberLabel, bill.number], ['Issued', dayShort(bill.issued)]], RIGHT,
      11 * MM + kind + 3 * MM - px(12.5) * 0.5, { dt: soft, dd: ctx.onAccent })
    y = bandH
  }

  // --- Customer / Account ----------------------------------------------------
  y = billTo(ctx, y + 9 * MM, { left: 'Customer', accountLines: ['Quote this number when you pay'] })

  // --- Paid on · Paid by · Your service runs to ------------------------------
  y += 9 * MM
  const gap = 6 * MM
  const unit = (CONTENT - gap * 2) / 3.1
  const widths = [unit, unit, unit * 1.1]
  const boxH = 5 * MM * 2 + px(11.5) + 2 * MM + px(24)
  const boxes: [string, string, boolean][] = [
    ['Paid on', dayLong(r.paidOn), false],
    ['Paid by', r.paidBy, false],
    ['Your service runs to', r.runsTo ? dayShort(r.runsTo) : 'Unchanged', true],
  ]
  let x = LEFT
  boxes.forEach(([dt, dd, big], i) => {
    const w = widths[i]
    page.round(x, y, w, boxH, 1.1 * MM, { fill: big ? SOFT : [255, 255, 255], stroke: LINE, width: 0.75 })
    page.text(dt, x + 5 * MM, y + 5 * MM + px(11.5) * 0.8, px(11.5), { colour: MUTED })
    const size = big ? px(24) : px(16)
    const fitted = wrapText(dd, size, true, w - 10 * MM)[0] ?? dd
    page.text(fitted, x + 5 * MM, y + 5 * MM + px(11.5) + 2 * MM + size * 0.8, size, { font: 'F2' })
    x += w + gap
  })
  y += boxH

  // --- What you paid for -----------------------------------------------------
  y += 9 * MM + px(12.5)
  page.text('What you paid for', LEFT, y, px(12.5), { font: 'F2' })
  y = itemsTable(ctx, y + 3 * MM, ['Service', 'Covers', 'Amount'])
  y = totalsBlock(ctx, y + 6 * MM, [
    { label: taxRowLabel(ctx), value: bill.totals.tax, tax: true },
  ], { label: 'Paid', value: bill.totals.gross })

  // --- Paid in full, or what is left ----------------------------------------
  y += 7 * MM
  const clear = r.outstanding <= 0.005
  const size = px(14)
  const boxPad = 4 * MM
  const paidH = boxPad * 2 + px(18)
  page.round(LEFT, y, CONTENT, paidH, 1.1 * MM, { fill: clear ? PAID_BG : OWED_BG, stroke: clear ? PAID_EDGE : OWED_EDGE, width: 0.75 })
  const mid = y + paidH / 2 + size * 0.35
  if (clear) {
    page.runs([{ t: 'Paid in full.', font: 'F2' }, { t: ' Nothing is outstanding on this account.' }], LEFT + 5 * MM, mid, size)
  } else {
    page.runs([{ t: ctx.m(r.outstanding) + ' is still due', font: 'F2' }, { t: ' on this account.' }], LEFT + 5 * MM, mid, size)
  }
  page.text(ctx.m(Math.max(0, r.outstanding)) + ' due', RIGHT - 5 * MM, y + paidH / 2 + px(18) * 0.35, px(18), { font: 'F2', align: 'right' })
  y += paidH

  // --- Next payment ----------------------------------------------------------
  const ways = [
    bill.howToPay.inPerson,
    bill.howToPay.bank ? 'Bank transfer: ' + bill.howToPay.bank.split(/\r?\n/).join(', ') + ', reference ' + bill.customer.accountNumber : null,
    bill.howToPay.online ? 'Card, online: ' + bill.howToPay.online : null,
  ].filter(Boolean) as string[]
  if (r.runsTo || ways.length) {
    y += 10 * MM
    page.hline(LEFT, RIGHT, y, 0.75, LINE)
    y += 5 * MM + px(12.5)
    page.text('Next payment', LEFT, y, px(12.5), { font: 'F2' })
    y += 3 * MM
    const s = px(12.5)
    const lead = s * 1.7
    y += lead * 0.75
    page.text(r.runsTo ? 'Due by ' + dayLong(r.runsTo) : 'Pay whenever you are ready', LEFT, y, s, { font: 'F2' })
    for (const w of ways) {
      for (const part of wrapText(w, s, false, CONTENT)) {
        y += lead
        page.text(part, LEFT, y, s, { colour: MUTED })
      }
    }
  }

  legal(ctx, page)
}

// ---------------------------------------------------------------------------

/** The bill as PDF bytes, in the template the document names. */
export function billPdf(bill: BillDocument): Uint8Array {
  const doc = new Doc()
  const accent = hexToRgb(bill.brand.palette.accent)
  const onAccent = hexToRgb(bill.brand.palette.onAccent)
  const ctx: Ctx = { bill, doc, accent, onAccent, m: (n) => money(n, bill.symbol) }

  if (bill.template === 'ledger') ledger(ctx)
  else if (bill.template === 'receipt') receipt(ctx)
  else statement(ctx)

  return doc.bytes()
}

/** "invoice-10140-202610.pdf" and the like. */
export function billFilename(bill: BillDocument): string {
  const kind = bill.template === 'receipt' ? 'receipt' : bill.template === 'ledger' ? 'statement' : 'invoice'
  return kind + '-' + bill.number.replace(/[^A-Za-z0-9-]/g, '') + '.pdf'
}
