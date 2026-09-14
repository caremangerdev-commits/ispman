import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { notFound } from 'next/navigation'

import { getSmsBatchMessages, isDirectAudience, listSmsBatches } from '@/lib/data/sms'
import { formatDateTime } from '@/lib/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

export const metadata: Metadata = { title: 'Message Batch · ISPMan' }

const STATUS_STYLE: Record<string, string> = {
  queued: 'bg-gray-700/40 text-gray-300',
  sending: 'bg-blue-500/15 text-blue-300',
  sent: 'bg-green-500/15 text-green-400',
  delivered: 'bg-green-500/15 text-green-400',
  failed: 'bg-red-500/15 text-red-400',
  cancelled: 'bg-gray-700/40 text-gray-500',
}

export default async function BatchPage({ params }: PageProps<'/dashboard/messages/[id]'>) {
  const { company } = await requirePermission('send_bulk_sms')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) notFound()

  const { id } = await params
  const batchId = Number(id)
  if (!Number.isInteger(batchId)) notFound()

  // Scoped by company, so a batch id from another tenant is a 404 and not a
  // read of somebody else's customer list.
  const batches = await listSmsBatches(company.id, 200)
  const batch = batches.find((b) => b.id === batchId)
  if (!batch) notFound()

  const messages = await getSmsBatchMessages(company.id, batchId)

  // Names for the rows, in one query rather than one per message.
  const ids = [...new Set(messages.map((m) => m.customerId).filter((v): v is number => v !== null))]
  const names = new Map<number, string>()
  if (ids.length > 0) {
    const { data } = await tenantClient()
      .from('customers').select('id, first_name, last_name')
      .eq('company_id', company.id).in('id', ids)
    for (const r of (data ?? []) as { id: number; first_name: string | null; last_name: string | null }[]) {
      names.set(r.id, [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Customer #' + r.id)
    }
  }

  return (
    <div className="max-w-4xl space-y-4">
      <Link
        href="/dashboard/messages"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to messages
      </Link>

      <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-gray-200">
              Sent by {batch.sentByName}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {formatDateTime(batch.createdAt)}
            </p>
          </div>
          <div className="flex gap-4 text-right">
            <div>
              <p className="text-lg font-semibold text-green-400">{batch.sent}</p>
              <p className="text-[11px] text-gray-500">sent</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-red-400">{batch.failed}</p>
              <p className="text-[11px] text-gray-500">failed</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-gray-400">{batch.skipped}</p>
              <p className="text-[11px] text-gray-500">skipped</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg bg-gray-950 p-3">
          <p className="whitespace-pre-wrap font-mono text-xs text-gray-300">{batch.body}</p>
        </div>

        {batch.audience ? (
          <p className="text-xs text-gray-500">
            <span className="text-gray-400">Audience:</span> {batch.audience}
          </p>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Customer</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Number</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {messages.map((m) => (
                <tr key={m.id} className="transition hover:bg-gray-800/40">
                  <td className="px-4 py-2.5">
                    {m.customerId ? (
                      <Link
                        href={'/dashboard/customers/' + m.customerId}
                        className="text-gray-300 transition hover:text-blue-400"
                      >
                        {names.get(m.customerId) ?? 'Customer #' + m.customerId}
                      </Link>
                    ) : isDirectAudience(batch.audience) ? (
                      <span className="text-gray-500">Direct number</span>
                    ) : (
                      <span className="text-gray-600">Customer removed</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-gray-500">
                    +{m.phone}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        'rounded px-1.5 py-0.5 text-[11px] font-medium ' +
                        (STATUS_STYLE[m.status] ?? 'bg-gray-700/40 text-gray-400')
                      }
                    >
                      {m.status}
                    </span>
                  </td>
                  <td className="max-w-[18rem] px-4 py-2.5 text-xs text-gray-500">
                    {m.error ? (
                      <span className="block truncate text-red-400" title={m.error}>
                        {m.error}
                      </span>
                    ) : m.sentAt ? (
                      formatDateTime(m.sentAt)
                    ) : (
                      <span className="text-gray-600">
                        {m.attempts > 0 ? m.attempts + ' attempt(s)' : 'waiting'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
