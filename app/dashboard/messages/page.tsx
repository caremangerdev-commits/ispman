import type { Metadata } from 'next'
import Link from 'next/link'

import { Composer } from '@/components/messages/Composer'
import { listMiscCategories, listServicePlans } from '@/lib/data/catalog'
import { loadEnrichedCustomers } from '@/lib/data/customers'
import { getSmsSettings, listSmsBatches } from '@/lib/data/sms'
import { timeAgo } from '@/lib/format'
import { channelReadiness } from '@/lib/messaging/enqueue'
import { CHANNELS } from '@/lib/messaging/routes'
import { getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Send a Message · ISPMan' }

export default async function MessagesPage() {
  // MANAGER AND ABOVE. The route is gated, not just the nav entry — a cashier
  // typing this URL is redirected exactly as one who clicked a hidden link
  // would be.
  const { company } = await requirePermission('send_bulk_sms')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration required</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            Messaging needs migration 0021. Ask your administrator to apply it.
          </p>
        </div>
      </div>
    )
  }

  const [settings, customers, categories, plans, batches] = await Promise.all([
    getSmsSettings(company.id),
    loadEnrichedCustomers(company.id),
    listMiscCategories(company.id).catch(() => []),
    listServicePlans(company.id).catch(() => []),
    // Enough that a run of one-number tests cannot push the real batches off
    // the page: the two kinds are split below and capped separately.
    listSmsBatches(company.id, 80),
  ])

  // ONE ROW PER BATCH in the table, and only customer batches. A direct send
  // is stored as a batch of one — same table, same detail page — but listing
  // it among the batches makes ten tests to your own phone look like a batch
  // that shattered into ten rows. They get their own, shorter list.
  const customerBatches = batches.filter((b) => !b.direct).slice(0, 25)
  const directSends = batches.filter((b) => b.direct).slice(0, 10)

  const directStatus = (b: typeof batches[number]) =>
    b.failed > 0 ? 'failed' : b.sent > 0 ? 'sent' : b.total === 0 ? 'skipped' : 'queued'

  const addresses = [
    ...new Set(customers.map((c) => (c.address ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b))

  const accessPoints = [
    ...new Set(customers.map((c) => (c.access_point ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b))

  const cutOffDates = [
    ...new Set(customers.map((c) => c.cut_off_date).filter((d): d is number => typeof d === 'number')),
  ].sort((a, b) => a - b)

  const hasBothConnectionTypes =
    new Set(customers.map((c) => c.connection_type).filter(Boolean)).size > 1

  // Which channels this company can send on right now, from the adapters. If
  // none, the reasons are shown in the order the operator would fix them.
  const readiness = await channelReadiness(company.id, settings)
  const ready = CHANNELS.filter((c) => readiness[c].ready)
  const blockedReason = ready.length > 0
    ? null
    : CHANNELS.map((c) => {
        const r = readiness[c]
        return r.ready ? '' : r.reason
      }).filter(Boolean).join(' ') + ' See Settings → Notifications.'

  return (
    <div className="max-w-4xl space-y-5">
      <p className="text-sm text-gray-500">
        Compose a message, choose who receives it, and see exactly who it will reach
        before anything is sent.
      </p>

      <Composer
        miscCategories={categories.map((c) => ({ id: c.id, name: c.name }))}
        servicePlans={plans.map((p) => ({ id: p.id, name: p.name }))}
        addresses={addresses}
        accessPoints={accessPoints}
        cutOffDates={cutOffDates}
        hasBothConnectionTypes={hasBothConnectionTypes}
        templates={settings.smsTemplates}
        allowForeign={settings.allowForeign}
        defaultRoute={settings.routes.bulk}
        channelsAvailable={settings.channelsAvailable}
        readyChannels={ready}
        canSendNow={ready.length > 0}
        blockedReason={blockedReason}
      />

      {/* The record. A batch is who sent it, when, what it said, and how it
          went — reachable long after the messages themselves are gone. One
          row per batch; the per-recipient detail is behind the link. */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-200">Recent batches</h2>

        {customerBatches.length === 0 ? (
          <p className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-8 text-center text-sm text-gray-600">
            {directSends.length > 0
              ? 'No batches to customers yet — only the direct messages below.'
              : 'Nothing has been sent yet.'}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                    <th scope="col" className="px-4 py-2.5 font-semibold">Sent</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">By</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Message</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Sent</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Failed</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Skipped</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {customerBatches.map((b) => (
                    <tr key={b.id} className="transition hover:bg-gray-800/40">
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-400">
                        <Link
                          href={'/dashboard/messages/' + b.id}
                          className="transition hover:text-blue-400"
                        >
                          {timeAgo(b.createdAt)}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-400">
                        {b.sentByName}
                      </td>
                      <td className="max-w-[22rem] px-4 py-2.5">
                        <span className="block truncate text-gray-300" title={b.body}>
                          {b.body}
                        </span>
                        {b.audience ? (
                          <span className="mt-0.5 block truncate text-[11px] text-gray-600">
                            {b.audience}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-green-400">
                        {b.sent}
                        <span className="text-gray-600"> / {b.total}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-400">
                        {b.failed > 0 ? (
                          <span className="text-red-400">{b.failed}</span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500">
                        {b.skipped || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* One-number sends: a technician, a supplier, a test to your own phone.
          Each is one message, so the counts a batch needs collapse to a single
          status word. Same detail page behind the time. */}
      {directSends.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-200">Direct messages</h2>
          <ul className="divide-y divide-gray-800 overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
            {directSends.map((b) => {
              const status = directStatus(b)
              return (
                <li key={b.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <Link
                    href={'/dashboard/messages/' + b.id}
                    className="whitespace-nowrap text-gray-400 transition hover:text-blue-400"
                  >
                    {timeAgo(b.createdAt)}
                  </Link>
                  <span className="whitespace-nowrap font-mono text-xs text-gray-300">
                    +{b.directTo}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-gray-400" title={b.body}>
                    {b.body}
                  </span>
                  <span className="whitespace-nowrap text-xs text-gray-500">{b.sentByName}</span>
                  <span
                    className={
                      'rounded px-1.5 py-0.5 text-[11px] font-medium ' +
                      (status === 'sent'
                        ? 'bg-green-500/15 text-green-400'
                        : status === 'failed'
                          ? 'bg-red-500/15 text-red-400'
                          : 'bg-gray-700/40 text-gray-300')
                    }
                  >
                    {status}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
