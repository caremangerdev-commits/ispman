import { NextResponse, type NextRequest } from 'next/server'

import { csvFile, csvRow, slug } from '@/lib/csv'
import { listMiscCategories } from '@/lib/data/catalog'
import { PAYMENT_METHOD_LABELS } from '@/lib/data/checkoff'
import { getCurrency } from '@/lib/data/company'
import { listPayments } from '@/lib/data/payments'
import { can } from '@/lib/permissions'
import { receiptNumber } from '@/lib/receipt'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'

/**
 * The payments list as a CSV of the CURRENT FILTERED SET.
 *
 * WHAT YOU SEE IS WHAT YOU GET, and that is a claim this route has to earn.
 * It reads the same query string the page reads and hands it to the same
 * listPayments with `all: true`, so the file is the screen's own rows without
 * its pagination — not the visible page, not the whole company. A route that
 * built its own query would agree with the page until the day somebody changed
 * one of them.
 *
 * GATED ON view_revenue_reports — manager and above, the same line
 * import_customers draws for bulk data moving the other way. That is now the
 * same set of roles view_all_payments grants, so nobody who can reach the page
 * is refused the button; the two permissions are kept separate anyway because
 * they mean different things and can diverge again. See lib/permissions.ts.
 *
 * The check stands on its own regardless of who sees the button, because a
 * hidden button is not access control.
 */
export async function GET(request: NextRequest) {
  const { company, profile } = await getSession()

  if (!can(profile.role, 'view_revenue_reports')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sp = request.nextUrl.searchParams
  const one = (k: string) => sp.get(k) ?? ''

  const [caps, currency, cats] = await Promise.all([
    getSchemaCapabilities(),
    getCurrency(company.id),
    listMiscCategories(company.id),
  ])

  const result = await listPayments({
    companyId: company.id,
    from: one('from'),
    to: one('to'),
    type: one('type'),
    query: one('q'),
    agent: one('agent'),
    checked: one('checked'),
    category: one('category'),
    all: true,
  })

  // Same labelling rule as the income breakdown: an id that no longer resolves
  // is named as a deleted category rather than folded into Uncategorised. The
  // payment was attributed when it was taken, and 0018 keeps the id precisely
  // so "attributed to something since deleted" stays distinguishable from
  // "never attributed".
  const names = new Map(cats.map((c) => [c.id, c.name]))
  const segmentName = (id: number | null) =>
    id === null ? 'Uncategorised' : names.get(id) ?? 'Deleted category #' + id

  // NO TAX ID COLUMN, DELIBERATELY. This export exists so an owner can check
  // figures; a downloadable file of national identifiers is a different risk
  // class and nothing here needs one. See supabase/migrations/0019_tax_id.sql.
  const header = [
    'Receipt No',
    ...(caps.accountNumbers ? ['Account No'] : []),
    'Date',
    'Recorded At',
    'Customer',
    'Category',
    'Type',
    'Purpose',
    // The code, not the symbol: a heading is the only place the currency can be
    // stated without turning the amounts themselves into text.
    'Amount (' + currency + ')',
    'Months',
    'Method',
    'Agent',
    ...(caps.checkoff ? ['Checked Off'] : []),
    'Notes',
  ]

  const rows = [csvRow(header)]

  for (const p of result.rows) {
    rows.push(
      csvRow([
        receiptNumber(p.id),
        ...(caps.accountNumbers ? [p.accountNumber ?? ''] : []),
        // paid_on is the business date the cashier stated, and it is what the
        // date filter above means — so it is what "Date" has to be here too.
        // Rows written before 0013 have none and fall back to the timestamp's
        // calendar date.
        p.paid_on ?? p.payment_date.slice(0, 10),
        p.payment_date,
        p.customerName,
        segmentName(p.segmentId),
        p.kind === 'other' ? 'Other' : 'Service',
        p.purpose ?? '',
        // A NUMBER, deliberately unformatted. See lib/csv.ts.
        p.amount,
        p.months_paid,
        PAYMENT_METHOD_LABELS[p.method],
        p.agent ?? '',
        ...(caps.checkoff ? [p.checkedOff ? 'Checked off' : 'Outstanding'] : []),
        p.notes ?? '',
      ])
    )
  }

  // The summary, after a blank line so the rows above stay a clean rectangle
  // that sorts and filters as a table. The three figures are the page's own
  // summary cards over the same rows.
  const pad = (label: string, value: string | number) => {
    const cells: (string | number | null)[] = new Array(header.length).fill('')
    cells[header.indexOf('Customer')] = label
    cells[header.indexOf('Amount (' + currency + ')')] = value
    return csvRow(cells)
  }

  rows.push(csvRow(new Array(header.length).fill('')))
  rows.push(pad('Payments', result.total))
  rows.push(pad('Total collected', result.totalCollected))
  rows.push(pad('Average payment', Math.round(result.averagePayment * 100) / 100))

  // Named for the company and the day it was taken, so two exports do not land
  // in a downloads folder as "export (1)".
  const today = new Date().toISOString().slice(0, 10)
  const filename = slug(company.name) + '-payments-' + today + '.csv'

  return new NextResponse(csvFile(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      // A report of money taken is never worth serving from a cache.
      'Cache-Control': 'no-store',
    },
  })
}
