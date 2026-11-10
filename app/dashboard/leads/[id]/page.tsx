import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, MapPin } from 'lucide-react'

import { EditLeadForm } from '@/components/leads/EditLeadForm'
import { LeadActions } from '@/components/leads/LeadActions'
import { listServicePlans } from '@/lib/data/catalog'
import { companySymbol } from '@/lib/data/currency'
import { accuracyLabel, getLead, mapLink } from '@/lib/data/leads'
import { formatCurrency } from '@/lib/format'
import { can } from '@/lib/permissions'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Prospect · ISPMan' }

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd className="text-right text-sm">{children}</dd>
    </div>
  )
}

const fmtWhen = (value: string) =>
  new Date(value).toLocaleString('en-US', {
    day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })

export default async function LeadPage({ params }: PageProps<'/dashboard/leads/[id]'>) {
  const { company, profile } = await requirePermission('manage_leads')
  const { id } = await params
  const leadId = Number(id)

  // A rep asking for somebody else's prospect gets the same answer as for one
  // that does not exist — the owner filter is in the query. See lib/data/leads.ts.
  const seesAll = can(profile.role, 'view_all_leads')
  const lead = await getLead(company.id, leadId, seesAll ? null : profile.id)
  if (!lead) notFound()

  const [symbol, plans] = await Promise.all([
    companySymbol(company.id),
    listServicePlans(company.id).catch(() => []),
  ])

  /**
   * WHO CAN STILL BE SOLD TO. Anything that has not already become a customer
   * — which includes one marked "not interested" (owner, 10 Nov 2026).
   *
   * That used to be `status === 'new'`, so a no at the door was final in the
   * interface: a prospect who rang back a week later had nowhere to go, even
   * though convertLead itself has always allowed it. Only an actual customer
   * is the end of the line.
   */
  const sellable = lead.customerId === null

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Link
        href="/dashboard/leads"
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to prospects
      </Link>

      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">{lead.name}</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          {lead.status === 'won'
            ? 'Signed up' + (lead.convertedAt ? ' on ' + fmtWhen(lead.convertedAt) : '')
            : lead.status === 'lost'
              ? 'Not interested'
              : 'Prospect, not a customer yet'}
        </p>
      </div>

      {lead.status === 'won' && lead.customerId ? (
        <Link
          href={'/dashboard/customers/' + lead.customerId}
          className="block rounded-xl border border-green-900 bg-green-950/30 px-5 py-4 transition hover:bg-green-950/50"
        >
          <p className="text-sm font-semibold text-green-300">Open their account →</p>
          <p className="mt-0.5 text-xs text-green-400/70">
            They are not on the network until a MAC is added to it.
          </p>
        </Link>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <dl className="divide-y divide-gray-800">
          <Row label="Phone">
            <a href={'tel:' + lead.phone} className="text-blue-400 transition hover:text-blue-300">
              {lead.phone}
            </a>
          </Row>
          <Row label="Address">
            <span className="text-gray-200">{lead.address}</span>
          </Row>
          <Row label="Location">
            {lead.latitude !== null && lead.longitude !== null ? (
              <span className="inline-flex flex-col items-end gap-0.5">
                <a
                  href={mapLink(lead.latitude, lead.longitude)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-blue-400 transition hover:text-blue-300"
                >
                  <MapPin className="h-3.5 w-3.5" aria-hidden />
                  Open in a map
                </a>
                <span className="font-mono text-[11px] text-gray-500">
                  {lead.latitude.toFixed(6)}, {lead.longitude.toFixed(6)}
                </span>
                {/* The radius, in words. A coordinate without it cannot be
                    trusted — see components/leads/LocationCapture.tsx. */}
                {accuracyLabel(lead.accuracyM) ? (
                  <span
                    className={
                      'text-[11px] ' +
                      ((lead.accuracyM ?? 0) > 100 ? 'text-red-400'
                        : (lead.accuracyM ?? 0) > 20 ? 'text-amber-400'
                          : 'text-gray-500')
                    }
                  >
                    Accurate {accuracyLabel(lead.accuracyM)}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-gray-500">
                None captured — ring before sending anyone
              </span>
            )}
          </Row>
          <Row label="Installation quoted">
            <span className="tabular-nums text-gray-200">
              {lead.installFee > 0 ? formatCurrency(lead.installFee, symbol) : '—'}
            </span>
          </Row>
          <Row label="Monthly quoted">
            <span className="tabular-nums text-gray-200">
              {lead.monthlyRate !== null && lead.monthlyRate > 0
                ? formatCurrency(lead.monthlyRate, symbol)
                : '—'}
            </span>
          </Row>
          <Row label="Signed up by">
            <span className="text-gray-200">{lead.agent ?? '—'}</span>
          </Row>
          <Row label="Recorded">
            <span className="text-gray-400">{fmtWhen(lead.createdAt)}</span>
          </Row>
          {lead.notes ? (
            <Row label="Notes">
              <span className="whitespace-pre-wrap text-gray-300">{lead.notes}</span>
            </Row>
          ) : null}
          {lead.lostReason ? (
            <Row label="Why not">
              <span className="whitespace-pre-wrap text-gray-300">{lead.lostReason}</span>
            </Row>
          ) : null}
        </dl>
      </section>

      {sellable ? (
        <LeadActions
          leadId={lead.id}
          installFee={lead.installFee}
          canConvert={can(profile.role, 'convert_lead')}
          // Already a no: offering it again is the one button that does nothing.
          canMarkLost={lead.status !== 'lost'}
        />
      ) : null}

      {/* Editing needs no permission of its own: reaching this page at all
          means manage_leads, and getLead() has already decided it is one of
          yours to see. See updateLead() in app/actions/leads.ts. */}
      <EditLeadForm
        lead={lead}
        servicePlans={plans}
        canDelete={can(profile.role, 'delete_lead')}
      />
    </div>
  )
}
