import type { Metadata } from 'next'
import { Building2, DollarSign, Users } from 'lucide-react'

import { activateCompany, suspendCompany } from '@/app/actions/platform'
import { getPlatformStats } from '@/lib/data/platform'
import { formatCurrency } from '@/lib/format'

export const metadata: Metadata = { title: 'Platform Overview · ISPMan' }

const PLAN_STYLES: Record<string, string> = {
  professional: 'bg-blue-500/15 text-blue-400',
  starter: 'bg-gray-600/30 text-gray-300',
  enterprise: 'bg-violet-500/15 text-violet-400',
}

export default async function SuperAdminPage() {
  // Access is enforced by app/superadmin/layout.tsx.
  const stats = await getPlatformStats()

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">Platform Overview</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Across every company on ISPMan.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total Companies" value={String(stats.companyCount)} icon={Building2} tone="bg-amber-500/10 text-amber-400" />
        <Stat label="Total Customers" value={String(stats.customerCount)} icon={Users} tone="bg-blue-500/10 text-blue-400" />
        <Stat label="Revenue This Month" value={formatCurrency(stats.revenueThisMonth)} icon={DollarSign} tone="bg-green-500/10 text-green-400" />
      </div>

      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Companies</h2>
          <p className="text-xs text-gray-500">{stats.companies.length} on platform</p>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-5 py-2 font-semibold">Company</th>
                <th scope="col" className="px-5 py-2 text-right font-semibold">Customers</th>
                <th scope="col" className="px-5 py-2 font-semibold">Plan</th>
                <th scope="col" className="px-5 py-2 font-semibold">Status</th>
                <th scope="col" className="px-5 py-2 font-semibold">Joined</th>
                <th scope="col" className="px-5 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {stats.companies.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-gray-600">
                    No companies on the platform yet.
                  </td>
                </tr>
              )}

              {stats.companies.map((c) => {
                const suspended = (c.status ?? '').toLowerCase() === 'suspended'
                return (
                  <tr key={c.id} className="transition hover:bg-gray-800/40">
                    <td className="px-5 py-2.5 font-medium text-gray-200">{c.name}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-gray-300">
                      {c.customerCount}
                    </td>
                    <td className="px-5 py-2.5">
                      <span
                        className={
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                          (PLAN_STYLES[c.plan ?? ''] ?? 'bg-gray-700/40 text-gray-400')
                        }
                      >
                        {c.plan ?? 'none'}
                      </span>
                    </td>
                    <td className="px-5 py-2.5">
                      <span
                        className={
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                          (suspended
                            ? 'bg-red-500/15 text-red-400'
                            : 'bg-green-500/15 text-green-400')
                        }
                      >
                        {c.status ?? 'unknown'}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-gray-400">
                      {c.created_at
                        ? new Date(c.created_at).toLocaleDateString('en-US', {
                            day: 'numeric', month: 'short', year: 'numeric',
                          })
                        : '—'}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="cursor-not-allowed rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-500">
                          View
                        </span>

                        {suspended ? (
                          <form action={activateCompany}>
                            <input type="hidden" name="id" value={c.id} />
                            <button
                              type="submit"
                              className="rounded-md bg-green-500/10 px-2 py-1 text-[11px] font-semibold text-green-400 transition hover:bg-green-500/20"
                            >
                              Activate
                            </button>
                          </form>
                        ) : (
                          <form action={suspendCompany}>
                            <input type="hidden" name="id" value={c.id} />
                            <button
                              type="submit"
                              className="rounded-md bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-400 transition hover:bg-red-500/20"
                            >
                              Suspend
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-gray-600">
        Platform queries use the service-role client and are intentionally not
        scoped by company. Companies and Settings pages are not built yet.
      </p>
    </div>
  )
}

function Stat({
  label, value, icon: Icon, tone,
}: {
  label: string
  value: string
  icon: React.ElementType
  tone: string
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <span className={'flex h-9 w-9 items-center justify-center rounded-lg ' + tone}>
        <Icon className="h-4.5 w-4.5" aria-hidden />
      </span>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-white">{value}</p>
      <p className="mt-0.5 text-xs font-medium text-gray-400">{label}</p>
    </div>
  )
}
