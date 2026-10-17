import type { Metadata } from 'next'

import { resolveIncident } from '@/app/actions/incidents'
import { IncidentForm } from '@/components/incidents/IncidentForm'
import { listAccessPoints, listIncidents } from '@/lib/data/incidents'
import { getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Incidents · ISPMan' }

export default async function IncidentsPage() {
  const { company } = await requirePermission('manage_company_settings')
  const caps = await getSchemaCapabilities()

  if (!caps.portalTier2) {
    return (
      <div className="space-y-2">
        <h1 className="text-lg font-semibold text-gray-100">Outage incidents</h1>
        <p className="text-sm text-gray-400">Not set up on this database yet. Apply migration 0037_portal_tier2.sql.</p>
      </div>
    )
  }

  const [incidents, accessPoints] = await Promise.all([
    listIncidents(company.id),
    listAccessPoints(company.id),
  ])

  const fmt = (v: string | null) =>
    v ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(v)) : '—'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-100">Outage incidents</h1>
        <p className="text-sm text-gray-400">
          Customers in scope see a banner on the portal. SMS on open and restore is off by default
          — turn it on under Settings if you want it.
        </p>
      </div>

      <IncidentForm accessPoints={accessPoints} />

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">History</h2>
        {incidents.length === 0 ? (
          <p className="text-sm text-gray-500">No incidents yet.</p>
        ) : (
          <ul className="space-y-2">
            {incidents.map((i) => (
              <li key={i.id} className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-100">{i.title}</p>
                    <p className="text-xs text-gray-500">
                      {i.scope === 'company' ? 'Company-wide' : 'Access point: ' + (i.scopeValue ?? '?')}
                      {' · opened ' + fmt(i.openedAt)}
                      {i.status === 'open' && i.nextUpdateAt ? ' · next update by ' + fmt(i.nextUpdateAt) : ''}
                      {i.status === 'restored' ? ' · restored ' + fmt(i.restoredAt) : ''}
                    </p>
                    {i.message ? <p className="mt-1 text-sm text-gray-300">{i.message}</p> : null}
                  </div>
                  <span
                    className={
                      'shrink-0 rounded-full px-3 py-1 text-xs font-medium ' +
                      (i.status === 'open' ? 'bg-red-900/50 text-red-300' : 'bg-green-900/40 text-green-300')
                    }
                  >
                    {i.status === 'open' ? 'Open' : 'Restored'}
                  </span>
                </div>
                {i.status === 'open' ? (
                  <form action={resolveIncident} className="mt-3">
                    <input type="hidden" name="id" value={i.id} />
                    <button
                      type="submit"
                      className="rounded-md bg-green-700 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-green-600"
                    >
                      Mark restored
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
