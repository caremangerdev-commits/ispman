import { NextResponse, type NextRequest } from 'next/server'

import { brandFor } from '@/lib/data/brand'
import { getCustomerPayments } from '@/lib/data/customers'
import { getPortalAccount } from '@/lib/data/portal'
import { formatCurrency } from '@/lib/format'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'
import { statementPdf, type StatementRow } from '@/lib/portal-statement'

/**
 * The signed-in customer's account statement (or one month's bill) as a PDF.
 * Company- and customer-scoped; financial data is never cached.
 *
 *   /api/portal/statement            full statement
 *   /api/portal/statement?month=YYYY-MM   that month's bill
 */
export const dynamic = 'force-dynamic'

function fmtDay(value: string): string {
  const d = new Date(value.length <= 10 ? value + 'T00:00:00' : value)
  if (!Number.isFinite(d.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

export async function GET(request: NextRequest) {
  const company = await getPortalCompany()
  if (!company) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  const session = await getPortalSession(company.id)
  if (!session) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const [account, payments, brand] = await Promise.all([
    getPortalAccount(company.id, session.customerId),
    getCustomerPayments(company.id, session.customerId),
    brandFor(company.id),
  ])
  if (!account) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  const month = request.nextUrl.searchParams.get('month')
  const monthMatch = month && /^\d{4}-\d{2}$/.test(month) ? month : null

  const chosen = monthMatch
    ? payments.filter((p) => (p.payment_date ?? '').slice(0, 7) === monthMatch)
    : payments

  const rows: StatementRow[] = chosen.map((p) => ({
    date: fmtDay(p.payment_date),
    description: p.months_paid && p.months_paid > 0
      ? p.months_paid + (p.months_paid === 1 ? ' month of service' : ' months of service')
      : 'Payment',
    amount: formatCurrency(Number(p.amount)),
  }))

  const summary: { label: string; value: string }[] = []
  if (account.billingAvailable) {
    summary.push({ label: account.balance > 0.005 ? 'Balance owing' : 'Balance', value: formatCurrency(account.balance) })
    if (account.credit > 0.005) summary.push({ label: 'Credit held', value: formatCurrency(account.credit) })
  }
  if (account.expiry) summary.push({ label: 'Service active until', value: fmtDay(account.expiry) })
  if (account.plan) summary.push({ label: 'Plan', value: account.plan.name + ' · ' + account.plan.downMbps + '/' + account.plan.upMbps + ' Mbps' })

  const heading = monthMatch
    ? 'Bill — ' + new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(monthMatch + '-01T00:00:00'))
    : 'Account statement'

  const { bytes } = statementPdf({
    brand,
    heading,
    generatedOn: fmtDay(new Date().toISOString()),
    customerName: account.name,
    accountNumber: account.accountNumber,
    summary,
    rows,
  })

  const filename = (monthMatch ? 'bill-' + monthMatch : 'statement') + '-' + company.slug + '.pdf'
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Cache-Control': 'no-store',
    },
  })
}
