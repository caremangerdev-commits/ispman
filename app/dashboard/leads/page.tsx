import type { Metadata } from 'next'
import Link from 'next/link'
import { MapPin, Plus } from 'lucide-react'

import { companySymbol } from '@/lib/data/currency'
import { listLeads, mapLink, type LeadStatus } from '@/lib/data/leads'
import { formatCurrency } from '@/lib/format'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Prospects · ISPMan' }

const STATUS_STYLES: Record<LeadStatus, { label: string; cls: string }> = {
  new: { label: 'New', cls: 'bg-blue-500/15 text-blue-400' },
  won: { label: 'Signed up', cls: 'bg-green-500/15 text-green-400' },
  lost: { label: 'Not interested', cls: 'bg-gray-700/40 text-gray-400' },
}

export default async function LeadsPage({ searchParams }: PageProps<'/dashboard/leads'>) {
  const { company, profile } = await requirePermission('manage_leads')
  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const status = (one(sp.status) ?? '') as LeadStatus | ''
  const query = one(sp.q) ?? ''

  const caps = await getSchemaCapabilities()
  if (!caps.leads) {
    return (
      <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-300/90">
        <strong className="font-semibold">Not set up yet.</strong> Door-to-door
        prospects need migration 0046. Ask your administrator to apply it.
      </p>
    )
  }

  // WHOSE PROSPECTS. A rep sees only the ones they signed up; the filter is
  // applied in the query, not here. See lib/data/leads.ts.
  const seesAll = can(profile.role, 'view_all_leads')

  const [{ rows, counts, wonValue }, symbol] = await Promise.all([
    listLeads({
      companyId: company.id,
      ownerId: seesAll ? null : profile.id,
      status,
      query,
    }),
    companySymbol(company.id),
  ])

  const tab = (value: LeadStatus | '', label: string, n: number) => {
    const params = new URLSearchParams()
    if (value) params.set('status', value)
    if (query) params.set('q', query)
    const href = '/dashboard/leads' + (params.size > 0 ? '?' + params : '')
    const active = status === value
    return (
      <Link
        key={value || 'all'}
        href={href}
        className={
          'rounded-lg px-3 py-1.5 text-xs font-semibold transition ' +
          (active ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700')
        }
      >
        {label} <span className="opacity-70">{n}</span>
      </Link>
    )
  }

  const total = counts.new + counts.won + counts.lost

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-gray-400">
            {seesAll
              ? 'Everyone the reps have signed up at the door.'
              : 'The people you have signed up at the door.'}
          </p>
          {counts.won > 0 ? (
            <p className="mt-0.5 text-xs text-gray-500">
              {counts.won} signed up, {formatCurrency(wonValue, symbol)} in installations.
            </p>
          ) : null}
        </div>
        <Link
          href="/dashboard/leads/new"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add prospect
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {tab('', 'All', total)}
        {tab('new', 'New', counts.new)}
        {tab('won', 'Signed up', counts.won)}
        {tab('lost', 'Not interested', counts.lost)}
      </div>

      <form method="get" className="flex gap-2">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search name, phone or address…"
          className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
        />
      </form>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 px-5 py-10 text-center">
          <p className="text-sm text-gray-400">
            {query || status ? 'Nothing matched.' : 'No prospects yet.'}
          </p>
          {!query && !status ? (
            <Link
              href="/dashboard/leads/new"
              className="mt-3 inline-block text-sm font-semibold text-blue-400 hover:text-blue-300"
            >
              Add the first one
            </Link>
          ) : null}
        </div>
      ) : (
        /* Cards rather than a table: this list is read on a phone as often as
           at a desk, and a table of eight columns is unreadable on one. */
        <ul className="space-y-2">
          {rows.map((l) => {
            const style = STATUS_STYLES[l.status]
            return (
              <li key={l.id}>
                <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 transition hover:border-gray-700">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={'/dashboard/leads/' + l.id}
                        className="text-sm font-semibold text-white transition hover:text-blue-400"
                      >
                        {l.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-gray-400">{l.phone}</p>
                      <p className="mt-0.5 text-xs text-gray-500">{l.address}</p>
                    </div>
                    <span
                      className={
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                        style.cls
                      }
                    >
                      {style.label}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                    {l.installFee > 0 ? (
                      <span className="tabular-nums text-gray-300">
                        {formatCurrency(l.installFee, symbol)} install
                      </span>
                    ) : null}
                    {l.monthlyRate !== null && l.monthlyRate > 0 ? (
                      <span className="tabular-nums">
                        {formatCurrency(l.monthlyRate, symbol)}/month
                      </span>
                    ) : null}
                    {seesAll && l.agent ? <span>by {l.agent}</span> : null}
                    {l.latitude !== null && l.longitude !== null ? (
                      <a
                        href={mapLink(l.latitude, l.longitude)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-blue-400 transition hover:text-blue-300"
                      >
                        <MapPin className="h-3.5 w-3.5" aria-hidden />
                        Map
                        {l.accuracyM !== null && l.accuracyM > 100 ? (
                          <span className="text-amber-400">(rough)</span>
                        ) : null}
                      </a>
                    ) : (
                      <span className="text-gray-600">No location</span>
                    )}
                  </div>

                  {l.status === 'won' && l.customerId ? (
                    <Link
                      href={'/dashboard/customers/' + l.customerId}
                      className="mt-2 inline-block text-xs font-semibold text-green-400 hover:text-green-300"
                    >
                      Open their account →
                    </Link>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {rows.some((l) => l.accuracyM !== null && l.accuracyM > 100) ? (
        <p className="text-[11px] text-gray-600">
          A location marked rough came from a weak signal. It is likely the right
          street rather than the right house — ring before sending anyone.
        </p>
      ) : null}
    </div>
  )
}
