import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
  AlertCircle, Ban, CheckCircle2, Clock, DollarSign, Users, WifiOff, XCircle,
} from 'lucide-react'

import { CustomerDonut } from '@/components/charts/CustomerDonut'
import { RevenueChart } from '@/components/charts/RevenueChart'
import { ActivityLog } from '@/components/dashboard/ActivityLog'
import { ExpiringCustomers } from '@/components/dashboard/ExpiringCustomers'
import { RecentPayments } from '@/components/dashboard/RecentPayments'
import { RecentTickets } from '@/components/dashboard/RecentTickets'
import {
  CashierDashboard, CsrDashboard, TechnicianDashboard,
} from '@/components/dashboard/RoleDashboards'
import { AccessDenied } from '@/components/ui/AccessDenied'
import { StatCard } from '@/components/ui/StatCard'
import { getDashboardData } from '@/lib/data/dashboard'
import {
  getCashierDashboard, getCsrDashboard, getTechnicianDashboard, searchCustomersLite,
} from '@/lib/data/roleDashboards'
import { formatCurrency } from '@/lib/format'
import { skipsDashboard } from '@/lib/home'
import { can, ROLE_LABELS } from '@/lib/permissions'
import { displayName, getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Dashboard · ISPMan' }

export default async function DashboardPage({ searchParams }: PageProps<'/dashboard'>) {
  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const denied = one(sp.denied)
  const query = one(sp.q) ?? ''

  const { profile, company } = await getSession()
  const role = profile.role

  // A cashier has no dashboard — the record-payment screen is their home.
  // requirePermission() bounces refused access to /dashboard?denied=…, so that
  // flag is carried across rather than dropped, or the cashier would be
  // silently redirected with no idea why.
  if (skipsDashboard(role)) {
    redirect(
      '/dashboard/payments/new' + (denied ? '?denied=' + encodeURIComponent(denied) : '')
    )
  }

  const banner = denied ? (
    <AccessDenied permission={denied} role={ROLE_LABELS[role]} />
  ) : null

  // Roles without KPI access get a task-focused home instead of the full
  // analytics dashboard. Each variant re-checks its own data permissions.
  if (!can(role, 'view_dashboard_kpis')) {
    const hits = query ? await searchCustomersLite(company.id, query) : []

    if (role === 'cashier') {
      const data = await getCashierDashboard(company.id, displayName(profile))
      return (
        <div className="space-y-4">
          {banner}
          <CashierDashboard data={data} query={query} hits={hits} />
        </div>
      )
    }

    if (role === 'technician') {
      const data = await getTechnicianDashboard(company.id, profile.id)
      return (
        <div className="space-y-4">
          {banner}
          <TechnicianDashboard data={data} query={query} hits={hits} />
        </div>
      )
    }

    // csr, and any future role that can see customers but not KPIs
    const data = await getCsrDashboard(company.id, profile.id)
    return (
      <div className="space-y-4">
        {banner}
        <CsrDashboard data={data} query={query} hits={hits} />
      </div>
    )
  }

  const {
    stats, revenue, statusBreakdown, recentPayments, urgentCustomers, recentTickets, activity,
  } = await getDashboardData(company.id)

  return (
    <div className="space-y-5">
      {banner}

      {/* PageHeading in the layout already greets by name, and the header bar
          carries the page title, so only the summary line survives here. */}
      <p className="text-sm text-gray-500">
        Here is what is happening across {company.name} today.
      </p>

      {/* Row 1 — KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total Customers" value={String(stats.totalCustomers)} icon={Users} accent="blue" trend={stats.totalCustomersTrend} />
        <StatCard
          label="Active Customers"
          value={String(stats.activeCustomers)}
          icon={CheckCircle2}
          accent="green"
          trend={stats.activeCustomersTrend}
          hint={stats.radiusKnown ? 'Currently able to get online' : 'Unable to reach network'}
        />
        {/* Every count below comes from the network registry, so the five
            status cards always sum to Total Customers. */}
        <StatCard label="Expired" value={String(stats.expiredCustomers)} icon={XCircle} accent="red" hint="Lapsed within 3 months" />
        <StatCard label="Inactive" value={String(stats.inactiveCustomers)} icon={Clock} accent="orange" hint="Lapsed over 3 months ago" />
        <StatCard label="Not Activated" value={String(stats.unprovisionedCustomers)} icon={WifiOff} accent="amber" hint="Not on the network yet" />
        <StatCard label="Disconnected" value={String(stats.disconnectedCustomers)} icon={Ban} accent="slate" hint="Taken off by an operator" />
        <StatCard label="Revenue This Month" value={formatCurrency(stats.revenueThisMonth)} icon={DollarSign} accent="emerald" trend={stats.revenueTrend} />
        <StatCard label="Outstanding Balance" value={formatCurrency(stats.outstandingBalance)} icon={AlertCircle} accent="orange" hint={'Across ' + stats.accountsInArrears + ' accounts'} />
      </div>

      {/* Row 2 — charts. Revenue is gated: it is a reporting view. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {can(role, 'view_revenue_reports') ? (
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5 lg:col-span-3">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-white">Revenue Over Time</h2>
              <div className="flex items-center gap-3 text-[11px] text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-blue-500" aria-hidden />
                  Total Billed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden />
                  Total Collected
                </span>
              </div>
            </div>
            <RevenueChart data={revenue} />
          </section>
        ) : null}

        <section
          className={
            'rounded-xl border border-gray-800 bg-gray-900 p-5 ' +
            (can(role, 'view_revenue_reports') ? 'lg:col-span-2' : 'lg:col-span-5')
          }
        >
          <h2 className="text-sm font-semibold text-white">Customer Status</h2>
          <p className="mb-3 mt-0.5 text-xs text-gray-500">
            Live from the network
          </p>
          <CustomerDonut data={statusBreakdown} />
        </section>
      </div>

      {/* Row 3 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {can(role, 'view_all_payments') ? <RecentPayments payments={recentPayments} /> : null}
        <ExpiringCustomers customers={urgentCustomers} />
      </div>

      {/* Row 4 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {can(role, 'view_support_tickets') ? <RecentTickets tickets={recentTickets} /> : null}
        <ActivityLog entries={activity} />
      </div>
    </div>
  )
}
