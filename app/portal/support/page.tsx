import { notFound, redirect } from 'next/navigation'

import { TicketComposer } from '@/components/portal/TicketComposer'
import { listPortalTickets } from '@/lib/data/portal-tickets'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'
import { getSchemaCapabilities } from '@/lib/schema'

export const dynamic = 'force-dynamic'

const STATUS: Record<string, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' }

function fmtDay(value: string): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

export default async function SupportPage() {
  const company = await getPortalCompany()
  if (!company) notFound()
  const session = await getPortalSession(company.id)
  if (!session) redirect('/')
  if (!(await getSchemaCapabilities()).portalTier2) notFound()

  const tickets = await listPortalTickets(company.id, session.customerId)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Support</h1>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts; a full nav keeps that rewrite */}
        <a href="/" className="text-sm text-neutral-500">← Account</a>
      </header>

      {tickets.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium text-neutral-500">Your tickets</h2>
          <ul className="flex flex-col gap-2">
            {tickets.map((t) => (
              <li key={t.id}>
                <a
                  href={'/support/' + t.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3 active:bg-neutral-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-base font-medium">{t.title}</span>
                    <span className="text-sm text-neutral-500">{fmtDay(t.createdAt)}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                    {STATUS[t.status] ?? t.status}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-neutral-200 p-5">
        <h2 className="mb-3 text-base font-semibold">Open a ticket</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Tell us what’s wrong. A photo of your router’s lights or the cabling helps a lot.
        </p>
        <TicketComposer mode="new" />
      </section>
    </div>
  )
}
