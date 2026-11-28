import { dayShort, money, type BillDocument } from '@/lib/bill/document'

/**
 * The bill as a text message: the same figures the PDF and the email carry,
 * from the same BillDocument, in a sentence or two.
 *
 * ONE TEXT WHERE IT CAN BE. Every part over 160 characters is another text the
 * company pays for, so the wording is short ("1 Dec 2026", no bill number) and
 * the details stay on the PDF.
 *
 * PLAIN CHARACTERS ONLY. A single character outside the GSM alphabet (an en
 * dash, a middle dot, a curly quote) turns the whole message into Unicode,
 * where a part holds 70 characters instead of 160. So: hyphens, commas,
 * straight quotes.
 *
 * PURE: no database, no clock.
 */
export function billSms(bill: BillDocument, opts: { firstName: string | null }): string {
  const m = (n: number) => money(n, bill.symbol)
  const hi = 'Hi ' + (opts.firstName?.trim() || bill.customer.name) + ', '
  const company = bill.company.name
  const acct = bill.customer.accountNumber
  const how = bill.howToPay.online
    ? ' Pay at ' + bill.howToPay.online + (acct ? ', account ' + acct : '') + '.'
    : acct ? ' Quote account ' + acct + ' when you pay.' : ''

  if (bill.template === 'receipt' && bill.receipt) {
    const r = bill.receipt
    return (
      hi + company + ' received ' + m(r.amount) + ' on ' + dayShort(r.paidOn) + ', thank you.' +
      (r.outstanding > 0.005
        ? ' Still to pay: ' + m(r.outstanding) + '.'
        : r.nextDue ? ' Next payment due ' + dayShort(r.nextDue) + '.' : '')
    )
  }

  if (bill.paidUp) {
    return (
      hi + 'your ' + company + ' ' + bill.title.toLowerCase() + ' of ' + m(bill.totals.gross) + ' is paid, thank you.' +
      (bill.due ? ' Next payment due ' + dayShort(bill.due) + '.' : '')
    )
  }

  const toPay = bill.totalToPay
  if (toPay <= 0.005) return hi + 'you have nothing to pay ' + company + ' right now.'
  return (
    hi + 'your ' + company + ' ' + bill.title.toLowerCase() + ' is ' + m(toPay) +
    (bill.due ? ', due ' + dayShort(bill.due) : ', due now') + '.' +
    (bill.otherOwed > 0.005 ? ' Includes ' + m(bill.otherOwed) + ' other charges.' : '') +
    how
  )
}
