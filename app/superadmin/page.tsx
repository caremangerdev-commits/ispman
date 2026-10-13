import type { Metadata } from 'next'
import Link from 'next/link'
import { Building2, DollarSign, Plus, Users } from 'lucide-react'

import { activateCompany, suspendCompany } from '@/app/actions/platform'
import { EnterCompanyButton } from '@/components/platform/EnterCompanyButton'
import { getPlatformStats } from '@/lib/data/platform'
import { livePeersAllCompanies } from '@/lib/data/tunnels'
import { formatCurrency } from '@/lib/format'
import { getSchemaCapabilities } from '@/lib/schema'
import {
  readHandshakes, readSyncStatus, tunnelSyncConfigured, type SyncStatus,
} from '@/lib/tunnels/server'
import { ago, tunnelStatus, type TunnelStatus } from '@/lib/tunnels/status'

export const metadata: Metadata = { title: 'Platform Overview · ISPMan' }

const PLAN_STYLES: Record<string, string> = {
  professional: 'bg-blue-500/15 text-blue-400',
  starter: 'bg-gray-600/30 text-gray-300',
  enterprise: 'bg-violet-500/15 text-violet-400',
}

/**
 * Every live router tunnel, in every company, that is not up: waiting for the
 * server side, never connected, or down. Company admins add their own
 * routers now, so this is where the platform operator sees one waiting
 * without opening each company. Null before migration 0033.
 */
async function tunnelsNeedingAttention() {
  if (!(await getSchemaCapabilities()).routerTunnels) return null
  const [peers, handshakes, sync] = await Promise.all([
    livePeersAllCompanies(), readHandshakes(), readSyncStatus(),
  ])
  const now = new Date()
  const rows = peers
    .map((p) => ({ ...p, ...tunnelStatus(p.publicKey, handshakes, now) }))
    .filter((r) => r.status !== 'up')
  return { rows, live: peers.length, sync, automatic: tunnelSyncConfigured(), now }
}

export default async function SuperAdminPage() {
  // Access is enforced by app/superadmin/layout.tsx.
  const [stats, tunnels] = await Promise.all([getPlatformStats(), tunnelsNeedingAttention()])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">Platform Overview</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Across every company on ISPMan.
          </p>
        </div>

        <Link
          href="/superadmin/companies/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-amber-500"
        >
          <Plus className="h-4 w-4" aria-hidden />
          New Company
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total Companies" value={String(stats.companyCount)} icon={Building2} tone="bg-amber-500/10 text-amber-400" />
        <Stat label="Total Customers" value={String(stats.customerCount)} icon={Users} tone="bg-blue-500/10 text-blue-400" />
        <Stat label="Revenue This Month" value={formatCurrency(stats.revenueThisMonth)} icon={DollarSign} tone="bg-green-500/10 text-green-400" />
      </div>

      {tunnels ? <TunnelsAttention {...tunnels} /> : null}

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
                    <td className="px-5 py-2.5">
                      <Link
                        href={'/superadmin/companies/' + c.id}
                        className="font-medium text-gray-200 transition hover:text-amber-400"
                      >
                        {c.name}
                      </Link>
                    </td>
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
                        <Link
                          href={'/superadmin/companies/' + c.id}
                          className="rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                        >
                          View
                        </Link>

                        <EnterCompanyButton companyId={c.id} />

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
        scoped by company. A company is otherwise managed from inside its own
        dashboard.
      </p>
    </div>
  )
}

const TUNNEL_CLS: Record<TunnelStatus, string> = {
  up: 'bg-green-500/15 text-green-400',
  down: 'bg-red-500/15 text-red-400',
  never: 'bg-red-500/15 text-red-400',
  not_on_server: 'bg-amber-500/15 text-amber-400',
  waiting: 'bg-blue-500/15 text-blue-400',
  unknown: 'bg-gray-700/40 text-gray-400',
}

/** One line on how the server side is running: the root job's last run, or that it is done by hand. */
function SyncLine({ sync, automatic, now }: { sync: SyncStatus | null; automatic: boolean; now: Date }) {
  const line = (cls: string, text: React.ReactNode) => (
    <p className={'border-b border-gray-800 px-5 py-2 text-xs ' + cls}>{text}</p>
  )
  if (!sync) {
    return automatic
      ? line('text-amber-400', 'Server sync is on, but its status is not reported (WG_SYNC_STATUS_FILE).')
      : line('text-gray-500', "Server side is by hand: run each router's server block from the company's Router Tunnels page.")
  }
  if (!sync.fresh) {
    return line(
      'text-amber-400',
      <>Server sync last ran {ago(now.getTime() - sync.ranAt.getTime())}. Check <code>systemctl status ispman-wg-sync.timer</code>.</>
    )
  }
  if (!sync.ok) return line('text-red-400', 'Last server sync changed nothing: ' + (sync.error ?? 'unknown error'))
  if (sync.held.length > 0) {
    return line(
      'text-red-400',
      <>
        Server sync is holding {sync.held.length} removal{sync.held.length === 1 ? '' : 's'} (more at once
        than it is allowed). If they are right, run <code>sudo ispman-wg-sync --allow-removals {sync.held.length}</code>.
      </>
    )
  }
  return line('text-green-400', 'Server sync ran ' + ago(now.getTime() - sync.ranAt.getTime()) + '.')
}

function TunnelsAttention({
  rows, live, sync, automatic, now,
}: NonNullable<Awaited<ReturnType<typeof tunnelsNeedingAttention>>>) {
  const waiting = rows.filter((r) => r.status === 'not_on_server').length

  return (
    <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
      <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3">
        <h2 className="text-sm font-semibold text-white">Router tunnels needing attention</h2>
        <p className="text-xs text-gray-500">
          {waiting} waiting for the server side · {rows.length - waiting} other · {live} live
        </p>
      </header>

      <SyncLine sync={sync} automatic={automatic} now={now} />

      {rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-gray-600">Every live router tunnel is up.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-5 py-2 font-semibold">Company</th>
                <th scope="col" className="px-5 py-2 font-semibold">Router</th>
                <th scope="col" className="px-5 py-2 font-semibold">Address</th>
                <th scope="col" className="px-5 py-2 font-semibold">State</th>
                <th scope="col" className="px-5 py-2 font-semibold">Key saved</th>
                <th scope="col" className="px-5 py-2 text-right font-semibold" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-gray-800/40">
                  <td className="px-5 py-2.5">
                    <Link
                      href={'/superadmin/companies/' + r.companyId}
                      className="font-medium text-gray-200 transition hover:text-amber-400"
                    >
                      {r.companyName}
                    </Link>
                  </td>
                  <td className="px-5 py-2.5 text-gray-300">{r.name}</td>
                  <td className="px-5 py-2.5 font-mono text-xs text-gray-400">{r.tunnelIp}</td>
                  <td className="px-5 py-2.5">
                    <span className={'rounded px-1.5 py-0.5 text-[11px] font-semibold ' + TUNNEL_CLS[r.status]}>
                      {r.text}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-gray-400">
                    {r.keySetAt ? ago(now.getTime() - new Date(r.keySetAt).getTime()) : '—'}
                  </td>
                  <td className="px-5 py-2.5">
                    <div className="flex justify-end">
                      <EnterCompanyButton companyId={r.companyId} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
