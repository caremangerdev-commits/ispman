import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { CheckoffClient } from '@/components/checkoff/CheckoffClient'
import { HandoverHistory } from '@/components/checkoff/HandoverHistory'
import {
  getAllAgentsSummary, getCheckoffSummary, handoverDateFor, listAgents,
  listHandovers, lastHandoverByAgent,
} from '@/lib/data/checkoff'
import { getGeneralSettings } from '@/lib/data/company'
import { currencySymbol } from '@/lib/format'
import { CHECKOFF_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { can } from '@/lib/permissions'

export const metadata: Metadata = { title: 'Checkoff · ISPMan' }

export default async function CheckoffPage({
  searchParams,
}: PageProps<'/dashboard/checkoff'>) {
  const { company, profile } = await getSession()

  // view_checkoff covers super_admin, company_admin and manager — a CSR or
  // cashier collects money but does not reconcile it.
  if (!can(profile.role, 'view_checkoff')) {
    redirect('/dashboard?denied=view_checkoff')
  }

  const caps = await getSchemaCapabilities()

  if (!caps.checkoff) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-6">
          <p className="text-sm font-semibold text-amber-300">
            Checkoff is not set up on this system yet.
          </p>
          <p className="mt-1.5 text-sm text-amber-400/80">{CHECKOFF_HINT}</p>
          <p className="mt-3 text-xs text-gray-500">
            Payments still record normally in the meantime.
          </p>
        </div>
      </div>
    )
  }

  const sp = await searchParams
  const raw = Array.isArray(sp.agent) ? sp.agent[0] : sp.agent
  const agentId = Number(raw)

  const viewRaw = Array.isArray(sp.view) ? sp.view[0] : sp.view
  const view: 'outstanding' | 'history' = viewRaw === 'history' ? 'history' : 'outstanding'

  const settings = await getGeneralSettings(company.id)
  const [agents, allAgents, handovers, handoverIndex] = await Promise.all([
    listAgents(company.id),
    getAllAgentsSummary({ companyId: company.id, timezone: settings.timezone }),
    listHandovers(company.id),
    lastHandoverByAgent(company.id),
  ])

  const selectedAgent = Number.isInteger(agentId)
    ? agents.find((a) => a.id === agentId) ?? null
    : null

  const summary = selectedAgent
    ? await getCheckoffSummary({
        companyId: company.id,
        agent: selectedAgent,
        timezone: settings.timezone,
      })
    : null

  // Tabs are server-rendered links rather than state inside CheckoffClient:
  // the two views load different data, and putting the switch in the URL means
  // a handover history can be linked to and survives a refresh.
  const tab = (key: 'outstanding' | 'history', label: string, count?: number) => {
    const active = view === key
    return (
      <Link
        key={key}
        href={'/dashboard/checkoff' + (key === 'history' ? '?view=history' : '')}
        aria-current={active ? 'page' : undefined}
        className={
          'rounded-lg px-3 py-1.5 text-xs font-medium transition ' +
          (active
            ? 'bg-blue-600 text-white'
            : 'bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200')
        }
      >
        {label}
        {count !== undefined ? (
          <span className={'ml-1.5 ' + (active ? 'text-blue-200' : 'text-gray-600')}>
            {count}
          </span>
        ) : null}
      </Link>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {tab('outstanding', 'Outstanding')}
        {tab('history', 'Past handovers', handovers.rows.length)}
      </div>

      {view === 'history' ? (
        <HandoverHistory
          rows={handovers.rows}
          symbol={currencySymbol(settings.currency)}
        />
      ) : (
        <CheckoffClient
          agents={agents}
          selectedAgent={selectedAgent}
          summary={summary}
          allAgents={{
            rows: allAgents.rows, total: allAgents.total, customers: allAgents.customers,
          }}
          currency={settings.currency}
          timezone={settings.timezone}
          lastHandoverIso={
            selectedAgent ? handoverDateFor(selectedAgent, handoverIndex) : null
          }
        />
      )}
    </div>
  )
}
