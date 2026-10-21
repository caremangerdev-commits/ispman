import { dayLong, money, rangeText, type BillDocument } from '@/lib/bill/document'
import { payColumns } from '@/lib/bill/pdf'

/**
 * The email a bill travels in: its subject, and the short cover note above the
 * attachment.
 *
 * THE BILL IS THE ATTACHMENT, NOT THIS. The emailed bill is the PDF that
 * lib/bill/pdf.ts#billPdf draws — the same bytes a customer downloads from the
 * portal and staff print from the record, in the company's chosen template
 * with its tax line, letterhead, currency and bank details. A PDF and not an
 * HTML rendering of the template, because an HTML copy of three templates is a
 * second renderer that would drift from the first, and because no two mail
 * clients draw HTML alike: Outlook lays email out with Word's engine, Gmail
 * strips styles and clips long messages, dark mode inverts colours. A PDF looks
 * the same everywhere and is the document a tax invoice has to be.
 *
 * So this is only the cover note, and every figure in it comes from the same
 * BillDocument the PDF is drawn from, formatted by the same `money` and date
 * helpers, and the ways to pay in the PDF's own words (payColumns). It is
 * plain text, put in the company's email shell at send time like every other
 * message (lib/messaging/present.ts): the "Label: value" lines become the
 * shell's table.
 *
 * PURE: no database, no clock.
 */
export function billEmail(
  bill: BillDocument,
  opts: { firstName: string | null }
): { subject: string; body: string } {
  const m = (n: number) => money(n, bill.symbol)
  const facts: [string, string | null][] = []

  if (bill.template === 'receipt' && bill.receipt) {
    facts.push(
      ['Receipt', bill.number],
      ['Paid on', dayLong(bill.receipt.paidOn)],
      ['Paid by', bill.receipt.paidBy],
      ['Amount', m(bill.receipt.amount)],
      ['Service runs to', bill.receipt.runsTo ? dayLong(bill.receipt.runsTo) : null],
      ['Still to pay', bill.receipt.outstanding > 0.005 ? m(bill.receipt.outstanding) : null],
    )
  } else if (bill.template === 'ledger') {
    const closing = bill.ledger.closing
    facts.push(
      ['Statement', bill.number],
      ['Covers', rangeText(bill.ledger.from, bill.ledger.to)],
      [closing < -0.005 ? 'In credit' : 'Closing balance', m(Math.abs(closing) < 0.005 ? 0 : Math.abs(closing))],
      ['Due by', closing > 0.005 && bill.due ? dayLong(bill.due) : null],
      ['Service runs to', bill.serviceRunsTo ? dayLong(bill.serviceRunsTo) : null],
    )
  } else {
    const due = bill.summary.totalDue
    facts.push(
      [bill.numberLabel, bill.number],
      ['Period', rangeText(bill.period.start, bill.period.end)],
      [due < -0.005 ? 'In credit' : 'Amount due', m(Math.abs(due) < 0.005 ? 0 : Math.abs(due))],
      ['Due by', due > 0.005 && bill.due ? dayLong(bill.due) : null],
      ['Service runs to', bill.serviceRunsTo ? dayLong(bill.serviceRunsTo) : null],
    )
  }

  // One line each: a "Label: value" run is drawn as a table only while every
  // line of it reads that way, and a payment note can be several lines.
  const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ', ').trim()
  const pay = bill.template === 'receipt' ? [] : payColumns(bill, true)

  const paragraphs = [
    'Hi ' + (opts.firstName?.trim() || bill.customer.name) + ',',
    'Your ' + bill.title.toLowerCase() + ' from ' + bill.company.name + ' is attached.',
    facts.filter(([, v]) => v).map(([label, value]) => label + ': ' + oneLine(value as string)).join('\n'),
    pay.length ? 'How to pay:' : null,
    pay.length ? pay.map((c) => c.title + ': ' + oneLine(c.lines.join(' '))).join('\n') : null,
    bill.company.name,
  ]

  return {
    subject: bill.title + ' ' + bill.number + ' from ' + bill.company.name,
    body: paragraphs.filter(Boolean).join('\n\n'),
  }
}
