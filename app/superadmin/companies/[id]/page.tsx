import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Building2, DollarSign, SlidersHorizontal, Users } from 'lucide-react'

import { CompanyUsers } from '@/components/platform/CompanyUsers'
import { getCompanyDetail } from '@/lib/data/platform'
import { formatCurrency } from '@/lib/format'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Company · ISPMan' }

const PLAN_STYLES: Record<string, string> = {
  professional: 'bg-blue-500/15 text-blue-400',
  starter: 'bg-gray-600/30 text-gray-300',
  enterprise: 'bg-violet-500/15 text-violet-400',
}

const dateFmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    : '—'

function Card({ title, icon: Icon, children }: {
  title: string
  icon: React.ElementType
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900">
      <header className="flex items-center gap-2 border-b border-gray-800 px-5 py-2.5">
        <Icon className="h-4 w-4 text-gray-500" aria-hidden />
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </header>
      <dl className="divide-y divide-gray-800/70">{children}</dl>
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2">
      <dt className="shrink-0 text-xs text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-right text-sm text-gray-200">{value}</dd>
    </div>
  )
}

const dash = <span className="text-gray-600">—</span>

/**
 * The platform operator's view of one tenant.
 *
 * Access is enforced by app/superadmin/layout.tsx, which checks is_super_admin,
 * and again by resetPasswordAsSuperAdmin — the single write this page offers.
 *
 * READ ONLY OTHERWISE, deliberately. A super admin can see a company and
 * recover access to it; everything else is operated from inside the tenant by
 * someone who belongs to it. There is no company switcher and this page is not
 * one.
 */
export default async function CompanyDetailPage({
  params,
}: PageProps<'/superadmin/companies/[id]'>) {
  const { id } = await params
  const companyId = Number(id)
  if (!Number.isInteger(companyId)) notFound()

  const [detail, session] = await Promise.all([getCompanyDetail(companyId), getSession()])
  if (!detail) notFound()

  const { company, settings, counts, users } = detail
  const suspended = (company.status ?? '').toLowerCase() === 'suspended'

  return (
    <div className="space-y-4">
      <Link
        href="/superadmin"
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to platform overview
      </Link>

      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-xl font-semibold tracking-tight text-white">{company.name}</h1>
        <span
          className={
            'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
            (PLAN_STYLES[company.plan ?? ''] ?? 'bg-gray-700/40 text-gray-400')
          }
        >
          {company.plan ?? 'none'}
        </span>
        <span
          className={
            'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
            (suspended ? 'bg-red-500/15 text-red-400' : 'bg-green-500/15 text-green-400')
          }
        >
          {company.status ?? 'unknown'}
        </span>
      </div>

      {/* Counts */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Customers" value={String(counts.customers)} icon={Users} tone="bg-blue-500/10 text-blue-400" />
        <Stat label="Users" value={String(counts.users)} icon={Building2} tone="bg-amber-500/10 text-amber-400" />
        <Stat
          label={'Payments This Month' + (counts.paymentsThisMonth ? ' (' + counts.paymentsThisMonth + ')' : '')}
          value={formatCurrency(counts.revenueThisMonth)}
          icon={DollarSign}
          tone="bg-green-500/10 text-green-400"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Company" icon={Building2}>
          <Row label="Name" value={company.name} />
          <Row label="Email" value={company.email ?? dash} />
          <Row label="Phone" value={company.phone ?? dash} />
          <Row label="Address" value={company.address ?? dash} />
          <Row label="Plan" value={company.plan ?? dash} />
          <Row label="Status" value={company.status ?? dash} />
          <Row label="Created" value={dateFmt(company.created_at)} />
        </Card>

        <Card title="Settings" icon={SlidersHorizontal}>
          {settings ? (
            <>
              <Row label="Currency" value={settings.currency ?? dash} />
              <Row label="Timezone" value={settings.timezone ?? dash} />
              <Row
                label="Cut Off Day"
                value={settings.cut_off_date ? 'Day ' + settings.cut_off_date : dash}
              />
              <Row
                label="Bill Day"
                value={settings.bill_date ? 'Day ' + settings.bill_date : dash}
              />
              <Row
                label="Grace Period"
                value={
                  settings.grace_period_days === null
                    ? dash
                    : settings.grace_period_days + ' day' + (settings.grace_period_days === 1 ? '' : 's')
                }
              />
              <Row label="SMS Notifications" value={settings.sms_enabled ? 'On' : 'Off'} />
              <Row label="Email Notifications" value={settings.email_enabled ? 'On' : 'Off'} />
            </>
          ) : (
            <div className="px-5 py-6">
              <p className="text-sm text-red-400">This company has no settings row.</p>
              <p className="mt-1 text-xs text-gray-500">
                It will fall back to application defaults. Step 2 of company creation may
                have failed.
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* Users */}
      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Users</h2>
          <p className="text-xs text-gray-500">
            {users.length} {users.length === 1 ? 'account' : 'accounts'} · every role shown
          </p>
        </header>

        <CompanyUsers users={users} currentUserId={session.profile.id} />
      </section>

      <p className="text-xs text-gray-600">
        Read only apart from Reset Password. Company details, settings and user accounts are
        edited from inside the tenant by someone who belongs to it.
      </p>
    </div>
  )
}

function Stat({ label, value, icon: Icon, tone }: {
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
