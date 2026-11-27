import { NextResponse, type NextRequest } from 'next/server'

import { csvFile, csvRow, slug } from '@/lib/csv'
import { filtersFromParams } from '@/lib/customer-filter'
import { listMiscCategories, listServicePlans } from '@/lib/data/catalog'
import { getCurrency } from '@/lib/data/company'
import { listCustomers } from '@/lib/data/customers'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { CUSTOMER_STATUSES, STATUS_LABELS, type CustomerStatus } from '@/lib/status'

function isStatus(v: string): v is CustomerStatus {
  return (CUSTOMER_STATUSES as string[]).includes(v)
}

/**
 * The customer list as a CSV of the CURRENT FILTERED SET, the way the payments
 * export does it: the same query string through the same filtersFromParams and
 * listCustomers the page uses, without the paging. Manager and above
 * (import_customers): the same people who can bring a customer list in may
 * take one out. No tax ID column, for the reason the payments export gives.
 */
export async function GET(request: NextRequest) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'import_customers')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sp = request.nextUrl.searchParams
  const filters = filtersFromParams((k) => sp.get(k) ?? undefined, isStatus)

  const [list, currency, plans, cats] = await Promise.all([
    listCustomers({ companyId: company.id, filters, page: 1, perPage: 1_000_000 }),
    getCurrency(company.id),
    listServicePlans(company.id).catch(() => []),
    listMiscCategories(company.id).catch(() => []),
  ])
  const planName = new Map(plans.map((p) => [p.id, p.name]))
  const catName = new Map(cats.map((c) => [c.id, c.name]))

  const header = [
    'Account No', 'First name', 'Last name', 'Phone', 'Email', 'Address', 'Plan', 'Category',
    'Monthly rate (' + currency + ')', 'Balance (' + currency + ')', 'Credit (' + currency + ')',
    'Status', 'Service until', 'Bill day', 'MAC address', 'Connection', 'Access point', 'Added',
  ]
  const rows = [csvRow(header)]
  for (const c of list.rows) {
    rows.push(csvRow([
      c.account_number ?? '',
      c.first_name ?? '',
      c.last_name ?? '',
      c.phone ?? '',
      c.email ?? '',
      c.address ?? '',
      c.service_plan_id ? (planName.get(c.service_plan_id) ?? '') : '',
      c.misc_category_id ? (catName.get(c.misc_category_id) ?? '') : '',
      // Bare numbers, so the columns sum. See lib/csv.ts.
      Number(c.monthly_rate ?? 0),
      Number(c.carried_balance ?? 0),
      Number(c.account_credit ?? 0),
      c.radiusStatus ? STATUS_LABELS[c.radiusStatus] : '',
      c.radiusExpiryDate ?? '',
      c.bill_date ?? '',
      c.mac_address ?? '',
      c.connection_type ?? '',
      c.access_point ?? '',
      c.date_added ? String(c.date_added).slice(0, 10) : '',
    ]))
  }

  const today = new Date().toISOString().slice(0, 10)
  const filename = slug(company.name) + '-customers-' + today + '.csv'
  return new NextResponse(csvFile(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Cache-Control': 'no-store',
    },
  })
}
