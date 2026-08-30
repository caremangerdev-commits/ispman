import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { CheckoffClient } from '@/components/checkoff/CheckoffClient'
import {
  getAllAgentsSummary, getCheckoffSummary, listAgents,
} from '@/lib/data/checkoff'
import { getGeneralSettings } from '@/lib/data/company'
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
        <h1 className="text-xl font-semibold tracking-tight text-white">Checkoff</h1>
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

  const settings = await getGeneralSettings(company.id)
  const [agents, allAgents] = await Promise.all([
    listAgents(company.id),
    getAllAgentsSummary({ companyId: company.id, timezone: settings.timezone }),
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

  return (
    <CheckoffClient
      agents={agents}
      selectedAgent={selectedAgent}
      summary={summary}
      allAgents={{ rows: allAgents.rows, total: allAgents.total, customers: allAgents.customers }}
      currency={settings.currency}
      timezone={settings.timezone}
    />
  )
}
